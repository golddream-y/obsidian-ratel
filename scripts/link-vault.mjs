#!/usr/bin/env node
/**
 * @file scripts/link-vault.mjs
 * @description 把编译产物 + manifest 软链到指定 Obsidian vault 的插件目录,便于本地调试
 * @module scripts/link-vault
 *
 * 用法:
 *   node scripts/link-vault.mjs /path/to/vault
 *   node scripts/link-vault.mjs              # 从 RATEL_VAULT 环境变量读
 *   node scripts/link-vault.mjs --unlink     # 移除之前建的链接
 *   node scripts/link-vault.mjs --help
 *
 * 关键路径:用 symlink 而非 copy,后续 `npm run dev` 重 build 后
 * Obsidian 端无需重新链接(只要 Obsidian 重载一次)。
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const PLUGIN_ID = 'ratel-vault';

/** 软链源文件:相对仓库根的路径 → 是否必须存在 */
const LINK_SOURCES = [
	{ rel: 'dist/main.js', required: true, desc: '主线程 bundle' },
	{ rel: 'dist/worker.js', required: true, desc: 'Worker bundle' },
	{ rel: 'manifest.json', required: true, desc: 'Obsidian 插件清单' },
	{ rel: 'styles.css', required: false, desc: '样式(可选)' },
];

/**
 * 打印带颜色的消息。stderr 输出,避免污染 stdout。
 * @param {string} color - ANSI 颜色码
 * @param {string} msg - 消息内容
 */
function log(color, msg) {
	const c = {
		reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
		green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
	}[color] ?? '';
	process.stderr.write(`${c}${msg}${c ? '\x1b[0m' : ''}\n`);
}

/** 打印使用说明 */
function printHelp() {
	log('cyan', `
用法: node scripts/link-vault.mjs [vault-path] [选项]

参数:
  vault-path    Obsidian vault 根路径。省略时从 RATEL_VAULT 环境变量读取。

选项:
  --unlink      移除之前在 <vault>/.obsidian/plugins/${PLUGIN_ID}/ 创建的链接
  --help, -h    显示本帮助

示例:
  node scripts/link-vault.mjs ~/Documents/ratel-test-vault
  RATEL_VAULT=~/Documents/ratel-test-vault node scripts/link-vault.mjs
  node scripts/link-vault.mjs --unlink
`);
}

/**
 * 解析 vault 路径(优先 CLI 参数,其次环境变量,失败报错退出)。
 * @param {string[]} argv
 * @returns {string|null} 解析后的绝对路径,未解析返回 null
 */
function resolveVaultPath(argv) {
	const arg = argv.find((a) => !a.startsWith('--') && !a.startsWith('-'));
	const fromEnv = process.env.RATEL_VAULT;
	const raw = arg ?? fromEnv;
	if (!raw) return null;
	return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * 把单一目标链接到指定位置(幂等:已存在且正确则跳过,错误目标则替换)。
 *
 * @param {string} target - 链接指向的源路径(相对 pluginDir)
 * @param {string} linkPath - 链接文件位置
 * @returns {'created' | 'skipped' | 'replaced'}
 */
function ensureSymlink(target, linkPath) {
	// 关键路径:用 lstatSync + try/catch 检测链接本身(不跟随)。
	// existsSync 会跟随 symlink,目标被删时行为不一致;这里关心的是"链接位是否存在"。
	let existingStat = null;
	try { existingStat = lstatSync(linkPath); } catch { /* 不存在 */ }

	if (existingStat) {
		if (existingStat.isSymbolicLink()) {
			const currentTarget = readlinkSync(linkPath);
			if (currentTarget === target) return 'skipped';
			// 关键路径:用 unlinkSync 而非 rmSync。
			// 修复:macOS 上 rmSync({force:true}) 删除 symlink 后,symlinkSync 紧接着同名创建仍抛 EEXIST;
			// unlinkSync(直接 unlink 系统调用)无此问题。
			unlinkSync(linkPath);
			symlinkSync(target, linkPath);
			return 'replaced';
		}
		// 路径被占用且不是符号链接(可能是普通文件 / 目录) — 不能直接覆盖。
		throw new Error(`${linkPath} 已存在且不是符号链接,请先手动删除`);
	}
	symlinkSync(target, linkPath);
	return 'created';
}

/**
 * 移除 vault 插件目录中由本脚本创建的链接(不影响真实文件)。
 * @param {string} pluginDir
 */
function unlinkAll(pluginDir) {
	if (!existsSync(pluginDir)) {
		log('yellow', `⚠ 目录不存在,无需清理: ${pluginDir}`);
		return;
	}
	let removed = 0;
	for (const src of LINK_SOURCES) {
		const linkPath = join(pluginDir, basename(src.rel));
		// 关键路径:用 lstatSync + try/catch 替代 existsSync。
		// 修复:existsSync 会跟随 symlink,目标解析失败时返回 false,导致 unlink 被跳过。
		let st;
		try { st = lstatSync(linkPath); } catch { continue; /* 不存在 */ }
		if (st.isSymbolicLink()) {
			unlinkSync(linkPath);
			removed++;
		}
	}
	log('green', `✓ 已移除 ${removed} 个链接,真实文件未动`);
}

/** 提取路径的 basename(跨平台兼容) */
function basename(p) {
	return p.split('/').pop().split('\\').pop();
}

/** 主入口 */
function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		printHelp();
		process.exit(0);
	}

	const vaultPath = resolveVaultPath(argv);
	if (!vaultPath) {
		log('red', '✗ 缺少 vault 路径。请通过参数或 RATEL_VAULT 环境变量传入。');
		printHelp();
		process.exit(1);
	}

	if (!existsSync(vaultPath)) {
		log('red', `✗ vault 路径不存在: ${vaultPath}`);
		process.exit(1);
	}

	const pluginDir = join(vaultPath, '.obsidian/plugins', PLUGIN_ID);

	if (argv.includes('--unlink')) {
		unlinkAll(pluginDir);
		return;
	}

	// 关键路径:目录不存在则创建,这是首次链接的常见情况。
	mkdirSync(pluginDir, { recursive: true });

	log('cyan', `\n→ 链接到 ${pluginDir}\n`);

	let created = 0, skipped = 0, replaced = 0;
	for (const src of LINK_SOURCES) {
		const absSource = join(REPO_ROOT, src.rel);
		if (!existsSync(absSource)) {
			if (src.required) {
				log('red', `✗ 必需文件不存在: ${src.rel} — 请先 \`npm run build\``);
				process.exit(1);
			}
			log('yellow', `  ○ 跳过(可选): ${src.rel}`);
			continue;
		}
		const linkPath = join(pluginDir, basename(src.rel));
		// 用相对路径做链接,仓库搬家更友好。
		const relTarget = relative(pluginDir, absSource);
		try {
			const result = ensureSymlink(relTarget, linkPath);
			const tag = {
				created: `${'✓'.padEnd(2)} 新建`,
				skipped: `${'○'.padEnd(2)} 已存在`,
				replaced: `${'↻'.padEnd(2)} 替换`,
			}[result];
			const color = result === 'created' ? 'green' : result === 'replaced' ? 'yellow' : 'dim';
			log(color, `  ${tag}  ${basename(src.rel).padEnd(14)}  →  ${relTarget}  ${'  ' + src.desc}`);
			result === 'created' && created++;
			result === 'skipped' && skipped++;
			result === 'replaced' && replaced++;
		} catch (err) {
			log('red', `✗ ${basename(src.rel)}: ${err.message}`);
			process.exit(1);
		}
	}

	log('cyan', `
✓ 完成 (新建 ${created} · 已存在 ${skipped} · 替换 ${replaced})

后续:
  1. 在 Obsidian 打开该 vault
  2. Settings → Community plugins → 启用 Ratel
  3. 代码改动后:
     - \`npm run dev\`  监听 build
     - Obsidian 命令面板 → "Reload" 重载插件(无需重新链接)
  4. 不想再测?  \`node scripts/link-vault.mjs --unlink\`
`);
}

main();

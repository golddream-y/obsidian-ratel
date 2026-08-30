/**
 * @file src/skills/script-vm.ts
 * @description vm 沙箱核心 — 受能力面裁剪的脚本执行(ADR-017;被 skill-script-worker 调用)
 * @module skills/script-vm
 * @depends node:vm, node:fs, node:path
 *
 * 关键路径:
 * - 本文件运行在 worker_threads 内,严禁 import 'obsidian' 与 i18n(错误文案由工具层包装)。
 * - 全新 vm context 天然无 fetch / require / process / XMLHttpRequest — 只注入白名单 API。
 * - 不设 vm timeout 选项:击杀权统一归主线程 worker.terminate()(ADR-017 单一击杀路径)。
 */

import * as vm from 'node:vm';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/** 结果 JSON 序列化上限(64KB)— 巨型返回值不撑爆工具结果与上下文 */
const MAX_RESULT_BYTES = 64 * 1024;
const TRUNCATION_NOTE = '(已截断:脚本返回值超出 64KB 上限)';

export interface VmSandboxRequest {
	/** 脚本源码(UTF-8 文本;入口约定为同步代码,末表达式作为返回值) */
	code: string;
	/** 命令行参数,注入为全局 args */
	args: string[];
	/** fs 白名单目录(绝对路径;通常 = [vaultRoot, skillDir]) */
	allowedDirs: string[];
	/** 心跳回调 — 脚本 reportProgress() 触发,主线程软超时据此复位 */
	onProgress?: (message: string) => void;
	/** console 透传回调 */
	onLog?: (level: 'log' | 'warn' | 'error', message: unknown) => void;
}

export type VmSandboxResult =
	| { ok: true; result: string }
	| { ok: false; error: string; stack?: string };

/**
 * fs 白名单校验:resolve 后必须落在某个 allowedDir 内,否则抛错。
 *
 * 关键路径:startsWith 必须补 path.sep,防 `/vault-evil` 误匹配 `/vault` 前缀。
 */
function resolveAllowed(p: string, allowedDirs: string[], cwd: string): string {
	const abs = nodePath.resolve(cwd, p);
	for (const dir of allowedDirs) {
		if (abs === dir || abs.startsWith(dir + nodePath.sep)) return abs;
	}
	throw new Error(`fs 访问被拒绝(超出沙箱白名单): ${p}`);
}

/** 受限 fs — 只暴露同步 API,全部过白名单校验;写操作自动建父目录降低脚本样板 */
function createRestrictedFs(allowedDirs: string[], cwd: string): Record<string, unknown> {
	const guard = (p: string): string => resolveAllowed(p, allowedDirs, cwd);
	const guardWrite = (p: string): string => {
		const abs = guard(p);
		nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
		return abs;
	};
	return {
		readFileSync: (p: string, enc?: 'utf8' | 'utf-8') => nodeFs.readFileSync(guard(p), enc ?? 'utf-8'),
		writeFileSync: (p: string, data: string) => nodeFs.writeFileSync(guardWrite(p), data, 'utf-8'),
		appendFileSync: (p: string, data: string) => nodeFs.appendFileSync(guardWrite(p), data, 'utf-8'),
		existsSync: (p: string) => {
			try {
				return nodeFs.existsSync(guard(p));
			} catch {
				return false;
			}
		},
		mkdirSync: (p: string) => nodeFs.mkdirSync(guardWrite(p), { recursive: true }),
		readdirSync: (p: string) => nodeFs.readdirSync(guard(p)),
		statSync: (p: string) => nodeFs.statSync(guard(p)),
	};
}

/** 末表达式值 → 字符串(JSON 优先;超限截断加尾注) */
function serializeResult(value: unknown): string {
	let text: string;
	if (value === undefined) {
		text = 'undefined';
	} else if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === null
	) {
		text = String(value);
	} else {
		try {
			text = JSON.stringify(value) ?? Object.prototype.toString.call(value);
		} catch {
			// 循环引用等不可序列化值降级为 Object 标签
			text = Object.prototype.toString.call(value);
		}
	}
	if (Buffer.byteLength(text, 'utf-8') > MAX_RESULT_BYTES) {
		// 关键路径:按字节截断可能切到多字节字符中间,解码产生替换符,不影响阅读(与 prompts/injection/injector 同表述)
		let out = Buffer.from(text, 'utf-8').subarray(0, MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATION_NOTE, 'utf-8')).toString('utf-8');
		out += TRUNCATION_NOTE;
		return out;
	}
	return text;
}

/**
 * 在受限 vm context 中执行脚本。
 *
 * 设计要点:
 * - 注入全局:args / reportProgress / console(透传)/ fs(白名单)/ path(纯函数,无 IO)
 * - 不注入 require / process / fetch — 新 context 默认就没有,无需显式砍
 * - 脚本抛错不向上冒泡:返回 ok:false,由调用方(worker)决定计数与呈现
 *
 * @returns ok:true 时 result 为序列化字符串;ok:false 时为脚本错误
 * @example
 *   const r = runInVmSandbox({ code: 'args[0]', args: ['x'], allowedDirs: [dir] });
 */
export function runInVmSandbox(req: VmSandboxRequest): VmSandboxResult {
	// 关键路径:入口统一 normalize(每项 nodePath.resolve)— 带尾斜杠的 allowedDir 会让 dir + sep
	// 拼出双斜杠,startsWith 永假,fs 白名单静默全拒;空数组不抛错(语义 = fs 全拒,T3 测试依赖此场景)
	const allowedDirs = req.allowedDirs.map((d) => nodePath.resolve(d));
	const cwd = allowedDirs[0] ?? process.cwd();
	const sandbox: Record<string, unknown> = {
		args: req.args,
		reportProgress: (msg: unknown) => req.onProgress?.(String(msg)),
		console: {
			// 偏差修正:参数数组拼为单条字符串消息(测试断言回调收到字符串,worker 侧无需再拼接)
			log: (...a: unknown[]) => req.onLog?.('log', a.map(String).join(' ')),
			warn: (...a: unknown[]) => req.onLog?.('warn', a.map(String).join(' ')),
			error: (...a: unknown[]) => req.onLog?.('error', a.map(String).join(' ')),
		},
		fs: createRestrictedFs(allowedDirs, cwd),
		path: {
			join: (...parts: string[]) => nodePath.join(...parts),
			resolve: (...parts: string[]) => nodePath.resolve(...parts),
			dirname: (p: string) => nodePath.dirname(p),
			basename: (p: string) => nodePath.basename(p),
			extname: (p: string) => nodePath.extname(p),
			sep: nodePath.sep,
			relative: (from: string, to: string) => nodePath.relative(from, to),
		},
	};
	const context = vm.createContext(sandbox);
	try {
		const value: unknown = vm.runInContext(req.code, context, { filename: 'skill-script.js' }) as unknown;
		return { ok: true, result: serializeResult(value) };
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		return { ok: false, error: e.message, stack: e.stack };
	}
}

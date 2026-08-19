/**
 * @file src/tools/read-skill-reference.ts
 * @description `read_skill_reference` 工具 — 读 skill references/ 内文件,只读 + traversal 防护(spec §4.6b)
 * @module tools/read-skill-reference
 * @depends core/tool-registry, skills/skill-registry, i18n, node:fs, node:path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/** 参考文件读取上限 — 与 search/read 工具同量级,防巨型文件吃掉上下文 */
const MAX_REF_BYTES = 100 * 1024;

/**
 * 校验相对路径:拒绝绝对路径与任何 `..` 段(spec §4.6b 防 traversal 第一道)。
 */
function assertRelativeSubPath(p: string): void {
	if (path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) {
		throw new Error(tNow('skill.ref.invalidPath', { path: p }));
	}
}

/**
 * 构造 `read_skill_reference` 工具实例。
 *
 * 设计要点:
 * - 只读工具(readOnly: true),不触发写钩子;默认权限 allow(与 read_note 同级)
 * - 三道防护:相对路径校验 → resolve 锁定 references/ 前缀 → realpath 防符号链接逃逸
 * - 大小上限 100KB;二进制(含 NUL 字节)拒绝
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 */
export function createReadSkillReferenceTool(registry: SkillRegistry, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.skillName !== 'string' || args.skillName.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'skillName', type: typeof args.skillName }));
			}
			if (typeof args.path !== 'string' || args.path.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'path', type: typeof args.path }));
			}
			const skill = registry.get(args.skillName);
			if (!skill) throw new Error(tNow('skill.notice.notFound', { name: args.skillName }));
			if (!registry.isEnabled(args.skillName)) {
				throw new Error(tNow('error.skill.notEnabled', { name: args.skillName }));
			}
			assertRelativeSubPath(args.path);

			const refsRoot = path.join(skill.dir, 'references');
			const abs = path.resolve(refsRoot, args.path);
			// 关键路径:resolve 后仍必须落在 references/ 内(双保险,防 'a/../../b' 类拼凑)
			if (abs !== refsRoot && !abs.startsWith(refsRoot + path.sep)) {
				throw new Error(tNow('skill.ref.invalidPath', { path: args.path }));
			}
			// 修复:文件不存在时 realpathSync 抛 ENOENT(英文系统错误,绕过 i18n),先判存在再解析
			if (!fs.existsSync(abs)) throw new Error(tNow('skill.ref.notFound', { path: args.path }));
			// 关键路径:realpath 防符号链接逃逸 — 解析后真实路径必须仍指向 skill 目录内
			const realAbs = fs.realpathSync(abs);
			const realRoot = fs.realpathSync(skill.dir);
			if (!realAbs.startsWith(realRoot + path.sep)) {
				throw new Error(tNow('skill.ref.invalidPath', { path: args.path }));
			}
			const stat = fs.statSync(realAbs);
			if (!stat.isFile()) throw new Error(tNow('skill.ref.notFound', { path: args.path }));
			if (stat.size > MAX_REF_BYTES) throw new Error(tNow('skill.ref.tooLarge', { path: args.path }));
			const content = fs.readFileSync(realAbs, 'utf-8');
			// 关键路径:NUL 字节是二进制文件的特征,读给 LLM 无意义且污染上下文
			if (content.includes('\u0000')) throw new Error(tNow('skill.ref.binary', { path: args.path }));
			return content;
		},
	};
}

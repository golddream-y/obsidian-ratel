/**
 * @file src/tools/activate-skill.ts
 * @description `activate_skill` 工具 — 激活指定 skill,把指令写入当前 Session 消息(ADR-012)
 * @module tools/activate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';
// 关键路径(S-SR-LAYERING):instructions 超 8KB 时按 UTF-8 字节尾部截断
import { truncateUtf8Bytes } from '../prompts/injection/injector';

// 关键路径(S-SR-LAYERING):单条 skill instructions 注入上限 8KB —
// 巨型 SKILL.md 不再全文吃掉上下文;截断加尾注指引模型回查源文件。
const MAX_SKILL_INSTRUCTIONS_BYTES = 8 * 1024;
const TRUNCATION_NOTE = '\n\n(已截断:内容超出注入上限,完整做法请查看 SKILL.md 原文)';

/**
 * 会话侧写入钩子 — 由 ask() 绑定到当前 ContextManager。
 */
export interface SkillSessionHooks {
	hasInSession: (name: string) => boolean;
	appendToSession: (name: string, instructions: string) => void;
	supersedeInSession?: (name: string) => void;
}

/** 统计回调 — 由 main 注入 UsageStatsStore;单测可不传 */
export interface SkillUsageStats {
	bumpSkill: (name: string) => void;
}

/**
 * 构造 `activate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - ADR-012:副作用是把 instructions 写入 Session.messages,不再依赖 Active 段每轮重注。
 * - `sessionHooks` 由 main.ask 注入当前 ctx;单测可不传(仅测 registry 校验)。
 * - instructions 超 8KB 截断加尾注(S-SR-LAYERING);激活成功后经 `stats` 计数。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param sessionHooks - 可选;写入当前会话 transcript
 * @param stats - 可选;使用统计回调(pluginDir/usage-stats.json)
 */
export function createActivateSkillTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
	sessionHooks?: SkillSessionHooks,
	stats?: SkillUsageStats,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			if (sessionHooks?.hasInSession(name)) {
				return tNow('skill.notice.alreadyActive', { name });
			}
			// 关键路径:registry.activate 校验存在/启用;activeSkills 仅作可选缓存。
			const skill = registry.activate(name);
			// 关键路径(S-SR-LAYERING):超 8KB 尾部截断 + 尾注指引回查 SKILL.md 原文。
			const raw = skill.instructions;
			const body = Buffer.byteLength(raw, 'utf-8') > MAX_SKILL_INSTRUCTIONS_BYTES
				? truncateUtf8Bytes(raw, MAX_SKILL_INSTRUCTIONS_BYTES) + TRUNCATION_NOTE
				: raw;
			sessionHooks?.appendToSession(skill.manifest.name, body);
			stats?.bumpSkill(skill.manifest.name);
			return tNow('skill.notice.activated', { name: skill.manifest.name });
		},
	};
}

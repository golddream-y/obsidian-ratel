/**
 * @file src/skills/skill-script-permission.ts
 * @description 脚本信任门 — trustedScripts 白名单 + 首次授权 Modal 决策(ADR-017 / spec §4.6c)
 * @module skills/skill-script-permission
 */

/** Modal 返回的三态决策 */
export type TrustConfirmDecision = 'always' | 'once' | 'deny';
/** 门检查结果 */
export type TrustDecision = 'run' | 'deny';

export interface ScriptTrustDeps {
	/** 是否在 settings.trustedScripts 白名单内(main 注入) */
	isTrusted: (scriptId: string) => boolean;
	/** 弹出 ScriptTrustModal,等用户决策(main 注入) */
	confirm: (scriptId: string) => Promise<TrustConfirmDecision>;
	/** 「允许并记住」时写入 settings.trustedScripts(main 注入;同时清熔断计数) */
	persistTrust: (scriptId: string) => void;
}

/**
 * 脚本信任门 — per-script 首次授权(类 Obsidian 插件权限模型)。
 *
 * 设计要点:
 * - 白名单内直行,不打扰
 * - 'always' 持久化(用户显式信任);'once' 只放本次;ESC/拒绝 = deny
 * - 工具层把 deny 转为工具结果(不抛异常,LLM 可换路,ADR-017 §4)
 */
export class ScriptTrustGate {
	constructor(private readonly deps: ScriptTrustDeps) {}

	/**
	 * 检查 scriptId(`skillName/scriptPath`)是否可运行。
	 *
	 * @returns 'run' 可执行;'deny' 用户拒绝
	 */
	async check(scriptId: string): Promise<TrustDecision> {
		if (this.deps.isTrusted(scriptId)) return 'run';
		const decision = await this.deps.confirm(scriptId);
		if (decision === 'deny') return 'deny';
		if (decision === 'always') this.deps.persistTrust(scriptId);
		return 'run';
	}
}

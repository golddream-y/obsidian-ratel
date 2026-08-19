/**
 * @file src/tools/run-skill-script.ts
 * @description `run_skill_script` 工具 — 熔断 + 信任门 + Worker/vm 沙箱编排(ADR-017)
 * @module tools/run-skill-script
 * @depends core/tool-registry, skills/skill-registry, skills/skill-script-permission,
 *          skills/skill-script-sandbox(接口), i18n, node:fs, node:path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ScriptTrustGate } from '../skills/skill-script-permission';
import type { ScriptRunOutcome, ScriptRunRequest } from '../skills/skill-script-sandbox';
import { tNow } from '../i18n';

/** 连续失败熔断阈值(ADR-017 §5:被杀/超时/崩溃) */
export const SCRIPT_FAILURE_THRESHOLD = 3;

/** 脚本扩展名白名单 — 语言边界 JS-only(ADR-017:vm 只懂 JS,非 JS 引导走 MCP) */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** 沙箱接口子集 — main 注入 SkillScriptSandbox;测试注入 fake */
export interface ScriptSandboxLike {
	run(req: ScriptRunRequest): Promise<ScriptRunOutcome>;
}

/**
 * 失败计数接口子集 — 方法名与 UsageStatsStore 保持一致(以已合并代码签名为准),
 * main 接线时直接注入真实实例,无需适配层。
 */
export interface ScriptFailureCounter {
	getScriptFailureCount(scriptId: string): number;
	bumpScriptFailure(scriptId: string): void;
	clearScriptFailure(scriptId: string): void;
}

export interface RunSkillScriptDeps {
	sandbox: ScriptSandboxLike;
	trustGate: ScriptTrustGate;
	failures: ScriptFailureCounter;
	/** 现读 settings.skillScriptTimeout(设置面板改完立即生效) */
	timeoutMs: () => number;
	/** vault 根绝对路径(fs 白名单之一) */
	vaultRoot: () => string;
	/** 软超时警告(main → Notice;可选) */
	onSoftTimeout?: (scriptId: string) => void;
	/** 熔断提醒(main → Notice;可选) */
	onCircuitBreak?: (scriptId: string) => void;
}

/**
 * 校验相对路径:拒绝绝对路径与任何 `..` 段(防 traversal 第一道,ADR-017 §1)。
 */
function assertRelativeSubPath(p: string): void {
	if (path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) {
		throw new Error(tNow('skill.script.invalidPath', { path: p }));
	}
}

/**
 * 构造 `run_skill_script` 工具实例。
 *
 * 设计要点(ADR-017):
 * - 错误作为工具结果返回而非抛异常 — LLM 看到「超时被终止」可自行换路,不崩回合(§4)
 * - 熔断只数 timeout/crashed;scriptError 是正常失败,LLM 可修参重试(§5)
 * - 检查顺序:语言边界 → 信任门 → 熔断 → 执行(熔断的恢复路径 = 重新授权「允许并记住」时清计数)
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param deps - 沙箱 / 信任门 / 计数 / 超时与 vault 根注入
 */
export function createRunSkillScriptTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
	deps: RunSkillScriptDeps,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.skillName !== 'string' || args.skillName.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'skillName', type: typeof args.skillName }));
			}
			if (typeof args.scriptPath !== 'string' || args.scriptPath.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'scriptPath', type: typeof args.scriptPath }));
			}
			const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];

			const skill = registry.get(args.skillName);
			if (!skill) throw new Error(tNow('skill.notice.notFound', { name: args.skillName }));
			if (!registry.isEnabled(args.skillName)) {
				throw new Error(tNow('error.skill.notEnabled', { name: args.skillName }));
			}
			assertRelativeSubPath(args.scriptPath);
			const scriptId = `${args.skillName}/${args.scriptPath}`;

			// 关键路径:语言边界(JS-only,ADR-017)— 扩展名检查放在信任门**之前**:
			// 永远跑不了的脚本不该让用户授权;返回工具结果(非 throw)让 LLM 引导用户走 MCP。
			const ext = path.extname(args.scriptPath).toLowerCase();
			if (!SCRIPT_EXTENSIONS.includes(ext)) {
				return tNow('skill.script.unsupported', { path: args.scriptPath, ext: ext || '无扩展名' });
			}

			// 关键路径:先信任门后熔断 — untrusted 脚本先过 Modal,选「允许并记住」时
			// main 的 persistTrust 回调会同时清计数,给熔断脚本一条用户主导的恢复路径。
			if ((await deps.trustGate.check(scriptId)) === 'deny') {
				return tNow('skill.script.denied', { id: scriptId });
			}

			const count = deps.failures.getScriptFailureCount(scriptId);
			if (count >= SCRIPT_FAILURE_THRESHOLD) {
				deps.onCircuitBreak?.(scriptId);
				return tNow('skill.script.circuitBreak', { id: scriptId, count: SCRIPT_FAILURE_THRESHOLD });
			}

			const scriptsRoot = path.join(skill.dir, 'scripts');
			const abs = path.resolve(scriptsRoot, args.scriptPath);
			// 关键路径:resolve 后仍必须落在 scripts/ 内(双保险,防 'a/../../b' 类拼凑)
			if (abs !== scriptsRoot && !abs.startsWith(scriptsRoot + path.sep)) {
				throw new Error(tNow('skill.script.invalidPath', { path: args.scriptPath }));
			}
			if (!fs.existsSync(abs)) throw new Error(tNow('skill.script.notFound', { path: args.scriptPath }));
			const code = fs.readFileSync(abs, 'utf-8');

			const outcome = await deps.sandbox.run({
				code,
				args: scriptArgs,
				// 关键路径:fs 白名单 = vault 根 + 该 skill 目录(ADR-017 §1)
				allowedDirs: [deps.vaultRoot(), skill.dir],
				timeoutMs: deps.timeoutMs(),
				onSoftTimeout: () => deps.onSoftTimeout?.(scriptId),
			});

			switch (outcome.status) {
				case 'ok':
					deps.failures.clearScriptFailure(scriptId);
					return outcome.result;
				case 'scriptError':
					// 关键路径:脚本自己 throw 是正常失败,不计熔断(ADR-017 §5)
					return tNow('skill.script.failed', { message: outcome.error });
				case 'timeout': {
					deps.failures.bumpScriptFailure(scriptId);
					const hint = outcome.hadProgress ? tNow('skill.script.timeoutProgressHint') : '';
					return tNow('skill.script.timeout', { id: scriptId, seconds: Math.round(deps.timeoutMs() / 1000) }) + (hint ? ' ' + hint : '');
				}
				case 'crashed':
					deps.failures.bumpScriptFailure(scriptId);
					return tNow('skill.script.crashed', { detail: outcome.detail ?? 'unknown' });
			}
		},
	};
}

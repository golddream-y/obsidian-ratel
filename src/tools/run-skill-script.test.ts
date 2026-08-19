/**
 * @file src/tools/run-skill-script.test.ts
 * @description run_skill_script 工具测试 — 熔断 / 信任门 / 超时语义 / 成功清零(sandbox 全 mock)
 * @module tools/run-skill-script.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLang } from '../i18n';
import { SkillRegistry } from '../skills/skill-registry';
import { ScriptTrustGate } from '../skills/skill-script-permission';
import type { ScriptRunOutcome, ScriptRunRequest } from '../skills/skill-script-sandbox';
import {
	createRunSkillScriptTool,
	SCRIPT_FAILURE_THRESHOLD,
	type ScriptFailureCounter,
	type ScriptSandboxLike,
} from './run-skill-script';
import type { ToolDefinition } from '../ports/llm';

const DEF: ToolDefinition = {
	name: 'run_skill_script',
	// 关键路径:ToolDefinition.description 必填,补占位值满足类型(plan 原代码缺失)
	description: 'run skill script test',
	parameters: { type: 'object', properties: {}, required: [] },
};

/** 可编程假沙箱:记录请求与调用序列,返回预设 outcome */
class FakeSandbox implements ScriptSandboxLike {
	lastReq: ScriptRunRequest | null = null;
	outcome: ScriptRunOutcome = { status: 'ok', result: '"done"' };
	/** continueRun() 的预设返回(默认 noRunning — 无挂起) */
	continueOutcome: ScriptRunOutcome = { status: 'noRunning' };
	/** killRun() 的预设返回(默认 noRunning — 无挂起) */
	killOutcome: ScriptRunOutcome = { status: 'noRunning' };
	/** 调用序列(run / continueRun / killRun)— 钉死分流优先级 */
	calls: string[] = [];
	async run(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		this.lastReq = req;
		this.calls.push('run');
		return this.outcome;
	}
	async continueRun(): Promise<ScriptRunOutcome> {
		this.calls.push('continueRun');
		return this.continueOutcome;
	}
	async killRun(): Promise<ScriptRunOutcome> {
		this.calls.push('killRun');
		return this.killOutcome;
	}
}

/**
 * 内存失败计数 — 方法名与 UsageStatsStore 保持一致(以已合并代码签名为准),
 * main 接线时可直接注入真实实例,无需适配层。
 */
class FakeFailures implements ScriptFailureCounter {
	counts = new Map<string, number>();
	bumped: string[] = [];
	cleared: string[] = [];
	getScriptFailureCount(id: string) {
		return this.counts.get(id) ?? 0;
	}
	bumpScriptFailure(id: string) {
		this.bumped.push(id);
		this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
	}
	clearScriptFailure(id: string) {
		this.cleared.push(id);
		this.counts.delete(id);
	}
}

describe('run_skill_script 工具', () => {
	let dir: string;
	let registry: SkillRegistry;
	let sandbox: FakeSandbox;
	let failures: FakeFailures;
	let trusted: string[];

	beforeEach(() => {
		// 关键路径:langStore 全局共享,锁定 zh 让 toThrow 正则与文案断言稳定匹配中文。
		setLang('zh');
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skillrun-'));
		fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'scripts', 'clean.js'), 'result = 1');
		registry = new SkillRegistry();
		registry.reload(
			[{
				manifest: { name: 'data-cleaner', description: 'd', enabled: true, activation: 'auto', tags: [] },
				instructions: 'body',
				source: 'vault',
				dir,
			}],
			[],
		);
		sandbox = new FakeSandbox();
		failures = new FakeFailures();
		trusted = [];
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function makeTool(opts: { decision?: 'always' | 'once' | 'deny' } = {}) {
		const gate = new ScriptTrustGate({
			isTrusted: (id) => trusted.includes(id),
			confirm: async () => opts.decision ?? 'once',
			persistTrust: (id) => trusted.push(id),
		});
		return createRunSkillScriptTool(registry, DEF, {
			sandbox,
			trustGate: gate,
			failures,
			timeoutMs: () => 30_000,
			vaultRoot: () => '/vault',
		});
	}

	it('正常执行 - 白名单脚本直行 - 返回结果并清零计数', async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', 0);
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', args: ['--x'] });
		expect(out).toBe('"done"');
		expect(sandbox.lastReq?.allowedDirs).toEqual(['/vault', dir]);
		expect(sandbox.lastReq?.timeoutMs).toBe(30_000);
	});

	it('用户拒绝 - 返回 denied 工具结果(不抛异常)', async () => {
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('拒绝');
	});

	it('无心跳超时(stalled)- 计数 +1 并返回卡死文案', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'timeout', kind: 'stalled', hadProgress: false };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('无任何进度心跳');
		expect(out).toContain('卡死');
		expect(failures.bumped).toEqual(['data-cleaner/clean.js']);
	});

	it('绝对上限超时(maxDuration)- 计数 +1 并返回绝对上限文案', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'timeout', kind: 'maxDuration', hadProgress: true };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('绝对上限');
		expect(out).toContain('10 分钟');
		expect(failures.bumped).toEqual(['data-cleaner/clean.js']);
	});

	it('still-running - 不计熔断不 bump - 文案含时长/最近进度/continueRun 引导', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'stillRunning', elapsedMs: 32_400, lastProgress: '已清洗 50%', hadProgress: true };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('仍在运行');
		expect(out).toContain('32');
		expect(out).toContain('已清洗 50%');
		// 关键路径:LLM 决策引导 — 续等与终止两个动作都必须出现在文案里
		expect(out).toContain('continueRun');
		expect(out).toContain('killRun');
		// 熔断口径(ADR-017 v1.1 §5):still-running 未终止,不计数
		expect(failures.bumped).toEqual([]);
	});

	it('still-running 无 lastProgress - 进度占位兜底为「无进度描述」', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'stillRunning', elapsedMs: 30_000, hadProgress: true };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('无进度描述');
	});

	it('killRun 分支 - 不走信任门/熔断/语言边界(脚本已在跑,授权在启动时已过)', async () => {
		// 关键路径:三重不利条件 — 未 trusted + 用户 decision 'deny' + 熔断计数已满;
		// 若 killRun 分支误走任何一道检查,会分别返回「拒绝」或「熔断」而非终止结果。
		failures.counts.set('data-cleaner/clean.js', SCRIPT_FAILURE_THRESHOLD);
		sandbox.killOutcome = { status: 'killed' };
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', killRun: true });
		expect(out).toContain('已按指示终止');
		expect(sandbox.calls).toEqual(['killRun']);
		// killRun 不进沙箱跑新脚本
		expect(sandbox.lastReq).toBeNull();
		// 熔断口径:主动终止是有意决策,不计数
		expect(failures.bumped).toEqual([]);
	});

	it('continueRun 分支 - 不走信任门/熔断 - 挂起脚本完成后返回结果', async () => {
		sandbox.continueOutcome = { status: 'ok', result: '"done-after-wait"' };
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', continueRun: true });
		expect(out).toBe('"done-after-wait"');
		expect(sandbox.calls).toEqual(['continueRun']);
		expect(sandbox.lastReq).toBeNull();
		expect(failures.bumped).toEqual([]);
	});

	it('continueRun 与 killRun 同真 - killRun 优先', async () => {
		sandbox.continueOutcome = { status: 'ok', result: '"done"' };
		sandbox.killOutcome = { status: 'killed' };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', continueRun: true, killRun: true });
		expect(out).toContain('已按指示终止');
		expect(sandbox.calls).toEqual(['killRun']);
	});

	it('continueRun 无挂起脚本 - 返回 noRunning 文案(action=continueRun)', async () => {
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', continueRun: true });
		expect(out).toContain('没有正在运行的脚本');
		expect(out).toContain('continueRun');
	});

	it('killRun 无挂起脚本 - 返回 noRunning 文案(action=killRun)', async () => {
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', killRun: true });
		expect(out).toContain('没有正在运行的脚本');
		expect(out).toContain('killRun');
	});

	it('崩溃 - 计数 +1 并返回 crashed 结果', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'crashed', detail: 'segfault' };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('异常退出');
		expect(failures.bumped).toEqual(['data-cleaner/clean.js']);
	});

	it('脚本抛错(scriptError)- 不计入熔断(ADR-017:仅被杀/超时/崩溃计数)', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'scriptError', error: 'boom' };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('boom');
		expect(failures.bumped).toEqual([]);
	});

	it('成功一次 - 清零连续失败计数', async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', 2);
		const tool = makeTool();
		await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(failures.cleared).toEqual(['data-cleaner/clean.js']);
	});

	it(`连续失败 ${SCRIPT_FAILURE_THRESHOLD} 次 - 熔断,再调用直接拒绝执行`, async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', SCRIPT_FAILURE_THRESHOLD);
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('熔断');
		// 关键路径:熔断后不再进沙箱
		expect(sandbox.lastReq).toBeNull();
	});

	it('脚本不存在 - 抛 notFound;scripts 外路径被拒', async () => {
		trusted = ['data-cleaner/x.js'];
		const tool = makeTool();
		await expect(tool.execute({ skillName: 'data-cleaner', scriptPath: 'nope.js' })).rejects.toThrow(/未找到/);
		await expect(tool.execute({ skillName: 'data-cleaner', scriptPath: '../SKILL.md' })).rejects.toThrow(/路径非法/);
	});

	it('语言边界 - .py 脚本返回 unsupported 并引导 MCP - 不弹授权不进沙箱', async () => {
		fs.writeFileSync(path.join(dir, 'scripts', 'clean.py'), 'print(1)');
		// 关键路径:刻意不预置 trusted — 钉住「扩展名检查在信任门之前」的顺序:
		// 若实现错序,untrusted 脚本会先走 confirm(decision 'deny')返回「拒绝」
		// 而非「不是 JavaScript」,下方断言才会真失败。
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.py' });
		// 修复:plan 断言「仅支持 JavaScript」与 zh 文案「仅支持 .js/.mjs/.cjs」不一致,以文案为准
		expect(out).toContain('不是 JavaScript');
		expect(out).toContain('仅支持 .js/.mjs/.cjs');
		expect(out).toContain('MCP');
		expect(sandbox.lastReq).toBeNull();
	});

	it('语言边界 - 无扩展名脚本返回 unsupported(含「无扩展名」标记)- 不进沙箱', async () => {
		fs.writeFileSync(path.join(dir, 'scripts', 'noext'), 'result = 1');
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'noext' });
		expect(out).toContain('不是 JavaScript');
		expect(out).toContain('无扩展名');
		expect(sandbox.lastReq).toBeNull();
	});

	it('args 非数组 - 静默按空数组执行成功(钉住现有兜底行为)', async () => {
		trusted = ['data-cleaner/clean.js'];
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', args: 'not-array' });
		expect(out).toBe('"done"');
		// 关键路径:钉住兜底 — 非数组 args 静默降级为空数组,不抛错不拦截
		expect(sandbox.lastReq?.args).toEqual([]);
	});
});

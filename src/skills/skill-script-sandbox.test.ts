/**
 * @file src/skills/skill-script-sandbox.test.ts
 * @description SkillScriptSandbox 测试 — 真实 worker_threads:协议 / 心跳分类超时状态机 / 串行 / exit 兜底(ADR-017 v1.1)
 * @module skills/skill-script-sandbox.test
 * @depends esbuild(仅测试内现场打包,write:false)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { SkillScriptSandbox, wrapBrowserWorker } from './skill-script-sandbox';

/**
 * 现场把真实 worker 入口打成 CJS 字符串(与 esbuild.config.mjs 产物同构)。
 *
 * 关键路径:vitest ESM 无 __dirname,用 fileURLToPath(new URL(...)) 推导
 * (与 esbuild.config.mjs 的 fileURLToPath 惯例一致)。
 */
async function buildRealWorkerCode(): Promise<string> {
	const result = await esbuild.build({
		entryPoints: [fileURLToPath(new URL('../worker/skill-script-worker.ts', import.meta.url))],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		write: false,
	});
	const code = result.outputFiles?.[0]?.text;
	if (!code) throw new Error('esbuild 现场打包未产出 worker 代码(write:false 应返回 outputFiles)');
	return code;
}

describe('SkillScriptSandbox(真实 worker_threads)', () => {
	let workerCode: string;
	beforeAll(async () => {
		workerCode = await buildRealWorkerCode();
	});

	it('run - 正常脚本 - 末表达式结果回传', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `args.join('+')`, args: ['1', '2'], allowedDirs: [], timeoutMs: 5_000 });
		expect(out).toEqual({ status: 'ok', result: '"1+2"' });
	});

	it('run - 脚本抛错 - scriptError 含消息', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `throw new Error('boom')`, args: [], allowedDirs: [], timeoutMs: 5_000 });
		expect(out.status).toBe('scriptError');
		if (out.status === 'scriptError') expect(out.error).toContain('boom');
	});

	it('硬超时 - 死循环被 terminate 击杀 - timeout outcome', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `while (true) { }`, args: [], allowedDirs: [], timeoutMs: 300 });
		// 关键路径:这是 ADR-017 的核心验收 — 死循环只卡 worker,毫秒级可杀
		expect(out.status).toBe('timeout');
	});

	it('软超时 - 无心跳脚本触发 onSoftTimeout 但不终止', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		let softFired = false;
		const out = await sandbox.run({
			code: `const t = Date.now(); while (Date.now() - t < 1500) {} 'done'`,
			args: [],
			allowedDirs: [],
			timeoutMs: 10_000,
			softTimeoutMs: 300,
			onSoftTimeout: () => { softFired = true; },
		});
		expect(softFired).toBe(true);
		expect(out).toEqual({ status: 'ok', result: '"done"' });
	});

	it('软超时 - reportProgress 心跳复位 - 不误报', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		let softFired = false;
		const out = await sandbox.run({
			code: `for (let i = 0; i < 5; i++) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 400) {} } 'done'`,
			args: [],
			allowedDirs: [],
			timeoutMs: 10_000,
			softTimeoutMs: 1_000,
			onSoftTimeout: () => { softFired = true; },
		});
		expect(softFired).toBe(false);
		expect(out.status).toBe('ok');
	});

	it('并发=1 - 两次 run 串行 - 第二次等第一次完成', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const order: string[] = [];
		const p1 = sandbox.run({
			code: `const t = Date.now(); while (Date.now() - t < 600) {} 'first'`,
			args: [], allowedDirs: [], timeoutMs: 10_000,
		}).then((o) => { order.push('p1'); return o; });
		const p2 = sandbox.run({ code: `'second'`, args: [], allowedDirs: [], timeoutMs: 10_000 })
			.then((o) => { order.push('p2'); return o; });
		const [o1, o2] = await Promise.all([p1, p2]);
		expect(order).toEqual(['p1', 'p2']);
		expect(o1.status).toBe('ok');
		expect(o2.status).toBe('ok');
	});

	it('exit 兜底 - worker 直接退出未回 done - crashed 而非悬空', async () => {
		// 裸 JS worker(协议兼容子集):收到 run 直接退出
		const bareCode = `require('node:worker_threads').parentPort.on('message', () => process.exit(0));`;
		const sandbox = new SkillScriptSandbox(bareCode);
		const out = await sandbox.run({ code: `'x'`, args: [], allowedDirs: [], timeoutMs: 5_000 });
		expect(out.status).toBe('crashed');
	});
});

describe('SkillScriptSandbox 心跳分类超时状态机(ADR-017 v1.1)', () => {
	let workerCode: string;
	beforeAll(async () => {
		workerCode = await buildRealWorkerCode();
	});

	it('有心跳 + 窗口到点 - stillRunning 含时长与最近进度 - worker 不终止', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({
			// 每 150ms 打一次点的长任务:窗口到点时心跳活跃
			code: `for (let i = 0; i < 8; i++) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 150) {} } 'late'`,
			args: [], allowedDirs: [], timeoutMs: 500,
		});
		expect(out.status).toBe('stillRunning');
		if (out.status !== 'stillRunning') return;
		expect(out.elapsedMs).toBeGreaterThanOrEqual(500);
		expect(out.hadProgress).toBe(true);
		expect(out.lastProgress).toContain('tick');
		// worker 未被 terminate 的证明:pending 仍在,killRun 得到 killed 而非 noRunning
		expect(await sandbox.killRun()).toEqual({ status: 'killed' });
	});

	it('stillRunning 后脚本完成 - continueRun - resolve ok', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			// 总时长约 1s 的打点任务,窗口 700ms → 先 stillRunning 再完成
			code: `for (let i = 0; i < 4; i++) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 250) {} } 'done'`,
			args: [], allowedDirs: [], timeoutMs: 700,
		});
		expect(out1.status).toBe('stillRunning');
		const out2 = await sandbox.continueRun();
		expect(out2).toEqual({ status: 'ok', result: '"done"' });
	});

	it('stillRunning 后 killRun - killed 且 worker 已 terminate', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			// forever-progress:持续打点永不结束
			code: `for (;;) { reportProgress('forever'); const t = Date.now(); while (Date.now() - t < 100) {} }`,
			args: [], allowedDirs: [], timeoutMs: 400,
		});
		expect(out1.status).toBe('stillRunning');
		expect(await sandbox.killRun()).toEqual({ status: 'killed' });
		// worker 已 terminate、pending 已清:后续操作均 noRunning
		expect(await sandbox.continueRun()).toEqual({ status: 'noRunning' });
		expect(await sandbox.killRun()).toEqual({ status: 'noRunning' });
	});

	it('零心跳 + 窗口到点 - timeout/stalled - worker 已 terminate', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `while (true) { }`, args: [], allowedDirs: [], timeoutMs: 300 });
		// vm 单线程死循环发不出任何消息 → 无心跳判卡死(ADR-017 §3「死」)
		expect(out).toEqual({ status: 'timeout', kind: 'stalled', hadProgress: false });
	});

	it('中途停跳(先打点后死循环)- stalled 巡检停跳满窗口即杀 - 不等重置后的 window', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		// 打点一次后死循环:窗口到点时"停跳未满窗口"→ stillRunning
		const out1 = await sandbox.run({
			code: `const s = Date.now(); while (Date.now() - s < 200) {} reportProgress('once'); while (true) { }`,
			args: [], allowedDirs: [], timeoutMs: 1_000,
		});
		expect(out1.status).toBe('stillRunning');
		// 停跳窗口过半后续等:重置后的 window 在 +1000ms,巡检杀点在 lastBeat+1000ms(更早)
		await new Promise((r) => setTimeout(r, 500));
		const start = Date.now();
		const out2 = await sandbox.continueRun();
		expect(out2).toEqual({ status: 'timeout', kind: 'stalled', hadProgress: true });
		// 早于重置窗口(1000ms)返回,证明是巡检判死而非 window 到点
		expect(Date.now() - start).toBeLessThan(900);
	});

	it('continueRun 多轮 - 连续超时再 stillRunning - 最终完成 ok', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			// 总时长约 1.4s 的打点任务,窗口 600ms → 两轮 stillRunning 后完成
			code: `for (let i = 0; i < 7; i++) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 200) {} } 'done'`,
			args: [], allowedDirs: [], timeoutMs: 600,
		});
		expect(out1.status).toBe('stillRunning');
		const out2 = await sandbox.continueRun();
		expect(out2.status).toBe('stillRunning');
		const out3 = await sandbox.continueRun();
		expect(out3).toEqual({ status: 'ok', result: '"done"' });
	});

	it('绝对上限 - 累计超 maxRunMs - maxDuration 击杀且 continue 不重置计时', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			code: `for (;;) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 100) {} }`,
			args: [], allowedDirs: [], timeoutMs: 400, maxRunMs: 1_100,
		});
		expect(out1.status).toBe('stillRunning');
		const out2 = await sandbox.continueRun();
		expect(out2.status).toBe('stillRunning');
		// 若 continueRun 重置计时,此处应仍 stillRunning;累计口径下第三轮到 1100ms → maxDuration
		const out3 = await sandbox.continueRun();
		expect(out3).toEqual({ status: 'timeout', kind: 'maxDuration', hadProgress: true });
	});

	it('pending 存在时新 run - 隐含终止旧脚本 - 新脚本正常执行', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			code: `for (;;) { reportProgress('forever'); const t = Date.now(); while (Date.now() - t < 100) {} }`,
			args: [], allowedDirs: [], timeoutMs: 400,
		});
		expect(out1.status).toBe('stillRunning');
		const out2 = await sandbox.run({ code: `'fresh'`, args: [], allowedDirs: [], timeoutMs: 5_000 });
		expect(out2).toEqual({ status: 'ok', result: '"fresh"' });
		// 旧 pending 已被隐含终止清理:后续 continueRun 无可等待对象
		expect(await sandbox.continueRun()).toEqual({ status: 'noRunning' });
	});

	it('continueRun/killRun - 无 pending - noRunning 不抛错', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		expect(await sandbox.continueRun()).toEqual({ status: 'noRunning' });
		expect(await sandbox.killRun()).toEqual({ status: 'noRunning' });
	});

	it('terminateAll - pending 挂起中 unload - deferred 被 resolve 不悬空', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out1 = await sandbox.run({
			code: `for (;;) { reportProgress('forever'); const t = Date.now(); while (Date.now() - t < 100) {} }`,
			args: [], allowedDirs: [], timeoutMs: 400,
		});
		expect(out1.status).toBe('stillRunning');
		const pending = sandbox.continueRun();
		sandbox.terminateAll();
		expect(await pending).toEqual({ status: 'killed' });
	});
});

// ==================== 浏览器 Worker 适配(Obsidian 渲染进程路径) ====================

/**
 * 浏览器 Worker 协议桩 — addEventListener / MessageEvent 风格,
 * 模拟 Obsidian Electron 渲染进程的 Web Worker(nodeIntegrationInWorker)消息边界。
 * 关键路径:Obsidian 里 node:worker_threads 不可用(V8 platform 限制),生产走浏览器 Worker;
 * 此桩钉住 wrapBrowserWorker 的协议胶水(e.data 解包 / error 映射 / 终态回收)。
 */
class FakeBrowserWorker {
	private listeners = new Map<string, Array<(e: unknown) => void>>();
	posted: unknown[] = [];
	terminated = false;
	addEventListener(type: string, cb: (e: unknown) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(cb);
		this.listeners.set(type, list);
	}
	postMessage(msg: unknown) {
		this.posted.push(msg);
	}
	terminate() {
		this.terminated = true;
	}
	/** 测试驱动:以浏览器事件语义派发(worker → 主线程);message 包 MessageEvent.data,error 裸载荷 */
	emit(type: 'message' | 'error', payload: unknown) {
		for (const cb of this.listeners.get(type) ?? []) {
			cb(type === 'message' ? { data: payload } : payload);
		}
	}
}

describe('SkillScriptSandbox 浏览器 Worker 适配(Obsidian 渲染进程路径)', () => {
	it('浏览器协议 - message 解包 e.data - done 正常返回 - 终态后 worker 被 terminate 回收', async () => {
		const fake = new FakeBrowserWorker();
		const sandbox = new SkillScriptSandbox('code', () => wrapBrowserWorker(fake as unknown as Worker));
		const pending = sandbox.run({ code: 'x', args: [], allowedDirs: [], timeoutMs: 5_000 });
		// 让 run 的微任务链先跑:postMessage({type:'run'}) 已发出
		await new Promise((r) => setTimeout(r, 0));
		expect(fake.posted[0]).toMatchObject({ type: 'run', code: 'x' });
		fake.emit('message', { type: 'done', result: { ok: true, result: '"ok"' } });
		expect(await pending).toEqual({ status: 'ok', result: '"ok"' });
		// 关键路径(修复):一次性 worker 终态必须 terminate,否则线程闲置泄漏
		expect(fake.terminated).toBe(true);
	});

	it('浏览器协议 - progress 心跳更新 lastProgress - error 事件映射 crashed', async () => {
		const fake = new FakeBrowserWorker();
		const sandbox = new SkillScriptSandbox('code', () => wrapBrowserWorker(fake as unknown as Worker));
		// 关键路径:窗口 300ms,发完心跳即到点 → stillRunning(不真等 5s)
		const pending = sandbox.run({ code: 'x', args: [], allowedDirs: [], timeoutMs: 300 });
		await new Promise((r) => setTimeout(r, 0));
		fake.emit('message', { type: 'progress', message: '已处理 3/45' });
		// 窗口到点(有心跳)→ stillRunning,worker 不 terminate
		fake.emit('message', { type: 'progress', message: '已处理 4/45' });
		const out = await pending;
		expect(out.status).toBe('stillRunning');
		if (out.status !== 'stillRunning') return;
		expect(out.lastProgress).toBe('已处理 4/45');
		expect(fake.terminated).toBe(false);
		// 挂起中 error → crashed 且 worker 回收
		const next = sandbox.continueRun();
		fake.emit('error', { message: 'harness boom' });
		await expect(next).resolves.toMatchObject({ status: 'crashed', detail: 'harness boom' });
		expect(fake.terminated).toBe(true);
	});
});

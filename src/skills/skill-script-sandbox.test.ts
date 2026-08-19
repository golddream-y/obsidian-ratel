/**
 * @file src/skills/skill-script-sandbox.test.ts
 * @description SkillScriptSandbox 测试 — 真实 worker_threads:协议 / 死循环击杀 / 串行 / exit 兜底
 * @module skills/skill-script-sandbox.test
 * @depends esbuild(仅测试内现场打包,write:false)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { SkillScriptSandbox } from './skill-script-sandbox';

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

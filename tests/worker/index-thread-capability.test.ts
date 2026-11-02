/**
 * @file tests/worker/index-thread-capability.test.ts
 * @description T0 真线程能力与主线程阻塞探针 — 子线程身份、文件提交、探针自检与对照读数
 * @module tests/worker/index-thread-capability
 *
 * 关键路径:
 * - 断言的是**真实线程身份**（isMainThread=false、threadId>0），不是「await 一个异步函数就算迁移」。
 * - 探针必须先检出人为注入的 300 ms 长任务；否则它给出的低阻塞读数不可信。
 * - 同一份整库 JSON 提交分别放在子线程与主线程：前者迟到量应远小于后者，这是方向有效的证据。
 * - 阈值取宽松量级，只判断「是否隔离」与「是否检出」，不充当性能验收。
 */

import { describe, expect, it } from 'vitest';
import {
	commitJsonOnMainThread,
	measureMainThreadStall,
	probeSelfCheck,
	runInChildThread,
} from '../helpers/index-thread-capability';

const DOCS = 4000;
const DIMS = 512;

describe('T0 真线程能力', () => {
	it('子线程身份 - 不是主线程 - 具备独立 threadId', async () => {
		const result = await runInChildThread({ kind: 'identity' });
		expect(result.isMainThread).toBe(false);
		expect(result.threadId).toBeGreaterThan(0);
	});

	it('子线程提交整库 JSON - 写入并 fsync 成功 - 体积与文档数一致', async () => {
		const result = await runInChildThread({ kind: 'json-commit', docs: 200, dims: 32 });
		expect(result.docs).toBe(200);
		expect(result.bytes).toBeGreaterThan(200 * 32);
	});

	it('探针自检 - 注入 300ms 主线程长任务 - 如实检出同量级迟到', async () => {
		const stall = await probeSelfCheck(300);
		expect(stall.maxGapMs).toBeGreaterThanOrEqual(250);
		expect(stall.samples).toBeGreaterThan(0);
	});

	it('同一份大提交 - 子线程期间主线程迟到远小于主线程直跑 - 证明隔离有效', async () => {
		const onThread = await measureMainThreadStall(() =>
			runInChildThread({ kind: 'json-commit', docs: DOCS, dims: DIMS }),
		);
		const onMain = await measureMainThreadStall(() => commitJsonOnMainThread(DOCS, DIMS));

		const threadResult = onThread.value as { bytes: number };
		const mainResult = onMain.value as { bytes: number };
		// 同数据同序列化口径，体积必须一致，排除两边造了不同负载。
		expect(threadResult.bytes).toBe(mainResult.bytes);

		// 主线程直跑必须出现可观测阻塞；子线程期间主线程应保持低迟到。
		expect(onMain.stall.maxGapMs).toBeGreaterThanOrEqual(50);
		expect(onThread.stall.maxGapMs).toBeLessThan(onMain.stall.maxGapMs);
		expect(onThread.stall.maxGapMs).toBeLessThanOrEqual(120);
	});
});

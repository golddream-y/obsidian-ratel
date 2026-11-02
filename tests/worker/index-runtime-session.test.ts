/**
 * @file tests/worker/index-runtime-session.test.ts
 * @description 索引会话 — 打开、单文件提交、旧块替换、推理失败保留与关闭语义
 * @module tests/worker/index-runtime-session
 *
 * 关键路径:用真实 Vectra 存储与真实临时目录,只把嵌入换成可控替身;
 * 断言落在「块数变化」而不是「调用过某个方法」,确保替换语义真的生效。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import type { RuntimeHandlerContext } from '../../src/worker/index-runtime-worker';

const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };
const DIMENSIONS = 8;

/** 超过单个块预算的长正文,保证切出多块。 */
const LONG_TEXT = Array.from({ length: 5 }, (_, index) => `段落${index}`.repeat(80)).join('\n');

/** 可控嵌入通道。 */
function makeContext(options: { fail?: boolean } = {}): { ctx: RuntimeHandlerContext; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		ctx: {
			async callHost(_method, payload) {
				const texts = (payload as { texts?: string[] }).texts ?? [];
				calls.push(texts);
				if (options.fail === true) throw new Error('模型未就绪');
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		},
	};
}

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-session-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('索引会话', () => {
	it('未打开 - 状态与写入都拒绝 - 不隐式建库', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await expect(handlers['session.status']!({})).rejects.toThrow('尚未打开');
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: 'x' }, makeContext().ctx)).rejects.toThrow('尚未打开');
	});

	it('打开后写入一篇 - 块落盘 - 状态可读', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const result = await handlers['session.upsertFile']!({ path: 'a.md', content: '第一段\n第二段' }, makeContext().ctx) as { chunkCount: number };
		expect(result.chunkCount).toBeGreaterThan(0);
		const status = await handlers['session.status']!({}) as { totalDocs: number; written: number };
		expect(status.totalDocs).toBe(result.chunkCount);
		expect(status.written).toBe(1);
	});

	it('同路径内容变短 - 旧块被替换 - 不残留幽灵块', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const ctx = makeContext().ctx;
		const first = await handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, ctx) as { chunkCount: number };
		const second = await handlers['session.upsertFile']!({ path: 'a.md', content: '一' }, ctx) as { chunkCount: number };
		expect(first.chunkCount).toBeGreaterThan(1);
		expect(second.chunkCount).toBeLessThan(first.chunkCount);
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(second.chunkCount);
	});

	it('嵌入失败 - 旧版本完整保留 - 错误如实抛出', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, makeContext().ctx);
		const before = (await handlers['session.status']!({}) as { totalDocs: number }).totalDocs;
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, makeContext({ fail: true }).ctx))
			.rejects.toThrow('模型未就绪');
		const after = (await handlers['session.status']!({}) as { totalDocs: number }).totalDocs;
		expect(after).toBe(before);
	});

	it('删除文件 - 块清零 - 其他文件不受影响', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const ctx = makeContext().ctx;
		await handlers['session.upsertFile']!({ path: 'a.md', content: '一' }, ctx);
		const b = await handlers['session.upsertFile']!({ path: 'b.md', content: '二\n三' }, ctx) as { chunkCount: number };
		await handlers['session.deleteFile']!({ path: 'a.md' });
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(b.chunkCount);
	});

	it('关闭后写入 - 明确拒绝 - 不写半份内容', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.close']!({});
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: 'x' }, makeContext().ctx)).rejects.toThrow('尚未打开');
	});

	it('嵌入条数与块数不一致 - 拒绝提交 - 不留半份', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const bad: RuntimeHandlerContext = { callHost: async () => [[0.1]] };
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, bad)).rejects.toThrow('不一致');
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(0);
	});
});

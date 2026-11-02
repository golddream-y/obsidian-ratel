/**
 * @file tests/worker/index-runtime-entry.test.ts
 * @description Worker 入口 — init 握手、只读守卫与读写服务
 * @module tests/worker/index-runtime-entry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guardReadOnly, isInitMessage, startIndexRuntimeWorker } from '../../src/worker/index-runtime-entry';
import type { RuntimeFileSystem } from '../../src/worker/index-runtime-fs-handlers';

/** 记录出站消息的假作用域。 */
function makeScope(): { scope: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null }; out: Array<Record<string, unknown>> } {
	const out: Array<Record<string, unknown>> = [];
	return { scope: { postMessage: (message) => out.push(message as Record<string, unknown>), onmessage: null }, out };
}

/** 真实临时目录文件系统。 */
function makeFs(): RuntimeFileSystem {
	return {
		readFile: (target) => fsp.readFile(target, 'utf8'),
		writeFile: async (target, data) => { await fsp.writeFile(target, data, 'utf8'); },
		rename: (from, to) => fsp.rename(from, to),
		stat: async (target) => {
			try {
				const stats = await fsp.stat(target);
				return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
			} catch { return null; }
		},
		readdir: (target) => fsp.readdir(target),
		mkdir: async (target) => { await fsp.mkdir(target, { recursive: true }); },
		remove: (target, recursive) => fsp.rm(target, { recursive, force: true }),
	};
}

/** 一条协议请求。 */
function request(runtimeId: string, method: string, payload?: unknown, requestId = 'r1'): Record<string, unknown> {
	return { kind: 'request', protocolVersion: 1, runtimeId, epoch: 1, requestId, method, payload };
}

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-entry-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('索引 Worker 入口', () => {
	it('init 之前的请求 - 一律忽略 - 不回帧', async () => {
		const { scope, out } = makeScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: request('rt-1', 'ping') });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(out).toHaveLength(0);
		expect(entry.server()).toBeNull();
	});

	it('init 之后 - ping 得到 pong', async () => {
		const { scope, out } = makeScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-write' } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'ping') });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ kind: 'response', ok: true, result: 'pong' });
	});

	it('只读模式 - 读取可用 - 写入被拒绝', async () => {
		const { scope, out } = makeScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		await fsp.writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-only' } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'fs.read', { path: 'a.txt' }, 'r1') });
		scope.onmessage?.({ data: request('rt-1', 'fs.write', { path: 'b.txt', data: 'y' }, 'r2') });
		await vi.waitFor(() => expect(out).toHaveLength(2));
		expect(out.find((m) => m.requestId === 'r1')).toMatchObject({ ok: true, result: { data: 'x' } });
		expect(out.find((m) => m.requestId === 'r2')).toMatchObject({ ok: false });
		await expect(fsp.access(path.join(root, 'b.txt'))).rejects.toThrow();
	});

	it('读写模式 - 写入落盘', async () => {
		const { scope, out } = makeScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-write' } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'fs.write', { path: 'c.txt', data: 'z' }) });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ ok: true });
		await expect(fsp.readFile(path.join(root, 'c.txt'), 'utf8')).resolves.toBe('z');
	});

	it('init 帧校验 - 字段缺失或访问模式非法即拒绝', () => {
		expect(isInitMessage({ kind: 'init', runtimeId: 'r', epoch: 1, root: '/x', access: 'read-write' })).toBe(true);
		expect(isInitMessage({ kind: 'init', runtimeId: 'r', epoch: 1, root: '/x', access: 'admin' })).toBe(false);
		expect(isInitMessage({ kind: 'init', root: '/x', access: 'read-write' })).toBe(false);
		expect(isInitMessage({ kind: 'request' })).toBe(false);
	});

	it('只读守卫 - 写方法全部拒绝 - 读方法原样保留', async () => {
		const guarded = guardReadOnly({ 'fs.read': () => 'ok', 'fs.write': () => 'bad' });
		expect(guarded['fs.read']!({})).toBe('ok');
		expect(() => guarded['fs.write']!({})).toThrow('只读运行时拒绝写入');
	});
});

/** 自动应答嵌入请求的假作用域。 */
function makeEmbedScope(): {
	scope: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null };
	out: Array<Record<string, unknown>>;
} {
	const out: Array<Record<string, unknown>> = [];
	const scope: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null } = {
		postMessage: (message) => {
			out.push(message as Record<string, unknown>);
			const frame = message as { kind?: string; callId?: string; payload?: { texts?: string[] } };
			if (frame.kind !== 'call' || frame.callId === undefined) return;
			const texts = frame.payload?.texts ?? [];
			void Promise.resolve().then(() => {
				scope.onmessage?.({
					data: {
						kind: 'call-result', protocolVersion: 1, runtimeId: 'rt-1', epoch: 1,
						callId: frame.callId, ok: true,
						result: texts.map(() => Array.from({ length: 8 }, () => 0.1)),
					},
				});
			});
		},
		onmessage: null,
	};
	return { scope, out };
}


describe('入口装配索引会话', () => {
	it('读写模式 - 会话打开并写入 - 状态反映真实块数', async () => {
		const { scope, out } = makeEmbedScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-write', chunkOptions: { maxTokens: 500, overlapTokens: 100 } } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'session.open', {}, 'r1') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r1')).toBe(true));
		expect(out.find((m) => m.requestId === 'r1')).toMatchObject({ ok: true });

		scope.onmessage?.({ data: request('rt-1', 'session.upsertFile', { path: 'a.md', content: '一段正文' }, 'r2') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r2')).toBe(true), { timeout: 5000 });
		const written = out.find((m) => m.requestId === 'r2') as { ok: boolean; result: { chunkCount: number } };
		expect(written.ok).toBe(true);
		expect(written.result.chunkCount).toBeGreaterThan(0);

		scope.onmessage?.({ data: request('rt-1', 'session.status', {}, 'r3') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r3')).toBe(true));
		expect(out.find((m) => m.requestId === 'r3')).toMatchObject({ ok: true, result: { totalDocs: written.result.chunkCount } });
	});

	it('只读模式 - 不装配会话入口 - 写入请求被拒', async () => {
		const { scope, out } = makeEmbedScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-only' } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'session.open', {}, 'r1') });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ ok: false });
		expect(String(out[0]?.error)).toContain('未知方法');
	});
});

describe('撤销时的会话收尾', () => {
	it('撤销后 - 会话写入被拒绝 - 不再产生新块', async () => {
		const { scope, out } = makeEmbedScope();
		const entry = startIndexRuntimeWorker({ scope, fsOverride: makeFs() });
		scope.onmessage?.({ data: { kind: 'init', runtimeId: 'rt-1', epoch: 1, root, access: 'read-write', chunkOptions: { maxTokens: 500, overlapTokens: 100 } } });
		await entry.ready;
		scope.onmessage?.({ data: request('rt-1', 'session.open', {}, 'r1') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r1')).toBe(true));

		scope.onmessage?.({ data: { kind: 'control', protocolVersion: 1, runtimeId: 'rt-1', epoch: 1, control: 'revoke', reason: '用户暂停' } });
		await vi.waitFor(() => expect(out.some((m) => m.control === 'revoked-and-drained')).toBe(true));

		scope.onmessage?.({ data: request('rt-1', 'session.upsertFile', { path: 'a.md', content: '正文' }, 'r2') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r2')).toBe(true));
		expect(out.find((m) => m.requestId === 'r2')).toMatchObject({ ok: false });
	});
});

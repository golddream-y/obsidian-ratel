/**
 * @file tests/worker/index-runtime-worker.test.ts
 * @description 运行时服务循环 — 请求应答、未知方法、重复请求、撤销与取消确认
 * @module tests/worker/index-runtime-worker
 */

import { describe, expect, it, vi } from 'vitest';
import { serveRuntime, type RuntimeServerPort } from '../../src/worker/index-runtime-worker';
import { INDEX_RUNTIME_PROTOCOL_VERSION } from '../../src/worker/index-runtime-protocol';

const GRANT = { runtimeId: 'rt-1', epoch: 1 };

/** 记录出站消息的假端口。 */
function makePort(): { port: RuntimeServerPort; out: Array<Record<string, unknown>> } {
	const out: Array<Record<string, unknown>> = [];
	return { port: { postMessage: (message) => out.push(message as Record<string, unknown>), onmessage: null }, out };
}

/** 构造一条请求。 */
function request(method: string, payload?: unknown, requestId = 'r1'): Record<string, unknown> {
	return {
		kind: 'request',
		protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
		runtimeId: GRANT.runtimeId,
		epoch: GRANT.epoch,
		requestId,
		method,
		payload,
	};
}

describe('索引运行时服务循环', () => {
	it('正常请求 - 返回一次成功终态', async () => {
		const { port, out } = makePort();
		serveRuntime({ port, grant: GRANT, handlers: { ping: () => 'pong' } });
		port.onmessage?.({ data: request('ping') });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ kind: 'response', requestId: 'r1', ok: true, result: 'pong' });
	});

	it('未知方法 - 立即失败 - 不留悬挂请求', async () => {
		const { port, out } = makePort();
		serveRuntime({ port, grant: GRANT, handlers: {} });
		port.onmessage?.({ data: request('nope') });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ ok: false });
		expect(String(out[0]?.error)).toContain('未知方法');
	});

	it('处理器抛错 - 转成失败终态 - 不泄漏异常', async () => {
		const { port, out } = makePort();
		serveRuntime({ port, grant: GRANT, handlers: { boom: () => { throw new Error('坏了'); } } });
		port.onmessage?.({ data: request('boom') });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ ok: false, error: '坏了' });
	});

	it('身份或 epoch 不符 - 直接忽略 - 不回帧', async () => {
		const { port, out } = makePort();
		serveRuntime({ port, grant: GRANT, handlers: { ping: () => 'pong' } });
		port.onmessage?.({ data: { ...request('ping'), runtimeId: 'other' } });
		port.onmessage?.({ data: { ...request('ping'), epoch: 9 } });
		port.onmessage?.({ data: { ...request('ping'), protocolVersion: 99 } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(out).toHaveLength(0);
	});

	it('撤销 - 拒绝后续请求 - 回报已排空', async () => {
		const { port, out } = makePort();
		const server = serveRuntime({ port, grant: GRANT, handlers: { ping: () => 'pong' } });
		port.onmessage?.({ data: { ...request('revoke'), kind: 'control', control: 'revoke', reason: 'user' } });
		await vi.waitFor(() => expect(out.some((m) => m.control === 'revoked-and-drained')).toBe(true));
		expect(server.revoked).toBe(true);
		port.onmessage?.({ data: request('ping', undefined, 'r2') });
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r2')).toBe(true));
		expect(out.find((m) => m.requestId === 'r2')).toMatchObject({ ok: false });
	});

	it('取消 - 回 cancel-ack - 供宿主归还配额', async () => {
		const { port, out } = makePort();
		serveRuntime({ port, grant: GRANT, handlers: { ping: () => 'pong' } });
		port.onmessage?.({ data: { kind: 'control', control: 'cancel', protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION, runtimeId: GRANT.runtimeId, epoch: 1, requestId: 'r7' } });
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(out[0]).toMatchObject({ control: 'cancel-ack', requestId: 'r7' });
	});

	it('撤销回调先收敛再回报 - 顺序可观测', async () => {
		const { port, out } = makePort();
		const order: string[] = [];
		serveRuntime({
			port,
			grant: GRANT,
			handlers: {},
			onRevoked: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push('closed');
			},
		});
		port.postMessage = ((postMessage) => (message: unknown) => {
			if ((message as { control?: string }).control === 'revoked-and-drained') order.push('drained');
			postMessage(message);
		})(port.postMessage);
		port.onmessage?.({ data: { kind: 'control', control: 'revoke', protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION, runtimeId: GRANT.runtimeId, epoch: 1 } });
		await vi.waitFor(() => expect(order).toEqual(['closed', 'drained']));
		expect(out.length).toBe(1);
	});
});

describe('反向调用宿主', () => {
	it('处理器调用宿主 - 拿到结果 - 超时不悬挂', async () => {
		const { port, out } = makePort();
		serveRuntime({
			port,
			grant: GRANT,
			handlers: {
				embed: async (payload, ctx) => {
					const vectors = await ctx!.callHost('embed', payload);
					return { count: Array.isArray(vectors) ? vectors.length : 0 };
				},
			},
		});
		port.onmessage?.({ data: request('embed', { texts: ['a', 'b'] }, 'r1') });
		await vi.waitFor(() => expect(out.some((m) => m.kind === 'call')).toBe(true));
		const call = out.find((m) => m.kind === 'call') as { callId: string };
		port.onmessage?.({
			data: {
				kind: 'call-result',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: GRANT.runtimeId,
				epoch: GRANT.epoch,
				callId: call.callId,
				ok: true,
				result: [[0.1], [0.2]],
			},
		});
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r1')).toBe(true));
		expect(out.find((m) => m.requestId === 'r1')).toMatchObject({ ok: true, result: { count: 2 } });
	});

	it('宿主调用失败 - 请求如实失败 - 不静默返回空', async () => {
		const { port, out } = makePort();
		serveRuntime({
			port,
			grant: GRANT,
			handlers: { embed: (_payload, ctx) => ctx!.callHost('embed', {}) },
		});
		port.onmessage?.({ data: request('embed', {}, 'r1') });
		await vi.waitFor(() => expect(out.some((m) => m.kind === 'call')).toBe(true));
		const call = out.find((m) => m.kind === 'call') as { callId: string };
		port.onmessage?.({
			data: {
				kind: 'call-result',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: GRANT.runtimeId,
				epoch: GRANT.epoch,
				callId: call.callId,
				ok: false,
				error: '模型未就绪',
			},
		});
		await vi.waitFor(() => expect(out.some((m) => m.requestId === 'r1')).toBe(true));
		expect(out.find((m) => m.requestId === 'r1')).toMatchObject({ ok: false, error: '模型未就绪' });
	});
});

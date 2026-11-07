/**
 * @file tests/worker/index-runtime-protocol.test.ts
 * @description 运行时协议 — 版本/身份校验、载荷计费与一次性结算
 * @module tests/worker/index-runtime-protocol
 */

import { describe, expect, it } from 'vitest';
import {
	INDEX_RUNTIME_PROTOCOL_VERSION,
	SettleOnce,
	estimatePayloadBytes,
	parseRuntimeMessage,
} from '../../src/worker/index-runtime-protocol';

const base = { protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION, runtimeId: 'rt-1', epoch: 1 };

describe('运行时协议', () => {
	it('合法请求/响应/控制 - 正确解析', () => {
		expect(parseRuntimeMessage({ ...base, kind: 'request', requestId: 'r1', method: 'ping' })).not.toBeNull();
		expect(parseRuntimeMessage({ ...base, kind: 'response', requestId: 'r1', ok: true })).not.toBeNull();
		expect(parseRuntimeMessage({ ...base, kind: 'control', control: 'revoke' })).not.toBeNull();
	});

	it('版本不符/缺身份/非法 epoch/未知控制 - 一律拒绝', () => {
		expect(parseRuntimeMessage({ ...base, protocolVersion: 99, kind: 'request', requestId: 'r1', method: 'x' })).toBeNull();
		expect(parseRuntimeMessage({ protocolVersion: 1, kind: 'request', requestId: 'r1', method: 'x', runtimeId: '', epoch: 1 })).toBeNull();
		expect(parseRuntimeMessage({ ...base, epoch: -1, kind: 'request', requestId: 'r1', method: 'x' })).toBeNull();
		expect(parseRuntimeMessage({ ...base, kind: 'control', control: 'explode' })).toBeNull();
		expect(parseRuntimeMessage('hello')).toBeNull();
		expect(parseRuntimeMessage(null)).toBeNull();
	});

	it('进度事件 - 合法时解析成功、缺 type 拒绝', () => {
		// 关键路径:事件不参与请求配对,但仍必须过校验 —— 漏掉分支会被静默丢弃,
		// 表现为「进度仍整批跳」而没有任何报错。
		const base = { protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION, runtimeId: 'rt-1', epoch: 1 };
		expect(parseRuntimeMessage({ ...base, kind: 'event', type: 'file-committed', payload: { path: 'a.md' } })).toMatchObject({ kind: 'event', type: 'file-committed' });
		expect(parseRuntimeMessage({ ...base, kind: 'event' })).toBeNull();
		expect(parseRuntimeMessage({ ...base, kind: 'event', type: '' })).toBeNull();
	});

	it('载荷按字符串长度与结构递归计费 - 大字符串明显更大', () => {
		expect(estimatePayloadBytes('abcd')).toBe(8);
		expect(estimatePayloadBytes({ text: 'abcd' })).toBeGreaterThan(8);
		expect(estimatePayloadBytes('x'.repeat(1000))).toBe(2000);
	});

	it('一次性结算 - 第二次调用不执行', () => {
		const guard = new SettleOnce();
		let calls = 0;
		expect(guard.settle(() => { calls += 1; })).toBe(true);
		expect(guard.settle(() => { calls += 1; })).toBe(false);
		expect(calls).toBe(1);
		expect(guard.isSettled).toBe(true);
	});
});

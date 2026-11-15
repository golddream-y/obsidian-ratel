/**
 * @file tests/settings/chat-headers.test.ts
 * @description 自定义请求头文本解析 — 合法行保留、非法行上报、大小写去重
 * @module tests/settings/chat-headers
 */

import { describe, expect, it } from 'vitest';
import { formatChatHeaders, parseChatHeaders } from '../../src/settings/chat-headers';

describe('自定义请求头解析', () => {
	it('标准行 - 解析出名称与值 - 顺序与输入一致', () => {
		const result = parseChatHeaders('x-opencode-session: abc123\nX-Tenant: t1');
		expect(result.headers).toEqual({ 'x-opencode-session': 'abc123', 'X-Tenant': 't1' });
		expect(result.invalidLines).toEqual([]);
	});

	it('空行与注释 - 被忽略 - 不计为非法行', () => {
		const result = parseChatHeaders('\n# 说明\nx-a: 1\n\n');
		expect(result.headers).toEqual({ 'x-a': '1' });
		expect(result.invalidLines).toEqual([]);
	});

	it('缺少冒号或空值 - 上报为非法行 - 不写入请求头', () => {
		const result = parseChatHeaders('x-bare\nx-empty:\nvalid: v');
		expect(result.headers).toEqual({ valid: 'v' });
		expect(result.invalidLines).toEqual(['x-bare', 'x-empty:']);
	});

	it('非法头名 - 上报为非法行 - 不进入请求头', () => {
		const result = parseChatHeaders('x bad: v\nx-ok: v');
		expect(result.headers).toEqual({ 'x-ok': 'v' });
		expect(result.invalidLines).toEqual(['x bad: v']);
	});

	it('大小写重复 - 后者覆盖 - 只保留一个键', () => {
		const result = parseChatHeaders('X-Session: first\nx-session: second');
		expect(Object.keys(result.headers)).toHaveLength(1);
		expect(Object.values(result.headers)).toEqual(['second']);
	});

	it('格式化 - 空值返回空串 - 有值逐行输出', () => {
		expect(formatChatHeaders(undefined)).toBe('');
		expect(formatChatHeaders({})).toBe('');
		expect(formatChatHeaders({ a: '1', b: '2' })).toBe('a: 1\nb: 2');
	});

	it('解析与格式化 - 往返一致 - 值中的冒号保留', () => {
		const text = 'x-url: https://example.com:8443/path';
		expect(formatChatHeaders(parseChatHeaders(text).headers)).toBe(text);
	});
});

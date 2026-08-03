/**
 * @file tests/adapters/mcp-stdio-framing.test.ts
 * @description stdio Content-Length / 换行分帧
 * @module tests/adapters/mcp-stdio-framing
 */

import { describe, it, expect } from 'vitest';
import {
	encodeContentLengthMessage,
	StdioFramingBuffer,
} from '../../src/adapters/mcp-stdio-framing';

describe('mcp-stdio-framing', () => {
	it('encodeContentLengthMessage - 生成 Content-Length 头', () => {
		const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
		const encoded = encodeContentLengthMessage(body);
		expect(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`)).toBe(
			true,
		);
		expect(encoded.endsWith(body)).toBe(true);
	});

	it('StdioFramingBuffer - Content-Length 完整帧 - 弹出消息', () => {
		const buf = new StdioFramingBuffer();
		const msg = '{"a":1}';
		const frame = encodeContentLengthMessage(msg);
		expect(buf.push(Buffer.from(frame, 'utf8'))).toEqual([msg]);
	});

	it('StdioFramingBuffer - 分两次到达 - 拼齐后弹出', () => {
		const buf = new StdioFramingBuffer();
		const frame = encodeContentLengthMessage('{"x":true}');
		const mid = Math.floor(frame.length / 2);
		expect(buf.push(Buffer.from(frame.slice(0, mid), 'utf8'))).toEqual([]);
		expect(buf.push(Buffer.from(frame.slice(mid), 'utf8'))).toEqual(['{"x":true}']);
	});

	it('StdioFramingBuffer - 无头时按行 JSON - 弹出一行', () => {
		const buf = new StdioFramingBuffer();
		expect(buf.push(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n', 'utf8'))).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{}}',
		]);
	});
});

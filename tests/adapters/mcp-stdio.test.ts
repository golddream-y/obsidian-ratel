/**
 * @file tests/adapters/mcp-stdio.test.ts
 * @description MCP stdio Transport（注入假 spawn）
 * @module tests/adapters/mcp-stdio
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { McpStdioTransport } from '../../src/adapters/mcp-stdio';
import { encodeContentLengthMessage } from '../../src/adapters/mcp-stdio-framing';

function mockChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdin = { write: vi.fn(), end: vi.fn() };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

describe('McpStdioTransport', () => {
	it('request - 写入 Content-Length 帧并解析响应', async () => {
		const child = mockChild();
		const spawn = vi.fn().mockReturnValue(child);
		const t = new McpStdioTransport({
			command: 'node',
			args: ['server.js'],
			env: {},
			spawnImpl: spawn as never,
		});
		await t.start();
		expect(spawn).toHaveBeenCalledWith(
			'node',
			['server.js'],
			expect.objectContaining({ shell: false }),
		);

		const p = t.request('initialize', { protocolVersion: '2024-11-05' });
		const resultBody = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'x', version: '0' },
			},
		});
		queueMicrotask(() => {
			child.stdout.emit('data', Buffer.from(encodeContentLengthMessage(resultBody), 'utf8'));
		});
		await expect(p).resolves.toMatchObject({ capabilities: { tools: {} } });
		expect(child.stdin.write).toHaveBeenCalled();
		await t.close();
		expect(child.kill).toHaveBeenCalled();
	});
});

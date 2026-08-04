/**
 * @file src/adapters/mcp-stdio.ts
 * @description MCP stdio Transport（child_process.spawn，shell: false）
 * @module adapters/mcp-stdio
 * @depends node:child_process, ./mcp-jsonrpc, ./mcp-stdio-framing
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpTransport } from '../ports/mcp';
import { MCP_DEFAULT_TIMEOUT_MS } from '../ports/mcp';
import { createJsonRpcRequest, parseJsonRpcResponse } from './mcp-jsonrpc';
import { encodeContentLengthMessage, StdioFramingBuffer } from './mcp-stdio-framing';
import { devLogger } from '../logging/dev-logger';

export type McpSpawnFn = (
	command: string,
	args: string[],
	options: {
		shell: false;
		env: NodeJS.ProcessEnv;
		stdio: ['pipe', 'pipe', 'pipe'];
	},
) => ChildProcessWithoutNullStreams;

export interface McpStdioTransportOptions {
	command: string;
	args: string[];
	env: Record<string, string>;
	timeoutMs?: number;
	/** 可注入：测试假 spawn；生产默认 child_process.spawn */
	spawnImpl?: McpSpawnFn;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	/** DOM lib 下 window.setTimeout 返回 number；兼容 popout */
	timer: number;
}

/**
 * 本地子进程 MCP Transport。
 *
 * 安全路径:
 * - 永远 shell: false
 * - 禁止把 env 值写入日志
 */
export class McpStdioTransport implements McpTransport {
	private readonly command: string;
	private readonly args: string[];
	private readonly env: Record<string, string>;
	private readonly timeoutMs: number;
	private readonly spawnImpl: McpSpawnFn;
	private child: ChildProcessWithoutNullStreams | null = null;
	private framing = new StdioFramingBuffer();
	private nextId = 1;
	private pending = new Map<number | string, Pending>();

	constructor(opts: McpStdioTransportOptions) {
		this.command = opts.command;
		this.args = opts.args;
		this.env = opts.env;
		this.timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
		this.spawnImpl = opts.spawnImpl ?? spawn;
	}

	async start(): Promise<void> {
		if (this.child) return;
		const child = this.spawnImpl(this.command, this.args, {
			shell: false,
			env: this.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.child = child;
		this.framing = new StdioFramingBuffer();

		child.stdout.on('data', (chunk: Buffer) => {
			const messages = this.framing.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			for (const msg of messages) this.onMessage(msg);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			const line = chunk.toString('utf8').slice(0, 500);
			devLogger.warn('mcp', `stdio stderr: ${line}`);
		});
		child.on('error', (err) => {
			devLogger.error('mcp', 'stdio 子进程错误', err);
			this.rejectAll(err instanceof Error ? err : new Error(String(err)));
		});
		child.on('exit', (code) => {
			this.rejectAll(new Error(`MCP stdio 进程退出 code=${code}`));
			this.child = null;
		});
	}

	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.child) throw new Error('MCP stdio Transport 未 start');
		const id = this.nextId++;
		const req = createJsonRpcRequest(id, method, params);
		const frame = encodeContentLengthMessage(JSON.stringify(req));

		return new Promise<unknown>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP stdio 超时: ${method}`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.child!.stdin.write(frame, 'utf8');
			} catch (err) {
				window.clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async close(): Promise<void> {
		this.rejectAll(new Error('MCP stdio 已关闭'));
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				// ignore
			}
			this.child = null;
		}
	}

	private onMessage(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			devLogger.warn('mcp', 'stdio 非法 JSON 行');
			return;
		}
		if (!parsed || typeof parsed !== 'object') return;
		const obj = parsed as { id?: number | string; method?: string };
		// 通知（无 id）忽略
		if (obj.id === undefined || obj.id === null) return;
		const pending = this.pending.get(obj.id);
		if (!pending) return;
		window.clearTimeout(pending.timer);
		this.pending.delete(obj.id);
		try {
			pending.resolve(parseJsonRpcResponse(parsed));
		} catch (err) {
			pending.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			window.clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}

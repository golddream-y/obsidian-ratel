# P-MCP-HOST-CORE — MCP Host 核心（Port + 双 Transport + 入册）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主线程落地 MCP Host：JSON-RPC + HTTP/stdio 双 Transport + Client + Host 编排，将 `tools/list` 结果以 `mcp__<server>__<tool>` 注册进 ToolRegistry；零配置时零出站。

**Architecture:** `McpHost` 按 `settings.mcpServers` 差分启停；每 Server 一个 `McpClient` 挂可替换 `McpTransport`；发现的工具经 `mcp-tool-bridge` 转成同形 `Tool` 入册。Agent Loop / 权限门不动。`syncToolDefinitions` 只更新内置工具名，不碰 MCP 前缀。

**Tech Stack:** TypeScript / Vitest / Obsidian `requestUrl` / Node `child_process.spawn`（`shell: false`）/ JSON-RPC 2.0

**Spec:** [S-MCP-HOST](../specs/2026-08-03-mcp-host-design.md) · **ADR:** [ADR-014](../../adr/2026-08-03-mcp-host-platform.md) · [ADR-015](../../adr/2026-08-03-capability-pool.md)

## Global Constraints

- 用户可见字符串本期 CORE **尽量少**（Notice 可暂用中文 `throw`/`devLogger`；UI 文案留给 P-MCP-HOST-UI 走 i18n）
- 测试 `it(...)` 描述中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出注释按 AGENTS.md 中文规范
- **禁止**裸 `fetch`；HTTP 仅 `requestUrl`
- **禁止** `shell: true`；stdio 必须 `shell: false`
- **禁止**把密钥写入 settings / 日志
- Worker / Embedding Worker **零改动、零 import MCP**
- **不改** Agent Loop 主结构、融合检索、MemoryStore
- 一期只做 Tools（list + call）；不做 Resources / Sampling / Roots / Prompts
- `MCP_PROTOCOL_VERSION = '2024-11-05'`（广泛兼容；写死常量）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ports/mcp.ts` | 新建：契约 + `McpServerConfig` + 常量 |
| `src/adapters/mcp-jsonrpc.ts` | 新建：请求/响应编解码、错误类 |
| `src/adapters/mcp-sse.ts` | 新建：从 SSE 文本提取 JSON-RPC result |
| `src/adapters/mcp-stdio-framing.ts` | 新建：Content-Length / 换行分帧纯函数 |
| `src/adapters/mcp-http.ts` | 新建：Streamable HTTP Transport |
| `src/adapters/mcp-stdio.ts` | 新建：stdio Transport（可注入 spawn） |
| `src/adapters/mcp-client.ts` | 新建：initialize / listTools / callTool |
| `src/core/mcp-tool-bridge.ts` | 新建：命名净化 + `Tool` 工厂 |
| `src/core/mcp-host.ts` | 新建：多 Server sync / dispose / 熔断 |
| `src/core/tool-registry.ts` | 改：`unregister` / `unregisterByPrefix` |
| `src/secrets/ratel-secrets.ts` | 改：`mcpSecretId` / `resolveMcpSecret` / `hasMcpSecret` |
| `src/logging/dev-logger.ts` | 改：`LogModule` 加 `'mcp'` |
| `src/settings.ts` | 改：`mcpServers` / `mcpApprovedSpawns` 字段 + 默认 `[]` |
| `src/prompts/composer.ts` | 改：`formatToolGuideList` 接受带 description 的工具，MCP 描述不丢 |
| `src/main.ts` | 改：持有 `mcpHost`；onload sync；onunload dispose；settings 变更触发 |
| `tests/core/tool-registry.test.ts` | 追加 unregister 用例 |
| `tests/adapters/mcp-jsonrpc.test.ts` | 新建 |
| `tests/adapters/mcp-sse.test.ts` | 新建 |
| `tests/adapters/mcp-stdio-framing.test.ts` | 新建 |
| `tests/core/mcp-tool-bridge.test.ts` | 新建 |
| `tests/adapters/mcp-client.test.ts` | 新建（假 Transport） |
| `tests/adapters/mcp-http.test.ts` | 新建（mock requestUrl） |
| `tests/core/mcp-host.test.ts` | 新建 |
| `tests/secrets/ratel-secrets.test.ts` | 追加 MCP secret |
| `tests/prompts/composer.test.ts` | 改 formatToolGuideList 签名相关断言 |
| `docs/superpowers/STATUS.md` | CORE 完成后改状态 |

**依赖 P-MCP-HOST-UI：** 设置页增删 Server、spawn 首次确认 Modal、动态权限列表、钥匙串 hint UI。CORE 可用测试直接构造 `McpServerConfig[]` 调 `sync`；`confirmSpawn` 以依赖注入回调形式预留（默认 always-true 或 always-false 由 Host 构造参数决定，UI plan 接真 Modal）。

---

### Task 1: Port 契约 + ToolRegistry unregister

**Files:**
- Create: `src/ports/mcp.ts`
- Modify: `src/core/tool-registry.ts`
- Modify: `src/logging/dev-logger.ts`（`LogModule` 加 `'mcp'`）
- Test: `tests/core/tool-registry.test.ts`

- [ ] **Step 1: 写失败测试（unregister）**

在 `tests/core/tool-registry.test.ts` 追加：

```typescript
it('unregister - 已注册工具 - 从 definitions 移除', () => {
	const registry = new ToolRegistry();
	registry.register(dummyTool);
	registry.unregister('test_tool');
	expect(registry.definitions()).toEqual([]);
});

it('unregister - 未注册 - 不抛错', () => {
	const registry = new ToolRegistry();
	expect(() => registry.unregister('missing')).not.toThrow();
});

it('unregisterByPrefix - 只删匹配前缀', () => {
	const registry = new ToolRegistry();
	registry.register(dummyTool);
	registry.register({
		definition: { name: 'mcp__tavily__search', description: 's', parameters: {} },
		execute: async () => 'ok',
	});
	registry.register({
		definition: { name: 'mcp__brave__search', description: 's', parameters: {} },
		execute: async () => 'ok',
	});
	registry.unregisterByPrefix('mcp__tavily__');
	expect(registry.definitions().map((d) => d.name).sort()).toEqual([
		'mcp__brave__search',
		'test_tool',
	]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/core/tool-registry.test.ts
```

Expected: FAIL（`unregister` 不存在）

- [ ] **Step 3: 实现 unregister + Port 文件**

`src/core/tool-registry.ts` 在 `register` 旁追加：

```typescript
/**
 * 按名称移除工具；不存在时静默忽略。
 *
 * @param name - 工具名
 */
unregister(name: string): void {
	this.tools.delete(name);
}

/**
 * 移除所有名称以 prefix 开头的工具（MCP Server 出册用）。
 *
 * @param prefix - 例如 `mcp__tavily__`
 */
unregisterByPrefix(prefix: string): void {
	for (const name of [...this.tools.keys()]) {
		if (name.startsWith(prefix)) this.tools.delete(name);
	}
}
```

创建 `src/ports/mcp.ts`：

```typescript
/**
 * @file src/ports/mcp.ts
 * @description MCP Host/Client/Transport 零实现契约与配置类型
 * @module ports/mcp
 */

/** 客户端声明的 MCP 协议版本（广泛兼容） */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** 默认初始化 / 单次 call 超时 */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/** 连续 call 失败多少次后熔断下线 */
export const MCP_CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * settings.json 中的 MCP Server 条目（无密钥明文）。
 */
export interface McpServerConfig {
	id: string;
	label: string;
	enabled: boolean;
	transport: 'http' | 'stdio';
	url?: string;
	command?: string;
	args?: string[];
	/** 额外注入的环境变量名；值运行时从钥匙串或空串解析，禁止写入 settings */
	envKeys?: string[];
	timeoutMs?: number;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	content: string;
	isError?: boolean;
}

export interface McpTransport {
	start(): Promise<void>;
	request(method: string, params?: unknown): Promise<unknown>;
	close(): Promise<void>;
}

export interface McpClientPort {
	readonly serverId: string;
	initialize(): Promise<void>;
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	close(): Promise<void>;
}

export type McpServerStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface McpHostPort {
	sync(servers: McpServerConfig[]): Promise<void>;
	getStatus(serverId: string): McpServerStatus;
	/** 停止单个 Server（设置页「停止」） */
	stop(serverId: string): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * 校验 Server id：小写字母开头，字母数字连字符，最长 32。
 */
export function isValidMcpServerId(id: string): boolean {
	return /^[a-z][a-z0-9-]{0,31}$/.test(id);
}

/**
 * 工具名前缀：`mcp__<serverId>__`
 */
export function mcpToolPrefix(serverId: string): string {
	return `mcp__${serverId}__`;
}
```

`src/logging/dev-logger.ts`：`LogModule` 联合类型追加 `'mcp'`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/core/tool-registry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ports/mcp.ts src/core/tool-registry.ts src/logging/dev-logger.ts tests/core/tool-registry.test.ts
git commit -m "feat(mcp): Port 契约 + ToolRegistry unregister"
```

---

### Task 2: JSON-RPC + SSE 解析纯函数

**Files:**
- Create: `src/adapters/mcp-jsonrpc.ts`
- Create: `src/adapters/mcp-sse.ts`
- Test: `tests/adapters/mcp-jsonrpc.test.ts`
- Test: `tests/adapters/mcp-sse.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/adapters/mcp-jsonrpc.test.ts`：

```typescript
/**
 * @file tests/adapters/mcp-jsonrpc.test.ts
 * @description MCP JSON-RPC 编解码单元测试
 * @module tests/adapters/mcp-jsonrpc
 */

import { describe, it, expect } from 'vitest';
import {
	createJsonRpcRequest,
	parseJsonRpcResponse,
	McpJsonRpcError,
} from '../../src/adapters/mcp-jsonrpc';

describe('mcp-jsonrpc', () => {
	it('createJsonRpcRequest - 生成带 id 的请求对象', () => {
		const req = createJsonRpcRequest(1, 'tools/list', {});
		expect(req).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {},
		});
	});

	it('parseJsonRpcResponse - 成功 result - 返回 result', () => {
		expect(parseJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toEqual({
			ok: true,
		});
	});

	it('parseJsonRpcResponse - error 字段 - 抛 McpJsonRpcError', () => {
		expect(() =>
			parseJsonRpcResponse({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32601, message: 'Method not found' },
			}),
		).toThrow(McpJsonRpcError);
	});

	it('parseJsonRpcResponse - 非法形状 - 抛错', () => {
		expect(() => parseJsonRpcResponse(null)).toThrow(/无效/);
	});
});
```

`tests/adapters/mcp-sse.test.ts`：

```typescript
/**
 * @file tests/adapters/mcp-sse.test.ts
 * @description SSE 文本中提取 JSON-RPC 响应
 * @module tests/adapters/mcp-sse
 */

import { describe, it, expect } from 'vitest';
import { extractJsonRpcFromSse } from '../../src/adapters/mcp-sse';

describe('mcp-sse', () => {
	it('extractJsonRpcFromSse - 单 data 行 - 解析 JSON', () => {
		const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
		expect(extractJsonRpcFromSse(body)).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { tools: [] },
		});
	});

	it('extractJsonRpcFromSse - 多 data 拼行 - 合并解析', () => {
		const body =
			'data: {"jsonrpc":"2.0","id":2,\n' +
			'data: "result":{"ok":true}}\n\n';
		// 关键路径:部分网关把 JSON 拆多行 data；实现应按事件块拼接后再 JSON.parse
		expect(extractJsonRpcFromSse(body)).toEqual({
			jsonrpc: '2.0',
			id: 2,
			result: { ok: true },
		});
	});

	it('extractJsonRpcFromSse - 无 data - 抛错', () => {
		expect(() => extractJsonRpcFromSse('event: ping\n\n')).toThrow(/SSE/);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/adapters/mcp-jsonrpc.test.ts tests/adapters/mcp-sse.test.ts
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/adapters/mcp-jsonrpc.ts`：

```typescript
/**
 * @file src/adapters/mcp-jsonrpc.ts
 * @description MCP JSON-RPC 2.0 请求构造与响应解析
 * @module adapters/mcp-jsonrpc
 */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
}

export class McpJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = 'McpJsonRpcError';
		this.code = code;
		this.data = data;
	}
}

export function createJsonRpcRequest(
	id: number | string,
	method: string,
	params?: unknown,
): JsonRpcRequest {
	const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
	if (params !== undefined) req.params = params;
	return req;
}

/**
 * 解析 JSON-RPC 响应对象；成功返回 result，错误抛 McpJsonRpcError。
 */
export function parseJsonRpcResponse(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object') {
		throw new Error('MCP JSON-RPC 响应无效');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.error && typeof obj.error === 'object') {
		const err = obj.error as { code?: number; message?: string; data?: unknown };
		throw new McpJsonRpcError(
			typeof err.code === 'number' ? err.code : -32000,
			err.message ?? 'MCP 错误',
			err.data,
		);
	}
	if (!('result' in obj)) {
		throw new Error('MCP JSON-RPC 响应缺少 result');
	}
	return obj.result;
}
```

`src/adapters/mcp-sse.ts`：

```typescript
/**
 * @file src/adapters/mcp-sse.ts
 * @description 从 SSE 响应体提取 JSON-RPC 消息
 * @module adapters/mcp-sse
 */

/**
 * 取第一个含 data 的事件块，拼接 data 行后 JSON.parse。
 *
 * @param body - 原始 SSE 文本
 * @returns 解析后的对象（通常为 JSON-RPC Response）
 * @throws 无可用 data 或 JSON 非法
 */
export function extractJsonRpcFromSse(body: string): unknown {
	const blocks = body.replace(/\r\n/g, '\n').split('\n\n');
	for (const block of blocks) {
		const dataLines: string[] = [];
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).replace(/^ /, ''));
			}
		}
		if (dataLines.length === 0) continue;
		const text = dataLines.join('');
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error('MCP SSE data 不是合法 JSON');
		}
	}
	throw new Error('MCP SSE 响应无 data 事件');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/adapters/mcp-jsonrpc.test.ts tests/adapters/mcp-sse.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp-jsonrpc.ts src/adapters/mcp-sse.ts tests/adapters/mcp-jsonrpc.test.ts tests/adapters/mcp-sse.test.ts
git commit -m "feat(mcp): JSON-RPC 编解码与 SSE 提取"
```

---

### Task 3: stdio 分帧纯函数

**Files:**
- Create: `src/adapters/mcp-stdio-framing.ts`
- Test: `tests/adapters/mcp-stdio-framing.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
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
```

- [ ] **Step 2: 跑测确认失败 → Step 3 实现**

`src/adapters/mcp-stdio-framing.ts`：

```typescript
/**
 * @file src/adapters/mcp-stdio-framing.ts
 * @description MCP stdio 分帧：Content-Length（优先）+ 换行 JSON 回退
 * @module adapters/mcp-stdio-framing
 */

export function encodeContentLengthMessage(body: string): string {
	const len = Buffer.byteLength(body, 'utf8');
	return `Content-Length: ${len}\r\n\r\n${body}`;
}

/**
 * 增量缓冲：优先解析 LSP 风格帧；若缓冲以 `{` 开头且含换行，按行尝试 JSON。
 */
export class StdioFramingBuffer {
	private buffer = Buffer.alloc(0);

	/**
	 * @param chunk - 新到的 stdout 字节
	 * @returns 本轮解析出的完整消息字符串列表
	 */
	push(chunk: Buffer): string[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const out: string[] = [];
		while (true) {
			const msg = this.tryReadOne();
			if (msg === null) break;
			out.push(msg);
		}
		return out;
	}

	private tryReadOne(): string | null {
		const headerEnd = indexOfHeaderEnd(this.buffer);
		if (headerEnd !== -1) {
			const header = this.buffer.subarray(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// 坏头：丢弃到 headerEnd 之后继续
				this.buffer = this.buffer.subarray(headerEnd + 4);
				return null;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4; // \r\n\r\n
			if (this.buffer.length < bodyStart + length) return null;
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
			this.buffer = this.buffer.subarray(bodyStart + length);
			return body;
		}

		// 回退：整行 JSON
		const nl = this.buffer.indexOf(0x0a);
		if (nl === -1) return null;
		const line = this.buffer.subarray(0, nl).toString('utf8').replace(/\r$/, '');
		this.buffer = this.buffer.subarray(nl + 1);
		const trimmed = line.trim();
		if (!trimmed) return this.tryReadOne();
		if (trimmed.startsWith('{')) return trimmed;
		return this.tryReadOne();
	}
}

function indexOfHeaderEnd(buf: Buffer): number {
	const s = buf.toString('utf8');
	const idx = s.indexOf('\r\n\r\n');
	return idx === -1 ? -1 : Buffer.byteLength(s.slice(0, idx), 'utf8');
}
```

注意：`indexOfHeaderEnd` 用字符串找 `\r\n\r\n` 再换算字节偏移，对纯 ASCII 头安全。

- [ ] **Step 4: PASS → Step 5: Commit**

```bash
git add src/adapters/mcp-stdio-framing.ts tests/adapters/mcp-stdio-framing.test.ts
git commit -m "feat(mcp): stdio Content-Length / 换行分帧"
```

---

### Task 4: mcp-tool-bridge（命名 + Tool 工厂）

**Files:**
- Create: `src/core/mcp-tool-bridge.ts`
- Test: `tests/core/mcp-tool-bridge.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/core/mcp-tool-bridge.test.ts
 * @description MCP 工具 → ToolRegistry Tool 桥接
 * @module tests/core/mcp-tool-bridge
 */

import { describe, it, expect, vi } from 'vitest';
import { sanitizeMcpToolName, buildMcpRegistryName, createMcpTool } from '../../src/core/mcp-tool-bridge';
import type { McpClientPort } from '../../src/ports/mcp';

describe('mcp-tool-bridge', () => {
	it('sanitizeMcpToolName - 非法字符替换为下划线', () => {
		expect(sanitizeMcpToolName('search.web')).toBe('search_web');
		expect(sanitizeMcpToolName('ok_tool-1')).toBe('ok_tool-1');
	});

	it('buildMcpRegistryName - 拼前缀', () => {
		expect(buildMcpRegistryName('tavily', 'search')).toBe('mcp__tavily__search');
	});

	it('createMcpTool - execute 调 client.callTool 原名', async () => {
		const callTool = vi.fn().mockResolvedValue({ content: 'hit', isError: false });
		const client = { callTool } as unknown as McpClientPort;
		const tool = createMcpTool(client, 'tavily', 'Tavily', {
			name: 'search',
			description: 'web search',
			inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
		});
		expect(tool.definition.name).toBe('mcp__tavily__search');
		expect(tool.definition.description).toContain('web search');
		expect(tool.readOnly).toBe(false);
		const result = await tool.execute({ q: 'ratel' });
		expect(callTool).toHaveBeenCalledWith('search', { q: 'ratel' });
		expect(result).toBe('hit');
	});

	it('createMcpTool - isError 时仍返回文本（Loop 降级读字符串）', async () => {
		const client = {
			callTool: vi.fn().mockResolvedValue({ content: 'boom', isError: true }),
		} as unknown as McpClientPort;
		const tool = createMcpTool(client, 'tavily', 'Tavily', {
			name: 'search',
			description: 'd',
			inputSchema: { type: 'object', properties: {} },
		});
		await expect(tool.execute({})).resolves.toBe('boom');
	});
});
```

- [ ] **Step 2–4: 实现并通过**

```typescript
/**
 * @file src/core/mcp-tool-bridge.ts
 * @description 将 MCP tools/list 条目转为 ToolRegistry 可注册的 Tool
 * @module core/mcp-tool-bridge
 * @depends ../ports/mcp, ./tool-registry
 */

import type { Tool } from './tool-registry';
import type { McpClientPort, McpToolInfo } from '../ports/mcp';
import { mcpToolPrefix } from '../ports/mcp';

export function sanitizeMcpToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function buildMcpRegistryName(serverId: string, toolName: string): string {
	return `${mcpToolPrefix(serverId)}${sanitizeMcpToolName(toolName)}`;
}

/**
 * 构造可注册 Tool；execute 闭包捕获 client 与 MCP 原名。
 *
 * 关键路径:readOnly 一期固定 false（保守走权限 ask / 写钩子）。
 */
export function createMcpTool(
	client: McpClientPort,
	serverId: string,
	serverLabel: string,
	info: McpToolInfo,
): Tool {
	const registryName = buildMcpRegistryName(serverId, info.name);
	const description = info.description?.trim()
		? `[MCP:${serverLabel}] ${info.description.trim()}`
		: `[MCP:${serverLabel}] ${info.name}`;

	return {
		definition: {
			name: registryName,
			description,
			parameters: info.inputSchema ?? { type: 'object', properties: {} },
		},
		readOnly: false,
		async execute(args: Record<string, unknown>): Promise<unknown> {
			const result = await client.callTool(info.name, args);
			return result.content;
		},
	};
}
```

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp-tool-bridge.ts tests/core/mcp-tool-bridge.test.ts
git commit -m "feat(mcp): tools/list 到 ToolRegistry 桥接"
```

---

### Task 5: McpClient（假 Transport）

**Files:**
- Create: `src/adapters/mcp-client.ts`
- Test: `tests/adapters/mcp-client.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/adapters/mcp-client.test.ts
 * @description McpClient 握手 / list / call（注入假 Transport）
 * @module tests/adapters/mcp-client
 */

import { describe, it, expect, vi } from 'vitest';
import { McpClient } from '../../src/adapters/mcp-client';
import type { McpTransport } from '../../src/ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../../src/ports/mcp';

function fakeTransport(handler: (method: string, params?: unknown) => unknown): McpTransport {
	return {
		start: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		request: vi.fn(async (method: string, params?: unknown) => handler(method, params)),
	};
}

describe('McpClient', () => {
	it('initialize - 发送 protocolVersion 与 clientInfo', async () => {
		const transport = fakeTransport((method) => {
			if (method === 'initialize') {
				return {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'fake', version: '0' },
				};
			}
			throw new Error(`unexpected ${method}`);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		expect(transport.start).toHaveBeenCalled();
		expect(transport.request).toHaveBeenCalledWith(
			'initialize',
			expect.objectContaining({
				protocolVersion: MCP_PROTOCOL_VERSION,
				clientInfo: expect.objectContaining({ name: 'ratel-vault' }),
			}),
		);
	});

	it('listTools - 映射 name/description/inputSchema', async () => {
		const transport = fakeTransport((method) => {
			if (method === 'initialize') {
				return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'f', version: '0' } };
			}
			if (method === 'tools/list') {
				return {
					tools: [
						{
							name: 'search',
							description: 'd',
							inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
						},
					],
				};
			}
			throw new Error(method);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		const tools = await client.listTools();
		expect(tools).toEqual([
			{
				name: 'search',
				description: 'd',
				inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
			},
		]);
	});

	it('callTool - 归一化 content 文本', async () => {
		const transport = fakeTransport((method) => {
			if (method === 'initialize') {
				return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'f', version: '0' } };
			}
			if (method === 'tools/call') {
				return {
					content: [{ type: 'text', text: 'hello' }],
					isError: false,
				};
			}
			throw new Error(method);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		await expect(client.callTool('search', { q: 'x' })).resolves.toEqual({
			content: 'hello',
			isError: false,
		});
	});

	it('initialize - Server 无 tools capability - 抛错', async () => {
		const transport = fakeTransport(() => ({
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			serverInfo: { name: 'f', version: '0' },
		}));
		const client = new McpClient('x', transport);
		await expect(client.initialize()).rejects.toThrow(/tools/);
	});
});
```

- [ ] **Step 2–4: 实现**

```typescript
/**
 * @file src/adapters/mcp-client.ts
 * @description 通用 MCP Client：initialize / tools/list / tools/call
 * @module adapters/mcp-client
 * @depends ../ports/mcp
 */

import type {
	McpCallResult,
	McpClientPort,
	McpToolInfo,
	McpTransport,
} from '../ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../ports/mcp';
import { PLUGIN_VERSION } from '../version'; // 若无此导出，改用 manifest 版本字符串常量 '0.0.0-dev' 或从 package 读；执行时以仓库实际版本源为准

function normalizeCallContent(raw: unknown): McpCallResult {
	if (!raw || typeof raw !== 'object') {
		return { content: String(raw ?? ''), isError: true };
	}
	const obj = raw as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	const texts = (obj.content ?? [])
		.filter((c) => c && (c.type === 'text' || c.text))
		.map((c) => c.text ?? '')
		.filter(Boolean);
	const content =
		texts.length > 0 ? texts.join('\n') : JSON.stringify(raw);
	return { content, isError: !!obj.isError };
}

export class McpClient implements McpClientPort {
	readonly serverId: string;
	private readonly transport: McpTransport;
	private initialized = false;

	constructor(serverId: string, transport: McpTransport) {
		this.serverId = serverId;
		this.transport = transport;
	}

	async initialize(): Promise<void> {
		await this.transport.start();
		const result = (await this.transport.request('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'ratel-vault', version: resolvePluginVersion() },
		})) as {
			capabilities?: { tools?: unknown };
		};
		if (!result?.capabilities || !('tools' in result.capabilities)) {
			throw new Error(`MCP Server ${this.serverId} 不支持 tools`);
		}
		// 部分 Server 期望 initialized 通知
		try {
			await this.transport.request('notifications/initialized', {});
		} catch {
			// 通知失败不阻断（部分实现无此方法）
		}
		this.initialized = true;
	}

	async listTools(): Promise<McpToolInfo[]> {
		this.assertReady();
		const result = (await this.transport.request('tools/list', {})) as {
			tools?: Array<{
				name: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
			}>;
		};
		return (result.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
		}));
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		this.assertReady();
		const raw = await this.transport.request('tools/call', {
			name,
			arguments: args,
		});
		return normalizeCallContent(raw);
	}

	async close(): Promise<void> {
		this.initialized = false;
		await this.transport.close();
	}

	private assertReady(): void {
		if (!this.initialized) throw new Error(`MCP Client ${this.serverId} 未初始化`);
	}
}

function resolvePluginVersion(): string {
	try {
		// 关键路径:避免循环依赖；若项目已有 version 模块则改 import
		return 'ratel-vault';
	} catch {
		return '0.0.0';
	}
}
```

**执行注意：** 仓库若无 `src/version.ts`，删除该 import，`clientInfo.version` 直接用 `manifest.json` 的 version 字符串字面量（读 `manifest.json` 的 `version` 字段写入常量，或硬编码当前 version）。**禁止留下 `PLUGIN_VERSION` 未定义引用。** 自审时改成：

```typescript
clientInfo: { name: 'ratel-vault', version: '0.1.0' }, // 与 manifest.json version 对齐；发版时可不强求同步
```

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp-client.ts tests/adapters/mcp-client.test.ts
git commit -m "feat(mcp): McpClient 握手与 tools API"
```

---

### Task 6: HTTP Transport + stdio Transport

**Files:**
- Create: `src/adapters/mcp-http.ts`
- Create: `src/adapters/mcp-stdio.ts`
- Test: `tests/adapters/mcp-http.test.ts`
- Test: `tests/adapters/mcp-stdio.test.ts`（注入假 child process）

- [ ] **Step 1: HTTP 失败测试**

```typescript
/**
 * @file tests/adapters/mcp-http.test.ts
 * @description MCP HTTP Transport（mock requestUrl）
 * @module tests/adapters/mcp-http
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestUrl = vi.fn();
vi.mock('obsidian', () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));

import { McpHttpTransport } from '../../src/adapters/mcp-http';

describe('McpHttpTransport', () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it('request - JSON 响应 - 返回 result', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
			json: { jsonrpc: '2.0', id: 1, result: { ok: true } },
		});
		const t = new McpHttpTransport({
			url: 'https://mcp.example/mcp',
			getApiKey: () => 'secret',
		});
		await t.start();
		await expect(t.request('initialize', { protocolVersion: '2024-11-05' })).resolves.toEqual({
			ok: true,
		});
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://mcp.example/mcp',
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
				}),
			}),
		);
	});

	it('request - 记住 mcp-session-id', async () => {
		requestUrl
			.mockResolvedValueOnce({
				status: 200,
				headers: { 'mcp-session-id': 'sess-1' },
				json: { jsonrpc: '2.0', id: 1, result: {} },
				text: '{}',
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: { jsonrpc: '2.0', id: 2, result: { tools: [] } },
				text: '{}',
			});
		const t = new McpHttpTransport({ url: 'https://mcp.example/mcp', getApiKey: () => null });
		await t.start();
		await t.request('initialize', {});
		await t.request('tools/list', {});
		const second = requestUrl.mock.calls[1][0] as { headers: Record<string, string> };
		expect(second.headers['mcp-session-id']).toBe('sess-1');
	});

	it('request - SSE 文本 - 走 extractJsonRpcFromSse', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			text: 'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n',
			json: undefined,
		});
		const t = new McpHttpTransport({ url: 'https://mcp.example/mcp', getApiKey: () => null });
		await t.start();
		await expect(t.request('initialize', {})).resolves.toEqual({ x: 1 });
	});
});
```

- [ ] **Step 2: 实现 `McpHttpTransport`**

要点：
- `private nextId = 1`；`private sessionId: string | null`
- `request` 内 `createJsonRpcRequest` → `requestUrl({ throw: false, body: JSON.stringify(req), headers })`
- 非 2xx 抛中文 Error
- 若 `content-type` 含 `event-stream` 或 `text` 以 `data:` 开头 → `extractJsonRpcFromSse` → `parseJsonRpcResponse`
- 否则用 `response.json` → `parseJsonRpcResponse`
- headers 大小写不敏感读取 `mcp-session-id`

- [ ] **Step 3: stdio 测试（注入 spawn）**

```typescript
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
		// 响应一帧
		const resultBody = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '0' } },
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
```

- [ ] **Step 4: 实现 `McpStdioTransport`**

要点：
- 构造参数：`command`, `args`, `env`, `spawnImpl?`（默认 `child_process.spawn`）, `timeoutMs?`
- `start`：`spawn(command, args, { shell: false, env, stdio: ['pipe','pipe','pipe'] })`；监听 stdout → `StdioFramingBuffer`；stderr → `devLogger.warn('mcp', …)`（**禁止**打印 env）
- `request`：分配 id，pending Map，写 `encodeContentLengthMessage(JSON.stringify(req))`，超时 reject
- `close`：kill 子进程、清 pending
- notifications（无 id 响应）可忽略；匹配 pending id 后 `parseJsonRpcResponse`

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp-http.ts src/adapters/mcp-stdio.ts tests/adapters/mcp-http.test.ts tests/adapters/mcp-stdio.test.ts
git commit -m "feat(mcp): HTTP 与 stdio 双 Transport"
```

---

### Task 7: McpHost（sync / 入册 / 熔断 / dispose）

**Files:**
- Create: `src/core/mcp-host.ts`
- Test: `tests/core/mcp-host.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/core/mcp-host.test.ts
 * @description McpHost 差分 sync、入册出册、dispose
 * @module tests/core/mcp-host
 */

import { describe, it, expect, vi } from 'vitest';
import { McpHost } from '../../src/core/mcp-host';
import { ToolRegistry } from '../../src/core/tool-registry';
import type { McpServerConfig, McpTransport } from '../../src/ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../../src/ports/mcp';

function makeTransportFactory(tools: Array<{ name: string; description?: string }>) {
	return (_cfg: McpServerConfig): McpTransport => {
		let id = 0;
		return {
			start: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			request: vi.fn(async (method: string) => {
				if (method === 'initialize') {
					return {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: 'f', version: '0' },
					};
				}
				if (method === 'notifications/initialized') return {};
				if (method === 'tools/list') {
					return {
						tools: tools.map((t) => ({
							name: t.name,
							description: t.description ?? '',
							inputSchema: { type: 'object', properties: {} },
						})),
					};
				}
				if (method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
				throw new Error(method);
			}),
		};
	};
}

describe('McpHost', () => {
	it('sync - enabled http server - 注册 mcp__ 工具', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search', description: 'd' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		const cfg: McpServerConfig = {
			id: 'tavily',
			label: 'Tavily',
			enabled: true,
			transport: 'http',
			url: 'https://example/mcp',
		};
		await host.sync([cfg]);
		expect(host.getStatus('tavily')).toBe('online');
		expect(registry.definitions().map((d) => d.name)).toEqual(['mcp__tavily__search']);
	});

	it('sync - disable 后 - 出册并 offline', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		const base: McpServerConfig = {
			id: 'tavily',
			label: 'Tavily',
			enabled: true,
			transport: 'http',
			url: 'https://example/mcp',
		};
		await host.sync([base]);
		await host.sync([{ ...base, enabled: false }]);
		expect(host.getStatus('tavily')).toBe('offline');
		expect(registry.definitions()).toEqual([]);
	});

	it('dispose - 清空全部', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		await host.sync([
			{
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://example/mcp',
			},
		]);
		await host.dispose();
		expect(registry.definitions()).toEqual([]);
	});

	it('sync - stdio confirmSpawn 拒绝 - 保持 offline 且不注册', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => false,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		await host.sync([
			{
				id: 'local',
				label: 'Local',
				enabled: true,
				transport: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp'],
			},
		]);
		expect(host.getStatus('local')).toBe('offline');
		expect(registry.definitions()).toEqual([]);
	});
});
```

- [ ] **Step 2–4: 实现 `McpHost`**

```typescript
/**
 * @file src/core/mcp-host.ts
 * @description 多 MCP Server 编排：差分 sync、入册出册、熔断、dispose
 * @module core/mcp-host
 */

import type {
	McpHostPort,
	McpServerConfig,
	McpServerStatus,
	McpTransport,
} from '../ports/mcp';
import {
	MCP_CIRCUIT_FAILURE_THRESHOLD,
	MCP_DEFAULT_TIMEOUT_MS,
	isValidMcpServerId,
	mcpToolPrefix,
} from '../ports/mcp';
import { McpClient } from '../adapters/mcp-client';
import { createMcpTool } from './mcp-tool-bridge';
import type { ToolRegistry } from './tool-registry';
import { devLogger } from '../logging/dev-logger';

export interface McpHostDeps {
	tools: ToolRegistry;
	/** 可注入：测试假 Transport；生产由 main 组装 http/stdio */
	createTransport: (cfg: McpServerConfig) => McpTransport;
	/** stdio 首次确认；HTTP 可直接 true */
	confirmSpawn: (cfg: McpServerConfig) => Promise<boolean>;
	getApiKey: (serverId: string) => string | null;
	getEnvValue: (key: string) => string;
}

interface Slot {
	config: McpServerConfig;
	status: McpServerStatus;
	client: McpClient | null;
	failures: number;
}

export class McpHost implements McpHostPort {
	private readonly deps: McpHostDeps;
	private slots = new Map<string, Slot>();

	constructor(deps: McpHostDeps) {
		this.deps = deps;
	}

	getStatus(serverId: string): McpServerStatus {
		return this.slots.get(serverId)?.status ?? 'offline';
	}

	async sync(servers: McpServerConfig[]): Promise<void> {
		const wanted = new Map<string, McpServerConfig>();
		for (const s of servers) {
			if (!isValidMcpServerId(s.id)) {
				devLogger.warn('mcp', `忽略非法 server id: ${s.id}`);
				continue;
			}
			wanted.set(s.id, s);
		}

		// 移除消失的
		for (const id of [...this.slots.keys()]) {
			if (!wanted.has(id)) await this.teardown(id);
		}

		for (const cfg of wanted.values()) {
			const prev = this.slots.get(cfg.id);
			if (!cfg.enabled) {
				if (prev) await this.teardown(cfg.id);
				this.slots.set(cfg.id, { config: cfg, status: 'offline', client: null, failures: 0 });
				continue;
			}
			// 配置指纹变化则重建
			if (prev && prev.status === 'online' && sameRuntimeConfig(prev.config, cfg)) {
				prev.config = cfg;
				continue;
			}
			await this.teardown(cfg.id);
			await this.bringUp(cfg);
		}
	}

	async stop(serverId: string): Promise<void> {
		const slot = this.slots.get(serverId);
		if (!slot) return;
		await this.teardown(serverId);
		this.slots.set(serverId, {
			config: { ...slot.config, enabled: false },
			status: 'offline',
			client: null,
			failures: 0,
		});
	}

	async dispose(): Promise<void> {
		for (const id of [...this.slots.keys()]) {
			await this.teardown(id);
		}
		this.slots.clear();
	}

	private async bringUp(cfg: McpServerConfig): Promise<void> {
		this.slots.set(cfg.id, { config: cfg, status: 'connecting', client: null, failures: 0 });
		try {
			if (cfg.transport === 'stdio') {
				const ok = await this.deps.confirmSpawn(cfg);
				if (!ok) {
					this.slots.set(cfg.id, { config: cfg, status: 'offline', client: null, failures: 0 });
					return;
				}
			}
			if (cfg.transport === 'http' && !cfg.url) throw new Error(`MCP ${cfg.id} 缺少 url`);
			if (cfg.transport === 'stdio' && !cfg.command) throw new Error(`MCP ${cfg.id} 缺少 command`);

			const transport = this.deps.createTransport(cfg);
			const client = new McpClient(cfg.id, transport);
			await client.initialize();
			const listed = await client.listTools();
			// 全有或全无
			this.deps.tools.unregisterByPrefix(mcpToolPrefix(cfg.id));
			for (const info of listed) {
				this.deps.tools.register(createMcpTool(client, cfg.id, cfg.label, info));
			}
			this.slots.set(cfg.id, { config: cfg, status: 'online', client, failures: 0 });
		} catch (err) {
			devLogger.error('mcp', `Server ${cfg.id} 启动失败`, err);
			this.deps.tools.unregisterByPrefix(mcpToolPrefix(cfg.id));
			this.slots.set(cfg.id, { config: cfg, status: 'error', client: null, failures: 0 });
		}
	}

	private async teardown(serverId: string): Promise<void> {
		const slot = this.slots.get(serverId);
		this.deps.tools.unregisterByPrefix(mcpToolPrefix(serverId));
		if (slot?.client) {
			try {
				await slot.client.close();
			} catch (err) {
				devLogger.warn('mcp', `关闭 ${serverId} 失败`, err);
			}
		}
		this.slots.delete(serverId);
	}
}

function sameRuntimeConfig(a: McpServerConfig, b: McpServerConfig): boolean {
	return (
		a.transport === b.transport &&
		a.url === b.url &&
		a.command === b.command &&
		JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
		JSON.stringify(a.envKeys ?? []) === JSON.stringify(b.envKeys ?? []) &&
		(a.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS) === (b.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS)
	);
}
```

**熔断：** 在 `createMcpTool` 的 execute 外包一层可由 Host 提供的 `wrapExecute`（可选增强）。一期最小：Host 测试覆盖启停即可；call 失败计数可在 bridge 注入回调：

执行时若时间紧，熔断可记为：**Host 持有 `onToolFailure(serverId)`，bridge 工厂由 Host 在 register 时包装 execute**。在 `bringUp` 内：

```typescript
const tool = createMcpTool(...);
const original = tool.execute.bind(tool);
tool.execute = async (args) => {
  try {
    const r = await original(args);
    slot.failures = 0;
    return r;
  } catch (e) {
    slot.failures++;
    if (slot.failures >= MCP_CIRCUIT_FAILURE_THRESHOLD) {
      await this.teardown(cfg.id);
      this.slots.set(cfg.id, { config: cfg, status: 'error', client: null, failures: slot.failures });
    }
    throw e;
  }
};
```

（`isError: true` 的软错误不计入熔断，仅抛异常计。）

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp-host.ts tests/core/mcp-host.test.ts
git commit -m "feat(mcp): McpHost sync 入册与 dispose"
```

---

### Task 8: settings 字段 + secrets + composer toolGuide + main 接线

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/secrets/ratel-secrets.ts`
- Modify: `src/prompts/composer.ts`
- Modify: `tests/prompts/composer.test.ts`
- Modify: `tests/secrets/ratel-secrets.test.ts`
- Modify: `src/main.ts`
- Test: 追加 settings 默认断言（可放 `tests/settings-migration.test.ts`）

- [ ] **Step 1: secrets 测试**

```typescript
it('mcpSecretId - 生成 ratel-mcp-<id>', () => {
	expect(mcpSecretId('tavily')).toBe('ratel-mcp-tavily');
});

it('resolveMcpSecret - 有密钥 - 返回值', () => {
	const app = mockApp({ 'ratel-mcp-tavily': 'k' });
	expect(resolveMcpSecret(app, 'tavily')).toBe('k');
});

it('resolveMcpSecret - 无密钥 - 返回 null', () => {
	const app = mockApp({});
	expect(resolveMcpSecret(app, 'tavily')).toBeNull();
});
```

实现：

```typescript
export function mcpSecretId(serverId: string): string {
	return `ratel-mcp-${serverId}`;
}

export function resolveMcpSecret(app: App, serverId: string): string | null {
	return getSecret(app, mcpSecretId(serverId)); // 复用文件内私有 getSecret
}

export function hasMcpSecret(app: App, serverId: string): boolean {
	return !!resolveMcpSecret(app, serverId);
}
```

- [ ] **Step 2: settings 增量**

在 `RatelVaultSettings`：

```typescript
/** MCP Server 列表；默认空 = 零出站 */
mcpServers: McpServerConfig[];
/** 用户已确认允许 spawn 的 stdio serverId 列表 */
mcpApprovedSpawns: string[];
```

`DEFAULT_SETTINGS`：`mcpServers: []`, `mcpApprovedSpawns: []`。

`import type { McpServerConfig } from './ports/mcp'`（或从 ports 再导出）。

- [ ] **Step 3: composer — MCP 描述不丢**

改 `formatToolGuideList`：

```typescript
export function formatToolGuideList(
	tools: Array<{ name: string; description: string }>,
	overrides: OverrideMap,
): string {
	return tools
		.map((t) => {
			const fromSection = resolveToolSection(t.name, 'description', overrides);
			const desc = fromSection || t.description || '';
			return `- ${t.name}: ${desc}`;
		})
		.join('\n');
}
```

`composeAgentSystem`：

```typescript
toolList: formatToolGuideList(ctx.tools, overrides),
```

更新 `tests/prompts/composer.test.ts`：

```typescript
formatToolGuideList(
  [
    { name: 'read_note', description: '' },
    { name: 'search_vault', description: '' },
  ],
  {},
);
```

并追加：

```typescript
it('formatToolGuideList - 无 section 时回退 definition.description（MCP）', () => {
	const list = formatToolGuideList(
		[{ name: 'mcp__tavily__search', description: '[MCP:Tavily] web search' }],
		{},
	);
	expect(list).toContain('mcp__tavily__search');
	expect(list).toContain('web search');
});
```

- [ ] **Step 4: main.ts 接线**

在插件类上：`mcpHost!: McpHost`。

`onload` 工具注册完成后：

```typescript
this.mcpHost = new McpHost({
	tools: this.tools,
	confirmSpawn: async (cfg) => {
		if (this.settings.mcpApprovedSpawns.includes(cfg.id)) return true;
		// CORE：无 UI 时拒绝 stdio，避免静默 spawn；UI plan 接 Modal 后改为弹窗并写入 mcpApprovedSpawns
		return false;
	},
	getApiKey: (id) => resolveMcpSecret(this.app, id),
	getEnvValue: (key) => {
		// 仅允许 cfg.envKeys 白名单内的 key；值优先钥匙串同名，否则 process.env
		return process.env[key] ?? '';
	},
	createTransport: (cfg) => {
		if (cfg.transport === 'http') {
			return new McpHttpTransport({
				url: cfg.url!,
				getApiKey: () => resolveMcpSecret(this.app, cfg.id),
				timeoutMs: cfg.timeoutMs,
			});
		}
		const env: Record<string, string> = { ...filterEnv(process.env) };
		for (const k of cfg.envKeys ?? []) {
			env[k] = resolveMcpSecret(this.app, cfg.id) && k.toLowerCase().includes('key')
				? (resolveMcpSecret(this.app, cfg.id) ?? '')
				: (process.env[k] ?? '');
		}
		// 简化：若 envKeys 含 API_KEY 类，用 mcp secret 填第一个密钥型 key；UI/文档说明
		return new McpStdioTransport({
			command: cfg.command!,
			args: cfg.args ?? [],
			env,
			timeoutMs: cfg.timeoutMs,
		});
	},
});

void this.mcpHost.sync(this.settings.mcpServers).catch((err) => {
	devLogger.error('mcp', '初始 sync 失败', err);
});
```

`onunload`：`await this.mcpHost?.dispose()`。

settings 保存路径：在现有 `saveSettings` / 控制值变更后，若 `mcpServers` 或相关字段变，调用 `this.mcpHost.sync(this.settings.mcpServers)`。

**env 注入细节（钉死）：**
- `filterEnv`：继承 `process.env` 的安全子集（至少 `PATH`, `HOME`, `LANG`）；不要把整个 env 无过滤传入若担心泄漏——一期可 ` { ...process.env } as Record<string,string>` 与社区一致，但 **永远不 log env**。
- 对 `envKeys`：每个 key 的值 = `process.env[key]`；若 key 匹配 `/api[_-]?key|token|secret/i` 且 `resolveMcpSecret` 非空，则用 secret 覆盖。

- [ ] **Step 5: 跑相关测试**

```bash
npx vitest run tests/core/mcp-host.test.ts tests/adapters/mcp-client.test.ts tests/adapters/mcp-http.test.ts tests/adapters/mcp-stdio.test.ts tests/core/mcp-tool-bridge.test.ts tests/prompts/composer.test.ts tests/secrets/ratel-secrets.test.ts tests/core/tool-registry.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts src/secrets/ratel-secrets.ts src/prompts/composer.ts src/main.ts tests/
git commit -m "feat(mcp): settings/secrets/composer/main 接线"
```

- [ ] **Step 7: 更新 STATUS**

`P-MCP-HOST-CORE` → Completed（执行结束时）；本 writing-plans 提交时保持 Pending 并填文件路径。

---

## 手工验收清单（CORE，无 UI）

1. 临时在测试或控制台构造 `mcpServers: [{ id:'tavily', label:'Tavily', enabled:true, transport:'http', url:'...' }]`，确认 `tools.definitions()` 含 `mcp__…`
2. 零配置启动：无额外 HTTP、无子进程
3. stdio 在 CORE 阶段 `confirmSpawn` 恒 false → 不 spawn（安全默认）

---

## 自审（对照 S-MCP-HOST）

| Spec 项 | Task |
|---|---|
| Port + 双 Transport | T1, T6 |
| JSON-RPC / SSE / 分帧 | T2, T3 |
| Client list/call | T5 |
| 入册 `mcp__*` + unregister | T1, T4, T7 |
| Host sync/dispose/熔断 | T7 |
| 密钥函数 | T8 |
| settings 字段 | T8 |
| toolGuide MCP 描述 | T8 |
| main 生命周期 | T8 |
| Resources 等非目标 | 未做 ✓ |
| UI / spawn Modal / i18n | → P-MCP-HOST-UI |
| README 隐私 | → P-MCP-HOST-DOCS |

**占位符扫描：** `PLUGIN_VERSION` 已在 Task 5 注明改为字面量，禁止未定义引用。  
**类型一致：** `McpServerConfig` / `McpTransport` / `createMcpTool` 签名跨 Task 对齐。

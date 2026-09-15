# P-RENDER-STABILITY-A:崩溃面包屑 + 内存阈值 + 空索引跳过 embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发送/回合各阶段把阶段 ID 与内存采样同步追加到插件目录磁盘；下次启动能看出上次是否异常退出；RSS/external 超阈值生命周期只提示一次；记忆主题索引为空或 embedding 未就绪时不再每句 ONNX。

**Architecture:** 新模块 `src/logging/breadcrumbs.ts` 独占 `fs.appendFileSync` / 心跳 / 轮转。`UserChatRequest.onBreadcrumb` 注入打点，`agent-loop` 不 import `fs`。诊断页与反馈「复制诊断」读最近 40 行，不含正文。本 plan 只做 spec 分期 A（§4.1 / §4.2 / §4.5）；§4.3 单次 load 与 §4.4 Worker 生命周期留给分期 B。

**Tech Stack:** TypeScript / Vitest / Node `fs`。无新 npm。Obsidian `Notice` + 现有诊断子页面。

**关联文档:** [S-RENDER-STABILITY](../specs/2026-09-15-render-stability-design.md)

## Global Constraints

- 只实现分期 A。禁止改 `ContextManager.load` 幂等、禁止改 `EmbeddingWorkerProxy` 惰性/空闲回收、禁止改 `AgentEvent`、禁止改 architecture 文档
- 面包屑行禁止消息正文、笔记路径、密钥；`n` 与 `sessionShort` 内的 `|` 替换成 `_`
- IO 全部 try/catch 静默；写失败不影响发送
- `settings.crashBreadcrumbs` 默认 `true`，开发者区，**不进** `CONFIG_UPDATE_WHITELIST`（与 `debugLog` 同类）
- 关开关：不写文件、不跑心跳；`onload` **仍读** `last-alive.json` 填诊断「上次运行」
- 终态只有 `ask.end` / `plugin.unload`；`ask.error` 之后 `finally` 仍打 `ask.end`
- **心跳不改 `lastPhase`**：`heartbeat` 只追加日志行并刷新 `last-alive` 的 `ts`/内存；否则空闲 30s 后 `lastPhase=heartbeat`，下次启动必误报 `crash.suspect`
- `onBreadcrumb` 挂在 `UserChatRequest` 上（与 `onRetryWait` 同模式），**不要**给 `agentLoop` 再加第 13 个位置参数
- 内存阈值用 Obsidian `Notice` 吐司 + 诊断页横幅，**不进** StatusStrip
- spec 的 `plugin.diagnostics` 落地为 `plugin.lastRunDiag` + `plugin.memoryHigh` + `plugin.breadcrumbs.readRecentLines()`
- 用户可见字符串走 i18n（`types.ts` + `zh.ts` + `en.ts`），禁止硬编码
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`；源码文件头中文
- 不改重试/压缩/上送预算；不出网；不改 vectra
- 只链 Obsidian Sandbox；禁止 `link:vault` 日常主库；本机绝对路径不进仓库
- 提交只暂存本 task 文件清单，禁止 `git add -A`
- 工作目录:当前仓库；**另开分支 `feat/p-render-stability-a`（从 `develop`）**。不要把实现混进 `feat/p-llm-retry-ui`

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/logging/breadcrumbs.ts` | 阶段枚举、行格式、轮转、心跳、异常退出检测、内存阈值一次回调 |
| `src/logging/breadcrumbs.test.ts` | 行格式 / 轮转 / 吞 IO / process 缺失 / 终态判定 / 阈值 |
| `src/core/memory-topics-auto-inject.ts` | `shouldAutoEmbedTopics` 纯函数 |
| `src/core/memory-topics-auto-inject.test.ts` | 空索引 / K=0 / 未 ready 跳过 |
| `src/settings.ts` | `crashBreadcrumbs` 字段 + 开发者 toggle |
| `src/settings/settings-apply.ts` | 开关心跳启停 |
| `src/settings/config-whitelist.ts` | 注释把 `crashBreadcrumbs` 列为红线（集合不加 key） |
| `tests/settings/config-whitelist.test.ts` | 断言不在白名单 |
| `src/utils/gitignore-writer.ts` | 忽略 `diag/` |
| `tests/utils/gitignore-writer.test.ts` | 断言含 `diag/` |
| `src/i18n/types.ts` `zh.ts` `en.ts` | 开关文案 + `diag.lastRun.*` + `diag.memoryHigh` |
| `src/main.ts` | 装配、onload 检测、heartbeat、ask 打点、跳过 embed |
| `src/types.ts` | `UserChatRequest.onBreadcrumb` |
| `src/core/agent-loop.ts` | 从 `req.onBreadcrumb` 打 `loop.*` / `llm.*` |
| `tests/core/agent-loop.test.ts` | 回调相位顺序 |
| `src/ui/chat/ChatView.svelte` | `send.enqueue` / `send.precheck` / `send.compact` |
| `src/ui/settings/diagnostics-setting-page.ts` | 「上次运行」+ 内存横幅 |
| `src/ui/chat/feedback-modal.ts` | 复制摘要附 40 行 |
| `README.md` `README.zh-CN.md` `docs/user-guide.md` | 隐私一句 + 诊断页说明 |

---

### Task 1:面包屑内核（格式 / 轮转 / 心跳 / 崩溃检测 / 阈值）

**Files:**
- Create: `src/logging/breadcrumbs.ts`
- Create: `src/logging/breadcrumbs.test.ts`

**Interfaces:**
- Produces: `BREADCRUMB_PHASES`、`BreadcrumbPhase`、`TERMINAL_PHASES`、`MEMORY_WARN_RSS_MB`、`MEMORY_WARN_EXTERNAL_MB`、`BREADCRUMB_MAX_BYTES`、`HEARTBEAT_MS`、`isTerminalPhase`、`shouldSuspectCrash`、`formatBreadcrumbLine`、`sessionShort`、`bytesToMb`、`LastRunDiag`、`class CrashBreadcrumbs`（`inspectLastRun` / `readLastAlive` 是实例方法，不要再导出顶层同名函数）

- [ ] **Step 1:写失败测试**

创建 `src/logging/breadcrumbs.test.ts`：

```typescript
/**
 * @file src/logging/breadcrumbs.test.ts
 * @description 崩溃面包屑 — 行格式、轮转、吞 IO、终态判定、内存阈值
 * @module logging/breadcrumbs.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	BREADCRUMB_PHASES,
	BREADCRUMB_MAX_BYTES,
	MEMORY_WARN_RSS_MB,
	MEMORY_WARN_EXTERNAL_MB,
	formatBreadcrumbLine,
	isTerminalPhase,
	shouldSuspectCrash,
	sessionShort,
	bytesToMb,
	CrashBreadcrumbs,
	type LastAliveSnapshot,
} from './breadcrumbs';

describe('面包屑纯函数', () => {
	it('BREADCRUMB_PHASES - 含 spec 全部 17 个阶段 - 顺序与字面量一致', () => {
		expect(BREADCRUMB_PHASES).toEqual([
			'plugin.load', 'plugin.unload', 'heartbeat',
			'send.enqueue', 'send.precheck', 'send.compact',
			'ask.begin', 'ask.embed.begin', 'ask.embed.end',
			'loop.load', 'loop.classify', 'llm.request', 'llm.first-delta',
			'loop.tool', 'ask.end', 'ask.error',
			'crash.suspect',
		]);
	});

	it('isTerminalPhase - 仅 ask.end 与 plugin.unload - 其余为进行中', () => {
		expect(isTerminalPhase('ask.end')).toBe(true);
		expect(isTerminalPhase('plugin.unload')).toBe(true);
		expect(isTerminalPhase('ask.error')).toBe(false);
		expect(isTerminalPhase('heartbeat')).toBe(false);
		expect(isTerminalPhase('crash.suspect')).toBe(false);
	});

	it('shouldSuspectCrash - lastPhase 终态 - 不怀疑', () => {
		expect(shouldSuspectCrash('ask.end')).toBe(false);
		expect(shouldSuspectCrash('plugin.unload')).toBe(false);
		expect(shouldSuspectCrash(undefined)).toBe(false);
	});

	it('shouldSuspectCrash - lastPhase 进行中 - 怀疑崩溃', () => {
		expect(shouldSuspectCrash('llm.request')).toBe(true);
		expect(shouldSuspectCrash('ask.begin')).toBe(true);
	});

	it('sessionShort - 取末 6 位 - 不足则原样', () => {
		expect(sessionShort('session-1788344537425')).toBe('537425');
		expect(sessionShort('abc')).toBe('abc');
		expect(sessionShort(undefined)).toBe('-');
	});

	it('formatBreadcrumbLine - 无正文管道分隔 - n 缺省为横杠', () => {
		const line = formatBreadcrumbLine({
			isoTime: '2026-09-15T03:06:00.000Z',
			phase: 'ask.begin',
			sessionId: 'session-1788344537425',
			n: undefined,
			rssMB: 512,
			heapMB: 200,
			externalMB: 80,
		});
		expect(line).toBe('2026-09-15T03:06:00.000Z|ask.begin|537425|-|512|200|80');
		expect(line.split('|')).toHaveLength(7);
	});

	it('formatBreadcrumbLine - n 含管道符 - 换成下划线', () => {
		const line = formatBreadcrumbLine({
			isoTime: '2026-09-15T03:06:00.000Z',
			phase: 'loop.tool',
			sessionId: 's1',
			n: 'search|vault',
			rssMB: '-',
			heapMB: '-',
			externalMB: '-',
		});
		expect(line).toBe('2026-09-15T03:06:00.000Z|loop.tool|s1|search_vault|-|-|-');
	});

	it('bytesToMb - 按 1024*1024 向下取整到整数 MB', () => {
		expect(bytesToMb(0)).toBe(0);
		expect(bytesToMb(1024 * 1024 - 1)).toBe(0);
		expect(bytesToMb(1024 * 1024)).toBe(1);
	});
});

describe('CrashBreadcrumbs 落盘', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-bc-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('mark - enabled 时追加一行并覆盖 last-alive - lastPhase 更新', () => {
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => ({ rss: 10 * 1024 * 1024, heapUsed: 4 * 1024 * 1024, external: 2 * 1024 * 1024 }),
			uptimeMs: () => 1000,
		});
		bc.mark('ask.begin', 'session-abcdef');
		const log = fs.readFileSync(path.join(dir, 'diag', 'breadcrumbs.log'), 'utf-8').trim();
		expect(log).toBe('2026-09-15T03:06:00.000Z|ask.begin|abcdef|-|10|4|2');
		const alive = JSON.parse(fs.readFileSync(path.join(dir, 'diag', 'last-alive.json'), 'utf-8')) as LastAliveSnapshot;
		expect(alive.lastPhase).toBe('ask.begin');
		expect(alive.sessionShort).toBe('abcdef');
		expect(alive.rssMB).toBe(10);
	});

	it('mark - enabled 为 false - 不创建 diag 目录', () => {
		const bc = new CrashBreadcrumbs({ pluginDir: dir, enabled: () => false });
		bc.mark('ask.begin', 's1');
		expect(fs.existsSync(path.join(dir, 'diag'))).toBe(false);
	});

	it('mark - appendFile 抛错 - 不外泄', () => {
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			appendLine: () => {
				throw new Error('EACCES');
			},
		});
		expect(() => bc.mark('ask.begin')).not.toThrow();
	});

	it('mark - memoryUsage 不可用 - 内存三列写横杠', () => {
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => null,
		});
		bc.mark('heartbeat');
		const log = fs.readFileSync(path.join(dir, 'diag', 'breadcrumbs.log'), 'utf-8').trim();
		expect(log.endsWith('heartbeat|-|-|-|-|-')).toBe(true);
	});

	it('轮转 - 超过 256KB - 生成 breadcrumbs.1.log 且只保留一份旧文件', () => {
		const diag = path.join(dir, 'diag');
		fs.mkdirSync(diag, { recursive: true });
		const logPath = path.join(diag, 'breadcrumbs.log');
		fs.writeFileSync(logPath, 'x'.repeat(BREADCRUMB_MAX_BYTES + 1));
		fs.writeFileSync(path.join(diag, 'breadcrumbs.1.log'), 'old-rotated');
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => null,
		});
		bc.mark('plugin.load');
		expect(fs.existsSync(path.join(diag, 'breadcrumbs.2.log'))).toBe(false);
		const rotated = fs.readFileSync(path.join(diag, 'breadcrumbs.1.log'), 'utf-8');
		expect(rotated.startsWith('x')).toBe(true);
		const fresh = fs.readFileSync(logPath, 'utf-8').trim();
		expect(fresh).toContain('plugin.load');
		expect(fresh).not.toContain('xxxx');
	});

	it('inspectLastRun - 无 last-alive - 返回 null 且不写 crash.suspect', () => {
		const bc = new CrashBreadcrumbs({ pluginDir: dir, enabled: () => true });
		expect(bc.inspectLastRun()).toBeNull();
		expect(fs.existsSync(path.join(dir, 'diag', 'breadcrumbs.log'))).toBe(false);
	});

	it('inspectLastRun - lastPhase 为 ask.end - suspectedCrash false 且不追加 crash.suspect', () => {
		const diag = path.join(dir, 'diag');
		fs.mkdirSync(diag, { recursive: true });
		fs.writeFileSync(
			path.join(diag, 'last-alive.json'),
			JSON.stringify({
				ts: '2026-09-15T03:00:00.000Z',
				lastPhase: 'ask.end',
				sessionShort: 'abcdef',
				rssMB: 10,
				heapMB: 4,
				externalMB: 2,
				uptimeMs: 5000,
			}),
		);
		const bc = new CrashBreadcrumbs({ pluginDir: dir, enabled: () => true });
		const snap = bc.inspectLastRun();
		expect(snap?.suspectedCrash).toBe(false);
		expect(snap?.lastPhase).toBe('ask.end');
		expect(fs.existsSync(path.join(dir, 'diag', 'breadcrumbs.log'))).toBe(false);
	});

	it('inspectLastRun - lastPhase 为 llm.request - suspectedCrash true；enabled 时追加 crash.suspect', () => {
		const diag = path.join(dir, 'diag');
		fs.mkdirSync(diag, { recursive: true });
		fs.writeFileSync(
			path.join(diag, 'last-alive.json'),
			JSON.stringify({
				ts: '2026-09-15T03:00:00.000Z',
				lastPhase: 'llm.request',
				sessionShort: 'abcdef',
				rssMB: 12,
				heapMB: 5,
				externalMB: 3,
				uptimeMs: 9000,
			}),
		);
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => null,
		});
		const snap = bc.inspectLastRun();
		expect(snap?.suspectedCrash).toBe(true);
		expect(snap?.lastPhase).toBe('llm.request');
		const log = fs.readFileSync(path.join(dir, 'diag', 'breadcrumbs.log'), 'utf-8').trim();
		expect(log).toContain('crash.suspect|abcdef|llm.request');
		// 关键路径:n 列是上次 lastPhase；sessionShort 从 last-alive 带回，不要写成 |-|llm.request
	});

	it('heartbeat - 先前已是 ask.end - last-alive.lastPhase 仍为 ask.end', () => {
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => ({ rss: 10 * 1024 * 1024, heapUsed: 4 * 1024 * 1024, external: 2 * 1024 * 1024 }),
			uptimeMs: () => 1000,
		});
		bc.mark('ask.end', 'session-abcdef');
		bc.mark('heartbeat', 'session-abcdef');
		const log = fs.readFileSync(path.join(dir, 'diag', 'breadcrumbs.log'), 'utf-8');
		expect(log).toContain('|heartbeat|');
		const alive = JSON.parse(fs.readFileSync(path.join(dir, 'diag', 'last-alive.json'), 'utf-8')) as LastAliveSnapshot;
		expect(alive.lastPhase).toBe('ask.end');
	});

	it('inspectLastRun - 开关关闭但有进行中 last-alive - 仍返回 suspectedCrash 且不写文件', () => {
		const diag = path.join(dir, 'diag');
		fs.mkdirSync(diag, { recursive: true });
		fs.writeFileSync(
			path.join(diag, 'last-alive.json'),
			JSON.stringify({
				ts: '2026-09-15T03:00:00.000Z',
				lastPhase: 'send.enqueue',
				sessionShort: '-',
				rssMB: 1,
				heapMB: 1,
				externalMB: 1,
				uptimeMs: 1,
			}),
		);
		const bc = new CrashBreadcrumbs({ pluginDir: dir, enabled: () => false });
		expect(bc.inspectLastRun()?.suspectedCrash).toBe(true);
		expect(fs.existsSync(path.join(dir, 'diag', 'breadcrumbs.log'))).toBe(false);
	});

	it('readRecentLines - 超过 40 行 - 只返回末 40 行', () => {
		const diag = path.join(dir, 'diag');
		fs.mkdirSync(diag, { recursive: true });
		const lines = Array.from({ length: 45 }, (_, i) => `t|heartbeat|-|${i}|1|1|1`);
		fs.writeFileSync(path.join(diag, 'breadcrumbs.log'), lines.join('\n') + '\n');
		const bc = new CrashBreadcrumbs({ pluginDir: dir, enabled: () => false });
		const recent = bc.readRecentLines(40);
		expect(recent).toHaveLength(40);
		expect(recent[0]).toContain('|5|');
		expect(recent[39]).toContain('|44|');
	});

	it('maybeWarnMemory - rss 超 4096 或 external 超 1536 - 生命周期只回调一次', () => {
		const onMemoryHigh = vi.fn();
		const bc = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => ({
				rss: (MEMORY_WARN_RSS_MB + 1) * 1024 * 1024,
				heapUsed: 1,
				external: 1,
			}),
			onMemoryHigh,
		});
		bc.mark('heartbeat');
		bc.mark('heartbeat');
		expect(onMemoryHigh).toHaveBeenCalledTimes(1);

		const bc2 = new CrashBreadcrumbs({
			pluginDir: dir,
			enabled: () => true,
			now: () => new Date('2026-09-15T03:06:00.000Z'),
			memoryUsage: () => ({
				rss: 1,
				heapUsed: 1,
				external: (MEMORY_WARN_EXTERNAL_MB + 1) * 1024 * 1024,
			}),
			onMemoryHigh,
		});
		bc2.mark('heartbeat');
		expect(onMemoryHigh).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/logging/breadcrumbs.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3:最小实现**

创建 `src/logging/breadcrumbs.ts`：

```typescript
/**
 * @file src/logging/breadcrumbs.ts
 * @description 渲染进程崩溃面包屑 — 同步追加阶段行 + 心跳 last-alive，崩后仍可读
 * @module logging/breadcrumbs
 */

import fs from 'node:fs';
import path from 'node:path';

export const BREADCRUMB_PHASES = [
	'plugin.load', 'plugin.unload', 'heartbeat',
	'send.enqueue', 'send.precheck', 'send.compact',
	'ask.begin', 'ask.embed.begin', 'ask.embed.end',
	'loop.load', 'loop.classify', 'llm.request', 'llm.first-delta',
	'loop.tool', 'ask.end', 'ask.error',
	'crash.suspect',
] as const;
export type BreadcrumbPhase = (typeof BREADCRUMB_PHASES)[number];

export const TERMINAL_PHASES = ['ask.end', 'plugin.unload'] as const;
export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/** 轮转阈值：单文件 256KB，只留一份 `.1.log` */
export const BREADCRUMB_MAX_BYTES = 256 * 1024;
/** 心跳间隔 30s */
export const HEARTBEAT_MS = 30_000;
/**
 * RSS 告警水位（MB）。
 * 取值依据：桌面 Obsidian 渲染进程连续数日后 rss 进数 GB 仍「能用」；
 * 4GB 已明显高于正常会话，提示重启，避免等到 Chromium tag 253 虚占数十 GB。
 */
export const MEMORY_WARN_RSS_MB = 4096;
/**
 * external 告警水位（MB）。
 * 取值依据：ORT WASM 线性内存只涨不缩；1.5GB ArrayBuffer/WASM 已属异常常驻。
 */
export const MEMORY_WARN_EXTERNAL_MB = 1536;

export type MemorySample = { rss: number; heapUsed: number; external: number };

export interface LastAliveSnapshot {
	ts: string;
	lastPhase: string;
	sessionShort: string;
	rssMB: number | '-';
	heapMB: number | '-';
	externalMB: number | '-';
	uptimeMs: number;
}

export interface LastRunDiag {
	suspectedCrash: boolean;
	lastPhase: string;
	sessionShort: string;
	ageMs: number;
	rssMB: number | '-';
	heapMB: number | '-';
	externalMB: number | '-';
	uptimeMs: number;
}

export interface CrashBreadcrumbsOptions {
	pluginDir: string;
	enabled: () => boolean;
	now?: () => Date;
	memoryUsage?: () => MemorySample | null;
	uptimeMs?: () => number;
	onMemoryHigh?: () => void;
	appendLine?: (filePath: string, line: string) => void;
	heartbeatMs?: number;
}

function sanitizeField(value: string): string {
	return value.replace(/\|/g, '_').replace(/\n/g, ' ');
}

export function sessionShort(sessionId: string | undefined): string {
	if (!sessionId) return '-';
	return sessionId.length <= 6 ? sessionId : sessionId.slice(-6);
}

export function bytesToMb(bytes: number): number {
	return Math.floor(bytes / (1024 * 1024));
}

export function isTerminalPhase(phase: string | undefined): boolean {
	return phase === 'ask.end' || phase === 'plugin.unload';
}

export function shouldSuspectCrash(lastPhase: string | undefined): boolean {
	if (!lastPhase) return false;
	return !isTerminalPhase(lastPhase);
}

export function formatBreadcrumbLine(input: {
	isoTime: string;
	phase: BreadcrumbPhase;
	sessionId?: string;
	n?: string | number;
	rssMB: number | '-';
	heapMB: number | '-';
	externalMB: number | '-';
}): string {
	const n = input.n === undefined || input.n === '' ? '-' : sanitizeField(String(input.n));
	return [
		input.isoTime,
		input.phase,
		sanitizeField(sessionShort(input.sessionId)),
		n,
		String(input.rssMB),
		String(input.heapMB),
		String(input.externalMB),
	].join('|');
}

function defaultMemoryUsage(): MemorySample | null {
	try {
		const mem = (globalThis as { process?: { memoryUsage?: () => MemorySample } }).process?.memoryUsage;
		if (typeof mem !== 'function') return null;
		return mem.call((globalThis as { process: unknown }).process);
	} catch {
		return null;
	}
}

/**
 * 崩溃面包屑写入器。
 *
 * 设计要点:
 * - 同步 append，崩前尽量落盘；任何 IO 失败静默
 * - enabled=false 时 mark/心跳不写文件，inspectLastRun / readRecentLines 仍读历史
 * - 内存阈值每个实例只回调一次
 */
export class CrashBreadcrumbs {
	private lastPhase: BreadcrumbPhase | undefined;
	private lastSessionId: string | undefined;
	private memoryWarned = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt: number;

	constructor(private readonly opts: CrashBreadcrumbsOptions) {
		this.startedAt = Date.now();
	}

	/** 诊断目录：`<pluginDir>/diag/` */
	diagDir(): string {
		return path.join(this.opts.pluginDir, 'diag');
	}

	logPath(): string {
		return path.join(this.diagDir(), 'breadcrumbs.log');
	}

	rotatedLogPath(): string {
		return path.join(this.diagDir(), 'breadcrumbs.1.log');
	}

	alivePath(): string {
		return path.join(this.diagDir(), 'last-alive.json');
	}

	mark(phase: BreadcrumbPhase, sessionId?: string, n?: string | number): void {
		// 关键路径:heartbeat 只刷新存活戳，不覆盖 lastPhase，否则空闲后必误报崩溃
		if (phase !== 'heartbeat') {
			this.lastPhase = phase;
		} else if (this.lastPhase === undefined) {
			this.lastPhase = 'heartbeat';
		}
		if (sessionId) this.lastSessionId = sessionId;
		if (!this.opts.enabled()) return;
		try {
			this.ensureDiagDir();
			this.rotateIfNeeded();
			const mem = this.sampleMemory();
			this.maybeWarnMemory(mem);
			const line = formatBreadcrumbLine({
				isoTime: (this.opts.now ?? (() => new Date()))().toISOString(),
				phase,
				sessionId: sessionId ?? this.lastSessionId,
				n,
				rssMB: mem ? bytesToMb(mem.rss) : '-',
				heapMB: mem ? bytesToMb(mem.heapUsed) : '-',
				externalMB: mem ? bytesToMb(mem.external) : '-',
			});
			const append = this.opts.appendLine ?? ((filePath, text) => {
				fs.appendFileSync(filePath, text + '\n', 'utf-8');
			});
			append(this.logPath(), line);
			this.writeAlive();
		} catch {
			// 修复:面包屑失败不得阻断发送
		}
	}

	startHeartbeat(): void {
		this.stopHeartbeat();
		if (!this.opts.enabled()) return;
		const ms = this.opts.heartbeatMs ?? HEARTBEAT_MS;
		this.timer = setInterval(() => {
			if (!this.opts.enabled()) return;
			this.mark('heartbeat', this.lastSessionId);
		}, ms);
		this.timer.unref?.();
	}

	stopHeartbeat(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	setEnabled(enabled: boolean): void {
		if (enabled) this.startHeartbeat();
		else this.stopHeartbeat();
	}

	inspectLastRun(): LastRunDiag | null {
		const alive = this.readLastAlive();
		if (!alive) return null;
		const ts = Date.parse(alive.ts);
		const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : 0;
		const suspectedCrash = shouldSuspectCrash(alive.lastPhase);
		if (suspectedCrash && this.opts.enabled()) {
			const sid = alive.sessionShort && alive.sessionShort !== '-' ? alive.sessionShort : undefined;
			this.mark('crash.suspect', sid, alive.lastPhase);
		}
		return {
			suspectedCrash,
			lastPhase: alive.lastPhase,
			sessionShort: alive.sessionShort,
			ageMs,
			rssMB: alive.rssMB,
			heapMB: alive.heapMB,
			externalMB: alive.externalMB,
			uptimeMs: alive.uptimeMs,
		};
	}

	readRecentLines(limit = 40): string[] {
		try {
			if (!fs.existsSync(this.logPath())) return [];
			const text = fs.readFileSync(this.logPath(), 'utf-8');
			const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
			return lines.slice(-limit);
		} catch {
			return [];
		}
	}

	private readLastAlive(): LastAliveSnapshot | null {
		try {
			if (!fs.existsSync(this.alivePath())) return null;
			const raw = JSON.parse(fs.readFileSync(this.alivePath(), 'utf-8')) as LastAliveSnapshot;
			if (!raw || typeof raw.lastPhase !== 'string') return null;
			return raw;
		} catch {
			return null;
		}
	}

	private writeAlive(): void {
		const mem = this.sampleMemory();
		const snap: LastAliveSnapshot = {
			ts: (this.opts.now ?? (() => new Date()))().toISOString(),
			lastPhase: this.lastPhase ?? 'heartbeat',
			sessionShort: sessionShort(this.lastSessionId),
			rssMB: mem ? bytesToMb(mem.rss) : '-',
			heapMB: mem ? bytesToMb(mem.heapUsed) : '-',
			externalMB: mem ? bytesToMb(mem.external) : '-',
			uptimeMs: this.opts.uptimeMs?.() ?? (Date.now() - this.startedAt),
		};
		fs.writeFileSync(this.alivePath(), JSON.stringify(snap), 'utf-8');
	}

	private sampleMemory(): MemorySample | null {
		try {
			return (this.opts.memoryUsage ?? defaultMemoryUsage)();
		} catch {
			return null;
		}
	}

	private maybeWarnMemory(mem: MemorySample | null): void {
		if (!mem || this.memoryWarned) return;
		const rssMB = bytesToMb(mem.rss);
		const externalMB = bytesToMb(mem.external);
		if (rssMB >= MEMORY_WARN_RSS_MB || externalMB >= MEMORY_WARN_EXTERNAL_MB) {
			this.memoryWarned = true;
			try {
				this.opts.onMemoryHigh?.();
			} catch {
				// 修复:Notice 失败不影响写面包屑
			}
		}
	}

	private ensureDiagDir(): void {
		fs.mkdirSync(this.diagDir(), { recursive: true });
	}

	private rotateIfNeeded(): void {
		try {
			if (!fs.existsSync(this.logPath())) return;
			const size = fs.statSync(this.logPath()).size;
			if (size <= BREADCRUMB_MAX_BYTES) return;
			fs.renameSync(this.logPath(), this.rotatedLogPath());
		} catch {
			// 修复:轮转失败则继续往当前文件追加
		}
	}
}
```

测试只通过 `CrashBreadcrumbs#inspectLastRun()`，不要再导出顶层同名函数。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/logging/breadcrumbs.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/logging/breadcrumbs.ts src/logging/breadcrumbs.test.ts
git commit -m "$(cat <<'EOF'
feat(render-stability): 崩溃面包屑内核落盘与异常退出检测

发送路径崩后只剩磁盘阶段行；先把格式、轮转和 last-alive 判定钉死。
EOF
)"
```

---

### Task 2:设置开关、i18n、gitignore、白名单红线

**Files:**
- Modify: `src/settings.ts`（接口 `debugLog` 旁加 `crashBreadcrumbs`；`DEFAULT_SETTINGS.debugLog` 旁默认 `true`；开发者 group 在 debugLog toggle 后加一项）
- Modify: `src/settings/settings-apply.ts`
- Modify: `src/settings/config-whitelist.ts`（注释红线列表加上 `crashBreadcrumbs`）
- Modify: `tests/settings/config-whitelist.test.ts`（`PRIVILEGE_ESCALATION_KEYS` 加 `'crashBreadcrumbs'`）
- Modify: `src/utils/gitignore-writer.ts`（`RATEL_GITIGNORE_LINES` 加 `'diag/'`）
- Modify: `tests/utils/gitignore-writer.test.ts`（首次写入断言含 `diag/`）
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

**Interfaces:**
- Consumes: Task 1 `CrashBreadcrumbs.setEnabled`
- Produces: `settings.crashBreadcrumbs`、i18n keys 如下

i18n keys（必须三处同步）：

| key | zh | en |
|---|---|---|
| `settings.developer.crashBreadcrumbs.name` | 崩溃面包屑 | Crash breadcrumbs |
| `settings.developer.crashBreadcrumbs.desc` | 把发送各阶段写到插件目录本地日志，不含对话正文。关闭后停止写入，下次启动仍读取历史。 | Write send-path phases to a local plugin log (no message text). Turning off stops writes; next launch still reads history. |
| `diag.lastRun.heading` | 上次运行 | Last run |
| `diag.lastRun.none` | 没有上次运行记录。 | No previous-run record. |
| `diag.lastRun.ok` | 上次正常退出。 | Last run exited cleanly. |
| `diag.lastRun.suspect` | 上次可能异常退出（渲染进程被杀时常见）。 | Last run may have crashed (typical when the renderer is killed). |
| `diag.lastRun.phase` | 最后阶段：{phase} | Last phase: {phase} |
| `diag.lastRun.age` | 距心跳：{seconds} 秒 | Age since heartbeat: {seconds}s |
| `diag.lastRun.memory` | 当时内存 RSS {rss} MB / heap {heap} MB / external {external} MB | Memory then: RSS {rss} MB / heap {heap} MB / external {external} MB |
| `diag.memoryHigh` | Ratel 内存偏高，建议重启 Obsidian。 | Ratel memory is high; restart Obsidian. |

- [ ] **Step 1:写失败测试（白名单 + gitignore）**

在 `tests/settings/config-whitelist.test.ts` 的 `PRIVILEGE_ESCALATION_KEYS` 数组 `debugLog` 后加 `'crashBreadcrumbs'`。

在 `tests/utils/gitignore-writer.test.ts` 的「首次写入」用例里加：

```typescript
expect(content).toContain('diag/');
```

（若现有 it 名是检查 `.index/`，在同一 it 里加一行即可，不要另开英文 it。）

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/settings/config-whitelist.test.ts tests/utils/gitignore-writer.test.ts`

Expected: FAIL（gitignore 首次写入用例不含 `diag/`）。`crashBreadcrumbs` 加入红线数组后白名单测试仍会 PASS（该 key 本来就不在集合里）——不要把「白名单 FAIL」当 RED 信号。

- [ ] **Step 3:接线**

1. `RatelVaultSettings` 在 `debugLog: boolean;` 后：

```typescript
	/** 崩溃面包屑落盘（S-RENDER-STABILITY 分期 A）；默认开，开发者区可关 */
	crashBreadcrumbs: boolean;
```

2. `DEFAULT_SETTINGS`：`debugLog: false,` 后 `crashBreadcrumbs: true,`

3. 开发者 group，`debugLog` toggle 后：

```typescript
					{
						name: tNow('settings.developer.crashBreadcrumbs.name'),
						desc: tNow('settings.developer.crashBreadcrumbs.desc'),
						control: { type: 'toggle', key: 'crashBreadcrumbs' },
					},
```

4. `SettingApplier` 增加可选：

```typescript
	syncCrashBreadcrumbs?(enabled: boolean): void;
```

`applySettingValue` 在 `debugLog` 分支旁：

```typescript
	if (key === 'crashBreadcrumbs') {
		plugin.syncCrashBreadcrumbs?.(value as boolean);
	}
```

5. `config-whitelist.ts` 注释红线改为含 `crashBreadcrumbs`（**不要**把该 key 加进 `CONFIG_UPDATE_WHITELIST`）。

6. `RATEL_GITIGNORE_LINES` 加 `'diag/'`。

7. i18n：`SettingsStrings` 在 `settings.developer.debugLog.name` 后加两个 crashBreadcrumbs key；`DiagnosticsStrings` 在 `'diag.intro'` 后加 `diag.lastRun.*` 与 `diag.memoryHigh`。`zh.ts` / `en.ts` 对应对象同样位置插入上表译文。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/settings/config-whitelist.test.ts tests/utils/gitignore-writer.test.ts src/i18n/strings.test.ts tests/settings/settings-apply.test.ts`

Expected: PASS（`strings.test.ts` 会核对 zh/en key 集合）

- [ ] **Step 5:Commit**

```bash
git add src/settings.ts src/settings/settings-apply.ts src/settings/config-whitelist.ts \
  tests/settings/config-whitelist.test.ts src/utils/gitignore-writer.ts \
  tests/utils/gitignore-writer.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(render-stability): 面包屑开关与诊断文案，diag 目录进 gitignore

默认开启落盘，且不允许 update_app_config 代关。
EOF
)"
```

---

### Task 3:记忆主题空索引 / 未就绪跳过 embed

**Files:**
- Create: `src/core/memory-topics-auto-inject.ts`
- Create: `src/core/memory-topics-auto-inject.test.ts`
- Modify: `src/main.ts`（`ask` 里 `K > 0 && message.trim()` 改为调用纯函数；通过后再 `embed`）

**Interfaces:**
- Produces: `shouldAutoEmbedTopics({ k, message, indexCount, embeddingReady })`

- [ ] **Step 1:写失败测试**

```typescript
/**
 * @file src/core/memory-topics-auto-inject.test.ts
 * @description 记忆主题自动注入 — 空索引与未就绪时跳过 embed
 * @module core/memory-topics-auto-inject.test
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoEmbedTopics } from './memory-topics-auto-inject';

describe('shouldAutoEmbedTopics', () => {
	const ok = { k: 3, message: 'hello', indexCount: 2, embeddingReady: true };

	it('shouldAutoEmbedTopics - 索引有条目且 K>0 且 embedding ready - 允许 embed', () => {
		expect(shouldAutoEmbedTopics(ok)).toBe(true);
	});

	it('shouldAutoEmbedTopics - indexEntries 为空 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, indexCount: 0 })).toBe(false);
	});

	it('shouldAutoEmbedTopics - K 为 0 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, k: 0 })).toBe(false);
	});

	it('shouldAutoEmbedTopics - 消息空白 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, message: '   ' })).toBe(false);
	});

	it('shouldAutoEmbedTopics - embedding 未就绪 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, embeddingReady: false })).toBe(false);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/core/memory-topics-auto-inject.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3:实现纯函数并接到 ask**

`src/core/memory-topics-auto-inject.ts`：

```typescript
/**
 * @file src/core/memory-topics-auto-inject.ts
 * @description 记忆主题自动注入门闩 — 空索引或不就绪时禁止调用 embed
 * @module core/memory-topics-auto-inject
 */

/**
 * 是否应对当前用户消息做 topics 自动检索向量化。
 *
 * 关键路径:index 为空时 search 必然空，仍 embed 会每句打一次 ONNX。
 */
export function shouldAutoEmbedTopics(input: {
	k: number;
	message: string;
	indexCount: number;
	embeddingReady: boolean;
}): boolean {
	return (
		input.k > 0 &&
		input.message.trim().length > 0 &&
		input.indexCount > 0 &&
		input.embeddingReady
	);
}
```

`src/main.ts` 顶部 import `shouldAutoEmbedTopics`。`ask` 中只替换原 `if (K > 0 && message.trim())` 条件，**本 task 不要打面包屑**：

```typescript
				const embeddingReady =
					!(this.embedding instanceof EmbeddingLocal) || this.embedding.isReady;
				if (
					shouldAutoEmbedTopics({
						k: K,
						message,
						indexCount: indexEntries.length,
						embeddingReady,
					})
				) {
					try {
						const vectors = await this.embedding.embed([message]);
						// ... 其余 hits 逻辑保持不动（ask.embed.* 打点在 Task 4）
```

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/core/memory-topics-auto-inject.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/core/memory-topics-auto-inject.ts src/core/memory-topics-auto-inject.test.ts src/main.ts
git commit -m "$(cat <<'EOF'
fix(memory): 主题索引为空或 embedding 未就绪时跳过自动 embed

避免每句对话都打一次 ONNX。
EOF
)"
```

---

### Task 4:主线程 / ChatView / agent-loop 打点

**Files:**
- Modify: `src/types.ts`（`UserChatRequest` 在 `onRetryWait` 旁加 `onBreadcrumb?`）
- Modify: `src/main.ts`（字段、onload、onunload、ask、`syncCrashBreadcrumbs`）
- Modify: `src/core/agent-loop.ts`（读 `req.onBreadcrumb`，**不**新增位置参数）
- Modify: `tests/core/agent-loop.test.ts`（新 it）
- Modify: `src/ui/chat/ChatView.svelte`

**Interfaces:**
- Consumes: `CrashBreadcrumbs`、`LastRunDiag`、`shouldAutoEmbedTopics`
- Produces: `plugin.breadcrumbs`、`plugin.lastRunDiag`、`plugin.memoryHigh`、`UserChatRequest.onBreadcrumb`

- [ ] **Step 1:写失败测试（agent-loop 回调顺序）**

在 `tests/core/agent-loop.test.ts` 的 `describe('agentLoop'` 内追加（与现有 `onRetryWait` 测法相同，挂在 req 上）：

```typescript
	it('onBreadcrumb - 无工具纯文本回合 - 依次 load/classify/request/first-delta', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence, undefined, 8000);
		const llm = createMockLLM([[{ text: 'Hi' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const phases: string[] = [];
		const classifier = async () => 'direct' as const;

		for await (const _ of agentLoop(
			{
				sessionId: 'session-abcdef',
				message: 'Hi',
				onBreadcrumb: (phase, n) => {
					phases.push(n === undefined ? phase : `${phase}:${n}`);
				},
			},
			ctx,
			llm,
			tools,
			hooks,
			undefined,
			classifier,
		)) {
			/* drain */
		}

		expect(phases.filter((p) => p.startsWith('loop.load'))[0]).toBeDefined();
		expect(phases).toContain('loop.classify');
		expect(phases.some((p) => p.startsWith('llm.request'))).toBe(true);
		expect(phases.some((p) => p.startsWith('llm.first-delta'))).toBe(true);
		const iLoad = phases.findIndex((p) => p.startsWith('loop.load'));
		const iCls = phases.indexOf('loop.classify');
		const iReq = phases.findIndex((p) => p.startsWith('llm.request'));
		const iDelta = phases.findIndex((p) => p.startsWith('llm.first-delta'));
		expect(iLoad).toBeLessThan(iCls);
		expect(iCls).toBeLessThan(iReq);
		expect(iReq).toBeLessThan(iDelta);
	});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/agent-loop.test.ts -t 'onBreadcrumb'`

Expected: FAIL（`req.onBreadcrumb` 未被调用，`phases` 为空）

- [ ] **Step 3:接线**

**`src/types.ts`** — 文件头增加 `import type { BreadcrumbPhase } from './logging/breadcrumbs';`（`import type` 不会把 `fs` 打进运行时）。`UserChatRequest.onRetryWait` 后：

```typescript
	/**
	 * 崩溃面包屑打点（S-RENDER-STABILITY A）。agent-loop 不 import fs。
	 */
	onBreadcrumb?: (phase: BreadcrumbPhase, n?: string | number) => void;
```

**agent-loop.ts** — **不要**给函数再加第 13 参。在现有参数列表之后用局部变量：

```typescript
	const onBreadcrumb = req.onBreadcrumb;
```

文件头：`import type { BreadcrumbPhase } from '../logging/breadcrumbs';` 仅当本文件要标注类型时才加；直接调 `req.onBreadcrumb?.(...)` 即可，字面量会被 `BreadcrumbPhase` 约束。

在 `await ctx.load(req.sessionId);` 之后：

```typescript
	onBreadcrumb?.('loop.load', ctx.getTranscript().length);
```

在意图分类得到最终 `intent` 之后、步循环 `try {` 之前：

```typescript
	onBreadcrumb?.('loop.classify');
```

无 classifier 时也打（表示已过分类阶段，intent 为默认 `direct`）。

在 `const stream = llm.chat({` **之前**：

```typescript
				onBreadcrumb?.('llm.request', step);
				let sawFirstDelta = false;
```

在 `for await (const delta of stream)` 内，处理 text/reasoning/toolCall 之前：

```typescript
					if (!sawFirstDelta && (delta.text || delta.reasoning || delta.toolCall)) {
						sawFirstDelta = true;
						onBreadcrumb?.('llm.first-delta', step);
					}
```

在 `for (const tc of toolCalls)` 循环开头：

```typescript
				onBreadcrumb?.('loop.tool', `${step}:${tc.name}`);
```

**main.ts**

1. import `CrashBreadcrumbs`、`LastRunDiag`（`tNow` 已从 `./i18n` 引入，勿重复）。
2. 类字段（`attachments` 旁）：

```typescript
	/** 崩溃面包屑（S-RENDER-STABILITY A）— onload 装配；可选链避免中途失败 */
	breadcrumbs?: CrashBreadcrumbs;
	lastRunDiag: LastRunDiag | null = null;
	memoryHigh = false;
```

3. `onload` 在 `ensurePluginGitignore(pluginDir);` 之后：

```typescript
		this.breadcrumbs = new CrashBreadcrumbs({
			pluginDir,
			enabled: () => this.settings.crashBreadcrumbs !== false,
			onMemoryHigh: () => {
				this.memoryHigh = true;
				new Notice(tNow('diag.memoryHigh'));
			},
		});
		this.lastRunDiag = this.breadcrumbs.inspectLastRun();
		this.breadcrumbs.mark('plugin.load');
		this.breadcrumbs.startHeartbeat();
```

4. 类方法：

```typescript
	syncCrashBreadcrumbs(enabled: boolean): void {
		this.breadcrumbs?.setEnabled(enabled);
	}
```

5. `onunload` **最前**（字段可能未初始化，用可选链）：

```typescript
		this.breadcrumbs?.mark('plugin.unload');
		this.breadcrumbs?.stopHeartbeat();
```

6. `ask`：在 `const ctx = new ContextManager(...)` 之后、goal/env/skills/memory 注入之前：

```typescript
		this.breadcrumbs?.mark('ask.begin', sessionId);
```

`try` 已包住 agentLoop；在现有 `finally`（`finalizeAskRound`）**开头**：

```typescript
			const failed = collectedEvents.some((e) => e.type === 'error');
			if (failed) this.breadcrumbs?.mark('ask.error', sessionId);
			this.breadcrumbs?.mark('ask.end', sessionId);
```

`shouldAutoEmbedTopics` 为 true 时，`embed` 前后：

```typescript
						this.breadcrumbs?.mark('ask.embed.begin', sessionId, 1);
						const vectors = await this.embedding.embed([message]);
						this.breadcrumbs?.mark('ask.embed.end', sessionId, 1);
```

`catch (embedErr)` 不要打 `ask.end`（由 finally 统一打）。

构造 `agentLoop` 的 req 时与 `onRetryWait` 并列：

```typescript
					{
						sessionId,
						message,
						attachments,
						modelMessage: opts?.modelMessage,
						onRetryWait: opts?.onRetryWait,
						onBreadcrumb: (phase, n) => this.breadcrumbs?.mark(phase, sessionId, n),
					},
```

**ChatView.svelte** `sendMessage`：

- `if (!currentGate.canSend) return;` 之后：`plugin.breadcrumbs?.mark('send.enqueue', sessionId);`
- `await preCtx.load(sessionId);` 之后：`plugin.breadcrumbs?.mark('send.precheck', sessionId, preCtx.getTranscript().length);`
- 两处 `await runCompactInChat({ auto: true })` 之前：`plugin.breadcrumbs?.mark('send.compact', sessionId);`

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/agent-loop.test.ts src/logging/breadcrumbs.test.ts src/core/memory-topics-auto-inject.test.ts`

Expected: PASS。不要求 Svelte 组件测。

- [ ] **Step 5:Commit**

```bash
git add src/main.ts src/core/agent-loop.ts tests/core/agent-loop.test.ts src/ui/chat/ChatView.svelte
git commit -m "$(cat <<'EOF'
feat(render-stability): 发送与 Agent Loop 各阶段写入崩溃面包屑

渲染进程被杀后仍能从插件目录读出最后停在哪一段。
EOF
)"
```

---

### Task 5:诊断页「上次运行」+ 反馈摘要 40 行 + 内存横幅

**Files:**
- Modify: `src/ui/settings/diagnostics-setting-page.ts`
- Modify: `src/ui/chat/feedback-modal.ts`
- Create: `tests/ui/chat/feedback-diagnostics.test.ts`（若仓库无 feedback 单测；测纯函数即可）

**Interfaces:**
- Consumes: `plugin.lastRunDiag`、`plugin.memoryHigh`、`plugin.breadcrumbs.readRecentLines(40)`
- Produces: `buildFeedbackDiagnostics` 增加可选 `recentBreadcrumbs?: string[]`

- [ ] **Step 1:写失败测试**

创建 `tests/ui/chat/feedback-diagnostics.test.ts`：

```typescript
/**
 * @file tests/ui/chat/feedback-diagnostics.test.ts
 * @description 反馈诊断摘要 — 可附最近面包屑且不含笔记正文
 * @module tests/ui/chat/feedback-diagnostics
 */

import { describe, it, expect } from 'vitest';
import { buildFeedbackDiagnostics } from '../../../src/ui/chat/feedback-modal';

const plugin = {
	app: { appVersion: '1.13.0' },
	manifest: { version: '0.0.0-test', id: 'ratel-vault' },
	settings: { chatModel: 'm', embedProvider: 'local' as const, language: 'zh' },
};

describe('buildFeedbackDiagnostics', () => {
	it('buildFeedbackDiagnostics - 传入面包屑 - 附在末尾且不含用户消息', () => {
		const text = buildFeedbackDiagnostics(plugin as never, [
			'2026-09-15T03:06:00.000Z|ask.begin|537425|-|10|4|2',
		]);
		expect(text).toContain('Breadcrumbs (last 40, no message text):');
		expect(text).toContain('ask.begin|537425');
		expect(text).not.toContain('请帮我总结');
	});

	it('buildFeedbackDiagnostics - 无面包屑 - 行为与原来一致不含 Breadcrumbs 段', () => {
		const text = buildFeedbackDiagnostics(plugin as never);
		expect(text).not.toContain('Breadcrumbs');
		expect(text).toContain('Embed: local');
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/ui/chat/feedback-diagnostics.test.ts`

Expected: FAIL（`buildFeedbackDiagnostics` 只接受 1 个参数 / 无 Breadcrumbs 段）

- [ ] **Step 3:实现**

`buildFeedbackDiagnostics(plugin, recentBreadcrumbs?: string[])`：在现有 `<!-- 请描述... -->` **之前**若数组非空则插入：

```
Breadcrumbs (last 40, no message text):
<逐行>
```

`FeedbackModal.onOpen`：

```typescript
		const recent = this.plugin.breadcrumbs?.readRecentLines(40) ?? [];
		const diag = buildFeedbackDiagnostics(this.plugin, recent);
```

`PluginLike` 增加可选 `breadcrumbs?: { readRecentLines(limit?: number): string[] }`。

`DiagnosticsSettingPage.display()` 在 intro `<p>` 之后、`createTabBar` 之前：

```typescript
		if (this.plugin.memoryHigh) {
			containerEl.createEl('p', {
				text: tNow('diag.memoryHigh'),
				cls: 'ratel-diag-memory-banner',
				attr: { style: 'color: var(--text-warning); margin-bottom: 12px;' },
			});
		}

		containerEl.createEl('h3', { text: tNow('diag.lastRun.heading') });
		const last = this.plugin.lastRunDiag;
		if (!last) {
			containerEl.createEl('p', { text: tNow('diag.lastRun.none') });
		} else {
			containerEl.createEl('p', {
				text: tNow(last.suspectedCrash ? 'diag.lastRun.suspect' : 'diag.lastRun.ok'),
			});
			containerEl.createEl('p', {
				text: tNow('diag.lastRun.phase', { phase: last.lastPhase }),
			});
			containerEl.createEl('p', {
				text: tNow('diag.lastRun.age', { seconds: Math.floor(last.ageMs / 1000) }),
			});
			containerEl.createEl('p', {
				text: tNow('diag.lastRun.memory', {
					rss: String(last.rssMB),
					heap: String(last.heapMB),
					external: String(last.externalMB),
				}),
			});
		}
```

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/ui/chat/feedback-diagnostics.test.ts src/i18n/strings.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/ui/settings/diagnostics-setting-page.ts src/ui/chat/feedback-modal.ts \
  tests/ui/chat/feedback-diagnostics.test.ts
git commit -m "$(cat <<'EOF'
feat(render-stability): 诊断页展示上次运行，反馈摘要附带面包屑

白屏之后用户能复制最后阶段，而不必打开 Console。
EOF
)"
```

---

### Task 6:隐私与 user-guide 一句（spec §5）

**Files:**
- Modify: `README.md`（Privacy 表加一行）
- Modify: `README.zh-CN.md`（隐私表加一行）
- Modify: `docs/user-guide.md`（§10 高级 / §12 隐私）

- [ ] **Step 1:改文档（无单测，人工对照 spec §5）**

`README.zh-CN.md` 表在「遥测 | 无」前插入：

```
| 崩溃面包屑 | 仅写入本机插件目录 `diag/`，不含对话正文；默认开，开发者区可关 |
```

`README.md`：

```
| Crash breadcrumbs | Written only under the local plugin `diag/` folder, no message text; on by default, toggle in Developer |
```

`docs/user-guide.md` §10 高级行保持，另在诊断相关处（「高级」那行后）加一句：

```
诊断页顶部会显示「上次运行」：若上次 Obsidian 白屏，这里能看到最后停在发送路径的哪一阶段，以及当时 RSS/heap/external。抽屉「反馈」复制诊断会附带最近 40 行面包屑（仍无笔记正文）。
```

§12 隐私加一条：

```
- 崩溃面包屑只存在本机插件目录，默认开启，可在设置 → 高级 → 开发者关闭
```

- [ ] **Step 2:Commit**

```bash
git add README.md README.zh-CN.md docs/user-guide.md
git commit -m "$(cat <<'EOF'
docs: 说明崩溃面包屑只存本地、不含正文

与诊断页「上次运行」行为对齐，避免被当成遥测。
EOF
)"
```

---

## 自审（2026-09-15 对照 spec + 现网代码后已改 plan）

**Spec 覆盖（分期 A）：**

| spec | task |
|---|---|
| §4.1 行格式 / 阶段枚举 / 同步 append / 256KB 轮转 / last-alive / 终态 / 开关 | 1, 2, 4 |
| §4.1 心跳不覆盖 `lastPhase`（spec 已同步澄清） | 1 |
| §4.1 onload 检测 + 诊断页 + 复制 40 行 | 5 |
| §4.2 4096 / 1536 一次 Notice + 诊断横幅 | 1 + 4 + 5 |
| §4.5 空索引 / K<=0 / embedding 未 ready 不 embed | 3 |
| §4.3 单次 load | **不做**（分期 B） |
| §4.4 Worker 生命周期 | **不做**（分期 B） |
| §5 README / user-guide | 6 |
| 不改 architecture / AgentEvent | Global Constraints |

**本轮已修的 plan 缺陷：**

1. 心跳若 `mark` 进 `lastPhase`，空闲 30s 后下次启动必误报崩溃 → 心跳只刷新 `ts`/内存
2. `crash.suspect` 必须带回 `last-alive.sessionShort`，否则对不上 `crash.suspect\|abcdef\|llm.request`
3. `onBreadcrumb` 改挂 `UserChatRequest`，不再给 `agentLoop` 加第 13 参
4. Task 3 不再提前打 `ask.embed.*`；`ask.begin` 只放在 ctx 构造成功之后
5. Task 2 的 RED 以 gitignore 为准（白名单加红线数组不会红）

**刻意不做 / 可接受偏差：**

- spec「状态条一次性 Notice」落地为 Obsidian `Notice` 吐司，不进 StatusStrip
- spec `plugin.diagnostics` 落地为 `lastRunDiag` + `memoryHigh` + `readRecentLines`
- §4.6「空索引时 embed 不被调用」测纯函数门闩，不 spy `main.ask`
- 反馈摘要里 `Breadcrumbs (last 40, ...)` 与现有 `Chat model:` 一样用英文诊断块，不走 i18n

**占位扫描：** 无 TBD / 「similar to Task N」。

**类型一致：** `CrashBreadcrumbs` / `LastRunDiag` / `BreadcrumbPhase` / `shouldAutoEmbedTopics` / `UserChatRequest.onBreadcrumb` 贯穿 Task 1–5。

**验证（全部 task 完成后）：**

```bash
npx vitest run src/logging/breadcrumbs.test.ts src/core/memory-topics-auto-inject.test.ts \
  tests/core/agent-loop.test.ts tests/ui/chat/feedback-diagnostics.test.ts \
  tests/settings/config-whitelist.test.ts tests/utils/gitignore-writer.test.ts \
  src/i18n/strings.test.ts
```

本地预览：Sandbox `link:vault` 后 Reload app without saving，发一条消息，确认 `<sandbox>/.obsidian/plugins/ratel-vault/diag/breadcrumbs.log` 出现 `send.enqueue` → `ask.begin` → `ask.end`。禁止动日常主库。

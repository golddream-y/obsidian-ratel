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

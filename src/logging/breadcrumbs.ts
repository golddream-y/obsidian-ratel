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

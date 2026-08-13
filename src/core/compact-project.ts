/**
 * @file src/core/compact-project.ts
 * @description 上下文投影 — microcompact、全量摘要 head、PTL 检测与自动压断路器
 * @module core/compact-project
 * @depends ports/llm, ports/persistence, tool-message-align
 */

import type { ChatMessage } from '../ports/llm';
import type { CompactMarker } from '../ports/persistence';
import { sanitizeToolMessageOrder } from './tool-message-align';

/** 保留最近 N 条 tool 结果不折叠 */
export const KEEP_RECENT_TOOL_RESULTS = 5;
/** 摘要区间最多注入的读笔记路径数 */
export const MAX_RESTORED_NOTE_PATHS = 5;
/** 自动压缩触发阈值(上下文占用百分比) */
export const AUTO_COMPACT_THRESHOLD_PCT = 85;
/** 连续失败次数达此值则断路 */
export const AUTO_COMPACT_CIRCUIT_LIMIT = 3;
/** 投影 tail 过短时不做全量摘要 */
export const MIN_TRANSCRIPT_TO_COMPACT = 3;
/** 全量摘要 system 消息前缀 */
export const COMPACT_SUMMARY_PREFIX = '[compact 摘要]\n';

/** 可 microcompact 的工具名 */
export const FOLDABLE_TOOL_NAMES = new Set([
	'read_note',
	'search_vault',
	'grep',
	'glob',
	'list_files',
	'search_memory',
]);

/** 投影结果:head 为摘要 system,tail 为 microcompact 后的原文窗口 */
export interface ProjectedTranscript {
	head: ChatMessage[];
	tail: ChatMessage[];
}

const PTL_PATTERN = /prompt too long|context length|maximum context|上下文过长|too many tokens/i;

/**
 * 从 tool 消息下标向前找配对 assistant,取 toolName / toolArgs。
 *
 * @param messages - 完整消息序列
 * @param toolIndex - role=tool 的下标
 * @returns 工具元数据;找不到配对则 null
 */
export function resolveToolMeta(
	messages: ChatMessage[],
	toolIndex: number,
): { name: string; args: Record<string, unknown> } | null {
	const tool = messages[toolIndex];
	if (!tool || tool.role !== 'tool' || !tool.toolCallId) return null;
	const id = tool.toolCallId;
	for (let i = toolIndex - 1; i >= 0; i--) {
		const prev = messages[i]!;
		if (prev.role === 'tool') continue;
		if (prev.role === 'assistant' && prev.toolCallId === id && prev.toolName) {
			return { name: prev.toolName, args: prev.toolArgs ?? {} };
		}
		return null;
	}
	return null;
}

/**
 * 生成折叠后的 tool 占位正文(面向模型,不走 i18n)。
 *
 * @param name - 工具名
 * @param args - 工具参数
 * @param chars - 折叠前 content.length
 */
export function formatCompactedPlaceholder(
	name: string,
	args: Record<string, unknown>,
	chars: number,
): string {
	const path = args.path;
	const pathPart =
		typeof path === 'string' && path.trim() ? ` path=${path.trim()}` : '';
	return `[compacted] ${name}${pathPart} chars=${chars}`;
}

/**
 * 对 tool 结果做 microcompact — 旧的可折叠工具正文换占位,不改其它字段。
 *
 * @param messages - 待处理消息(浅拷贝输出)
 * @param keepRecent - 保留最近几条 tool 不折叠,默认 KEEP_RECENT_TOOL_RESULTS
 */
export function microcompactMessages(
	messages: ChatMessage[],
	keepRecent = KEEP_RECENT_TOOL_RESULTS,
): ChatMessage[] {
	const out = messages.map((m) => ({ ...m }));
	const toolIndices: number[] = [];
	for (let i = 0; i < out.length; i++) {
		if (out[i]!.role === 'tool') toolIndices.push(i);
	}
	const foldCount = Math.max(0, toolIndices.length - keepRecent);
	const toFold = toolIndices.slice(0, foldCount);
	for (const idx of toFold) {
		const msg = out[idx]!;
		if (msg.content.startsWith('Error:')) continue;
		const meta = resolveToolMeta(out, idx);
		if (!meta || !FOLDABLE_TOOL_NAMES.has(meta.name)) continue;
		const chars = msg.content.length;
		out[idx] = { ...msg, content: formatCompactedPlaceholder(meta.name, meta.args, chars) };
	}
	return out;
}

/**
 * 从区间内提取最近读过的笔记路径(近者优先、去重、最多 MAX_RESTORED_NOTE_PATHS)。
 *
 * @param messages - 完整消息序列
 * @param from - 起始下标(含)
 * @param toInclusive - 结束下标(含)
 */
export function extractRestoredNotePaths(
	messages: ChatMessage[],
	from: number,
	toInclusive: number,
): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (let i = toInclusive; i >= from; i--) {
		const m = messages[i];
		if (!m || m.role !== 'assistant' || m.toolName !== 'read_note') continue;
		const path = m.toolArgs?.path;
		if (typeof path !== 'string' || !path.trim()) continue;
		const trimmed = path.trim();
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		paths.push(trimmed);
		if (paths.length >= MAX_RESTORED_NOTE_PATHS) break;
	}
	return paths;
}

/**
 * 组装投影:最近 marker 摘要进 head,tail 从 afterIndex+1 起再 microcompact。
 *
 * @param messages - UI 事实源 messages
 * @param markers - 全量压缩标记;缺省则投影全文
 */
export function projectView(
	messages: ChatMessage[],
	markers: CompactMarker[] | undefined,
): ProjectedTranscript {
	const latest = markers?.at(-1);
	if (!latest) {
		return {
			head: [],
			tail: sanitizeToolMessageOrder(microcompactMessages(messages)),
		};
	}
	const head: ChatMessage[] = [
		{
			role: 'system',
			content: COMPACT_SUMMARY_PREFIX + latest.summary,
		},
	];
	if (latest.restoredNotePaths.length > 0) {
		const lines = latest.restoredNotePaths.map((p) => `- ${p}`).join('\n');
		head.push({
			role: 'system',
			content: `最近读过的笔记（按需 read_note）:\n${lines}`,
		});
	}
	const tailSlice = messages.slice(latest.afterIndex + 1);
	const tail = sanitizeToolMessageOrder(microcompactMessages(tailSlice));
	return { head, tail };
}

/**
 * 判断 LLM 错误是否为上下文过长(413 / 文案匹配)。
 *
 * @param err - 捕获的 unknown 错误
 */
export function isPromptTooLong(err: unknown): boolean {
	if (typeof err === 'object' && err !== null && 'status' in err) {
		if ((err as { status: unknown }).status === 413) return true;
	}
	const message =
		err instanceof Error
			? err.message
			: typeof err === 'object' && err !== null && 'message' in err
				? String((err as { message: unknown }).message)
				: String(err);
	return PTL_PATTERN.test(message);
}

/**
 * 是否应触发自动压缩。
 *
 * @param percentage - 上下文占用百分比
 * @param enabled - 设置开关
 * @param circuitOpen - 本会话断路器是否已开
 */
export function shouldAutoCompact(
	percentage: number,
	enabled: boolean,
	circuitOpen: boolean,
): boolean {
	return enabled && !circuitOpen && percentage >= AUTO_COMPACT_THRESHOLD_PCT;
}

/**
 * 自动压缩断路器 — 进程内 Map,连续失败达限则 open,succeed 清零。
 */
export class CompactCircuitBreaker {
	private readonly failures = new Map<string, number>();

	/**
	 * 记录一次 compact 失败。
	 *
	 * @param sessionId - 会话 id
	 */
	fail(sessionId: string): void {
		const n = (this.failures.get(sessionId) ?? 0) + 1;
		this.failures.set(sessionId, n);
	}

	/**
	 * compact 成功,清除失败计数。
	 *
	 * @param sessionId - 会话 id
	 */
	succeed(sessionId: string): void {
		this.failures.delete(sessionId);
	}

	/**
	 * 本会话是否已达断路阈值。
	 *
	 * @param sessionId - 会话 id
	 */
	isOpen(sessionId: string): boolean {
		return (this.failures.get(sessionId) ?? 0) >= AUTO_COMPACT_CIRCUIT_LIMIT;
	}
}

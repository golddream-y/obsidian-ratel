/**
 * @file src/tools/note-agents.ts
 * @description 笔记 AGENTS.md 约束链：目录顺序、UTF-8 截断、拼接与本轮已见记录
 * @module tools/note-agents
 */

import { tNow } from '../i18n';
import type { ToolCall } from '../ports/llm';
import { peekUpdateFilePath } from './apply-patch-text';
import { validateVaultPath } from '../utils/path-safety';

export const AGENTS_FILE_NAME = 'AGENTS.md';
export const AGENTS_FILE_MAX_BYTES = 8192;
export const AGENTS_CHAIN_MAX_BYTES = 16384;

const PRIORITY_NOTE =
	'同一件事冲突时，离笔记更近的优先。用户这一轮的明确指令优先于这些文件。';
const NOTE_AGENTS_TOUCH = [
	'read_note', 'write_note', 'append_note', 'edit_note', 'delete_note',
	'apply_patch', 'move_note', 'copy_note',
] as const;

const BLOCK_HEADER =
	'[目录约束 AGENTS.md] 下面是本次路径所在目录的约束，本会话内持续有效；同一目录之后再出现新版本时以新版本为准。';

/**
 * 计算字符串的 UTF-8 字节长度。
 */
function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * 从库根到笔记所在目录的链（含库根 `''`）。
 *
 * @param notePath - 库内相对路径
 * @returns 目录段，根在前、近的在后
 */
export function agentsChainDirs(notePath: string): string[] {
	const parts = notePath.split(/[/\\]/).filter((p) => p.length > 0 && p !== '.');
	if (parts.length > 0) {
		parts.pop();
	}
	const dirs: string[] = [''];
	let acc = '';
	for (const part of parts) {
		acc = acc ? `${acc}/${part}` : part;
		dirs.push(acc);
	}
	return dirs;
}

/**
 * 链上除库根外的目录段。
 */
export function nestedDirs(notePath: string): string[] {
	return agentsChainDirs(notePath).filter((d) => d !== '');
}

/**
 * 按 UTF-8 字节上限截断文本，不在多字节字符中间切断。
 */
export function truncateUtf8(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) {
		return { text, truncated: false };
	}
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
		end--;
	}
	return {
		text: new TextDecoder().decode(bytes.subarray(0, end)),
		truncated: true,
	};
}

/**
 * 拼接多层约束正文：先单文件截断，再按合计从最远一层丢弃直至 ≤ 链上限。
 */
/**
 * 从工具调用参数收集本次碰到的库内笔记路径（校验失败则丢弃）。
 */
export function touchedNotePaths(tc: ToolCall): string[] {
	if (!(NOTE_AGENTS_TOUCH as readonly string[]).includes(tc.name)) return [];
	const raw: string[] = [];
	if (tc.name === 'apply_patch') {
		const path = typeof tc.args.patch === 'string' ? peekUpdateFilePath(tc.args.patch) : undefined;
		if (path) raw.push(path);
	} else if (tc.name === 'move_note') {
		if (typeof tc.args.from === 'string') raw.push(tc.args.from);
		if (typeof tc.args.to === 'string') raw.push(tc.args.to);
	} else if (tc.name === 'copy_note') {
		if (typeof tc.args.to === 'string') raw.push(tc.args.to);
	} else if (typeof tc.args.path === 'string') {
		raw.push(tc.args.path);
	}
	const out: string[] = [];
	for (const path of raw) {
		try {
			out.push(validateVaultPath(path));
		} catch {
			// 非法路径交给工具自己报错
		}
	}
	return out;
}

/**
 * 成功改写 AGENTS.md 后，需要作废已加载版本的子目录列表（不含库根）。
 */
export function staleAgentsDirs(paths: string[]): string[] {
	const out: string[] = [];
	for (const path of paths) {
		const parts = path.split(/[/\\]/).filter((p) => p.length > 0);
		if (parts.at(-1) !== 'AGENTS.md') continue;
		const dir = nestedDirs(path).at(-1);
		if (dir && !out.includes(dir)) out.push(dir);
	}
	return out;
}

/**
 * 拼接子目录约束块：单文件 8KB、整块 16KB；丢光所有层则返回 undefined。
 */
export function joinAgentsBlock(
	layers: { dir: string; text: string }[],
): { dirs: string[]; text: string } | undefined {
	if (layers.length === 0) return undefined;
	// 关键路径:单层原文超过整块上限时无法形成有效块,不挂块(§6.2 丢光)
	if (layers.length === 1 && utf8ByteLength(layers[0]!.text) > AGENTS_CHAIN_MAX_BYTES) {
		return undefined;
	}
	let truncated = false;
	let remaining = layers.map((layer) => {
		const cut = truncateUtf8(layer.text, AGENTS_FILE_MAX_BYTES);
		if (cut.truncated) truncated = true;
		return { dir: layer.dir, text: cut.text };
	});
	const assemble = (rows: { dir: string; text: string }[], cut: boolean) => {
		const body = rows.map((l) => `## ${l.dir}\n${l.text}`).join('\n\n');
		const parts = [BLOCK_HEADER, body, PRIORITY_NOTE];
		if (cut) parts.push(tNow('noteAgents.truncated'));
		return parts.join('\n\n');
	};
	while (remaining.length > 0) {
		const text = assemble(remaining, truncated);
		if (utf8ByteLength(text) <= AGENTS_CHAIN_MAX_BYTES) {
			return { dirs: remaining.map((l) => l.dir), text };
		}
		remaining = remaining.slice(1);
		truncated = true;
	}
	return undefined;
}

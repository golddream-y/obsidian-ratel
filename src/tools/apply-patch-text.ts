/**
 * @file src/tools/apply-patch-text.ts
 * @description Codex Update File 补丁的解析与字符串套用（不访问 Vault）
 * @module tools/apply-patch
 */

export type PatchOp = { kind: 'context' | 'delete' | 'insert'; text: string };

export type PatchHunk = { ops: PatchOp[]; eof: boolean };

export type PatchReason =
	| 'parse'
	| 'multi'
	| 'add'
	| 'delete'
	| 'move'
	| 'empty'
	| 'mismatch'
	| 'ambiguous'
	| 'eof';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const UPDATE_PREFIX = '*** Update File:';
const ADD_PREFIX = '*** Add File';
const DELETE_PREFIX = '*** Delete File';
const MOVE_PREFIX = '*** Move to';
const EOF_MARKER = '*** End of File';

function splitPatchLines(patch: string): string[] {
	return patch.replace(/\r\n/g, '\n').split('\n');
}

function hunkHasChange(ops: PatchOp[]): boolean {
	return ops.some((op) => op.kind === 'insert' || op.kind === 'delete');
}

/**
 * 从补丁中取出唯一的 Update File 路径（不要求其余语法合法）。
 *
 * @param patch - 补丁全文
 * @returns 恰好一条非空 Update File 路径时返回该路径，否则 undefined
 */
export function peekUpdateFilePath(patch: string): string | undefined {
	const lines = splitPatchLines(patch);
	const paths: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(UPDATE_PREFIX)) continue;
		const path = trimmed.slice(UPDATE_PREFIX.length).trim();
		if (path) paths.push(path);
	}
	return paths.length === 1 ? paths[0] : undefined;
}

/**
 * 解析仅含一个 Update File 的 Codex 补丁。
 *
 * @param patch - 补丁全文
 * @returns 成功时返回路径与 hunk 列表；失败时返回原因码
 */
export function parseUpdatePatch(
	patch: string,
): { ok: true; path: string; hunks: PatchHunk[] } | { ok: false; reason: PatchReason } {
	const lines = splitPatchLines(patch);
	let i = 0;
	while (i < lines.length && lines[i]!.trim() === '') i++;
	if (i >= lines.length || lines[i]!.trim() !== BEGIN) {
		return { ok: false, reason: 'parse' };
	}
	i++;

	let path: string | undefined;
	const hunks: PatchHunk[] = [];
	let current: PatchHunk | null = null;
	let sawUpdate = false;

	for (; i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();

		if (trimmed === END) {
			i++;
			for (; i < lines.length; i++) {
				if (lines[i]!.trim() !== '') return { ok: false, reason: 'parse' };
			}
			if (!path || hunks.length === 0) return { ok: false, reason: 'parse' };
			for (const hunk of hunks) {
				if (!hunkHasChange(hunk.ops)) return { ok: false, reason: 'empty' };
			}
			return { ok: true, path, hunks };
		}

		if (trimmed.startsWith(ADD_PREFIX)) return { ok: false, reason: 'add' };
		if (trimmed.startsWith(DELETE_PREFIX)) return { ok: false, reason: 'delete' };
		if (trimmed.startsWith(MOVE_PREFIX)) return { ok: false, reason: 'move' };

		if (trimmed.startsWith(UPDATE_PREFIX)) {
			const p = trimmed.slice(UPDATE_PREFIX.length).trim();
			if (!p) return { ok: false, reason: 'parse' };
			if (path) return { ok: false, reason: 'multi' };
			path = p;
			sawUpdate = true;
			current = null;
			continue;
		}

		if (!sawUpdate) return { ok: false, reason: 'parse' };

		if (trimmed.startsWith('@@')) {
			current = { ops: [], eof: false };
			hunks.push(current);
			continue;
		}

		if (!current) return { ok: false, reason: 'parse' };

		if (trimmed === EOF_MARKER) {
			current.eof = true;
			continue;
		}

		if (raw.startsWith(' ')) {
			current.ops.push({ kind: 'context', text: raw.slice(1) });
		} else if (raw.startsWith('-')) {
			current.ops.push({ kind: 'delete', text: raw.slice(1) });
		} else if (raw.startsWith('+')) {
			current.ops.push({ kind: 'insert', text: raw.slice(1) });
		} else {
			return { ok: false, reason: 'parse' };
		}
	}

	return { ok: false, reason: 'parse' };
}

function splitContentLines(content: string): { lines: string[]; trailingNewline: boolean } {
	if (content === '') return { lines: [], trailingNewline: false };
	const trailingNewline = content.endsWith('\n');
	const parts = content.split('\n');
	if (trailingNewline) parts.pop();
	return { lines: parts, trailingNewline };
}

function joinContentLines(lines: string[], trailingNewline: boolean): string {
	if (lines.length === 0) return trailingNewline ? '\n' : '';
	return lines.join('\n') + (trailingNewline ? '\n' : '');
}

function matchPattern(lines: string[], pattern: string[], from: number): boolean {
	if (from + pattern.length > lines.length) return false;
	for (let j = 0; j < pattern.length; j++) {
		if (lines[from + j] !== pattern[j]) return false;
	}
	return true;
}

function findUniqueMatch(
	lines: string[],
	pattern: string[],
	eof: boolean,
): { ok: true; start: number } | { ok: false; reason: PatchReason } {
	const hits: number[] = [];
	for (let i = 0; i <= lines.length - pattern.length; i++) {
		if (matchPattern(lines, pattern, i)) hits.push(i);
	}
	if (hits.length === 0) return { ok: false, reason: 'mismatch' };
	if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
	const start = hits[0]!;
	if (eof && start + pattern.length !== lines.length) {
		return { ok: false, reason: 'eof' };
	}
	return { ok: true, start };
}

function applyOneHunk(
	lines: string[],
	hunk: PatchHunk,
): { ok: true; lines: string[] } | { ok: false; reason: PatchReason } {
	const pattern: string[] = [];
	for (const op of hunk.ops) {
		if (op.kind === 'context' || op.kind === 'delete') pattern.push(op.text);
	}
	// 只有插入、没有上下文或删除行时，没有锚点，不能猜插在哪。
	if (pattern.length === 0) return { ok: false, reason: 'mismatch' };
	const located = findUniqueMatch(lines, pattern, hunk.eof);
	if (!located.ok) return located;

	let pos = located.start;
	const out = lines.slice(0, pos);
	for (const op of hunk.ops) {
		if (op.kind === 'insert') {
			out.push(op.text);
		} else if (op.kind === 'context') {
			out.push(lines[pos]!);
			pos += 1;
		} else {
			pos += 1;
		}
	}
	out.push(...lines.slice(pos));
	return { ok: true, lines: out };
}

/**
 * 按顺序把多个 hunk 套到文件全文上。
 *
 * @param content - 原始全文
 * @param hunks - 已解析的 hunk 列表
 * @returns 成功时返回新全文；任一 hunk 失败则整次失败
 */
export function applyUpdateHunks(
	content: string,
	hunks: PatchHunk[],
): { ok: true; content: string } | { ok: false; reason: PatchReason } {
	const { lines: initial, trailingNewline } = splitContentLines(content);
	let lines = initial;
	for (const hunk of hunks) {
		const applied = applyOneHunk(lines, hunk);
		if (!applied.ok) return applied;
		lines = applied.lines;
	}
	return { ok: true, content: joinContentLines(lines, trailingNewline) };
}

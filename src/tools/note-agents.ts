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
const CHAIN_TRUNCATED_NOTE = '较远的约束已截断。';

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

function formatLayer(dir: string, text: string): string {
	const heading = dir === '' ? '## 库根' : `## ${dir}`;
	return `${heading}\n${text}`;
}

function assembleChainText(remaining: { dir: string; text: string }[], truncated: boolean): string {
	const body = remaining.map((l) => formatLayer(l.dir, l.text)).join('\n\n');
	const parts = [body, PRIORITY_NOTE];
	if (truncated) {
		parts.push(CHAIN_TRUNCATED_NOTE);
	}
	return parts.filter((p) => p.length > 0).join('\n\n');
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

export function joinAgentsChain(
	layers: { dir: string; text: string }[],
): { text: string; truncated: boolean } {
	let truncated = false;
	const processed = layers.map((layer) => {
		const cut = truncateUtf8(layer.text, AGENTS_FILE_MAX_BYTES);
		if (cut.truncated) {
			truncated = true;
		}
		return { dir: layer.dir, text: cut.text };
	});

	let remaining = [...processed];
	while (remaining.length > 0) {
		const candidate = assembleChainText(remaining, truncated);
		if (utf8ByteLength(candidate) <= AGENTS_CHAIN_MAX_BYTES) {
			return { text: candidate, truncated };
		}
		remaining.shift();
		truncated = true;
	}

	return {
		text: assembleChainText([], true),
		truncated: true,
	};
}

/**
 * 记录本轮是否已向模型展示过某笔记路径的嵌套约束链。
 */
export class AgentsChainSeen {
	private readonly seen = new Set<string>();

	private key(notePath: string): string {
		return nestedDirs(notePath).slice().sort().join('/');
	}

	has(notePath: string): boolean {
		const nested = nestedDirs(notePath);
		if (nested.length === 0) {
			return true;
		}
		return this.seen.has(this.key(notePath));
	}

	mark(notePath: string): void {
		this.seen.add(this.key(notePath));
	}
}

/**
 * 收集本轮尚未注入的子目录 AGENTS.md。库根不包含在内。
 * 同一条目录链再调用返回空串。
 */
export async function collectUnseenAgentsChain(
	notePath: string,
	seen: AgentsChainSeen,
	readAgentsFile: (dir: string) => Promise<string | null>,
): Promise<string> {
	if (seen.has(notePath)) return '';
	const layers = await loadNestedAgentLayers(notePath, readAgentsFile);
	seen.mark(notePath);
	if (layers.length === 0) return '';
	const joined = joinAgentsChain(layers);
	return formatGateAttachment(joined);
}

/** 笔记工具可选注入：本轮已见记录 + 按目录读 AGENTS.md + 写入上下文 */
export interface NoteAgentsToolDeps {
	seen: AgentsChainSeen;
	readAgentsFile: (dir: string) => Promise<string | null>;
	appendChain?: (text: string) => void;
}

/**
 * 把路径上尚未注入的子目录约束交给 appendChain。不阻止后续写盘。
 */
export async function injectAgentsForPaths(
	deps: NoteAgentsToolDeps | undefined,
	paths: string[],
): Promise<void> {
	if (!deps) return;
	for (const notePath of paths) {
		const text = await collectUnseenAgentsChain(notePath, deps.seen, deps.readAgentsFile);
		if (text.trim()) deps.appendChain?.(text);
	}
}

async function loadNestedAgentLayers(
	notePath: string,
	readAgentsFile: (dir: string) => Promise<string | null>,
): Promise<{ dir: string; text: string }[]> {
	const layers: { dir: string; text: string }[] = [];
	for (const dir of nestedDirs(notePath)) {
		const text = await readAgentsFile(dir);
		if (text !== null && text.trim().length > 0) {
			layers.push({ dir, text });
		}
	}
	return layers;
}

function formatGateAttachment(joined: { text: string; truncated: boolean }): string {
	if (!joined.text.trim()) return '';
	if (!joined.truncated) return joined.text;
	return `${joined.text}\n\n${tNow('noteAgents.truncated')}`;
}

/**
 * 读操作仍可附上已收集的约束文本。写操作不再拦住。
 */
export async function applyNoteAgentsGate(input: {
	op: 'read' | 'write';
	notePath: string;
	seen: AgentsChainSeen;
	readAgentsFile: (dir: string) => Promise<string | null>;
}): Promise<{ proceed: boolean; attachment: string }> {
	const nested = nestedDirs(input.notePath);

	if (input.op === 'read') {
		const layers = await loadNestedAgentLayers(input.notePath, input.readAgentsFile);
		input.seen.mark(input.notePath);
		if (layers.length === 0) {
			return { proceed: true, attachment: '' };
		}
		const joined = joinAgentsChain(layers);
		return { proceed: true, attachment: formatGateAttachment(joined) };
	}

	if (nested.length === 0 || input.seen.has(input.notePath)) {
		return { proceed: true, attachment: '' };
	}

	const layers = await loadNestedAgentLayers(input.notePath, input.readAgentsFile);
	input.seen.mark(input.notePath);
	if (layers.length === 0) {
		return { proceed: true, attachment: '' };
	}
	const joined = joinAgentsChain(layers);
	return { proceed: true, attachment: formatGateAttachment(joined) };
}

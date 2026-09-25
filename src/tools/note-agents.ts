/**
 * @file src/tools/note-agents.ts
 * @description 笔记 AGENTS.md 约束链：目录顺序、UTF-8 截断、拼接与本轮已见记录
 * @module tools/note-agents
 */

import { tNow } from '../i18n';

export const AGENTS_FILE_NAME = 'AGENTS.md';
export const AGENTS_FILE_MAX_BYTES = 8192;
export const AGENTS_CHAIN_MAX_BYTES = 16384;

const PRIORITY_NOTE =
	'同一件事冲突时，离笔记更近的优先。用户这一轮的明确指令优先于这些文件。';
const CHAIN_TRUNCATED_NOTE = '较远的约束已截断。';

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

/** 笔记工具可选注入：本轮已见记录 + 按目录读 AGENTS.md */
export interface NoteAgentsToolDeps {
	seen: AgentsChainSeen;
	readAgentsFile: (dir: string) => Promise<string | null>;
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
 * 读/写笔记前的 AGENTS 链闸门：读操作附嵌套层约束；写操作未见过嵌套约束时退回正文。
 *
 * @param input - 操作类型、笔记路径、本轮已见与读文件函数
 * @returns proceed 为 false 时调用方应把 attachment 当工具结果返回且不写盘
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
	return { proceed: false, attachment: formatGateAttachment(joined) };
}

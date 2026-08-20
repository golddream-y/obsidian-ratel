/**
 * @file src/ui/chat/normalize-tool-detail.ts
 * @description 工具旁注 — 按结果形状归一为 ToolDetailModel(不拼用户句子)
 * @module ui/chat/normalize-tool-detail
 * @depends ./tool-detail-model
 */

import type { ToolDetailModel } from './tool-detail-model';

export interface NormalizeToolDetailInput {
	name?: string;
	args?: unknown;
	result?: unknown;
	errorMessage?: string;
	status?: 'calling' | 'done' | 'failed';
}

/**
 * 将工具调用快照归一为封闭形态。
 *
 * 优先级:error → busy → listing → links → hits → snippet → kv → empty。
 * 工具名仅作弱提示(如 search_vault 的 reranked / grep 标签)。
 */
export function normalizeToolDetail(input: NormalizeToolDetailInput): ToolDetailModel {
	if (input.errorMessage) {
		return { kind: 'error', message: input.errorMessage };
	}
	if (input.status === 'calling') {
		const args = asRecord(input.args);
		// 关键路径:run_skill_script 显示脚本名,而非笼统"执行中"
		if (input.name === 'run_skill_script') {
			const scriptName = str(args.scriptPath) || str(args.skillName) || '';
			const base = scriptName.split('/').pop() || scriptName;
			return { kind: 'busy', label: base || undefined };
		}
		return { kind: 'busy' };
	}

	const args = asRecord(input.args);
	const result = input.result;

	if (result != null && typeof result === 'object' && !Array.isArray(result)) {
		const r = result as Record<string, unknown>;

		// listing:files/folders 任一为数组即命中(含空目录)
		if (Array.isArray(r.files) || Array.isArray(r.folders)) {
			const path = str(r.path) || str(args.path) || '.';
			return {
				kind: 'listing',
				path: displayPath(path),
				files: asStringArray(r.files),
				folders: asStringArray(r.folders),
			};
		}

		if (r.outgoing != null || r.backlinks != null) {
			return {
				kind: 'links',
				path: displayPath(str(r.path) || str(args.path)) || undefined,
				outgoing: countField(r.outgoing),
				backlinks: countField(r.backlinks),
				unresolved: countField(r.unresolved),
			};
		}

		if (typeof r.content === 'string') {
			return {
				kind: 'snippet',
				path: displayPath(str(r.path) || str(args.path)) || undefined,
				chars: r.content.length,
			};
		}

		if (Array.isArray(r.outline) || Array.isArray(r.headings)) {
			const outline = (r.outline ?? r.headings) as unknown[];
			return {
				kind: 'hits',
				items: outlineLabels(outline),
				hint: 'generic',
				path: displayPath(str(r.path) || str(args.path)) || undefined,
			};
		}

		const nestedPaths = pathListFromObject(r);
		if (nestedPaths) {
			return {
				kind: 'hits',
				items: nestedPaths,
				hint: 'generic',
				path: displayPath(str(args.path)) || undefined,
				tag: str(args.tag) || undefined,
				property: str(args.key) || undefined,
			};
		}

		const entries = shallowKv(r);
		if (entries.length > 0) return { kind: 'kv', entries };
	}

	if (Array.isArray(result)) {
		const isGrepLike = input.name === 'grep' || input.name === 'glob';
		const reranked =
			input.name === 'search_vault' &&
			result.some(
				(x) => x && typeof x === 'object' && (x as { reranked?: boolean }).reranked === true,
			);
		return {
			kind: 'hits',
			items: isGrepLike ? grepLabels(result) : pathsFromArray(result),
			hint: reranked ? 'reranked' : isGrepLike ? 'grep' : 'generic',
			pattern: isGrepLike ? str(args.pattern) || undefined : undefined,
			query: !isGrepLike ? str(args.query) || undefined : undefined,
			path: displayPath(str(args.path)) || undefined,
		};
	}

	if (typeof result === 'string') {
		if (result.length === 0) return { kind: 'empty' };
		// 短路径串(如 get_active_note)当 hits 单条
		if (result.length < 200 && !result.includes('\n')) {
			return { kind: 'hits', items: [result], hint: 'generic' };
		}
		return { kind: 'snippet', chars: result.length };
	}

	const argEntries = shallowKv(args);
	if (argEntries.length > 0 && result == null) {
		return { kind: 'kv', entries: argEntries };
	}

	return { kind: 'empty' };
}

// ==================== 形状辅助 ====================

/** 从对象内 notes/paths/files 抽出路径列表;无则 null */
function pathListFromObject(r: Record<string, unknown>): string[] | null {
	for (const key of ['notes', 'paths', 'files'] as const) {
		if (!Array.isArray(r[key]) || r[key].length === 0) continue;
		const asStr = asStringArray(r[key]);
		if (asStr.length > 0) return asStr;
		const paths = pathsFromArray(r[key] as unknown[]);
		if (paths.length > 0) return paths;
	}
	return null;
}

function outlineLabels(outline: unknown[]): string[] {
	return outline.map((h, i) => {
		if (typeof h === 'string') return h;
		if (h && typeof h === 'object') {
			const o = h as Record<string, unknown>;
			return str(o.heading) || str(o.text) || str(o.title) || `#${i + 1}`;
		}
		return `#${i + 1}`;
	});
}

function pathsFromArray(items: unknown[]): string[] {
	return items
		.map((x) => {
			if (typeof x === 'string') return x;
			if (x && typeof x === 'object') {
				const o = x as Record<string, unknown>;
				const metaPath =
					o.metadata && typeof o.metadata === 'object'
						? str((o.metadata as { path?: unknown }).path)
						: '';
				return metaPath || str(o.path) || str(o.file);
			}
			return '';
		})
		.filter(Boolean);
}

function grepLabels(items: unknown[]): string[] {
	return items
		.map((x) => {
			if (typeof x === 'string') return x;
			if (x && typeof x === 'object') {
				const o = x as Record<string, unknown>;
				const file = str(o.file) || str(o.path);
				const line = typeof o.line === 'number' ? o.line : 0;
				if (file && line > 0) return `${file}:${line}`;
				return file;
			}
			return '';
		})
		.filter(Boolean);
}

function countField(v: unknown): number {
	if (Array.isArray(v)) return v.length;
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	return 0;
}

function shallowKv(obj: Record<string, unknown>): Array<{ key: string; value: string }> {
	return Object.entries(obj)
		.filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
		.slice(0, 8)
		.map(([key, value]) => ({ key, value: String(value) }));
}

function asRecord(v: unknown): Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string');
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function displayPath(path: string): string {
	if (!path || path === '.' || path === './') return '/';
	return path;
}

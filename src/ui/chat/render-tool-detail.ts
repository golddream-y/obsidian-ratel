/**
 * @file src/ui/chat/render-tool-detail.ts
 * @description 工具旁注 — ToolDetailModel → 多行叙事句(仅 i18n,不再猜形状)
 * @module ui/chat/render-tool-detail
 * @depends ./tool-detail-model, i18n
 */

import { tNow } from '../../i18n';
import type { ToolDetailModel } from './tool-detail-model';
import { TOOL_DETAIL_LIST_PREVIEW } from './tool-detail-model';

/**
 * 将 Model 渲染为展开旁注多行文本。
 */
export function renderToolDetail(model: ToolDetailModel): string {
	switch (model.kind) {
		case 'busy':
			return tNow('chat.tool.executing');
		case 'error':
			return model.message;
		case 'empty':
			return tNow('chat.tool.noResult');
		case 'listing':
			return renderListing(model);
		case 'links':
			return renderLinks(model);
		case 'hits':
			return renderHits(model);
		case 'snippet':
			return renderSnippet(model);
		case 'kv':
			return model.entries
				.map((e) => tNow('chat.tool.detail.kv', { key: e.key, value: e.value }))
				.join(' · ');
		default: {
			const _exhaustive: never = model;
			return _exhaustive;
		}
	}
}

/**
 * 折叠行短 meta — 与展开共用同一 Model,避免双套规则。
 */
export function metaShortFromModel(model: ToolDetailModel): string {
	switch (model.kind) {
		case 'busy':
			return '…';
		case 'error':
			return tNow('chat.tool.failed');
		case 'listing': {
			const n = model.files.length + model.folders.length;
			return n > 0 ? String(n) : '';
		}
		case 'links':
			return tNow('chat.tool.meta.graph');
		case 'hits':
			return model.items.length > 0 ? String(model.items.length) : '';
		case 'snippet':
			return model.chars > 0 ? String(model.chars) : '';
		case 'kv':
		case 'empty':
			return '';
		default: {
			const _exhaustive: never = model;
			return _exhaustive;
		}
	}
}

function renderListing(model: Extract<ToolDetailModel, { kind: 'listing' }>): string {
	const { path, files, folders } = model;
	const lines: string[] = [];

	if (files.length === 0 && folders.length === 0) {
		lines.push(tNow('chat.tool.detail.listingEmpty', { path }));
		return lines.join('\n');
	}
	if (files.length > 0 && folders.length > 0) {
		lines.push(
			tNow('chat.tool.detail.listingBoth', {
				path,
				files: files.length,
				folders: folders.length,
			}),
		);
	} else if (files.length > 0) {
		lines.push(tNow('chat.tool.detail.listingFiles', { path, n: files.length }));
	} else {
		lines.push(tNow('chat.tool.detail.listingFolders', { path, n: folders.length }));
	}

	lines.push(...bulletPaths(folders, path));
	lines.push(...bulletPaths(files, path));
	return lines.join('\n');
}

function renderLinks(model: Extract<ToolDetailModel, { kind: 'links' }>): string {
	const lines: string[] = [];
	if (model.path) {
		lines.push(tNow('chat.tool.detail.linksFor', { path: model.path }));
	}
	lines.push(
		[
			tNow('chat.tool.detail.outgoing', { n: model.outgoing }),
			tNow('chat.tool.detail.backlinks', { n: model.backlinks }),
			tNow('chat.tool.detail.unresolved', { n: model.unresolved }),
		].join(' · '),
	);
	return lines.join('\n');
}

function renderHits(model: Extract<ToolDetailModel, { kind: 'hits' }>): string {
	const lines: string[] = [];
	if (model.query) {
		lines.push(tNow('chat.tool.detail.query', { query: model.query }));
	} else if (model.pattern) {
		lines.push(tNow('chat.tool.detail.pattern', { pattern: model.pattern }));
	} else if (model.tag) {
		lines.push(tNow('chat.tool.detail.tag', { tag: model.tag }));
	} else if (model.property) {
		lines.push(tNow('chat.tool.detail.property', { key: model.property }));
	}
	if (model.path) {
		lines.push(tNow('chat.tool.detail.path', { path: model.path }));
	}
	if (model.hint === 'reranked') {
		lines.push(tNow('chat.tool.detail.hitsReranked', { n: model.items.length }));
	} else if (model.hint === 'grep') {
		lines.push(tNow('chat.tool.detail.matches', { n: model.items.length }));
	} else {
		lines.push(tNow('chat.tool.detail.hitsFound', { n: model.items.length }));
	}
	lines.push(...bulletPaths(model.items, model.path ?? ''));
	return lines.join('\n');
}

function renderSnippet(model: Extract<ToolDetailModel, { kind: 'snippet' }>): string {
	const lines: string[] = [];
	if (model.path) {
		lines.push(tNow('chat.tool.detail.path', { path: model.path }));
	}
	lines.push(tNow('chat.tool.detail.snippetChars', { n: model.chars }));
	return lines.join('\n');
}

function bulletPaths(paths: string[], parent: string): string[] {
	const shown = paths.slice(0, TOOL_DETAIL_LIST_PREVIEW);
	const bullets = shown.map((p) =>
		tNow('chat.tool.detail.bullet', { item: shortenUnderParent(p, parent) }),
	);
	const rest = paths.length - shown.length;
	if (rest > 0) bullets.push(tNow('chat.tool.detail.more', { n: rest }));
	return bullets;
}

function shortenUnderParent(path: string, parent: string): string {
	if (!parent || parent === '/' || parent === '.') return path;
	const prefix = parent.endsWith('/') ? parent : parent + '/';
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

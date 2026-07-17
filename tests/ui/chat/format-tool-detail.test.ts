/**
 * @file tests/ui/chat/format-tool-detail.test.ts
 * @description 工具旁注中间层 — 形状推断 + 叙事句
 * @module tests/ui/chat/format-tool-detail
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	formatToolDetail,
	formatToolMeta,
	normalizeToolDetail,
} from '../../../src/ui/chat/format-tool-detail';
import { setLang } from '../../../src/i18n';

describe('formatToolDetail / normalize', () => {
	beforeEach(() => {
		setLang('zh');
	});

	it('listing - list_files 形状 - 叙事首行含目录与数量', () => {
		const text = formatToolDetail(
			'list_files',
			{ path: 'Adventurer' },
			{
				path: 'Adventurer',
				files: [
					'Adventurer/From plain-text note-taking.md',
					'Adventurer/From standard note-taking.md',
					'Adventurer/No prior experience.md',
				],
				folders: [],
			},
		);
		expect(text).toContain('在 Adventurer 找到 3 个文件');
		expect(text).toContain('· From plain-text note-taking.md');
		expect(text).not.toContain('"files"');
		expect(normalizeToolDetail({
			name: 'list_files',
			args: { path: 'Adventurer' },
			result: { path: 'Adventurer', files: ['a.md'], folders: [] },
		}).kind).toBe('listing');
	});

	it('links - 形状命中 - 不计工具名', () => {
		const model = normalizeToolDetail({
			result: { path: 'a.md', outgoing: [1, 2], backlinks: [1], unresolved: [] },
		});
		expect(model.kind).toBe('links');
		const text = formatToolDetail('get_links', { path: 'a.md' }, {
			path: 'a.md',
			outgoing: [1, 2],
			backlinks: [1],
			unresolved: [],
		});
		expect(text).toContain('出链: 2');
		expect(formatToolMeta('get_links', {}, { outgoing: [], backlinks: [] })).toBe('图');
	});

	it('listing - 英文 - Found n files', () => {
		setLang('en');
		const text = formatToolDetail(
			'list_files',
			{ path: 'Guides' },
			{ path: 'Guides', files: ['Guides/a.md'], folders: [] },
		);
		expect(text).toContain('Found 1 file(s) in Guides');
	});

	it('hits - 顶层数组 - 不依赖工具名', () => {
		const model = normalizeToolDetail({
			result: [{ path: 'a.md' }, { path: 'b.md' }],
		});
		expect(model.kind).toBe('hits');
		if (model.kind === 'hits') expect(model.items).toEqual(['a.md', 'b.md']);
	});
});

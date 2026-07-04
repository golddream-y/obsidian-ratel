import { describe, it, expect } from 'vitest';
import { SECTIONS, getSectionMeta } from '../../src/prompts/sections';
import { PROMPTS_VERSION } from '../../src/prompts/types';

describe('prompt sections metadata', () => {
	it('PROMPTS_VERSION 为 1', () => {
		expect(PROMPTS_VERSION).toBe(1);
	});

	it('agent.base 可覆盖且无占位符', () => {
		const meta = getSectionMeta('agent.base');
		expect(meta.zone).toBe('static');
		expect(meta.allowOverride).toBe(true);
		expect(meta.placeholders).toEqual([]);
	});

	it('agent.rag.toolGuide 须保留 toolList 占位符', () => {
		const meta = getSectionMeta('agent.rag.toolGuide');
		expect(meta.placeholders).toContain('toolList');
	});

	it('injection.searchResults.body 须含 index/path/content', () => {
		const meta = getSectionMeta('injection.searchResults.body');
		expect(meta.placeholders).toEqual(expect.arrayContaining(['index', 'path', 'content']));
	});

	it('wrapper section 不在 SECTIONS 列表(不可覆盖)', () => {
		const ids = SECTIONS.map((s) => s.id);
		expect(ids).not.toContain('injection.searchResults.wrapper');
	});

	it('每个 tool section 有对应 tool-schemas 工具名', () => {
		const toolDescIds = SECTIONS.filter((s) => s.id.endsWith('.description')).map((s) => s.id);
		expect(toolDescIds).toContain('tool.read_note.description');
		expect(toolDescIds).toContain('tool.search_vault.description');
	});
});

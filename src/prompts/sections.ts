/**
 * @file src/prompts/sections.ts
 * @description Section 元数据注册表
 * @module prompts/sections
 */

import type { PromptSectionId, SectionMeta } from './types';

export const SECTIONS: SectionMeta[] = [
	{
		id: 'agent.base',
		label: 'Agent 身份',
		description: 'Ratel 身份、语气、用中文回复用户',
		zone: 'static',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'agent.rag.workflow',
		label: 'RAG 工作流',
		description: 'search_vault → read_note → 引用 [n]',
		zone: 'static',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'agent.rag.toolGuide',
		label: '工具选用指引',
		description: '何时用何种工具;末尾注入 {{toolList}}',
		zone: 'static',
		placeholders: ['toolList'],
		allowOverride: true,
	},
	{
		id: 'injection.searchResults.body',
		label: '检索结果排版',
		description: '单条检索结果模板;外框由 Composer 硬编码',
		zone: 'dynamic',
		placeholders: ['index', 'path', 'content'],
		allowOverride: true,
	},
	{
		id: 'internal.intent.system',
		label: '意图分类 System',
		description: '内部 LLM:只回答 rag 或 direct',
		zone: 'internal',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'internal.intent.user',
		label: '意图分类 User',
		description: '注入 {{message}}',
		zone: 'internal',
		placeholders: ['message'],
		allowOverride: true,
	},
	{
		id: 'internal.rewrite.system',
		label: '查询改写 System',
		description: '生成语义变体',
		zone: 'internal',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'internal.rewrite.user',
		label: '查询改写 User',
		description: '注入 {{query}}',
		zone: 'internal',
		placeholders: ['query'],
		allowOverride: true,
	},
	// --- tool.read_note ---
	{
		id: 'tool.read_note.description',
		label: 'read_note 描述',
		description: '工具 schema description',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.read_note.param.path',
		label: 'read_note.path',
		description: '参数 path 说明',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	// --- tool.search_vault ---
	{
		id: 'tool.search_vault.description',
		label: 'search_vault 描述',
		description: '工具 schema description',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.search_vault.param.query',
		label: 'search_vault.query',
		description: '参数 query 说明',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.search_vault.param.topK',
		label: 'search_vault.topK',
		description: '参数 topK 说明',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	// --- S-VAULT-TOOLS 预置 ---
	{
		id: 'tool.grep.description',
		label: 'grep 描述',
		description: '精确搜索工具',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.grep.param.pattern',
		label: 'grep.pattern',
		description: '搜索模式',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.glob.description',
		label: 'glob 描述',
		description: '文件名匹配',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.glob.param.pattern',
		label: 'glob.pattern',
		description: 'glob 模式',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.list_files.description',
		label: 'list_files 描述',
		description: '列目录',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.write_note.description',
		label: 'write_note 描述',
		description: '创建/覆盖',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.append_note.description',
		label: 'append_note 描述',
		description: '追加内容',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.edit_note.description',
		label: 'edit_note 描述',
		description: '精确替换',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.delete_note.description',
		label: 'delete_note 描述',
		description: '移到回收站',
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
];

const META_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function getSectionMeta(id: PromptSectionId): SectionMeta {
	const meta = META_BY_ID.get(id);
	if (!meta) throw new Error(`Unknown prompt section: ${id}`);
	return meta;
}

/** 设置 UI 可编辑的 section(排除不可覆盖项) */
export function listEditableSections(): SectionMeta[] {
	return SECTIONS.filter((s) => s.allowOverride);
}

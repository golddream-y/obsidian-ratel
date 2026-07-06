/**
 * @file src/prompts/sections.ts
 * @description Section 元数据注册表
 * @module prompts/sections
 */

import { tNow } from '../i18n';
import type { PromptSectionId, SectionMeta } from './types';

/**
 * 构建 section 元数据列表(label/description 走 tNow 运行时求值)。
 *
 * 关键路径:不作为模块级常量,而是函数 — i18n store 在模块 import 时可能尚未
 * 完成 applyLangPreference 调用,若用模块级常量会在加载期冻结默认语言文案。
 * 改为函数后,每次调用(getSectionMeta / listEditableSections)都读当前 langStore,
 * 保证设置面板在语言切换后能拿到正确文案。
 *
 * @returns 22 个 section 的完整元数据(含 i18n 后的 label/description)
 */
function buildSections(): SectionMeta[] {
	return [
		{
			id: 'agent.base',
			label: tNow('promptLabel.agent.base'),
			description: tNow('promptLabel.agent.base.desc'),
			zone: 'static',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'agent.rag.workflow',
			label: tNow('promptLabel.agent.rag.workflow'),
			description: tNow('promptLabel.agent.rag.workflow.desc'),
			zone: 'static',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'agent.rag.toolGuide',
			label: tNow('promptLabel.agent.rag.toolGuide'),
			description: tNow('promptLabel.agent.rag.toolGuide.desc'),
			zone: 'static',
			placeholders: ['toolList'],
			allowOverride: true,
		},
		{
			id: 'injection.searchResults.body',
			label: tNow('promptLabel.injection.searchResults.body'),
			description: tNow('promptLabel.injection.searchResults.body.desc'),
			zone: 'dynamic',
			placeholders: ['index', 'path', 'content'],
			allowOverride: true,
		},
		{
			id: 'internal.intent.system',
			label: tNow('promptLabel.internal.intent.system'),
			description: tNow('promptLabel.internal.intent.system.desc'),
			zone: 'internal',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'internal.intent.user',
			label: tNow('promptLabel.internal.intent.user'),
			description: tNow('promptLabel.internal.intent.user.desc'),
			zone: 'internal',
			placeholders: ['message'],
			allowOverride: true,
		},
		{
			id: 'internal.rewrite.system',
			label: tNow('promptLabel.internal.rewrite.system'),
			description: tNow('promptLabel.internal.rewrite.system.desc'),
			zone: 'internal',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'internal.rewrite.user',
			label: tNow('promptLabel.internal.rewrite.user'),
			description: tNow('promptLabel.internal.rewrite.user.desc'),
			zone: 'internal',
			placeholders: ['query'],
			allowOverride: true,
		},
		// --- tool.read_note ---
		{
			id: 'tool.read_note.description',
			label: tNow('promptLabel.tool.read_note.description'),
			description: tNow('promptLabel.tool.read_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.read_note.param.path',
			label: tNow('promptLabel.tool.read_note.param.path'),
			description: tNow('promptLabel.tool.read_note.param.path.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.search_vault ---
		{
			id: 'tool.search_vault.description',
			label: tNow('promptLabel.tool.search_vault.description'),
			description: tNow('promptLabel.tool.search_vault.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_vault.param.query',
			label: tNow('promptLabel.tool.search_vault.param.query'),
			description: tNow('promptLabel.tool.search_vault.param.query.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_vault.param.topK',
			label: tNow('promptLabel.tool.search_vault.param.topK'),
			description: tNow('promptLabel.tool.search_vault.param.topK.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- S-VAULT-TOOLS 预置 ---
		{
			id: 'tool.grep.description',
			label: tNow('promptLabel.tool.grep.description'),
			description: tNow('promptLabel.tool.grep.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.grep.param.pattern',
			label: tNow('promptLabel.tool.grep.param.pattern'),
			description: tNow('promptLabel.tool.grep.param.pattern.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.glob.description',
			label: tNow('promptLabel.tool.glob.description'),
			description: tNow('promptLabel.tool.glob.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.glob.param.pattern',
			label: tNow('promptLabel.tool.glob.param.pattern'),
			description: tNow('promptLabel.tool.glob.param.pattern.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.list_files.description',
			label: tNow('promptLabel.tool.list_files.description'),
			description: tNow('promptLabel.tool.list_files.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.write_note.description',
			label: tNow('promptLabel.tool.write_note.description'),
			description: tNow('promptLabel.tool.write_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.append_note.description',
			label: tNow('promptLabel.tool.append_note.description'),
			description: tNow('promptLabel.tool.append_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.edit_note.description',
			label: tNow('promptLabel.tool.edit_note.description'),
			description: tNow('promptLabel.tool.edit_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.delete_note.description',
			label: tNow('promptLabel.tool.delete_note.description'),
			description: tNow('promptLabel.tool.delete_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
	];
}

/**
 * 获取全部 section 元数据(每次调用都重新解析 i18n 文案)。
 *
 * 关键路径:对外暴露为函数而非常量,确保语言切换后调用方能拿到最新文案。
 *
 * @returns 22 个 section 的完整元数据
 */
export function getSections(): SectionMeta[] {
	return buildSections();
}

/**
 * 按 id 取单个 section 元数据。
 *
 * @param id - section 标识(如 'agent.base')
 * @returns 对应的 SectionMeta
 * @throws 当 id 不存在时抛错(纯开发者错误,不走 i18n)
 */
export function getSectionMeta(id: PromptSectionId): SectionMeta {
	const meta = buildSections().find((s) => s.id === id);
	if (!meta) throw new Error(`Unknown prompt section: ${id}`);
	return meta;
}

/** 设置 UI 可编辑的 section(排除不可覆盖项) */
export function listEditableSections(): SectionMeta[] {
	return buildSections().filter((s) => s.allowOverride);
}

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
 * @returns 28 个 section 的完整元数据(含 i18n 后的 label/description)
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
		// 关键路径:记忆系统注入提示 — 启动时注入到 system 与检索结果之间,用户可覆盖默认模板。
		{
			id: 'memory.systemPrompt',
			label: tNow('promptLabel.memory.systemPrompt'),
			description: tNow('promptLabel.memory.systemPrompt.desc'),
			zone: 'dynamic',
			placeholders: ['globalContent', 'topicList'],
			allowOverride: true,
		},
		// 关键路径:Skill 机制 Discovery 段 — 注入已加载 skill 的 name+description 列表。
		// zone: 'dynamic',allowOverride: false(spec §4.4 — 不可被用户覆盖删除,防 LLM 失去 skill 感知)。
		{
			id: 'agent.skills',
			label: tNow('promptLabel.agent.skills'),
			description: tNow('promptLabel.agent.skills.desc'),
			zone: 'dynamic',
			placeholders: ['skillList'],
			allowOverride: false,
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
		// --- tool.activate_skill ---
		{
			id: 'tool.activate_skill.description',
			label: tNow('promptLabel.tool.activate_skill.description'),
			description: tNow('promptLabel.tool.activate_skill.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.activate_skill.param.name',
			label: tNow('promptLabel.tool.activate_skill.param.name'),
			description: tNow('promptLabel.tool.activate_skill.param.name.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.deactivate_skill ---
		{
			id: 'tool.deactivate_skill.description',
			label: tNow('promptLabel.tool.deactivate_skill.description'),
			description: tNow('promptLabel.tool.deactivate_skill.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.deactivate_skill.param.name',
			label: tNow('promptLabel.tool.deactivate_skill.param.name'),
			description: tNow('promptLabel.tool.deactivate_skill.param.name.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_datetime ---
		{
			id: 'tool.get_datetime.description',
			label: tNow('promptLabel.tool.get_datetime.description'),
			description: tNow('promptLabel.tool.get_datetime.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_datetime.param.format',
			label: tNow('promptLabel.tool.get_datetime.param.format'),
			description: tNow('promptLabel.tool.get_datetime.param.format.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_datetime.param.offsetDays',
			label: tNow('promptLabel.tool.get_datetime.param.offsetDays'),
			description: tNow('promptLabel.tool.get_datetime.param.offsetDays.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_active_note ---
		{
			id: 'tool.get_active_note.description',
			label: tNow('promptLabel.tool.get_active_note.description'),
			description: tNow('promptLabel.tool.get_active_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_active_note.param.includeSelection',
			label: tNow('promptLabel.tool.get_active_note.param.includeSelection'),
			description: tNow('promptLabel.tool.get_active_note.param.includeSelection.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_active_note.param.includeFrontmatter',
			label: tNow('promptLabel.tool.get_active_note.param.includeFrontmatter'),
			description: tNow('promptLabel.tool.get_active_note.param.includeFrontmatter.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_daily_note ---
		{
			id: 'tool.get_daily_note.description',
			label: tNow('promptLabel.tool.get_daily_note.description'),
			description: tNow('promptLabel.tool.get_daily_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_daily_note.param.date',
			label: tNow('promptLabel.tool.get_daily_note.param.date'),
			description: tNow('promptLabel.tool.get_daily_note.param.date.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- list_recent_notes ---
		{
			id: 'tool.list_recent_notes.description',
			label: tNow('promptLabel.tool.list_recent_notes.description'),
			description: tNow('promptLabel.tool.list_recent_notes.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.list_recent_notes.param.limit',
			label: tNow('promptLabel.tool.list_recent_notes.param.limit'),
			description: tNow('promptLabel.tool.list_recent_notes.param.limit.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_note_outline ---
		{
			id: 'tool.get_note_outline.description',
			label: tNow('promptLabel.tool.get_note_outline.description'),
			description: tNow('promptLabel.tool.get_note_outline.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_note_outline.param.path',
			label: tNow('promptLabel.tool.get_note_outline.param.path'),
			description: tNow('promptLabel.tool.get_note_outline.param.path.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_links ---
		{
			id: 'tool.get_links.description',
			label: tNow('promptLabel.tool.get_links.description'),
			description: tNow('promptLabel.tool.get_links.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_links.param.path',
			label: tNow('promptLabel.tool.get_links.param.path'),
			description: tNow('promptLabel.tool.get_links.param.path.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- search_by_tag ---
		{
			id: 'tool.search_by_tag.description',
			label: tNow('promptLabel.tool.search_by_tag.description'),
			description: tNow('promptLabel.tool.search_by_tag.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_by_tag.param.tag',
			label: tNow('promptLabel.tool.search_by_tag.param.tag'),
			description: tNow('promptLabel.tool.search_by_tag.param.tag.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_by_tag.param.limit',
			label: tNow('promptLabel.tool.search_by_tag.param.limit'),
			description: tNow('promptLabel.tool.search_by_tag.param.limit.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- search_by_property ---
		{
			id: 'tool.search_by_property.description',
			label: tNow('promptLabel.tool.search_by_property.description'),
			description: tNow('promptLabel.tool.search_by_property.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_by_property.param.key',
			label: tNow('promptLabel.tool.search_by_property.param.key'),
			description: tNow('promptLabel.tool.search_by_property.param.key.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_by_property.param.value',
			label: tNow('promptLabel.tool.search_by_property.param.value'),
			description: tNow('promptLabel.tool.search_by_property.param.value.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.search_by_property.param.limit',
			label: tNow('promptLabel.tool.search_by_property.param.limit'),
			description: tNow('promptLabel.tool.search_by_property.param.limit.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- get_vault_structure ---
		{
			id: 'tool.get_vault_structure.description',
			label: tNow('promptLabel.tool.get_vault_structure.description'),
			description: tNow('promptLabel.tool.get_vault_structure.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.get_vault_structure.param.include',
			label: tNow('promptLabel.tool.get_vault_structure.param.include'),
			description: tNow('promptLabel.tool.get_vault_structure.param.include.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.open_note ---
		{
			id: 'tool.open_note.description',
			label: tNow('promptLabel.tool.open_note.description'),
			description: tNow('promptLabel.tool.open_note.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.open_note.param.path',
			label: tNow('promptLabel.tool.open_note.param.path'),
			description: tNow('promptLabel.tool.open_note.param.path.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.open_note.param.anchor',
			label: tNow('promptLabel.tool.open_note.param.anchor'),
			description: tNow('promptLabel.tool.open_note.param.anchor.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.open_settings ---
		{
			id: 'tool.open_settings.description',
			label: tNow('promptLabel.tool.open_settings.description'),
			description: tNow('promptLabel.tool.open_settings.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.open_settings.param.tab',
			label: tNow('promptLabel.tool.open_settings.param.tab'),
			description: tNow('promptLabel.tool.open_settings.param.tab.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.get_app_config ---
		{
			id: 'tool.get_app_config.description',
			label: tNow('promptLabel.tool.get_app_config.description'),
			description: tNow('promptLabel.tool.get_app_config.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.update_app_config ---
		{
			id: 'tool.update_app_config.description',
			label: tNow('promptLabel.tool.update_app_config.description'),
			description: tNow('promptLabel.tool.update_app_config.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.update_app_config.param.updates',
			label: tNow('promptLabel.tool.update_app_config.param.updates'),
			description: tNow('promptLabel.tool.update_app_config.param.updates.desc'),
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
 * @returns 28 个 section 的完整元数据
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

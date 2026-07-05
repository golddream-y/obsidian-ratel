/**
 * @file src/prompts/types.ts
 * @description 提示词模块类型定义
 * @module prompts/types
 */

import type { ToolDefinition } from '../ports/llm';
import type { Intent } from '../core/intent-classifier';

export const PROMPTS_VERSION = 1;

export type PromptZone = 'static' | 'dynamic' | 'internal' | 'tool';

export type PromptSectionId =
	| 'agent.base'
	| 'agent.rag.workflow'
	| 'agent.rag.toolGuide'
	| 'injection.searchResults.body'
	| 'internal.compact'
	| 'internal.intent.system'
	| 'internal.intent.user'
	| 'internal.rewrite.system'
	| 'internal.rewrite.user'
	| `tool.${string}.description`
	| `tool.${string}.param.${string}`;

export type OverrideMap = Partial<Record<PromptSectionId, string>>;

export type InternalTask = 'intent' | 'rewrite';

export interface PromptContext {
	intent?: Intent;
	tools: ToolDefinition[];
	message?: string;
	query?: string;
}

export interface SectionMeta {
	id: PromptSectionId;
	label: string;
	description: string;
	zone: PromptZone;
	placeholders: string[];
	allowOverride: boolean;
}

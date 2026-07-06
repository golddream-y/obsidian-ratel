/**
 * @file src/prompts/tool-schemas.ts
 * @description 工具 JSON Schema 骨架(类型/required/default);description 由 Composer 从 section 注入
 * @module prompts/tool-schemas
 */

import type { ToolDefinition } from '../ports/llm';

const DEFAULT_TOP_K = 5;

type SchemaSkeleton = Pick<ToolDefinition, 'name' | 'parameters'>;

export const TOOL_SCHEMA_SKELETONS: Record<string, SchemaSkeleton> = {
	read_note: {
		name: 'read_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
			},
			required: ['path'],
		},
	},
	search_vault: {
		name: 'search_vault',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				topK: { type: 'number', default: DEFAULT_TOP_K },
			},
			required: ['query'],
		},
	},
	grep: {
		name: 'grep',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string' },
				is_regex: { type: 'boolean' },
				include: { type: 'string' },
				path: { type: 'string' },
				ignore_case: { type: 'boolean' },
				context_lines: { type: 'number' },
				max_results: { type: 'number' },
			},
			required: ['pattern'],
		},
	},
	glob: {
		name: 'glob',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string' },
				path: { type: 'string' },
			},
			required: ['pattern'],
		},
	},
	list_files: {
		name: 'list_files',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
			},
		},
	},
	write_note: {
		name: 'write_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
	},
	append_note: {
		name: 'append_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['path', 'content'],
		},
	},
	edit_note: {
		name: 'edit_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
	},
	delete_note: {
		name: 'delete_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
			},
			required: ['path'],
		},
	},
	search_memory: {
		name: 'search_memory',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				topK: { type: 'number', default: DEFAULT_TOP_K },
			},
			required: ['query'],
		},
	},
	remember: {
		name: 'remember',
		parameters: {
			type: 'object',
			properties: {
				type: { type: 'string', enum: ['global', 'topic'] },
				topic: { type: 'string' },
				section: { type: 'string' },
				content: { type: 'string' },
				source: { type: 'string', enum: ['user', 'model'] },
			},
			required: ['type', 'content', 'source'],
		},
	},
	forget_memory: {
		name: 'forget_memory',
		parameters: {
			type: 'object',
			properties: {
				type: { type: 'string', enum: ['global', 'topic'] },
				topic: { type: 'string' },
				match: { type: 'string' },
			},
			required: ['type', 'match'],
		},
	},
};

export const ALL_TOOL_NAMES = [
	'read_note', 'search_vault', 'grep', 'glob', 'list_files',
	'write_note', 'append_note', 'edit_note', 'delete_note',
	'search_memory', 'remember', 'forget_memory',
];

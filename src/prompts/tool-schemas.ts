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
	activate_skill: {
		name: 'activate_skill',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string' },
			},
			required: ['name'],
		},
	},
	deactivate_skill: {
		name: 'deactivate_skill',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string' },
			},
			required: ['name'],
		},
	},
	read_skill_reference: {
		name: 'read_skill_reference',
		parameters: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				path: { type: 'string' },
			},
			required: ['skillName', 'path'],
		},
	},
	run_skill_script: {
		name: 'run_skill_script',
		parameters: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				scriptPath: { type: 'string' },
				args: { type: 'array', items: { type: 'string' } },
			},
			required: ['skillName', 'scriptPath'],
		},
	},
	get_datetime: {
		name: 'get_datetime',
		parameters: {
			type: 'object',
			properties: {
				format: { type: 'string', enum: ['iso', 'local', 'full'] },
				offsetDays: { type: 'number' },
			},
			required: [],
		},
	},
	get_active_note: {
		name: 'get_active_note',
		parameters: {
			type: 'object',
			properties: {
				includeSelection: { type: 'boolean' },
				includeFrontmatter: { type: 'boolean' },
			},
			required: [],
		},
	},
	get_daily_note: {
		name: 'get_daily_note',
		parameters: {
			type: 'object',
			properties: {
				date: { type: 'string' },
			},
			required: [],
		},
	},
	list_recent_notes: {
		name: 'list_recent_notes',
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'number' },
			},
			required: [],
		},
	},
	get_note_outline: {
		name: 'get_note_outline',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
			},
			required: ['path'],
		},
	},
	get_links: {
		name: 'get_links',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		},
	},
	search_by_tag: {
		name: 'search_by_tag',
		parameters: {
			type: 'object',
			properties: {
				tag: { type: 'string' },
				limit: { type: 'number' },
			},
			required: ['tag'],
		},
	},
	search_by_property: {
		name: 'search_by_property',
		parameters: {
			type: 'object',
			properties: {
				key: { type: 'string' },
				value: {},
				limit: { type: 'number' },
			},
			required: ['key'],
		},
	},
	get_vault_structure: {
		name: 'get_vault_structure',
		parameters: {
			type: 'object',
			properties: {
				include: {
					type: 'array',
					items: { type: 'string', enum: ['folders', 'tags', 'orphans'] },
				},
			},
			required: [],
		},
	},
	open_note: {
		name: 'open_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				anchor: { type: 'string' },
			},
			required: ['path'],
		},
	},
	open_settings: {
		name: 'open_settings',
		parameters: {
			type: 'object',
			properties: {
				// 关键路径:enum 与 settings.ts 的 SETTINGS_UI_TABS 同源,LLM 侧直接约束取值
				tab: { type: 'string', enum: ['chat', 'index', 'agent', 'appearance', 'advanced'] },
			},
			required: [],
		},
	},
	get_app_config: {
		name: 'get_app_config',
		parameters: {
			type: 'object',
			properties: {},
			required: [],
		},
	},
	update_app_config: {
		name: 'update_app_config',
		parameters: {
			type: 'object',
			properties: {
				// 关键路径(P-CFG):仅白名单内 key 生效,提权项由 validateConfigValue 硬拒
				updates: {
					type: 'object',
					description:
						'要修改的设置键值对;仅白名单内 key 生效(对话模型 / 分块索引 / Embedding / 记忆 / 日记 / 语言外观),工具权限、MCP、Prompt 覆盖等敏感项会被拒绝',
				},
			},
			required: ['updates'],
		},
	},
};

export const ALL_TOOL_NAMES = [
	'read_note', 'search_vault', 'grep', 'glob', 'list_files',
	'write_note', 'append_note', 'edit_note', 'delete_note',
	'search_memory', 'remember', 'forget_memory',
	'activate_skill', 'deactivate_skill',
	'read_skill_reference', 'run_skill_script',
	'get_datetime', 'get_active_note', 'get_daily_note', 'list_recent_notes', 'get_note_outline',
	'get_links', 'search_by_tag', 'search_by_property', 'get_vault_structure',
	'open_note',
	'open_settings',
	'get_app_config',
	'update_app_config',
];

/**
 * @file src/tools/draft-plugin-profile.ts
 * @description draft_plugin_profile — 从已装插件生成 vault/global 草稿 YAML
 * @module tools/draft-plugin-profile
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { EcosystemIo } from '../adapters/ecosystem-vault';
import { tNow } from '../i18n';
import { FORBID_KEY_RE } from '../utils/setting-path';

/**
 * 创建 draft_plugin_profile：扫描已装插件 data.json，写出 enabled:false 草稿档案。
 *
 * @param definition - LLM 工具 schema
 * @param deps - 生态 IO 与 vault/global 路径根
 * @returns 注册用 Tool
 */
export function createDraftPluginProfileTool(
	definition: ToolDefinition,
	deps: { io: EcosystemIo; configDir: string; vaultRoot: string; homedir: string },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || !args.pluginId.trim()) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			const pluginId = args.pluginId.trim();
			const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
			try {
				const man = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as {
					id?: string;
					name?: string;
					version?: string;
				};
				if (man.id !== pluginId) throw new Error('bad');
				let data: Record<string, unknown> = {};
				try {
					data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>;
				} catch {
					data = {};
				}
				const forbid = Object.keys(data).filter((k) => FORBID_KEY_RE.test(k));
				const dest =
					args.dest === 'global'
						? path.join(deps.homedir, '.ratel', 'plugin-profiles')
						: path.join(deps.vaultRoot, '.ratel', 'plugin-profiles');
				mkdirSync(dest, { recursive: true });
				const filePath = path.join(dest, `${pluginId}-draft.draft.yaml`);
				const comments = Object.keys(data).map((k) => `# snapshot ${k}: ${JSON.stringify(data[k])}`);
				const yaml =
					[
						'kind: obsidian-plugin-profile',
						`id: ${pluginId}-draft`,
						`pluginId: ${pluginId}`,
						`pluginName: ${man.name ?? pluginId}`,
						`pluginVersionRange: ">=${man.version ?? '0.0.0'}"`,
						'enabled: false',
						'install:',
						'  source: community-store',
						'forbid:',
						...forbid.map((k) => `  - ${k}`),
						...comments,
						'presets:',
						'  - id: default',
						'    when: 待作者填写',
						'    patch: {}',
					].join('\n') + '\n';
				writeFileSync(filePath, yaml, 'utf-8');
				return { path: filePath, draft: true };
			} catch {
				throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
			}
		},
	};
}

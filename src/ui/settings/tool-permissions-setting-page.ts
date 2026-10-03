/**
 * @file src/ui/settings/tool-permissions-setting-page.ts
 * @description 工具权限二级页声明式定义 — 权限档位 + 每个内置/MCP 工具允许/询问/拒绝
 * @module ui/settings/tool-permissions-setting-page
 * @depends obsidian, main, i18n, ui/mcp/parse-mcp-tool-name
 */

import {
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
} from 'obsidian';
import type RatelVaultPlugin from '../../main';
// 关键路径:声明式定义每次渲染重新调用 tNow,读取当前语言
import { tNow, type StringKey } from '../../i18n';
import { parseMcpToolName } from '../mcp/parse-mcp-tool-name';

/**
 * 构建工具权限二级页 — 控件从「记忆与权限」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带,不另造导航层
 * - 页内仍是权限档位下拉 + 每个工具一行 dropdown(含 MCP 工具),字段不减、默认值不改
 * - 嵌套 key(`toolPermissions.<name>`)仍由 SettingTab 的 getControlValue/setControlValue 分发
 *
 * @param plugin - 插件实例(读取运行时 MCP 工具清单)
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildToolPermissionsSettingPage(
	plugin: RatelVaultPlugin,
	isVisible: () => boolean,
): SettingDefinitionPage {
	return {
		type: 'page',
		name: tNow('settings.toolPermissions.page.name'),
		desc: tNow('settings.toolPermissions.page.desc'),
		visible: isVisible,
		items: buildToolPermissionItems(plugin),
	};
}

/**
 * 构建工具权限页的 items — 与原「记忆与权限」主页 group 完全相同的控件清单。
 *
 * 关键路径:信任档位 toggle + 内置工具 dropdown + MCP 工具 dropdown,
 * key 用 `toolPermissions.<name>` 嵌套格式,getControlValue/setControlValue 会分发。
 *
 * @param plugin - 插件实例(读取运行时 MCP 工具清单)
 * @returns 页内 items
 */
function buildToolPermissionItems(plugin: RatelVaultPlugin): SettingDefinitionItem[] {
	// 关键路径:工具名 → i18n key 映射,tNow 运行时读取当前语言
	const labelByKey = (toolName: string): string => {
		const map: Record<string, StringKey> = {
			search_vault: 'settings.toolPermissions.search_vault',
			read_note: 'settings.toolPermissions.read_note',
			grep: 'settings.toolPermissions.grep',
			glob: 'settings.toolPermissions.glob',
			list_files: 'settings.toolPermissions.list_files',
			write_note: 'settings.toolPermissions.write_note',
			append_note: 'settings.toolPermissions.append_note',
			edit_note: 'settings.toolPermissions.edit_note',
			apply_patch: 'settings.toolPermissions.apply_patch',
			delete_note: 'settings.toolPermissions.delete_note',
			move_note: 'settings.toolPermissions.move_note',
			copy_note: 'settings.toolPermissions.copy_note',
			// 关键路径:3 个 memory 工具友好名(与 ui.tool_name.* 区分,这是设置面板的权限标签)
			search_memory: 'settings.toolPermissions.search_memory',
			remember: 'settings.toolPermissions.remember',
			forget_memory: 'settings.toolPermissions.forget_memory',
			activate_skill: 'settings.toolPermissions.activate_skill',
			deactivate_skill: 'settings.toolPermissions.deactivate_skill',
			read_skill_reference: 'settings.toolPermissions.read_skill_reference',
			run_skill_script: 'settings.toolPermissions.run_skill_script',
			get_datetime: 'settings.toolPermissions.get_datetime',
			get_active_note: 'settings.toolPermissions.get_active_note',
			get_daily_note: 'settings.toolPermissions.get_daily_note',
			list_recent_notes: 'settings.toolPermissions.list_recent_notes',
			get_note_outline: 'settings.toolPermissions.get_note_outline',
			get_links: 'settings.toolPermissions.get_links',
			search_by_tag: 'settings.toolPermissions.search_by_tag',
			search_by_property: 'settings.toolPermissions.search_by_property',
			get_vault_structure: 'settings.toolPermissions.get_vault_structure',
			open_note: 'settings.toolPermissions.open_note',
			open_settings: 'settings.toolPermissions.open_settings',
			get_app_config: 'settings.toolPermissions.get_app_config',
			update_app_config: 'settings.toolPermissions.update_app_config',
			manage_goal: 'settings.toolPermissions.manage_goal',
			search_plugins: 'settings.toolPermissions.search_plugins',
			install_plugin: 'settings.toolPermissions.install_plugin',
			update_plugin: 'settings.toolPermissions.update_plugin',
			uninstall_plugin: 'settings.toolPermissions.uninstall_plugin',
			configure_plugin: 'settings.toolPermissions.configure_plugin',
			get_plugin_status: 'settings.toolPermissions.get_plugin_status',
			list_ecosystem_changes: 'settings.toolPermissions.list_ecosystem_changes',
			restore_backup: 'settings.toolPermissions.restore_backup',
			apply_diary_host: 'settings.toolPermissions.apply_diary_host',
			list_host_dir: 'settings.toolPermissions.list_host_dir',
			read_host_file: 'settings.toolPermissions.read_host_file',
			import_host_file: 'settings.toolPermissions.import_host_file',
			run_host_command: 'settings.toolPermissions.run_host_command',
		};
		const key = map[toolName];
		return key ? tNow(key) : toolName;
	};
	const allTools = [
		'search_vault', 'read_note', 'grep', 'glob', 'list_files',
		'write_note', 'append_note', 'edit_note', 'apply_patch', 'delete_note', 'move_note', 'copy_note',
		'search_memory', 'remember', 'forget_memory',
		'activate_skill', 'deactivate_skill',
		'read_skill_reference', 'run_skill_script',
		'get_datetime', 'get_active_note', 'get_daily_note', 'list_recent_notes', 'get_note_outline',
		'get_links', 'search_by_tag', 'search_by_property', 'get_vault_structure',
		'open_note',
		'open_settings',
		'get_app_config',
		'update_app_config',
		'manage_goal',
		'search_plugins',
		'install_plugin',
		'update_plugin',
		'uninstall_plugin',
		'configure_plugin',
		'get_plugin_status',
		'list_ecosystem_changes',
		'restore_backup',
		'apply_diary_host',
	];

	const items: SettingDefinitionItem[] = [
		{
			name: tNow('settings.toolPermissionLevel.name'),
			desc: tNow('settings.toolPermissionLevel.desc'),
			control: {
				type: 'dropdown',
				key: 'toolPermissionLevel',
				options: {
					safe: tNow('settings.toolPermissionLevel.safe'),
					auto: tNow('settings.toolPermissionLevel.auto'),
					danger: tNow('settings.toolPermissionLevel.danger'),
				},
			},
		},
	];

	for (const name of allTools) {
		items.push({
			name: labelByKey(name),
			desc: name,
			control: {
				type: 'dropdown',
				key: `toolPermissions.${name}`,
				options: {
					allow: tNow('settings.toolPermissions.allow'),
					ask: tNow('settings.toolPermissions.ask'),
					deny: tNow('settings.toolPermissions.deny'),
				},
			},
		});
	}

	const mcpToolNames = (plugin.tools?.definitions() ?? [])
		.map((d) => d.name)
		.filter((name) => name.startsWith('mcp__'))
		.sort();

	if (mcpToolNames.length > 0) {
		items.push({
			name: tNow('settings.toolPermissions.mcpSection'),
			searchable: false,
			render: (setting) => {
				new Setting(setting.settingEl)
					.setName(tNow('settings.toolPermissions.mcpSection'))
					.setHeading();
			},
		});

		const permissionOptions = {
			allow: tNow('settings.toolPermissions.allow'),
			ask: tNow('settings.toolPermissions.ask'),
			deny: tNow('settings.toolPermissions.deny'),
		};

		for (const name of mcpToolNames) {
			const parsed = parseMcpToolName(name);
			const label = parsed
				? `${parsed.serverId} · ${parsed.toolName}`
				: name;
			items.push({
				name: label,
				desc: name,
				control: {
					type: 'dropdown',
					key: `toolPermissions.${name}`,
					options: permissionOptions,
				},
			});
		}
	}

	return items;
}

/**
 * @file src/tools/open-settings.ts
 * @description open_settings 工具 — 打开 Ratel 设置面板并定位到指定 tab
 * @module tools/open-settings
 * @depends core/tool-registry, ports/workspace, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { WorkspacePort } from '../ports/workspace';

/**
 * 设置面板 tab 白名单 — 与 `src/settings.ts` 的 `SETTINGS_UI_TABS` 保持一致。
 * 关键路径:本地常量而非值导入 settings.ts,避免工具模块把整个设置面板
 * (obsidian PluginSettingTab + UI 渲染)拉进依赖图;adapter 侧 focusTab
 * 还有第二层校验,两处漂移时非法 tab 仍会被拒绝。
 * 导出原因:供测试值导入并与 SETTINGS_UI_TABS 做相等断言,tab 集合演进时防线即报错。
 */
export const VALID_TABS = ['chat', 'index', 'agent', 'appearance', 'advanced'] as const;

/**
 * 构造 `open_settings` 工具。
 *
 * 设计要点:
 * - 纯 UI 导航,不读写任何配置 → readOnly: true,默认权限 allow。
 * - 白名单外的配置(密钥、MCP、prompt 覆盖)Agent 不能代改,本工具把
 *   对应 tab 直接打开到用户眼前,引导词不再让用户自己翻菜单。
 * - tab 省略 / 非字符串按 undefined 处理(打开默认 chat tab)。
 * - 非法 tab 本地拒绝且不调用打开:adapter 侧虽还有 focusTab 校验,
 *   但 setting.open() 已切换到设置页,拒绝要发生在切页之前才有意义。
 *
 * @param workspace - 打开设置面板
 * @param definition - LLM schema
 */
export function createOpenSettingsTool(
	workspace: WorkspacePort,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			// 关键路径:args 运行时类型不可信(LLM 可能传非字符串),非字符串按省略处理
			const tab = typeof args.tab === 'string' && args.tab.length > 0 ? args.tab : undefined;
			if (tab != null && !(VALID_TABS as readonly string[]).includes(tab)) {
				return {
					opened: false,
					message: `tab 只能是: ${VALID_TABS.join('、')}。`,
				};
			}
			const opened = await workspace.openPluginSettings(tab);
			return {
				opened,
				tab: tab ?? 'chat',
				...(opened ? {} : { message: '设置面板未能打开(插件设置页尚未就绪),可让用户手动打开 设置 → Ratel。' }),
			};
		},
	};
}

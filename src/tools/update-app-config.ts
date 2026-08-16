/**
 * @file src/tools/update-app-config.ts
 * @description update_app_config 工具 — 白名单内代改设置,写入走 settings-apply 同一套副作用
 * @module tools/update-app-config
 * @depends core/tool-registry, ports/llm, settings/settings-apply, settings/config-whitelist
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { applySettingValue, type SettingApplier } from '../settings/settings-apply';
import { validateConfigValue } from '../settings/config-whitelist';

/**
 * update_app_config 工具宿主 — SettingApplier 加落盘。
 *
 * 设计要点:
 * - RatelVaultPlugin 结构兼容(settings / rebuildLLM / rebuildEmbeddingAdapter /
 *   syncToolDefinitions / saveSettings),main.ts 直接传 this;
 * - 不直接依赖 RatelVaultPlugin 类型,避免 tools ↔ main 循环 import。
 */
export interface ConfigUpdateHost extends SettingApplier {
	/** 持久化 settings 到 data.json(RatelVaultPlugin.saveSettings) */
	saveSettings(): Promise<void>;
}

/** 单个 key 的写入结论 — 拒绝时附中文 reason(LLM 可读,用于自我修正) */
export interface ConfigUpdateItemResult {
	key: string;
	ok: boolean;
	reason?: string;
}

/** update_app_config 返回体 — 逐 key 结论 + 成功应用清单 */
export interface ConfigUpdateResult {
	results: ConfigUpdateItemResult[];
	applied: string[];
}

/**
 * 构造 `update_app_config` 工具。
 *
 * 设计要点:
 * - `updates` 是键值对,逐 key `validateConfigValue`:拒绝的单条记 reason,
 *   通过的走 `applySettingValue` — 与设置面板 setControlValue 完全同一条写路径,
 *   副作用(rebuildLLM / rebuildEmbeddingAdapter / preset 联动)永不漂移。
 * - 单 key 拒绝不影响同批其他 key;只有至少一个 key 成功才落盘一次。
 * - 白名单硬编码在 config-whitelist.ts,提权项(toolPermissions / MCP /
 *   promptOverrides 等)结构上不可能被 LLM 写入。
 *
 * @param host - 宿主(settings + 副作用回调 + 落盘)
 * @param definition - LLM schema
 * @returns Tool 实例(readOnly: false)
 *
 * @example
 *   const tool = createUpdateAppConfigTool(plugin, toolDefMap.get('update_app_config')!);
 *   await tool.execute({ updates: { chunkSize: 800, autoIndex: false } });
 *   // → { results: [{key:'chunkSize',ok:true},{key:'autoIndex',ok:true}], applied: ['chunkSize','autoIndex'] }
 */
export function createUpdateAppConfigTool(
	host: ConfigUpdateHost,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		// 关键路径:写设置 + 落盘,必须触发写钩子与权限确认(默认 ask)
		readOnly: false,
		async execute(args: Record<string, unknown>): Promise<ConfigUpdateResult> {
			// 关键路径:args 运行时类型不可信(LLM 可能传 null / 数组),统一守卫
			const rawUpdates = args?.updates;
			const updates =
				rawUpdates != null && typeof rawUpdates === 'object' && !Array.isArray(rawUpdates)
					? (rawUpdates as Record<string, unknown>)
					: {};

			const results: ConfigUpdateItemResult[] = [];
			const applied: string[] = [];
			for (const [key, value] of Object.entries(updates)) {
				const verdict = validateConfigValue(key, value);
				if (verdict.ok) {
					// 关键路径:与设置面板共用 applySettingValue,副作用分发一致
					try {
						applySettingValue(host, key, value);
						applied.push(key);
						results.push({ key, ok: true });
					} catch (err) {
						// 关键路径:单 key 应用抛错不中断整批 — 防宿主回调(rebuildLLM 等)未来
						// 演变出可抛路径时,半应用状态直接炸掉整次调用、留下脏值无法收尾。
						// 记失败原因继续,让同批其余 key 正常落地,错误留给 LLM 自我修正。
						results.push({
							key,
							ok: false,
							reason: '应用时出错: ' + (err instanceof Error ? err.message : String(err)),
						});
						continue;
					}
				} else {
					results.push({ key, ok: false, reason: verdict.reason });
				}
			}

			// 关键路径:全拒 / 空批次不落盘,避免无意义 IO 与设置面板刷新
			if (applied.length > 0) {
				await host.saveSettings();
			}
			return { results, applied };
		},
	};
}

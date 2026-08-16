/**
 * @file src/tools/get-app-config.ts
 * @description get_app_config 工具 — 读取脱敏配置快照 + 密钥存在性 + 索引状态
 * @module tools/get-app-config
 * @depends core/tool-registry, core/index-manager, secrets/ratel-secrets, settings, svelte/store
 */

import { get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { Tool } from '../core/tool-registry';
import type { IndexStatus } from '../core/index-manager';
import type { ToolDefinition } from '../ports/llm';
import type { RatelVaultSettings } from '../settings';
import type { ChatSecretSettings, EmbedSecretSettings } from '../secrets/ratel-secrets';

/**
 * 密钥探测函数组 — 依赖注入,便于单测 mock。
 *
 * 设计要点:
 * - 形状对齐 `src/secrets/ratel-secrets.ts` 真实函数签名(探测函数带 app 参数)。
 * - 只暴露 has 前缀与 getSecretId 类函数,不含 resolve 类函数 — 工具永远拿不到密钥值本身。
 * - 用 method 简写声明,main.ts 可直接内联绑定模块散函数,无需包装层。
 */
export interface SecretProbe {
	/** Chat 是否已配置密钥(或本地 Ollama 无需密钥) */
	hasChatApiKey(app: unknown, settings: ChatSecretSettings): boolean;
	/** 当前 Chat 上下文所需的钥匙串密钥 ID;无需密钥时为 null */
	getChatSecretId(settings: ChatSecretSettings): string | null;
	/** Embedding 是否已配置密钥(或本地模式无需密钥) */
	hasEmbedApiKey(app: unknown, settings: EmbedSecretSettings): boolean;
	/** 当前 Embedding 上下文所需的钥匙串密钥 ID;无需密钥时为 null */
	getEmbedSecretId(settings: EmbedSecretSettings): string | null;
	/** Rerank 百炼密钥是否已配置 */
	hasRerankApiKey(app: unknown): boolean;
}

/**
 * get_app_config 返回的应用配置快照。
 *
 * 设计要点:
 * - `config`:settings 全量浅拷贝 — settings 接口本身无密钥字段(密钥全在 Obsidian 钥匙串),天然脱敏。
 * - `secrets`:只含 boolean 存在性与所需 secret ID,密钥值零暴露。
 * - `index`:status$ 当前状态 + 用户暂停开关;仅 Ready 态附带 totalDocs/lastIndexTime。
 */
export interface AppConfigSnapshot {
	config: Record<string, unknown>;
	secrets: {
		hasChatApiKey: boolean;
		requiredChatSecretId: string | null;
		hasEmbedApiKey: boolean;
		requiredEmbedSecretId: string | null;
		hasRerankApiKey: boolean;
	};
	index: {
		state: string;
		totalDocs?: number;
		lastIndexTime?: number;
		paused: boolean;
	};
}

/** get_app_config 工具宿主依赖 — app 实例 + 密钥探测函数组 */
export interface GetAppConfigHost {
	app: unknown;
	secrets: SecretProbe;
}

/**
 * 构造 `get_app_config` 工具。
 *
 * 设计要点:
 * - 纯读取,不写任何文件 → readOnly: true。
 * - 排查「为什么不工作」的第一步:Agent 先看配置现状(模型端点 / Embedding
 *   provider / 索引状态),再决定下一步动作(改设置 / 引导用户配密钥 / 重建索引)。
 * - settingsHost.settings 是 live 引用:用户改设置后无需重建工具,下次调用即读到新值;
 *   返回时浅拷贝,避免调用方(或后续 mutation)污染已返回的历史快照。
 *
 * @param host - app 实例 + 密钥探测函数组(ratel-secrets 散函数的内联绑定)
 * @param settingsHost - live settings 引用容器
 * @param indexStatus - IndexManager 的 status$ store,execute 时用 get() 读当前值
 * @param definition - LLM schema
 */
export function createGetAppConfigTool(
	host: GetAppConfigHost,
	settingsHost: { settings: RatelVaultSettings },
	indexStatus: Readable<IndexStatus>,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(): Promise<AppConfigSnapshot> {
			const s = settingsHost.settings;
			const status = get(indexStatus);
			return {
				// 关键路径:浅拷贝隔离 — settings 是 live 引用,快照返回后不受后续变更影响
				config: { ...s },
				secrets: {
					hasChatApiKey: host.secrets.hasChatApiKey(host.app, s),
					requiredChatSecretId: host.secrets.getChatSecretId(s),
					hasEmbedApiKey: host.secrets.hasEmbedApiKey(host.app, s),
					requiredEmbedSecretId: host.secrets.getEmbedSecretId(s),
					hasRerankApiKey: host.secrets.hasRerankApiKey(host.app),
				},
				index: {
					state: status.state,
					// 关键路径:totalDocs/lastIndexTime 仅 Ready 态存在(判别联合),其余状态省略
					...(status.state === 'Ready'
						? { totalDocs: status.totalDocs, lastIndexTime: status.lastIndexTime }
						: {}),
					// 关键路径:paused 来自设置面板的 indexPaused 开关,而非 status$ 的 Paused 态
					paused: s.indexPaused,
				},
			};
		},
	};
}

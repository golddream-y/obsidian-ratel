/**
 * @file src/settings/model-catalog.ts
 * @description models.dev 名单的类型、精确查表与下拉过滤（无 IO）
 * @module settings/model-catalog
 */

/** models.dev 全量名单地址 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** 本地 Ollama，不在名单里 */
export const LOCAL_PROVIDER_OLLAMA = 'ollama';

/** 自定义地址，不在名单里 */
export const LOCAL_PROVIDER_CUSTOM = 'custom';

export interface CatalogLimits {
	context: number;
	output: number;
}

export interface CatalogProviderRow {
	id: string;
	name: string;
	/** 官方接口地址。名单没给时为 null，不得编造。 */
	api: string | null;
	/** 官方文档地址。不是说明文字，名单里没有描述字段。 */
	doc: string | null;
}

export interface ModelsDevModel {
	id: string;
	limit?: { context?: number; output?: number };
	tool_call?: boolean;
	status?: string;
}

export interface ModelsDevProvider {
	id: string;
	name?: string;
	api?: string | null;
	doc?: string | null;
	models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/**
 * 按供应商 id + 模型 id 精确取窗口和单次输出。
 *
 * @param catalog - 已解析的名单
 * @param providerId - 供应商 id
 * @param modelId - 模型 id
 * @returns context 大于 0 时返回；output 缺省或非正数时为 0。未命中返回 undefined
 */
export function lookupCatalogLimits(
	catalog: ModelsDevCatalog,
	providerId: string,
	modelId: string,
): CatalogLimits | undefined {
	const model = catalog[providerId]?.models?.[modelId];
	const context = model?.limit?.context;
	if (typeof context !== 'number' || context <= 0) return undefined;
	const output = model?.limit?.output;
	return {
		context,
		output: typeof output === 'number' && output > 0 ? output : 0,
	};
}

/**
 * 下拉用的模型 id：窗口大于 0 且 tool_call 为真。不因 status 隐藏。
 *
 * @param catalog - 已解析的名单
 * @param providerId - 供应商 id
 * @returns 排序后的模型 id
 */
export function listCatalogModels(catalog: ModelsDevCatalog, providerId: string): string[] {
	const models = catalog[providerId]?.models ?? {};
	return Object.values(models)
		.filter((model) => (model.limit?.context ?? 0) > 0 && model.tool_call === true && model.id)
		.map((model) => model.id)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * 下拉用的供应商。空 api 记为 null，调用方不得编造地址。
 * 跳过 id 为 ollama / custom 的记录，避免和内置两项重复。
 *
 * @param catalog - 已解析的名单
 * @returns 按 name 排序的行
 */
export function listCatalogProviders(catalog: ModelsDevCatalog): CatalogProviderRow[] {
	const rows: CatalogProviderRow[] = [];
	for (const provider of Object.values(catalog)) {
		if (!provider?.id) continue;
		if (provider.id === LOCAL_PROVIDER_OLLAMA || provider.id === LOCAL_PROVIDER_CUSTOM) continue;
		const api = typeof provider.api === 'string' ? provider.api.trim() : '';
		const doc = typeof provider.doc === 'string' ? provider.doc.trim() : '';
		rows.push({
			id: provider.id,
			name: provider.name?.trim() || provider.id,
			api: api || null,
			doc: doc || null,
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
	return rows;
}

/**
 * 空白检索时先列出的供应商。
 * 这是我们挑的短名单，不是 models.dev 的分组或热度（名单里没有这两项）。
 */
export const PINNED_PROVIDER_IDS = [
	'deepseek',
	'volcengine',
	'alibaba-cn',
	'alibaba',
	'zhipuai',
	'zai',
	'moonshotai-cn',
	'siliconflow-cn',
	'siliconflow',
	'stepfun',
	'minimax-cn',
	'openai',
	'anthropic',
	'google',
	'xai',
	'mistral',
	'groq',
	'openrouter',
] as const;

/**
 * 检索用的中文别名。名单名称是英文，搜「火山」否则对不上 Volcengine Ark。
 * 只用于匹配和展示，不写入配置。
 */
const PROVIDER_SEARCH_ALIASES: Record<string, string> = {
	deepseek: '深度求索',
	volcengine: '火山引擎 方舟',
	'volcengine-coding-plan': '火山引擎 方舟',
	'alibaba-cn': '阿里云 百炼 通义',
	alibaba: '阿里云 百炼 通义',
	'alibaba-coding-plan': '阿里云',
	'alibaba-coding-plan-cn': '阿里云',
	zhipuai: '智谱',
	'zhipuai-coding-plan': '智谱',
	zai: '智谱',
	'zai-coding-plan': '智谱',
	'moonshotai-cn': '月之暗面 Kimi',
	moonshotai: '月之暗面 Kimi',
	'siliconflow-cn': '硅基流动',
	siliconflow: '硅基流动',
	stepfun: '阶跃星辰',
	'minimax-cn': '稀宇 MiniMax',
	minimax: '稀宇 MiniMax',
};

/** 展示在名称后面的中文别名。没有则返回空串。 */
export function providerSearchAlias(id: string): string {
	return PROVIDER_SEARCH_ALIASES[id] ?? '';
}

/**
 * 按检索词过滤供应商。空白时只返回短名单里实际存在的行，顺序跟短名单一致。
 *
 * @param rows - listCatalogProviders 的结果
 * @param query - 用户输入，匹配名称或 id
 * @returns 要放进下拉的行，不含本地 Ollama 和自定义
 */
export function filterCatalogProviders(
	rows: readonly CatalogProviderRow[],
	query: string,
): CatalogProviderRow[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		const byId = new Map(rows.map((row) => [row.id, row]));
		const pinned: CatalogProviderRow[] = [];
		for (const id of PINNED_PROVIDER_IDS) {
			const row = byId.get(id);
			if (row) pinned.push(row);
		}
		return pinned;
	}
	return rows
		.filter((row) => {
			const alias = providerSearchAlias(row.id).toLowerCase();
			return row.name.toLowerCase().includes(q)
				|| row.id.toLowerCase().includes(q)
				|| alias.includes(q);
		})
		.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** 下拉里的「手填」选项值，不会是合法模型 id */
export const CATALOG_MODEL_HAND = '__hand';

/**
 * 当前模型在过滤列表里就选中它，否则选手填。
 *
 * @param modelIds - listCatalogModels 的结果
 * @param current - 这一套已保存的模型 id
 * @returns 下拉 value
 */
export function modelPickValue(modelIds: readonly string[], current: string): string {
	return modelIds.includes(current) ? current : CATALOG_MODEL_HAND;
}

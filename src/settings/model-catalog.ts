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
	api: string | null;
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
		rows.push({
			id: provider.id,
			name: provider.name?.trim() || provider.id,
			api: api || null,
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
	return rows;
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

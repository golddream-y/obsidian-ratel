/**
 * @file src/adapters/data-json-merge.ts
 * @description data.json 浅合并 — settings 与 Persistence 字段互不覆盖
 * @module adapters/data-json-merge
 */

/**
 * 浅合并插件 data.json 对象。
 *
 * 关键路径:后写 patch 覆盖同名键,但调用方必须先 load 再 merge,
 * 避免 saveSettings 只写 settings、或 Persistence 只写索引而互相抹掉。
 *
 * @param existing - 磁盘上已有对象
 * @param patch - 要合并进去的字段
 */
export function mergePluginData(
	existing: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return { ...existing, ...patch };
}

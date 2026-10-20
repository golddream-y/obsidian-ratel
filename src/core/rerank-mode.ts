/**
 * @file src/core/rerank-mode.ts
 * @description 精排开关与来源 → 实际生效来源的纯函数解析
 * @module core/rerank-mode
 * @depends (无)
 */

/**
 * 精排来源 — 用户选择的精排路径。
 * - `native`:专用 rerank 模型(百炼 DashScope)。
 * - `llm`:当前对话模型,复用已有供应商,不新增外发目的地。
 */
export type RerankSource = 'native' | 'llm';

/**
 * 实际生效的精排来源。
 * - `off`:未启用,或所选来源缺少可用能力。
 */
export type EffectiveRerank = 'off' | 'native' | 'llm';

/**
 * 解析实际生效的精排来源。
 *
 * 关键路径:两种来源互斥——选定 llm 即替代 native,不叠加、不回落。
 * 缺能力时返回 off,由界面如实说明原因,不悄悄换一条更贵的路径。
 *
 * @param enabled - 用户是否启用精排开关。
 * @param source - 用户选择的精排来源。
 * @param cap - 当前可用能力(专用模型密钥是否存在、对话模型是否可用)。
 * @returns 实际生效的精排来源。
 * @example
 *   resolveRerankMode(true, 'llm', { hasNativeKey: false, hasLlm: true }); // 'llm'
 */
export function resolveRerankMode(
	enabled: boolean,
	source: RerankSource,
	cap: { hasNativeKey: boolean; hasLlm: boolean },
): EffectiveRerank {
	if (!enabled) return 'off';
	if (source === 'llm') return cap.hasLlm ? 'llm' : 'off';
	return cap.hasNativeKey ? 'native' : 'off';
}

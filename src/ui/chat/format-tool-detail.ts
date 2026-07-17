/**
 * @file src/ui/chat/format-tool-detail.ts
 * @description 工具 Trace 旁注门面 — normalize → render(S-CHAT-TRACE 中间层)
 * @module ui/chat/format-tool-detail
 * @depends ./normalize-tool-detail, ./render-tool-detail
 */

import { normalizeToolDetail } from './normalize-tool-detail';
import { metaShortFromModel, renderToolDetail } from './render-tool-detail';
import type { ToolDetailModel } from './tool-detail-model';

export type { ToolDetailModel };
export { normalizeToolDetail, metaShortFromModel, renderToolDetail };

export interface FormatToolDetailOptions {
	status?: 'calling' | 'done' | 'failed';
}

/**
 * 生成展开旁注文本(门面)。
 */
export function formatToolDetail(
	name: string,
	args: unknown,
	result: unknown,
	errorMessage?: string,
	status?: 'calling' | 'done' | 'failed',
): string {
	const model = normalizeToolDetail({ name, args, result, errorMessage, status });
	return renderToolDetail(model);
}

/**
 * 生成折叠行短 meta(与展开共用 Model)。
 */
export function formatToolMeta(
	name: string,
	args: unknown,
	result: unknown,
	errorMessage?: string,
	status?: 'calling' | 'done' | 'failed',
): string {
	const model = normalizeToolDetail({ name, args, result, errorMessage, status });
	return metaShortFromModel(model);
}

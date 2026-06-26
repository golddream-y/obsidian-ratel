/**
 * @file src/ui/attachment-utils.ts
 * @description 图片附件 token 估算与校验纯函数 — 供 AttachmentStrip / ChatView 调用
 * @module ui/attachment-utils
 */

/** 允许的图片 MIME 类型 */
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** 单张附件大小上限 5MB */
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

/** 单次发送最多 4 张附件 */
export const MAX_ATTACHMENTS = 4;

/** 校验输入 — 浏览器 File 对象的最小子集,便于单测构造 */
export interface AttachmentFileLike {
	name: string;
	type: string;
	size: number;
}

/** 校验结果 */
export interface ValidateResult {
	ok: boolean;
	reason?: string;
}

/**
 * 估算图片占用 token 数 — OpenAI Vision 经验公式:ceil(width * height / 750)。
 *
 * 关键路径:仅用于 UI 显示预估,不可用于计费;实际 token 由模型 API 计算。
 *
 * @param width - 图片宽度(像素)
 * @param height - 图片高度(像素)
 * @returns token 估算值(向上取整,0 时返回 0)
 */
export function estimateImageTokens(width: number, height: number): number {
	if (width <= 0 || height <= 0) return 0;
	return Math.ceil((width * height) / 750);
}

/**
 * 校验附件是否可添加 — MIME 类型 + 大小 + 数量限制。
 *
 * @param file - 浏览器 File 对象子集(name/type/size)
 * @param currentCount - 当前已添加的附件数
 * @returns ok=true 可添加;ok=false 附 reason 文案
 */
export function validateAttachment(file: AttachmentFileLike, currentCount: number): ValidateResult {
	if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
		return { ok: false, reason: `仅支持图片格式:${ALLOWED_MIME_TYPES.join(', ')}` };
	}
	if (file.size > MAX_ATTACHMENT_SIZE) {
		return { ok: false, reason: `图片大小超过 5MB(当前 ${(file.size / 1024 / 1024).toFixed(1)}MB)` };
	}
	if (currentCount >= MAX_ATTACHMENTS) {
		return { ok: false, reason: `单次最多 ${MAX_ATTACHMENTS} 张图片` };
	}
	return { ok: true };
}

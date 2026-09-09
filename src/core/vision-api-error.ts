/**
 * @file src/core/vision-api-error.ts
 * @description 识别「模型不收图」类 API 报错 — 发图后由接口失败映射,不再预拦截
 * @module core/vision-api-error
 */

/**
 * 是否像视觉/多模态被端点拒绝。
 *
 * @param message - 适配器或网关抛出的错误文案
 */
export function isLikelyVisionApiError(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes('image_url') ||
		m.includes('multimodal') ||
		/\bvision\b/.test(m) ||
		m.includes('does not support image') ||
		m.includes('invalid image') ||
		message.includes('不支持图片')
	);
}

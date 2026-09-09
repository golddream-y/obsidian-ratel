/**
 * @file src/core/vision-api-error.test.ts
 * @description 视觉 API 报错启发式 — 把拒图文案从普通 LLM_ERROR 里认出来
 * @module core/vision-api-error.test
 */
import { describe, it, expect } from 'vitest';
import { isLikelyVisionApiError } from './vision-api-error';

describe('isLikelyVisionApiError', () => {
	it('含 image_url - 判为拒图', () => {
		expect(isLikelyVisionApiError('Invalid content: image_url is not supported')).toBe(true);
	});

	it('含 multimodal / vision / does not support image - 判为拒图', () => {
		expect(isLikelyVisionApiError('This model does not support multimodal')).toBe(true);
		expect(isLikelyVisionApiError('Vision is not enabled for this model')).toBe(true);
		expect(isLikelyVisionApiError('The model does not support image input')).toBe(true);
	});

	it('含中文不支持图片 - 判为拒图', () => {
		expect(isLikelyVisionApiError('当前模型不支持图片')).toBe(true);
	});

	it('普通限流或鉴权文案 - 不误判', () => {
		expect(isLikelyVisionApiError('Rate limit exceeded')).toBe(false);
		expect(isLikelyVisionApiError('Invalid API key')).toBe(false);
		expect(isLikelyVisionApiError('HTTP 400: invalid request')).toBe(false);
	});
});

/**
 * @file tests/ui/attachment-utils.test.ts
 * @description attachment-utils — 图片 token 估算与校验纯函数单测
 * @module tests/ui/attachment-utils
 * @depends ui/attachment-utils
 */

import { describe, it, expect } from 'vitest';
import { estimateImageTokens, validateAttachment, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS, ALLOWED_MIME_TYPES } from '../../src/ui/chat/input/attachment-utils';

describe('attachment-utils', () => {
	describe('estimateImageTokens', () => {
		it('512x512 - 约 349 tokens(512*512/750)', () => {
			// 262144 / 750 = 349.525..., ceil = 350
			expect(estimateImageTokens(512, 512)).toBe(350);
		});

		it('1024x1024 - 约 1399 tokens', () => {
			// 1048576 / 750 = 1398.1, ceil = 1399
			expect(estimateImageTokens(1024, 1024)).toBe(1399);
		});

		it('100x100 - 至少 14 tokens', () => {
			expect(estimateImageTokens(100, 100)).toBeGreaterThanOrEqual(14);
		});

		it('0x0 - 返回 0(防负数)', () => {
			expect(estimateImageTokens(0, 0)).toBe(0);
		});
	});

	describe('validateAttachment', () => {
		it('合法 PNG 5MB 以内 - 通过', () => {
			const result = validateAttachment({
				name: 'a.png',
				type: 'image/png',
				size: 2 * 1024 * 1024,
			}, 0);
			expect(result.ok).toBe(true);
		});

		it('合法 JPEG - 通过', () => {
			const result = validateAttachment({
				name: 'a.jpg',
				type: 'image/jpeg',
				size: 1024,
			}, 2);
			expect(result.ok).toBe(true);
		});

		it('合法 WebP - 通过', () => {
			const result = validateAttachment({
				name: 'a.webp',
				type: 'image/webp',
				size: 1024,
			}, 0);
			expect(result.ok).toBe(true);
		});

		it('合法 GIF - 通过', () => {
			const result = validateAttachment({
				name: 'a.gif',
				type: 'image/gif',
				size: 1024,
			}, 0);
			expect(result.ok).toBe(true);
		});

		it('不支持的 MIME(text/plain) - 拒绝', () => {
			const result = validateAttachment({
				name: 'a.txt',
				type: 'text/plain',
				size: 1024,
			}, 0);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('图片');
		});

		it('超过 5MB - 拒绝', () => {
			const result = validateAttachment({
				name: 'big.png',
				type: 'image/png',
				size: MAX_ATTACHMENT_SIZE + 1,
			}, 0);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('5MB');
		});

		it('已有 4 张 - 拒绝(单次最多 4 张)', () => {
			const result = validateAttachment({
				name: 'a.png',
				type: 'image/png',
				size: 1024,
			}, MAX_ATTACHMENTS);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('4 张');
		});

		it('已有 3 张加第 4 张 - 通过', () => {
			const result = validateAttachment({
				name: 'a.png',
				type: 'image/png',
				size: 1024,
			}, MAX_ATTACHMENTS - 1);
			expect(result.ok).toBe(true);
		});
	});

	it('ALLOWED_MIME_TYPES - 含 png/jpeg/webp/gif', () => {
		expect(ALLOWED_MIME_TYPES).toContain('image/png');
		expect(ALLOWED_MIME_TYPES).toContain('image/jpeg');
		expect(ALLOWED_MIME_TYPES).toContain('image/webp');
		expect(ALLOWED_MIME_TYPES).toContain('image/gif');
	});

	it('MAX_ATTACHMENT_SIZE - 5MB', () => {
		expect(MAX_ATTACHMENT_SIZE).toBe(5 * 1024 * 1024);
	});

	it('MAX_ATTACHMENTS - 4', () => {
		expect(MAX_ATTACHMENTS).toBe(4);
	});
});

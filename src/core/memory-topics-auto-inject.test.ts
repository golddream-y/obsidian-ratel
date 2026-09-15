/**
 * @file src/core/memory-topics-auto-inject.test.ts
 * @description 记忆主题自动注入 — 空索引与未就绪时跳过 embed
 * @module core/memory-topics-auto-inject.test
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoEmbedTopics } from './memory-topics-auto-inject';

describe('shouldAutoEmbedTopics', () => {
	const ok = { k: 3, message: 'hello', indexCount: 2, embeddingReady: true };

	it('shouldAutoEmbedTopics - 索引有条目且 K>0 且 embedding ready - 允许 embed', () => {
		expect(shouldAutoEmbedTopics(ok)).toBe(true);
	});

	it('shouldAutoEmbedTopics - indexEntries 为空 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, indexCount: 0 })).toBe(false);
	});

	it('shouldAutoEmbedTopics - K 为 0 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, k: 0 })).toBe(false);
	});

	it('shouldAutoEmbedTopics - 消息空白 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, message: '   ' })).toBe(false);
	});

	it('shouldAutoEmbedTopics - embedding 未就绪 - 跳过', () => {
		expect(shouldAutoEmbedTopics({ ...ok, embeddingReady: false })).toBe(false);
	});
});

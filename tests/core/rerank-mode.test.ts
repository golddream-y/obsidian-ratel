/**
 * @file tests/core/rerank-mode.test.ts
 * @description 精排开关与来源解析单元测试
 * @module tests/core/rerank-mode
 * @depends src/core/rerank-mode
 */

import { describe, it, expect } from 'vitest';
import { resolveRerankMode } from '../../src/core/rerank-mode';

describe('resolveRerankMode', () => {
	const cap = (native: boolean, llm: boolean) => ({ hasNativeKey: native, hasLlm: llm });

	it('开关关闭 - 任意来源都不精排', () => {
		expect(resolveRerankMode(false, 'native', cap(true, true))).toBe('off');
		expect(resolveRerankMode(false, 'llm', cap(true, true))).toBe('off');
	});

	it('默认来源 native - 有密钥生效', () => {
		expect(resolveRerankMode(true, 'native', cap(true, false))).toBe('native');
	});

	it('native 无密钥 - 关闭，且不回落对话模型', () => {
		expect(resolveRerankMode(true, 'native', cap(false, true))).toBe('off');
	});

	it('llm - 对话模型可用时替代专用模型', () => {
		expect(resolveRerankMode(true, 'llm', cap(true, true))).toBe('llm');
	});

	it('llm 不可用 - 关闭', () => {
		expect(resolveRerankMode(true, 'llm', cap(true, false))).toBe('off');
	});
});

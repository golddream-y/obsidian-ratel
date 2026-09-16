/**
 * @file tests/core/preloaded-context.test.ts
 * @description ask 是否复用预加载 ctx — 纯函数，不启动 Plugin
 * @module tests/core/preloaded-context
 */

import { describe, it, expect } from 'vitest';
import { shouldReusePreloadedContext } from '../../src/core/preloaded-context';

describe('shouldReusePreloadedContext', () => {
	it('shouldReusePreloadedContext - sessionId 相同 - 复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's1')).toBe(true);
	});
	it('shouldReusePreloadedContext - sessionId 不同或缺失 - 不复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's2')).toBe(false);
		expect(shouldReusePreloadedContext(undefined, 's1')).toBe(false);
		expect(shouldReusePreloadedContext({ sessionId: '' }, 's1')).toBe(false);
	});
});

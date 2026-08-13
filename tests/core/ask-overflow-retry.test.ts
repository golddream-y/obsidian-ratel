import { describe, it, expect } from 'vitest';
import { shouldRetryAfterOverflow } from '../../src/core/compact-overflow-retry';

describe('shouldRetryAfterOverflow', () => {
	it('shouldRetryAfterOverflow - CONTEXT_OVERFLOW 首轮无工具 - true', () => {
		expect(
			shouldRetryAfterOverflow({
				code: 'CONTEXT_OVERFLOW',
				toolsAlreadyRun: false,
				alreadyRetried: false,
			}),
		).toBe(true);
	});

	it('shouldRetryAfterOverflow - 已跑工具 - false', () => {
		expect(
			shouldRetryAfterOverflow({
				code: 'CONTEXT_OVERFLOW',
				toolsAlreadyRun: true,
				alreadyRetried: false,
			}),
		).toBe(false);
	});

	it('shouldRetryAfterOverflow - 已重试过 - false', () => {
		expect(
			shouldRetryAfterOverflow({
				code: 'CONTEXT_OVERFLOW',
				toolsAlreadyRun: false,
				alreadyRetried: true,
			}),
		).toBe(false);
	});
});

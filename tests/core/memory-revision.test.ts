/**
 * @file tests/core/memory-revision.test.ts
 * @description memoryRevision bump 通知
 */
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { bumpMemory, memoryRevision } from '../../src/core/memory-revision';

describe('memoryRevision', () => {
	it('bumpMemory - 调用后 - revision 递增', () => {
		const before = get(memoryRevision);
		bumpMemory();
		expect(get(memoryRevision)).toBe(before + 1);
	});
});

/**
 * @file tests/ui/settings-revision.test.ts
 * @description settingsRevision bump 通知
 */
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { bumpSettingsRevision, settingsRevision } from '../../src/ui/settings-revision';

describe('settingsRevision', () => {
	it('bumpSettingsRevision - 调用后 - revision 递增', () => {
		const before = get(settingsRevision);
		bumpSettingsRevision();
		expect(get(settingsRevision)).toBe(before + 1);
	});
});

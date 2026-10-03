/**
 * @file tests/ui/settings-store.test.ts
 * @description settings$ 快照发布 — 隔离 / revision / 嵌套拷贝
 * @module tests/ui/settings-store
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_SETTINGS } from '../../src/settings';
import {
	settings$,
	publishSettingsSnapshot,
	resetSettingsStoreForTests,
	cloneSettingsSnapshot,
} from '../../src/ui/settings-store';
import { settingsRevision } from '../../src/ui/settings-revision';

describe('settings-store', () => {
	beforeEach(() => {
		resetSettingsStoreForTests();
	});

	it('publishSettingsSnapshot - 修改源对象后 - 已发布快照不被原地篡改', () => {
		const live = { ...DEFAULT_SETTINGS, chatModel: 'model-a' };
		publishSettingsSnapshot(live);
		const snap1 = get(settings$);
		live.chatModel = 'model-b';
		expect(snap1.chatModel).toBe('model-a');
		expect(get(settings$).chatModel).toBe('model-a');
	});

	it('publishSettingsSnapshot - 连续两次 - settingsRevision 各 +1 且无 double bump', () => {
		const before = get(settingsRevision);
		publishSettingsSnapshot({ ...DEFAULT_SETTINGS });
		expect(get(settingsRevision)).toBe(before + 1);
		publishSettingsSnapshot({ ...DEFAULT_SETTINGS, chatModel: 'x' });
		expect(get(settingsRevision)).toBe(before + 2);
	});

	it('cloneSettingsSnapshot - 改 toolPermissions 源 - 快照内权限表独立', () => {
		const live = {
			...DEFAULT_SETTINGS,
			toolPermissions: { ...DEFAULT_SETTINGS.toolPermissions, read_note: 'ask' as const },
		};
		const snap = cloneSettingsSnapshot(live);
		live.toolPermissions.read_note = 'allow';
		expect(snap.toolPermissions.read_note).toBe('ask');
	});

	it('cloneSettingsSnapshot - 改 chatProfiles 源的模型 - 快照里的套独立', () => {
		const live = {
			...DEFAULT_SETTINGS,
			chatProfiles: [{
				id: 'p1',
				name: 'A',
				apiBase: 'https://a',
				model: 'qwen',
				contextLengthPreset: '256k' as const,
				chatModelMaxTokens: 256_000,
			}],
		};
		const snap = cloneSettingsSnapshot(live);
		live.chatProfiles[0]!.model = 'claude';
		expect(snap.chatProfiles[0]!.model).toBe('qwen');
	});

	it('cloneSettingsSnapshot - 改 promptOverrides 源 - 快照独立', () => {
		const live = {
			...DEFAULT_SETTINGS,
			promptOverrides: { 'agent.identity': 'A' },
		};
		const snap = cloneSettingsSnapshot(live);
		live.promptOverrides['agent.identity'] = 'B';
		expect(snap.promptOverrides['agent.identity']).toBe('A');
	});
});

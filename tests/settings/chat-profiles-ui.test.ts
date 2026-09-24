/**
 * @file tests/settings/chat-profiles-ui.test.ts
 * @description 多套配置切换/另存/删除纯逻辑
 * @module tests/settings/chat-profiles-ui
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import {
	switchChatProfile,
	saveCurrentAsProfile,
	deleteChatProfile,
} from '../../src/settings/chat-profiles';
import {
	chatProfileSecretId,
	resolveChatApiKey,
	setChatProfileSecret,
} from '../../src/secrets/ratel-secrets';

const base = () => ({
	chatModel: 'm-current',
	chatApiBase: 'https://current',
	contextLengthPreset: '256k' as const,
	chatModelMaxTokens: 256_000,
	chatProfiles: [
		{ id: 'p1', name: 'A', apiBase: 'https://a', model: 'm1', contextLengthPreset: '128k' as const, chatModelMaxTokens: 128_000 },
	],
	activeChatProfileId: 'p1',
});

describe('switchChatProfile', () => {
	it('切到另一套 - 当前四字段换成该套', () => {
		const s = base();
		switchChatProfile(s as never, 'p1');
		expect(s.chatModel).toBe('m1');
		expect(s.chatApiBase).toBe('https://a');
		expect(s.activeChatProfileId).toBe('p1');
	});

	it('切换后上限按映射表更新 - 命中则写入该套', async () => {
		const s = base();
		switchChatProfile(s as never, 'p1');
		// 由 render 层调 applyModelContextWindow;此处断言切换本身不改上限字段以外的部分
		expect(s.chatModelMaxTokens).toBe(128_000);
	});
});

describe('saveCurrentAsProfile', () => {
	it('另存当前 - 新一套入列,active 指向新套', () => {
		const s = base();
		const created = saveCurrentAsProfile(s as never, '我的工作');
		expect(s.chatProfiles).toHaveLength(2);
		expect(created.name).toBe('我的工作');
		expect(s.activeChatProfileId).toBe(created.id);
	});

	it('另存为 CP-07 - 密钥仅在源套槽位 - 先读后存复制到新套', () => {
		const s = base();
		const store: Record<string, string> = { 'ratel-chat-profile-p1': 'sk-source-only' };
		const app = {
			secretStorage: {
				getSecret: (id: string) => store[id] ?? null,
				setSecret: (id: string, value: string) => {
					store[id] = value;
				},
			},
		} as unknown as App;

		const sourceProfileId = s.activeChatProfileId;
		const key = resolveChatApiKey(app, {
			chatApiBase: s.chatApiBase,
			chatProfiles: s.chatProfiles,
			activeChatProfileId: sourceProfileId,
		});
		expect(key).toBe('sk-source-only');

		const created = saveCurrentAsProfile(s as never, '副本');
		if (key) {
			setChatProfileSecret(app, created.id, key);
		}
		expect(store[chatProfileSecretId(created.id)]).toBe('sk-source-only');
	});

	it('另存为 CP-07 - 先切 active 再读密钥 - 无法复制源套槽位', () => {
		const s = base();
		const store: Record<string, string> = { 'ratel-chat-profile-p1': 'sk-source-only' };
		const app = {
			secretStorage: {
				getSecret: (id: string) => store[id] ?? null,
			},
		} as unknown as App;

		const created = saveCurrentAsProfile(s as never, '副本');
		const keyAfterSwitch = resolveChatApiKey(app, {
			chatApiBase: s.chatApiBase,
			chatProfiles: s.chatProfiles,
			activeChatProfileId: s.activeChatProfileId,
		});
		expect(keyAfterSwitch).toBeNull();
		expect(created.id).not.toBe('p1');
	});
});

describe('deleteChatProfile', () => {
	it('删除当前这套 - 拒绝', () => {
		const s = base();
		expect(() => deleteChatProfile(s as never, 'p1')).toThrow();
	});

	it('删除非当前套 - 从列表移除', () => {
		const s = base();
		s.chatProfiles.push({ id: 'p2', name: 'B', apiBase: 'https://b', model: 'm2', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 });
		deleteChatProfile(s as never, 'p2');
		expect(s.chatProfiles.map((p) => p.id)).toEqual(['p1']);
	});
});

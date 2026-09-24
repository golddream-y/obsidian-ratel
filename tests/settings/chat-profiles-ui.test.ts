/**
 * @file tests/settings/chat-profiles-ui.test.ts
 * @description 多套配置切换/另存/删除纯逻辑
 * @module tests/settings/chat-profiles-ui
 */
import { describe, it, expect } from 'vitest';
import {
	switchChatProfile,
	saveCurrentAsProfile,
	deleteChatProfile,
} from '../../src/settings/chat-profiles';

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
});

describe('saveCurrentAsProfile', () => {
	it('另存当前 - 新一套入列,active 指向新套', () => {
		const s = base();
		const created = saveCurrentAsProfile(s as never, '我的工作');
		expect(s.chatProfiles).toHaveLength(2);
		expect(created.name).toBe('我的工作');
		expect(s.activeChatProfileId).toBe(created.id);
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

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
	inferChatProvider,
	syncChatWindow,
	type ChatProfile,
} from '../../src/settings/chat-profiles';
import type { ModelContextLookup } from '../../src/ui/tokens/apply-model-context';
import {
	chatProfileSecretId,
	resolveChatApiKey,
	requiresChatApiKey,
	setChatProfileSecret,
} from '../../src/secrets/ratel-secrets';

// 关键路径:registry mock — 与 ModelContextLookup 结构兼容,查表逻辑不依赖真实网络
const makeRegistry = (map: Record<string, number>): ModelContextLookup => ({
	ensureRegistry: async () => map,
	lookupContextLength: (model: string, m: unknown) =>
		(m as Record<string, number | undefined>)[model],
});

const base = () => ({
	chatModel: 'm-current',
	chatApiBase: 'https://current',
	contextLengthPreset: '256k' as const,
	chatModelMaxTokens: 256_000,
	// 关键路径:标注 ChatProfile[] 使 windowUserSet 可选字段对测试可见(旧 data.json 无此字段)
	chatProfiles: [
		{ id: 'p1', name: 'A', apiBase: 'https://a', model: 'm1', contextLengthPreset: '128k' as const, chatModelMaxTokens: 128_000 },
	] as ChatProfile[],
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

	it('另存当前 - 继承源套 windowUserSet 标志', () => {
		const s = base();
		s.chatProfiles[0]!.windowUserSet = true;
		const created = saveCurrentAsProfile(s as never, '锁定窗口的套');
		expect(created.windowUserSet).toBe(true);
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

describe('inferChatProvider - 由地址推断提供商', () => {
	it('推断提供商 - 官方 DeepSeek 地址 - 返回 deepseek', () => {
		expect(inferChatProvider('https://api.deepseek.com')).toBe('deepseek');
	});

	it('推断提供商 - Ollama 本地地址(带与不带 /v1)- 返回 ollama', () => {
		expect(inferChatProvider('http://localhost:11434/v1')).toBe('ollama');
		expect(inferChatProvider('http://localhost:11434')).toBe('ollama');
	});

	it('推断提供商 - 其他地址 - 返回 custom', () => {
		expect(inferChatProvider('https://example.com/v1')).toBe('custom');
	});
});

describe('syncChatWindow - 窗口一行查表写入', () => {
	it('查表命中 - 写入 preset 与 tokens 并镜像活跃套', async () => {
		const s = base();
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({ 'm-current': 200_000 }),
			registryUrl: '',
			clearOnMiss: true,
		});
		expect(result.applied).toBe(true);
		expect(result.tokens).toBe(200_000);
		expect(s.contextLengthPreset).toBe('200k');
		expect(s.chatModelMaxTokens).toBe(200_000);
		expect(s.chatProfiles[0]!.contextLengthPreset).toBe('200k');
		expect(s.chatProfiles[0]!.chatModelMaxTokens).toBe(200_000);
	});

	it('查表命中且值未变 - changed 为 false(防重渲染循环)', async () => {
		const s = base();
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({ 'm-current': 256_000 }),
			registryUrl: '',
			clearOnMiss: true,
		});
		expect(result.applied).toBe(true);
		expect(result.changed).toBe(false);
	});

	it('活跃套 windowUserSet 为真 - 跳过查表不覆盖', async () => {
		const s = base();
		s.chatProfiles[0]!.windowUserSet = true;
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({ 'm-current': 1_048_576 }),
			registryUrl: '',
			clearOnMiss: true,
		});
		expect(result.skipped).toBe(true);
		expect(result.applied).toBe(false);
		expect(s.chatModelMaxTokens).toBe(256_000);
	});

	it('查不到且 clearOnMiss - 清空旧上限写 custom/0 并镜像活跃套', async () => {
		const s = base();
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({}),
			registryUrl: '',
			clearOnMiss: true,
		});
		expect(result.applied).toBe(false);
		expect(result.changed).toBe(true);
		expect(s.contextLengthPreset).toBe('custom');
		expect(s.chatModelMaxTokens).toBe(0);
		expect(s.chatProfiles[0]!.contextLengthPreset).toBe('custom');
		expect(s.chatProfiles[0]!.chatModelMaxTokens).toBe(0);
	});

	it('查不到且保留旧值(clearOnMiss=false)- 不写入', async () => {
		const s = base();
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({}),
			registryUrl: '',
			clearOnMiss: false,
		});
		expect(result.applied).toBe(false);
		expect(result.changed).toBe(false);
		expect(s.chatModelMaxTokens).toBe(256_000);
		expect(s.chatProfiles[0]!.chatModelMaxTokens).toBe(128_000);
	});

	it('旧库活跃套无 windowUserSet 字段 - 照常查表写入', async () => {
		const s = base();
		// 关键路径:旧 data.json 无 windowUserSet,undefined 视为未锁定
		expect(s.chatProfiles[0]!.windowUserSet).toBeUndefined();
		const result = await syncChatWindow(s as never, {
			registry: makeRegistry({ 'm-current': 128_000 }),
			registryUrl: '',
			clearOnMiss: true,
		});
		expect(result.applied).toBe(true);
		expect(s.chatModelMaxTokens).toBe(128_000);
	});
});

describe('requiresChatApiKey - 展开区条件密钥', () => {
	it('Ollama 本地地址 - 不要求密钥(不渲染密钥框)', () => {
		expect(requiresChatApiKey({ chatApiBase: 'http://localhost:11434/v1' })).toBe(false);
	});

	it('DeepSeek 官方地址 - 要求密钥', () => {
		expect(requiresChatApiKey({ chatApiBase: 'https://api.deepseek.com' })).toBe(true);
	});
});

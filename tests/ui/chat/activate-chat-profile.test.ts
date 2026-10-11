/**
 * @file tests/ui/chat/activate-chat-profile.test.ts
 * @description activateChatProfile 共用切换函数单测 — 顶栏默认调用、设置页选项透传、当前套短路
 * @module tests/ui/chat/activate-chat-profile
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:记录跨副作用的真实调用顺序 — vi.mock 工厂被提升到 import 之前,
// 共享数组必须用 vi.hoisted 创建,工厂内才能引用。
const order = vi.hoisted(() => ({
	calls: [] as string[],
	notices: [] as Array<{ message: string; timeout: number }>,
}));

// obsidian 只需 Notice 构造;捕获文案与超时,供顺序与文案断言。
vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string, timeout: number) {
			order.notices.push({ message, timeout });
			order.calls.push(`notice:${message}`);
		}
	},
}));

import { activateChatProfile } from '../../../src/ui/chat/activate-chat-profile';
import type RatelVaultPlugin from '../../../src/main';
import {
	createChatProfile,
	switchChatProfile,
	type ChatProfile,
} from '../../../src/settings/chat-profiles';
import type { RatelVaultSettings } from '../../../src/settings';
import { tNow } from '../../../src/i18n';

/** saveSettings 的观测形态 — 记录入参与顺序,不做真实落盘。 */
interface StubPlugin {
	settings: RatelVaultSettings;
	modelsDevCatalog: { ensureCatalog: ReturnType<typeof vi.fn> };
	saveSettings: ReturnType<typeof vi.fn>;
	rebuildLLM: ReturnType<typeof vi.fn>;
}

/**
 * 构造两套配置的最小 plugin 替身。
 * settings 经真实纯函数 createChatProfile/switchChatProfile 生成,
 * ensureCatalog 返回 null(走 syncChatWindow 查不到名单的清空分支);
 * 三个副作用均为 vi.fn,调用名压入 order.calls 以锁定同序。
 */
function makeStubPlugin(): {
	plugin: RatelVaultPlugin;
	raw: StubPlugin;
	first: ChatProfile;
	second: ChatProfile;
} {
	order.calls = [];
	order.notices = [];
	const settings = {
		chatModel: '',
		chatApiBase: '',
		contextLengthPreset: 'custom',
		chatModelMaxTokens: 0,
		chatProfiles: [] as ChatProfile[],
		activeChatProfileId: '',
	} as unknown as RatelVaultSettings;

	const first = createChatProfile(settings, '配置甲');
	first.apiBase = 'https://a.example/v1';
	first.model = 'model-a';
	const second = createChatProfile(settings, '配置乙');
	second.apiBase = 'https://b.example/v1';
	second.model = 'model-b';
	// 当前套先落为甲,四字段与甲一致(短路用例据此构造)。
	switchChatProfile(settings, first.id);

	const ensureCatalog = vi.fn(async () => {
		order.calls.push('ensureCatalog');
		return null;
	});
	// 关键路径:入参由 mock.calls 留存,断言默认调用收到 undefined(而非 {} 或其他对象)。
	const saveSettings = vi.fn(async (_options?: { refreshSettingsTab?: boolean }) => {
		order.calls.push('saveSettings');
	});
	const rebuildLLM = vi.fn(() => {
		order.calls.push('rebuildLLM');
	});

	const raw: StubPlugin = {
		settings,
		modelsDevCatalog: { ensureCatalog },
		saveSettings,
		rebuildLLM,
	};
	return { plugin: raw as unknown as RatelVaultPlugin, raw, first, second };
}

describe('activateChatProfile', () => {
	it('顶栏默认调用 - 切到另一套 - 四字段换为目标套且 saveSettings 无 refreshSettingsTab', async () => {
		const { plugin, raw, second } = makeStubPlugin();

		await activateChatProfile(plugin, second.id);

		// switchChatProfile 效果:模型/地址/活跃 id 已是目标套;syncChatWindow 会把
		// preset/tokens 镜像写回目标套自身,故四个字段与目标套当前值仍保持一致。
		expect(raw.settings.chatApiBase).toBe(second.apiBase);
		expect(raw.settings.chatModel).toBe(second.model);
		expect(raw.settings.contextLengthPreset).toBe(second.contextLengthPreset);
		expect(raw.settings.chatModelMaxTokens).toBe(second.chatModelMaxTokens);
		expect(raw.settings.activeChatProfileId).toBe(second.id);

		// 同序锁:ensureCatalog(名单)→ syncChatWindow(查不到的 Notice)
		// → saveSettings(无参)→ rebuildLLM → switched Notice。
		expect(order.calls).toEqual([
			'ensureCatalog',
			`notice:${tNow('settings.notice.contextLengthUnknown', { model: second.model })}`,
			'saveSettings',
			'rebuildLLM',
			`notice:${tNow('settings.chatProfiles.switched', { name: second.name })}`,
		]);
		expect(raw.saveSettings).toHaveBeenCalledTimes(1);
		// 关键路径:顶栏路径必须是无参调用,不能误传 { refreshSettingsTab: false }。
		expect(raw.saveSettings.mock.calls[0]?.[0]).toBeUndefined();
		expect(raw.rebuildLLM).toHaveBeenCalledTimes(1);

		// Notice 时长锁:本用例 ensureCatalog 返回 null,syncChatWindow 走 clearOnMiss
		// 清空分支(applied/skipped 皆 false),unknown 必现 — 文案与超时逐条精确锁定:
		// unknown 5000ms(长提示,让用户看清旧上限被清空),switched 3000ms。
		expect(order.notices).toEqual([
			{
				message: tNow('settings.notice.contextLengthUnknown', { model: second.model }),
				timeout: 5000,
			},
			{ message: tNow('settings.chatProfiles.switched', { name: second.name }), timeout: 3000 },
		]);
	});

	it('设置页选项 - 传 refreshSettingsTab:false 与 onActivated - 参数透传且回调在 switched Notice 之后', async () => {
		const { plugin, raw, second } = makeStubPlugin();
		const onActivated = vi.fn(() => {
			order.calls.push('onActivated');
		});

		await activateChatProfile(plugin, second.id, {
			refreshSettingsTab: false,
			onActivated,
		});

		expect(raw.saveSettings).toHaveBeenCalledTimes(1);
		expect(raw.saveSettings.mock.calls[0]?.[0]).toEqual({ refreshSettingsTab: false });
		expect(onActivated).toHaveBeenCalledTimes(1);
		// 回调必须在 switched Notice 之后(设置页据 Notice 提示后再本地重绘)。
		const switchedIndex = order.calls.indexOf(
			`notice:${tNow('settings.chatProfiles.switched', { name: second.name })}`,
		);
		const activatedIndex = order.calls.indexOf('onActivated');
		expect(switchedIndex).toBeGreaterThanOrEqual(0);
		expect(activatedIndex).toBeGreaterThan(switchedIndex);
	});

	it('目标套即当前套 - 四字段一致 - 短路且零副作用调用', async () => {
		const { plugin, raw, first } = makeStubPlugin();
		const onActivated = vi.fn(() => {
			order.calls.push('onActivated');
		});

		await activateChatProfile(plugin, first.id, { onActivated });

		expect(raw.modelsDevCatalog.ensureCatalog).not.toHaveBeenCalled();
		expect(raw.saveSettings).not.toHaveBeenCalled();
		expect(raw.rebuildLLM).not.toHaveBeenCalled();
		// 短路发生在 profileSelectNeedsSwitch 判定后的早返回,onActivated 钩子同样不得触发
		// (否则设置页会在未切换时白白 renderPage 一次)。
		expect(onActivated).not.toHaveBeenCalled();
		expect(order.notices).toHaveLength(0);
		expect(raw.settings.activeChatProfileId).toBe(first.id);
	});
});

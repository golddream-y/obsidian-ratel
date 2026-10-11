/**
 * @file tests/ui/settings/provider-control.test.ts
 * @description 供应商「选择」按钮三态(loading/offline/ready)纯函数与新增配置默认自定义守护
 * @module tests/ui/settings/provider-control
 */
import { describe, it, expect } from 'vitest';
import {
	resolveProviderControl,
	type ProviderListState,
} from '../../../src/ui/settings/provider-control';
import { createChatProfile } from '../../../src/settings/chat-profiles';
import { LOCAL_PROVIDER_CUSTOM } from '../../../src/settings/model-catalog';

describe('resolveProviderControl - 供应商选择按钮三态', () => {
	it('名单加载中 - 按钮禁用并转圈 - 文案为获取名单中', () => {
		expect(resolveProviderControl('loading')).toEqual({
			disabled: true,
			spinning: true,
			buttonTextKey: 'settings.chatProfiles.provider.listLoading',
		});
	});

	it('离线无名单 - 按钮禁用不转圈 - 文案为离线中', () => {
		expect(resolveProviderControl('offline')).toEqual({
			disabled: true,
			spinning: false,
			buttonTextKey: 'settings.chatProfiles.provider.offline',
		});
	});

	it('名单就绪 - 按钮可点不转圈 - 文案为选择', () => {
		expect(resolveProviderControl('ready')).toEqual({
			disabled: false,
			spinning: false,
			buttonTextKey: 'settings.chatProfiles.provider.choose',
		});
	});

	it('三态全覆盖 - 逐一解析均有对应控件形态', () => {
		const states: ProviderListState[] = ['loading', 'offline', 'ready'];
		const controls = states.map(resolveProviderControl);
		// loading 与 offline 都不可点,只有 ready 可点;只有 loading 转圈。
		expect(controls.map((c) => c.disabled)).toEqual([true, true, false]);
		expect(controls.map((c) => c.spinning)).toEqual([true, false, false]);
	});
});

describe('createChatProfile - 断网新增配置默认自定义', () => {
	it('新建配置 - 不依赖网络 - 供应商为自定义且窗口档位为 custom', () => {
		// 断网下也能直接填地址/密钥/模型名/窗口:新配置必须默认自定义,不预设名单供应商。
		const settings = { chatProfiles: [] } as never;
		const created = createChatProfile(settings, '新配置');
		expect(created.providerId).toBe(LOCAL_PROVIDER_CUSTOM);
		expect(created.contextLengthPreset).toBe('custom');
		expect(created.apiBase).toBe('');
		expect(created.model).toBe('');
	});
});

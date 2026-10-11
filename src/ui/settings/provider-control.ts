/**
 * @file src/ui/settings/provider-control.ts
 * @description 供应商「选择」按钮的三态纯函数:名单加载中 / 离线 / 就绪
 * @module ui/settings/provider-control
 * @depends ../../i18n(仅类型)
 */
import type { StringKey } from '../../i18n';

/**
 * 供应商名单的三种可得性:
 * - loading:正在拉取名单(含等待缓存),按钮锁定转圈;
 * - offline:无名单(断网且无缓存),按钮锁定并提示离线;
 * - ready:名单已就绪(过期缓存也算就绪),按钮可点。
 */
export type ProviderListState = 'loading' | 'offline' | 'ready';

/** 供应商按钮三种文案的 i18n key;收紧为字面量联合以便直接传给 tNow。 */
type ProviderButtonTextKey = Extract<StringKey,
	| 'settings.chatProfiles.provider.listLoading'
	| 'settings.chatProfiles.provider.offline'
	| 'settings.chatProfiles.provider.choose'>;

/** 按钮在某一状态下的控件形态。buttonTextKey 为 i18n key,由调用方翻译。 */
export interface ProviderControl {
	/** 是否禁用点击(loading/offline 均不可点)。 */
	disabled: boolean;
	/** 是否显示旋转图标(仅 loading)。 */
	spinning: boolean;
	/** 按钮文案的 i18n key。 */
	buttonTextKey: ProviderButtonTextKey;
}

/**
 * 按名单状态解析供应商「选择」按钮的禁用、转圈与文案。
 *
 * @param state - 名单加载状态
 * @returns 按钮控件形态;断网时锁定但不影响同页其他字段编辑
 */
export function resolveProviderControl(state: ProviderListState): ProviderControl {
	switch (state) {
		case 'loading':
			return {
				disabled: true,
				spinning: true,
				buttonTextKey: 'settings.chatProfiles.provider.listLoading',
			};
		case 'offline':
			return {
				disabled: true,
				spinning: false,
				buttonTextKey: 'settings.chatProfiles.provider.offline',
			};
		case 'ready':
			return {
				disabled: false,
				spinning: false,
				buttonTextKey: 'settings.chatProfiles.provider.choose',
			};
	}
}

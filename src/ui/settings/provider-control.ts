/**
 * @file src/ui/settings/provider-control.ts
 * @description 供应商「选择」按钮的三态纯函数:名单加载中 / 离线 / 就绪
 * @module ui/settings/provider-control
 * @depends ../../i18n(仅类型), ../../settings/model-catalog
 */
import type { StringKey } from '../../i18n';
import {
	LOCAL_PROVIDER_CUSTOM,
	LOCAL_PROVIDER_OLLAMA,
	listCatalogProviders,
	type ModelsDevCatalog,
} from '../../settings/model-catalog';

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

/**
 * 名单 resolve 后,地址/密钥/模型区相对 loading 态是否发生形态翻转。
 *
 * loading 态恒为「可编辑地址 + 手填模型」。resolve 后分三种情况:
 * - catalog 为 null(断网):字段形态与 loading 完全相同,不翻转;
 * - 本机项(custom/ollama)或名单里查不到的供应商:仍是可编辑地址 + 手填模型,不翻转;
 * - 名单中存在该供应商(listed):地址可能变只读、模型变下拉,形态真的翻转,
 *   调用方必须重建字段宿主。
 *
 * @param catalog - ensureCatalog 的结果,null=断网,对象=就绪(过期缓存也算)
 * @param providerId - 当前配置的供应商 id
 * @returns 字段形态是否翻转
 */
export function fieldsShapeFlips(
	catalog: ModelsDevCatalog | null,
	providerId: string,
): boolean {
	if (!catalog) return false;
	if (providerId === LOCAL_PROVIDER_OLLAMA || providerId === LOCAL_PROVIDER_CUSTOM) {
		return false;
	}
	return listCatalogProviders(catalog).some((row) => row.id === providerId);
}

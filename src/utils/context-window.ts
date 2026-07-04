/**
 * @file src/utils/context-window.ts
 * @description 模型上下文窗口上限 — settings 有效值读取
 * @module utils/context-window
 */

import type { RatelVaultSettings } from '../settings';
import {
	CUSTOM_TOKEN_MIN,
	DEFAULT_CONTEXT_LENGTH_PRESET,
	presetToTokens,
} from '../ui/tokens/context-length-presets';

/**
 * 返回用于 StatusLine / 上下文使用率的有效上限。
 *
 * @param settings - 含 chatModelMaxTokens 的设置片段
 */
export function getEffectiveChatModelMaxTokens(
	settings: Pick<RatelVaultSettings, 'chatModelMaxTokens'>,
): number {
	const n = settings.chatModelMaxTokens;
	if (n >= CUSTOM_TOKEN_MIN) return n;
	return presetToTokens(DEFAULT_CONTEXT_LENGTH_PRESET);
}

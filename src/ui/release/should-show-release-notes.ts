/**
 * @file src/ui/release/should-show-release-notes.ts
 * @description 判断这一版更新说明要不要再打开
 * @module ui/release/should-show-release-notes
 */

/**
 * 安装后或版本变化时打开一次。同一版本关掉之后不再打开。
 *
 * @param lastSeen - 已看过的版本；空字符串表示还没看过
 * @param version - 当前插件版本
 * @returns 需要打开时为 true
 */
export function shouldShowReleaseNotes(lastSeen: string, version: string): boolean {
	return version.length > 0 && lastSeen !== version;
}

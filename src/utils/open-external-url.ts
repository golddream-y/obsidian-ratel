/**
 * @file src/utils/open-external-url.ts
 * @description 桌面端打开外部 URL(优先 electron.shell.openExternal)
 * @module utils/open-external-url
 */

/**
 * 打开系统浏览器到外部 URL。
 *
 * @param url - 目标 URL
 */
export async function openExternalUrl(url: string): Promise<void> {
	try {
		const req = (
			window as unknown as {
				require?: (id: string) => { shell?: { openExternal: (u: string) => Promise<void> } };
			}
		).require;
		const electron = req?.('electron');
		if (electron?.shell?.openExternal) {
			await electron.shell.openExternal(url);
			return;
		}
	} catch {
		/* fallthrough */
	}
	window.open(url, '_blank');
}

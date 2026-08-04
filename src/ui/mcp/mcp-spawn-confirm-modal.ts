/**
 * @file src/ui/mcp/mcp-spawn-confirm-modal.ts
 * @description stdio MCP 首次 spawn 确认
 * @module ui/mcp/mcp-spawn-confirm-modal
 * @depends obsidian, ../../i18n, ../../ports/mcp
 */

import { App, Modal, Setting } from 'obsidian';
import { tNow } from '../../i18n';
import type { McpServerConfig } from '../../ports/mcp';

/**
 * 弹出确认框；用户允许返回 true，取消/关闭返回 false。
 *
 * @param app - Obsidian App
 * @param cfg - 待启动的 Server 配置
 * @returns 是否允许 spawn
 */
export function requestMcpSpawnConfirmation(
	app: App,
	cfg: McpServerConfig,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};

		const modal = new (class extends Modal {
			onOpen() {
				this.titleEl.setText(tNow('modal.mcpSpawn.title'));
				const cmd = [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
				this.contentEl.createEl('p', {
					text: tNow('modal.mcpSpawn.body', { command: cmd }),
				});
				new Setting(this.contentEl)
					.addButton((btn) =>
						btn.setButtonText(tNow('modal.mcpSpawn.cancel')).onClick(() => {
							this.close();
							finish(false);
						}),
					)
					.addButton((btn) =>
						btn
							.setButtonText(tNow('modal.mcpSpawn.confirm'))
							.setCta()
							.onClick(() => {
								this.close();
								finish(true);
							}),
					);
			}

			onClose() {
				finish(false);
			}
		})(app);
		modal.open();
	});
}

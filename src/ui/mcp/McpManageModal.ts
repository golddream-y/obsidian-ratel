/**
 * @file src/ui/mcp/McpManageModal.ts
 * @description MCP 安装与管理 Modal（抽屉主入口）
 * @module ui/mcp/McpManageModal
 * @depends obsidian, ../../i18n, ../../core/mcp-config, ../../secrets/ratel-secrets
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import type { McpServerConfig, McpServerStatus } from '../../ports/mcp';
import { validateMcpServerConfig } from '../../core/mcp-config';
import { mcpSecretId, hasMcpSecret } from '../../secrets/ratel-secrets';

/**
 * 是否应新建 Modal — 已有实例则 false。
 *
 * @param current - 插件持有的当前单例引用
 */
export function shouldCreateMcpManageModal(current: McpManageModal | null): boolean {
	return current === null;
}

/**
 * MCP 服务器安装 / 管理 Modal。
 *
 * 设计要点:
 * - 对齐 MemoryModal：抽屉入口 → 单例 open
 * - 列表 + 添加 HTTP/stdio；变更后 saveSettings → mcpHost.sync
 */
export class McpManageModal extends Modal {
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;
	private adding: 'http' | 'stdio' | null = null;
	private draft: Partial<McpServerConfig> = {};

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('modal.mcpManage.title'));
		this.renderBody();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}

	private renderBody(): void {
		this.contentEl.empty();
		const servers = this.plugin.settings.mcpServers;

		if (servers.length === 0 && !this.adding) {
			this.contentEl.createEl('p', { text: tNow('modal.mcpManage.empty') });
		}

		for (const cfg of servers) {
			this.renderServerRow(cfg);
		}

		if (this.adding) {
			this.renderAddForm(this.adding);
		} else {
			new Setting(this.contentEl)
				.addButton((b) =>
					b.setButtonText(tNow('modal.mcpManage.addHttp')).onClick(() => {
						this.adding = 'http';
						this.draft = { transport: 'http', enabled: true };
						this.renderBody();
					}),
				)
				.addButton((b) =>
					b.setButtonText(tNow('modal.mcpManage.addStdio')).onClick(() => {
						this.adding = 'stdio';
						this.draft = { transport: 'stdio', enabled: true, args: [] };
						this.renderBody();
					}),
				);
		}
	}

	private renderServerRow(cfg: McpServerConfig): void {
		const status = this.plugin.mcpHost?.getStatus(cfg.id) ?? 'offline';
		const statusLabel = statusLabelOf(status);
		const row = new Setting(this.contentEl)
			.setName(`${cfg.label} (${cfg.id})`)
			.setDesc(`${cfg.transport} · ${statusLabel}`);

		row.addToggle((tog) => {
			tog.setValue(cfg.enabled).onChange(async (v) => {
				cfg.enabled = v;
				await this.plugin.saveSettings();
				this.renderBody();
			});
		});

		row.addButton((b) =>
			b.setButtonText(tNow('modal.mcpManage.stop')).onClick(async () => {
				await this.plugin.mcpHost.stop(cfg.id);
				cfg.enabled = false;
				await this.plugin.saveSettings();
				this.renderBody();
			}),
		);

		row.addButton((b) =>
			b.setButtonText(tNow('modal.mcpManage.delete')).setWarning().onClick(async () => {
				this.plugin.settings.mcpServers = this.plugin.settings.mcpServers.filter(
					(s) => s.id !== cfg.id,
				);
				this.plugin.settings.mcpApprovedSpawns =
					this.plugin.settings.mcpApprovedSpawns.filter((id) => id !== cfg.id);
				await this.plugin.saveSettings();
				this.renderBody();
			}),
		);

		const secretId = mcpSecretId(cfg.id);
		this.contentEl.createEl('div', {
			cls: 'setting-item-description',
			text: `${tNow('modal.mcpManage.secretHint')}: ${secretId}${
				hasMcpSecret(this.app, cfg.id) ? '' : ' (—)'
			}`,
		});
	}

	private renderAddForm(kind: 'http' | 'stdio'): void {
		const draft = this.draft;
		new Setting(this.contentEl)
			.setName(tNow('modal.mcpManage.id'))
			.addText((t) =>
				t.setPlaceholder('tavily').onChange((v) => {
					draft.id = v.trim();
				}),
			);
		new Setting(this.contentEl)
			.setName(tNow('modal.mcpManage.label'))
			.addText((t) =>
				t.setPlaceholder('Tavily').onChange((v) => {
					draft.label = v.trim();
				}),
			);

		if (kind === 'http') {
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.url'))
				.addText((t) =>
					t.setPlaceholder('https://…').onChange((v) => {
						draft.url = v.trim();
					}),
				);
		} else {
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.command'))
				.addText((t) =>
					t.setPlaceholder('npx').onChange((v) => {
						draft.command = v.trim();
					}),
				);
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.args'))
				.addText((t) =>
					t.setPlaceholder('-y package').onChange((v) => {
						draft.args = v.trim() ? v.trim().split(/\s+/) : [];
					}),
				);
		}

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.cancel')).onClick(() => {
					this.adding = null;
					this.draft = {};
					this.renderBody();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(tNow('modal.mcpManage.save'))
					.setCta()
					.onClick(async () => {
						await this.saveDraft(kind);
					}),
			);
	}

	private async saveDraft(kind: 'http' | 'stdio'): Promise<void> {
		const cfg: McpServerConfig = {
			id: this.draft.id ?? '',
			label: this.draft.label || this.draft.id || '',
			enabled: true,
			transport: kind,
			url: this.draft.url,
			command: this.draft.command,
			args: this.draft.args ?? [],
		};
		const err = validateMcpServerConfig(cfg);
		if (err) {
			new Notice(tNow(`modal.mcpManage.error.${err}`));
			return;
		}
		if (this.plugin.settings.mcpServers.some((s) => s.id === cfg.id)) {
			new Notice(tNow('modal.mcpManage.error.duplicate_id'));
			return;
		}
		this.plugin.settings.mcpServers = [...this.plugin.settings.mcpServers, cfg];
		await this.plugin.saveSettings();
		this.adding = null;
		this.draft = {};
		this.renderBody();
	}
}

function statusLabelOf(status: McpServerStatus): string {
	switch (status) {
		case 'online':
			return tNow('modal.mcpManage.status.online');
		case 'connecting':
			return tNow('modal.mcpManage.status.connecting');
		case 'error':
			return tNow('modal.mcpManage.status.error');
		default:
			return tNow('modal.mcpManage.status.offline');
	}
}

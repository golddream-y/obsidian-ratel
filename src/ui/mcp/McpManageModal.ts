/**
 * @file src/ui/mcp/McpManageModal.ts
 * @description MCP 安装与管理 Modal（抽屉主入口）
 * @module ui/mcp/McpManageModal
 * @depends obsidian, ../../i18n, ../../core/mcp-config, ../../secrets/ratel-secrets, ../../ports/mcp
 */

import { App, Modal, Notice, Setting, TextAreaComponent } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import type { McpServerConfig, McpServerStatus } from '../../ports/mcp';
import { mcpToolPrefix } from '../../ports/mcp';
import { parseMcpServersJson, validateMcpServerConfig } from '../../core/mcp-config';
import { mcpSecretId, hasMcpSecret } from '../../secrets/ratel-secrets';

/** Modal 视图：默认列表；添加 / 粘贴 JSON 为次级流程 */
type McpManageView = 'list' | 'add-http' | 'add-stdio' | 'import-json';

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
 * - 打开默认进「已装列表」（可空），不直接进添加表单
 * - 添加 HTTP / stdio / 粘贴 JSON 均为次级动作
 * - 变更后 saveSettings → mcpHost.sync
 */
export class McpManageModal extends Modal {
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;
	private view: McpManageView = 'list';
	private draft: Partial<McpServerConfig> = {};
	private jsonDraft = '';

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('modal.mcpManage.title'));
		this.view = 'list';
		this.draft = {};
		this.jsonDraft = '';
		this.renderBody();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}

	private renderBody(): void {
		this.contentEl.empty();
		if (this.view === 'list') {
			this.renderListView();
			return;
		}
		if (this.view === 'import-json') {
			this.renderImportJsonForm();
			return;
		}
		this.renderAddForm(this.view === 'add-http' ? 'http' : 'stdio');
	}

	/**
	 * 已装列表页 — 打开 Modal 的默认视图。
	 */
	private renderListView(): void {
		const servers = this.plugin.settings.mcpServers;

		this.contentEl.createEl('h3', {
			text: tNow('modal.mcpManage.installedHeading').replace(
				'{count}',
				String(servers.length),
			),
		});

		if (servers.length === 0) {
			this.contentEl.createEl('p', { text: tNow('modal.mcpManage.empty') });
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: tNow('modal.mcpManage.emptyHint'),
			});
		} else {
			for (const cfg of servers) {
				this.renderServerRow(cfg);
			}
		}

		this.contentEl.createEl('h3', { text: tNow('modal.mcpManage.addSection') });
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: tNow('modal.mcpManage.addSectionHint'),
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.addHttp')).onClick(() => {
					this.view = 'add-http';
					this.draft = { transport: 'http', enabled: true };
					this.renderBody();
				}),
			)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.addStdio')).onClick(() => {
					this.view = 'add-stdio';
					this.draft = { transport: 'stdio', enabled: true, args: [] };
					this.renderBody();
				}),
			)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.importJson')).onClick(() => {
					this.view = 'import-json';
					this.jsonDraft = '';
					this.renderBody();
				}),
			);
	}

	private renderServerRow(cfg: McpServerConfig): void {
		const status = this.plugin.mcpHost?.getStatus(cfg.id) ?? 'offline';
		const statusLabel = statusLabelOf(status);
		const toolNames = this.listToolNames(cfg.id);
		const toolsPart =
			toolNames.length > 0
				? tNow('modal.mcpManage.toolsCount').replace('{count}', String(toolNames.length))
				: tNow('modal.mcpManage.toolsNone');

		const row = new Setting(this.contentEl)
			.setName(`${cfg.label} (${cfg.id})`)
			.setDesc(`${cfg.transport} · ${statusLabel} · ${toolsPart}`);

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

		if (toolNames.length > 0) {
			this.contentEl.createEl('div', {
				cls: 'setting-item-description',
				text: `${tNow('modal.mcpManage.toolsList')}: ${toolNames.join(', ')}`,
			});
		}

		const secretId = mcpSecretId(cfg.id);
		this.contentEl.createEl('div', {
			cls: 'setting-item-description',
			text: `${tNow('modal.mcpManage.secretHint')}: ${secretId}${
				hasMcpSecret(this.app, cfg.id) ? '' : ' (—)'
			}`,
		});
	}

	/**
	 * 从 ToolRegistry 取出该 Server 已发现的工具短名。
	 *
	 * @param serverId - Server id
	 * @returns 去掉 `mcp__<id>__` 前缀后的工具名
	 */
	private listToolNames(serverId: string): string[] {
		const prefix = mcpToolPrefix(serverId);
		const defs = this.plugin.tools?.definitions() ?? [];
		return defs
			.filter((d) => d.name.startsWith(prefix))
			.map((d) => d.name.slice(prefix.length))
			.filter(Boolean);
	}

	private renderAddForm(kind: 'http' | 'stdio'): void {
		this.contentEl.createEl('h3', {
			text:
				kind === 'http'
					? tNow('modal.mcpManage.addHttp')
					: tNow('modal.mcpManage.addStdio'),
		});

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
				b.setButtonText(tNow('modal.mcpManage.backToList')).onClick(() => {
					this.view = 'list';
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

	private renderImportJsonForm(): void {
		this.contentEl.createEl('h3', { text: tNow('modal.mcpManage.importJson') });
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: tNow('modal.mcpManage.importJsonHint'),
		});

		const area = new TextAreaComponent(this.contentEl);
		area.setPlaceholder(
			'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "pkg"] }\n  }\n}',
		);
		area.setValue(this.jsonDraft);
		area.inputEl.rows = 12;
		area.inputEl.style.width = '100%';
		area.inputEl.style.fontFamily = 'var(--font-monospace)';
		area.onChange((v) => {
			this.jsonDraft = v;
		});

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.backToList')).onClick(() => {
					this.view = 'list';
					this.jsonDraft = '';
					this.renderBody();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(tNow('modal.mcpManage.import'))
					.setCta()
					.onClick(async () => {
						await this.importJson();
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
		this.view = 'list';
		this.draft = {};
		this.renderBody();
	}

	private async importJson(): Promise<void> {
		const parsed = parseMcpServersJson(this.jsonDraft);
		if (!parsed.ok) {
			new Notice(tNow(`modal.mcpManage.error.${parsed.error}`));
			return;
		}

		const existing = new Set(this.plugin.settings.mcpServers.map((s) => s.id));
		const toAdd: McpServerConfig[] = [];
		let dup = 0;
		for (const cfg of parsed.result.servers) {
			if (existing.has(cfg.id)) {
				dup++;
				continue;
			}
			existing.add(cfg.id);
			toAdd.push(cfg);
		}

		if (toAdd.length === 0) {
			new Notice(
				dup > 0
					? tNow('modal.mcpManage.error.all_duplicate')
					: tNow('modal.mcpManage.error.no_servers'),
			);
			return;
		}

		this.plugin.settings.mcpServers = [...this.plugin.settings.mcpServers, ...toAdd];
		await this.plugin.saveSettings();

		const skipN = parsed.result.skipped.length;
		let msg = tNow('modal.mcpManage.importOk').replace('{count}', String(toAdd.length));
		if (dup > 0) {
			msg +=
				' ' + tNow('modal.mcpManage.importDupSkipped').replace('{count}', String(dup));
		}
		if (skipN > 0) {
			msg +=
				' ' +
				tNow('modal.mcpManage.importSkipped').replace('{count}', String(skipN));
		}
		if (parsed.result.envKeysNoted.length > 0) {
			msg +=
				' ' +
				tNow('modal.mcpManage.importEnvHint').replace(
					'{keys}',
					parsed.result.envKeysNoted.join(', '),
				);
		}
		new Notice(msg);

		this.view = 'list';
		this.jsonDraft = '';
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

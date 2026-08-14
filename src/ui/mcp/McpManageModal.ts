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
import { devLogger } from '../../logging/dev-logger';

/** Modal 视图：默认列表；添加 / 编辑 / 粘贴 JSON 为次级流程 */
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
 * - 添加 / 编辑 / 粘贴 JSON 均为次级动作；编辑时锁定 server id
 * - 启停用开关；「刷新」强制重连；变更后 saveSettings 会 await mcpHost.sync 再刷新列表
 */
export class McpManageModal extends Modal {
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;
	private view: McpManageView = 'list';
	private draft: Partial<McpServerConfig> = {};
	private jsonDraft = '';
	/** 非 null 表示正在编辑已有 Server（id 不可改） */
	private editingId: string | null = null;

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('modal.mcpManage.title'));
		// 关键路径:宽度挂在 modalEl（.modal 外框）,挂 contentEl 无法撑开 Obsidian 默认窄弹框。
		this.modalEl.addClass('ratel-mcp-manage-modal');
		this.view = 'list';
		this.draft = {};
		this.jsonDraft = '';
		this.editingId = null;
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

		const row = new Setting(this.contentEl).setDesc(
			`${cfg.transport} · ${statusLabel} · ${toolsPart}`,
		);
		// 状态点：在线绿 / 离线·错误红 / 连接中黄
		row.nameEl.empty();
		row.nameEl.createSpan({
			cls: `ratel-mcp-status-dot ratel-mcp-status-${status}`,
			attr: { 'aria-label': statusLabel },
		});
		row.nameEl.createSpan({ text: `${cfg.label} (${cfg.id})` });

		row.addToggle((tog) => {
			tog.setValue(cfg.enabled).onChange(async (v) => {
				cfg.enabled = v;
				await this.plugin.saveSettings();
				// 开启后 listTools 已在 sync 内完成；关开关等同旧「停止」
				if (v) this.notifyConnectResult(cfg.id);
				this.renderBody();
			});
		});

		row.addButton((b) =>
			b.setButtonText(tNow('modal.mcpManage.edit')).onClick(() => {
				this.beginEdit(cfg);
			}),
		);

		row.addButton((b) =>
			b.setButtonText(tNow('modal.mcpManage.refresh')).onClick(async () => {
				const enabledCfg = { ...cfg, enabled: true };
				cfg.enabled = true;
				new Notice(tNow('modal.mcpManage.refreshing'));
				try {
					// 关键路径:先 reconnect 再 saveSettings；saveSettings 会 await sync，但 online+同配置会短路
					await this.plugin.mcpHost.reconnect(enabledCfg);
					await this.plugin.saveSettings();
					this.notifyConnectResult(cfg.id);
				} catch (err) {
					devLogger.error('mcp', `刷新 ${cfg.id} 失败`, err);
					new Notice(tNow('modal.mcpManage.refreshFail'));
				}
				this.renderBody();
			}),
		);

		row.addButton((b) =>
			b
				.setButtonText(tNow('modal.mcpManage.delete'))
				.setDestructive()
				.onClick(async () => {
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
			this.contentEl.createDiv({
				cls: 'setting-item-description',
				text: `${tNow('modal.mcpManage.toolsList')}: ${toolNames.join(', ')}`,
			});
		}

		const secretId = mcpSecretId(cfg.id);
		this.contentEl.createDiv({
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

	/**
	 * 进入编辑表单：预填当前配置，锁定 id。
	 *
	 * @param cfg - 已装 Server
	 */
	private beginEdit(cfg: McpServerConfig): void {
		this.editingId = cfg.id;
		this.draft = {
			id: cfg.id,
			label: cfg.label,
			enabled: cfg.enabled,
			transport: cfg.transport,
			url: cfg.url,
			command: cfg.command,
			args: [...(cfg.args ?? [])],
			envKeys: cfg.envKeys ? [...cfg.envKeys] : undefined,
			timeoutMs: cfg.timeoutMs,
		};
		this.view = cfg.transport === 'http' ? 'add-http' : 'add-stdio';
		this.renderBody();
	}

	/** 退出添加/编辑表单，回到列表态 */
	private clearFormState(): void {
		this.view = 'list';
		this.draft = {};
		this.editingId = null;
	}

	private renderAddForm(kind: 'http' | 'stdio'): void {
		const editing = this.editingId !== null;
		this.contentEl.createEl('h3', {
			text: editing
				? tNow('modal.mcpManage.editHeading')
				: kind === 'http'
					? tNow('modal.mcpManage.addHttp')
					: tNow('modal.mcpManage.addStdio'),
		});
		if (editing) {
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: tNow('modal.mcpManage.editIdLocked'),
			});
		}

		const draft = this.draft;
		new Setting(this.contentEl)
			.setName(tNow('modal.mcpManage.id'))
			.addText((t) => {
				t.setPlaceholder('Tavily');
				if (draft.id) t.setValue(draft.id);
				if (editing) {
					t.setDisabled(true);
				} else {
					t.onChange((v) => {
						draft.id = v.trim();
					});
				}
			});
		new Setting(this.contentEl)
			.setName(tNow('modal.mcpManage.label'))
			.addText((t) => {
				t.setPlaceholder('Tavily');
				if (draft.label) t.setValue(draft.label);
				t.onChange((v) => {
					draft.label = v.trim();
				});
			});

		if (kind === 'http') {
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.url'))
				.addText((t) => {
					t.setPlaceholder('HTTPS://…');
					if (draft.url) t.setValue(draft.url);
					t.onChange((v) => {
						draft.url = v.trim();
					});
				});
		} else {
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: tNow('modal.mcpManage.stdioSplitHint'),
			});
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.command'))
				.addText((t) => {
					t.setPlaceholder('Npx');
					if (draft.command) t.setValue(draft.command);
					t.onChange((v) => {
						draft.command = v.trim();
					});
				});
			new Setting(this.contentEl)
				.setName(tNow('modal.mcpManage.args'))
				.addText((t) => {
					t.setPlaceholder('-y package');
					const argsText = (draft.args ?? []).join(' ');
					if (argsText) t.setValue(argsText);
					t.onChange((v) => {
						draft.args = v.trim() ? v.trim().split(/\s+/) : [];
					});
				});
		}

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.backToList')).onClick(() => {
					this.clearFormState();
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
		// 商店禁 inputEl.style.*;宽度/等宽字体走 styles.css
		area.inputEl.addClass('ratel-mcp-json-import-textarea');
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
		const editingId = this.editingId;
		let command = this.draft.command;
		let args = [...(this.draft.args ?? [])];
		// 修复:用户常把整行 shell 塞进 command；自动拆成 command + args
		if (kind === 'stdio' && command?.includes(' ') && args.length === 0) {
			const parts = command.trim().split(/\s+/).filter(Boolean);
			command = parts[0];
			args = parts.slice(1);
		}

		const cfg: McpServerConfig = {
			id: editingId ?? this.draft.id ?? '',
			label: this.draft.label || editingId || this.draft.id || '',
			enabled: this.draft.enabled ?? true,
			transport: kind,
			url: kind === 'http' ? this.draft.url : undefined,
			command: kind === 'stdio' ? command : undefined,
			args: kind === 'stdio' ? args : undefined,
			envKeys: this.draft.envKeys,
			timeoutMs: this.draft.timeoutMs,
		};
		const err = validateMcpServerConfig(cfg);
		if (err) {
			new Notice(tNow(`modal.mcpManage.error.${err}`));
			return;
		}

		if (editingId) {
			const idx = this.plugin.settings.mcpServers.findIndex((s) => s.id === editingId);
			if (idx < 0) {
				new Notice(tNow('modal.mcpManage.error.not_found'));
				return;
			}
			const next = [...this.plugin.settings.mcpServers];
			next[idx] = cfg;
			this.plugin.settings.mcpServers = next;
		} else {
			if (this.plugin.settings.mcpServers.some((s) => s.id === cfg.id)) {
				new Notice(tNow('modal.mcpManage.error.duplicate_id'));
				return;
			}
			this.plugin.settings.mcpServers = [...this.plugin.settings.mcpServers, cfg];
		}

		await this.plugin.saveSettings();
		if (cfg.enabled) this.notifyConnectResult(cfg.id);
		this.clearFormState();
		this.renderBody();
	}

	/**
	 * 连接结果 Notice — 成功报工具数，失败带 lastError。
	 *
	 * @param serverId - Server id
	 */
	private notifyConnectResult(serverId: string): void {
		const st = this.plugin.mcpHost?.getStatus(serverId) ?? 'offline';
		if (st === 'online') {
			const tools = this.listToolNames(serverId);
			new Notice(
				tNow('modal.mcpManage.refreshOk').replace('{count}', String(tools.length)),
			);
			return;
		}
		const detail = this.plugin.mcpHost?.getLastError(serverId);
		new Notice(
			detail
				? `${tNow('modal.mcpManage.refreshFail')}: ${detail}`
				: tNow('modal.mcpManage.refreshFail'),
		);
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

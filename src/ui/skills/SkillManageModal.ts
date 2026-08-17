/**
 * @file src/ui/skills/SkillManageModal.ts
 * @description 技能安装与管理 Modal(状态抽屉主入口,对齐 McpManageModal 模式)
 * @module ui/skills/SkillManageModal
 * @depends obsidian, node:fs/promises, ../../main, ../../i18n, ../../logging/dev-logger, ../../skills/types
 */

import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import { rm } from 'node:fs/promises';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import { devLogger } from '../../logging/dev-logger';
import type { SkillSource } from '../../skills/types';

/**
 * 是否应新建 Modal — 已有实例则 false。
 *
 * @param current - 插件持有的当前单例引用
 */
export function shouldCreateSkillManageModal(current: SkillManageModal | null): boolean {
	return current === null;
}

/**
 * 技能管理 Modal — 三源技能的统一管理入口(S-SKILL-UX)。
 *
 * 设计要点:
 * - 列表只显示合并后实际生效的技能(vault > global > builtin),描述行标生效来源
 * - per-skill 开关持久化到 settings.skillEnabled,不碰 SKILL.md 源文件
 * - 三源权限:内置只读(随插件更新);库内可编辑(Obsidian 打开)/可删(回收站);
 *   全局可编辑(系统打开目录)/可删(rm -rf)
 * - 删除为两击确认(第一击变提示文案,第二击执行),避免误删
 */
export class SkillManageModal extends Modal {
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;
	/** 当前处于「再点一次确认删除」状态的技能名(两击确认) */
	private confirmDeleteName: string | null = null;
	/** 当前处于「再点一次确认删除」状态的按钮引用(两击确认,跨行切换时重置旧按钮) */
	private confirmDeleteBtn: ButtonComponent | null = null;

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('modal.skillManage.title'));
		// 关键路径:宽度挂在 modalEl(.modal 外框),与 McpManageModal 同款。
		this.modalEl.addClass('ratel-skill-manage-modal');
		this.renderBody();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}

	private renderBody(): void {
		this.contentEl.empty();
		this.confirmDeleteName = null;
		this.confirmDeleteBtn = null;
		const skills = [...this.plugin.skillRegistry.getAll()].sort((a, b) =>
			a.manifest.name.localeCompare(b.manifest.name),
		);

		this.contentEl.createEl('h3', {
			text: tNow('modal.skillManage.installedHeading', { count: skills.length }),
		});

		if (skills.length === 0) {
			this.contentEl.createEl('p', { text: tNow('modal.skillManage.empty') });
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: tNow('modal.skillManage.emptyHint'),
			});
		} else {
			for (const skill of skills) {
				this.renderSkillRow(skill.manifest.name, skill.source);
			}
		}

		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText(tNow('modal.skillManage.reload')).onClick(async () => {
				await this.plugin.reloadSkills();
				new Notice(
					tNow('skill.notice.reloadDone', {
						count: this.plugin.skillRegistry.getAll().length,
					}),
				);
				this.renderBody();
			}),
		);
	}

	/**
	 * 渲染单个技能行 — 名称/来源描述 + 开关 + 按来源权限的操作按钮。
	 *
	 * 关键路径:正文已在 Registry 内存里(instructions),查看全文不读文件系统。
	 *
	 * @param name - 技能名(kebab-case)
	 * @param source - 生效来源(builtin/global/vault)
	 */
	private renderSkillRow(name: string, source: SkillSource): void {
		const registry = this.plugin.skillRegistry;
		const skill = registry.get(name);
		if (!skill) return;

		const desc =
			tNow(`skill.source.${source}`) +
			(skill.manifest.version ? ` · v${skill.manifest.version}` : '') +
			(source === 'builtin' ? ` · ${tNow('modal.skillManage.builtinReadonly')}` : '');

		const row = new Setting(this.contentEl).setName(name).setDesc(desc);

		// 查看全文:details/summary 只读展开(SKILL.md 正文,frontmatter 之后的 instructions)
		const details = this.contentEl.createEl('details');
		details.createEl('summary', { text: tNow('modal.skillManage.viewFull') });
		const pre = details.createEl('pre');
		pre.setText(skill.instructions);

		row.addToggle((tog) => {
			tog.setValue(registry.isEnabled(name)).onChange(async (v) => {
				// 关键路径:开关持久化到 settings.skillEnabled,禁用时 Registry 清 active。
				this.plugin.settings.skillEnabled[name] = v;
				registry.setEnabled(name, v);
				await this.plugin.saveSettings();
			});
		});

		if (source === 'vault') {
			row.addButton((b) =>
				b.setButtonText(tNow('modal.skillManage.edit')).onClick(() => {
					// 有 open-chat-note.ts 先例:UI 层直接 openLinkText(vault 相对路径)。
					void this.app.workspace.openLinkText(`${skill.dir}/SKILL.md`, '', false);
				}),
			);
			row.addButton((b) =>
				this.wireDeleteButton(b, name, async () => {
					await this.plugin.vault.trashFolder(skill.dir);
				}),
			);
		} else if (source === 'global') {
			row.addButton((b) =>
				b.setButtonText(tNow('modal.skillManage.edit')).onClick(() => {
					this.openInSystem(skill.dir);
				}),
			);
			row.addButton((b) =>
				this.wireDeleteButton(b, name, async () => {
					await rm(skill.dir, { recursive: true, force: true });
				}),
			);
		}
		// builtin:无编辑/删除(升级幂等重写,编辑必被覆盖)— desc 已注明。
	}

	/**
	 * 两击确认删除 — 第一击切「再点一次确认删除」,第二击执行后重扫描。
	 *
	 * @param b - 按钮组件
	 * @param name - 技能名
	 * @param remove - 来源对应的实际删除动作(vault 回收站 / global rm)
	 */
	private wireDeleteButton(
		b: ButtonComponent,
		name: string,
		remove: () => Promise<void>,
	): void {
		b.setButtonText(tNow('modal.skillManage.delete'))
			.setDestructive()
			.onClick(async () => {
				if (this.confirmDeleteName !== name) {
					// 修复: 跨行切换确认态时,旧武装按钮文案残留「再点一次确认删除」,重置回删除。
					if (this.confirmDeleteBtn && this.confirmDeleteBtn !== b) {
						this.confirmDeleteBtn.setButtonText(tNow('modal.skillManage.delete'));
					}
					// 第一击:进入确认态
					this.confirmDeleteName = name;
					this.confirmDeleteBtn = b;
					b.setButtonText(tNow('modal.skillManage.confirmDelete'));
					return;
				}
				this.confirmDeleteName = null;
				this.confirmDeleteBtn = null;
				try {
					await remove();
					// 关键路径:先清 skillEnabled 再 reloadSkills,避免同名 shadow 技能继承旧 override。
					delete this.plugin.settings.skillEnabled[name];
					await this.plugin.reloadSkills();
					await this.plugin.saveSettings();
					new Notice(tNow('modal.skillManage.deleted', { name }));
					this.renderBody();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					devLogger.error('skill', `删除技能 ${name} 失败`, err);
					new Notice(tNow('modal.skillManage.deleteFailed', { message }));
				}
			});
	}

	/**
	 * 系统文件管理器打开全局技能目录(Electron shell;仅桌面端可用)。
	 * 失败降级为 Notice 显示路径,用户自行前往。
	 */
	private openInSystem(dir: string): void {
		try {
			const electron = (
				window as unknown as {
					require?: (m: string) => { shell: { openPath: (p: string) => Promise<string> } };
				}
			).require?.('electron');
			if (electron) {
				// 关键路径: openPath 失败时 resolve 错误字符串而非 reject,需显式检查。
				void electron.shell.openPath(dir).then((errMsg) => {
					if (errMsg) {
						new Notice(tNow('modal.skillManage.editHint', { path: dir }));
					}
				});
				return;
			}
		} catch (err) {
			devLogger.warn('skill', 'electron shell 不可用,降级显示路径', err);
		}
		new Notice(tNow('modal.skillManage.editHint', { path: dir }));
	}
}

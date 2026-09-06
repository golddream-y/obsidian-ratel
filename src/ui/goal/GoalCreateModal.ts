/**
 * @file src/ui/goal/GoalCreateModal.ts
 * @description 创建目标表单 Modal — spec 4.11 面 4
 * @module ui/goal/GoalCreateModal
 * @depends obsidian, tools/manage-goal, estimate-grant-files, core/goal-grant, i18n
 */

import { Modal, Setting, type App } from 'obsidian';
import type { VaultPort } from '../../ports/vault';
import type { GoalCreateConfirmResult, GoalCreateDraft } from '../../tools/manage-goal';
import { validateGrantGlobs } from '../../core/goal-grant';
import { estimateGrantFileCount } from './estimate-grant-files';
import { tNow } from '../../i18n';

/**
 * 弹出可编辑创建表单 — 用户确认后才落盘(spec 4.3)。
 *
 * @param app - Obsidian App
 * @param vault - 用于估算 grant 覆盖文件数
 * @param draft - 模型建议字段
 */
export function showGoalCreateModal(
	app: App,
	vault: VaultPort,
	draft: GoalCreateDraft,
): Promise<GoalCreateConfirmResult> {
	return new Promise((resolve) => {
		const modal = new GoalCreateModal(app, vault, draft, resolve);
		modal.open();
	});
}

class GoalCreateModal extends Modal {
	private settled = false;
	private objective = '';
	private criteriaText = '';
	private pathGlob = '';
	private property = '';
	private maxRounds = 10;
	private grantText = '';
	private activate = true;
	private estimateEl?: HTMLElement;

	constructor(
		app: App,
		private vault: VaultPort,
		private draft: GoalCreateDraft,
		private onResolve: (result: GoalCreateConfirmResult) => void,
	) {
		super(app);
		this.objective = draft.objective;
		this.criteriaText = draft.criteriaText;
		this.maxRounds = draft.maxRounds ?? 10;
		this.grantText = (draft.grant ?? []).join('\n');
		this.activate = draft.suggestActivate;
		if (draft.predicate) {
			this.pathGlob = draft.predicate.pathGlob;
			this.property = draft.predicate.property;
		}
	}

	private settle(result: GoalCreateConfirmResult): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(result);
	}

	private parseGlobs(): string[] {
		return this.grantText
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
	}

	private refreshEstimate(): void {
		if (!this.estimateEl) return;
		const globs = this.parseGlobs();
		let count = 0;
		try {
			if (globs.length) validateGrantGlobs(globs);
			count = estimateGrantFileCount(this.vault, globs);
		} catch {
			count = 0;
		}
		this.estimateEl.setText(tNow('goal.modal.create.estimate', { count }));
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(tNow('goal.modal.create.title'));

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.objective'))
			.addText((t) =>
				t.setValue(this.objective).onChange((v) => {
					this.objective = v;
				}),
			);

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.criteria'))
			.addTextArea((t) => {
				t.setValue(this.criteriaText)
					.onChange((v) => {
						this.criteriaText = v;
					});
				t.inputEl.rows = 3;
			});

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.predicateGlob'))
			.addText((t) =>
				t.setValue(this.pathGlob).onChange((v) => {
					this.pathGlob = v;
				}),
			);

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.predicateProperty'))
			.addText((t) =>
				t.setValue(this.property).onChange((v) => {
					this.property = v;
				}),
			);

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.maxRounds'))
			.addText((t) =>
				t
					.setValue(String(this.maxRounds))
					.onChange((v) => {
						const n = Number.parseInt(v, 10);
						if (Number.isFinite(n) && n > 0) this.maxRounds = n;
					}),
			);

		new Setting(contentEl)
			.setName(tNow('goal.modal.create.grant'))
			.setDesc(tNow('goal.modal.create.grantDesc'))
			.addTextArea((t) => {
				t.setValue(this.grantText)
					.onChange((v) => {
						this.grantText = v;
						this.refreshEstimate();
					});
				t.inputEl.rows = 3;
			});

		this.estimateEl = contentEl.createEl('p', {
			cls: 'setting-item-description',
		});
		this.refreshEstimate();

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		if (this.draft.suggestActivate) {
			btnRow
				.createEl('button', { text: tNow('goal.modal.create.activate'), cls: 'mod-cta' })
				.onclick = () => {
					this.submit(true);
				};
		} else {
			btnRow
				.createEl('button', { text: tNow('goal.modal.create.queueOnly'), cls: 'mod-cta' })
				.onclick = () => {
					this.submit(false);
				};
			btnRow.createEl('button', { text: tNow('goal.modal.create.activate') }).onclick = () => {
				this.submit(true);
			};
		}
		btnRow.createEl('button', { text: tNow('modal.toolConfirm.deny') }).onclick = () => {
			this.settle({ confirmed: false });
			this.close();
		};
	}

	private submit(activate: boolean): void {
		const globs = this.parseGlobs();
		const predicate =
			this.pathGlob.trim() && this.property.trim()
				? {
						kind: 'frontmatter-all' as const,
						pathGlob: this.pathGlob.trim(),
						property: this.property.trim(),
					}
				: undefined;
		this.settle({
			confirmed: true,
			activate,
			objective: this.objective.trim(),
			criteriaText: this.criteriaText.trim(),
			maxRounds: this.maxRounds,
			grant: globs.length ? globs : null,
			predicate,
		});
		this.close();
	}

	onClose(): void {
		if (!this.settled) {
			this.settle({ confirmed: false });
		}
		this.contentEl.empty();
	}
}

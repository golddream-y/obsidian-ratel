/**
 * @file src/ui/skills/ScriptTrustModal.ts
 * @description Skill 脚本首次运行授权 Modal — 允许并记住 / 仅此次 / 拒绝(spec §4.6c)
 * @module ui/skills/ScriptTrustModal
 * @depends obsidian, i18n
 */

import { Modal, Notice, type App } from 'obsidian';
import { tNow } from '../../i18n';
import type { TrustConfirmDecision } from '../../skills/skill-script-permission';

/**
 * 弹出脚本授权 Modal。
 *
 * 关键路径:ESC / 点遮罩关闭视为拒绝(与 showToolConfirmModal 行为一致),
 * 避免 agent loop 永久 await。
 */
export function showScriptTrustModal(
	app: App,
	info: { scriptId: string; skillName: string; sourceLabel: string; skillDir: string },
): Promise<TrustConfirmDecision> {
	return new Promise((resolve) => {
		const modal = new ScriptTrustModal(app, info, resolve);
		modal.open();
	});
}

class ScriptTrustModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly info: { scriptId: string; skillName: string; sourceLabel: string; skillDir: string },
		private readonly onResolve: (d: TrustConfirmDecision) => void,
	) {
		super(app);
	}

	private settle(d: TrustConfirmDecision): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(d);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(tNow('modal.scriptTrust.title'));
		contentEl.createEl('p', {
			text: tNow('modal.scriptTrust.desc', {
				id: this.info.scriptId,
				skill: this.info.skillName,
				source: this.info.sourceLabel,
			}),
		});
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: tNow('modal.scriptTrust.sandboxNote'),
		});
		// 脚本来源目录绝对路径直接展示(路径本身无需 i18n),供用户核对脚本真实位置
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: this.info.skillDir,
		});
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.allowAlways') }).onclick = () => {
			new Notice(tNow('modal.scriptTrust.trustedNotice', { id: this.info.scriptId }));
			this.settle('always');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.allowOnce') }).onclick = () => {
			this.settle('once');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.deny') }).onclick = () => {
			this.settle('deny');
			this.close();
		};
	}

	onClose(): void {
		// 关键路径:ESC / 遮罩关闭 = 拒绝,Promise 不悬空
		this.settle('deny');
		this.contentEl.empty();
	}
}

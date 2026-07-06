// TODO(ratel): 临时方案,后续完善成类似 Hermes 的模型切换体验
// (在 Modal 内直接选模型 + Apply,不走设置面板)

/**
 * @file src/ui/chat/model-info-modal.ts
 * @description /model 信息 Modal — 展示当前模型配置 + 跳转 Ratel 设置面板(临时方案)
 * @module ui/chat/model-info-modal
 * @depends obsidian, ../../secrets/ratel-secrets, i18n
 */

import { App, Modal, Setting } from 'obsidian';
import { hasRerankApiKey } from '../../secrets/ratel-secrets';
import { tNow } from '../../i18n';

/**
 * RatelVaultPlugin 的最小接口切片 — 只取 Modal 需要的字段,避免耦合整个 plugin 类型。
 */
interface PluginLike {
	app: App;
	settings: {
		chatModel: string;
		chatApiBase: string;
		embedModelActive: string;
		embedProvider: 'local' | 'api';
		embedApiModel: string;
		chatModelMaxTokens: number;
	};
}

/**
 * 展示当前模型配置 + 跳转按钮的 Modal(临时方案)。
 *
 * 设计要点:
 * - 只读展示,不允许直接改配置(临时方案,后续完善为 Hermes 式切换)
 * - 跳转按钮直接打开 Ratel 设置 tab,省去用户在 Obsidian 设置列表中搜索
 *
 * TODO(ratel): 后续完善成类似 Hermes 的模型切换体验(在 Modal 内直接选模型 + Apply)
 */
export class ModelInfoModal extends Modal {
	constructor(app: App, private plugin: PluginLike) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('chat.modelInfo.title'));

		const s = this.plugin.settings;

		new Setting(this.contentEl)
			.setName(tNow('chat.modelInfo.chatModel'))
			.setDesc(s.chatModel || tNow('chat.modelInfo.notConfigured'));

		new Setting(this.contentEl)
			.setName(tNow('chat.modelInfo.chatBaseUrl'))
			.setDesc(s.chatApiBase || tNow('chat.modelInfo.default'));

		// 关键路径:embedProvider 决定显示哪个字段 — local 显示本地 ONNX 模型 id,api 显示 API 模型名
		const embedDesc = s.embedProvider === 'api'
			? (s.embedApiModel || tNow('chat.modelInfo.notConfigured'))
			: (s.embedModelActive || tNow('chat.modelInfo.defaultLocal'));
		new Setting(this.contentEl)
			.setName(tNow('chat.modelInfo.embedModel'))
			.setDesc(embedDesc);

		new Setting(this.contentEl)
			.setName(tNow('chat.modelInfo.contextLength'))
			.setDesc(s.chatModelMaxTokens > 0 ? `${s.chatModelMaxTokens} tokens` : tNow('chat.modelInfo.notConfigured'));

		new Setting(this.contentEl)
			.setName(tNow('chat.modelInfo.rerank'))
			.setDesc(hasRerankApiKey(this.plugin.app) ? tNow('chat.modelInfo.rerankConfigured') : tNow('chat.modelInfo.rerankNotConfigured'));

		new Setting(this.contentEl)
			.addButton((btn) => {
				btn.setButtonText(tNow('chat.modelInfo.openSettings'))
					.setCta()
					.onClick(() => {
						this.close();
						// 关键路径:Obsidian App.setting 不是公开类型,需 unknown 中转。
						// 先 open() 再 openTabById('ratel-vault'),直接跳到 Ratel tab,省去用户搜索。
						const app = this.app as unknown as {
							setting: {
								open: () => void;
								openTabById: (id: string) => void;
							};
						};
						app.setting.open();
						app.setting.openTabById('ratel-vault');
					});
			});
	}
}

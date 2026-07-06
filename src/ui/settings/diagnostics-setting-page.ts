/**
 * @file src/ui/settings/diagnostics-setting-page.ts
 * @description 诊断测试子页面 — 命令式渲染 Embedding/LLM/Rerank 三个子 Tab
 * @module ui/settings/diagnostics-setting-page
 * @depends obsidian, ../../main, ../diagnostics/tab-bar, ../diagnostics/embedding-test, ../diagnostics/llm-test, ../diagnostics/rerank-test
 */

import { App, SettingPage } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { createTabBar } from '../diagnostics/tab-bar';
import { renderEmbeddingTest } from '../diagnostics/embedding-test';
import { renderLLMTest } from '../diagnostics/llm-test';
import { renderRerankTest } from '../diagnostics/rerank-test';
// 关键路径:SettingPage.display() 每次进入子页面时调用,tNow 即可
import { tNow } from '../../i18n';

/**
 * 诊断测试子页面 — 在声明式 settings 中作为 `SettingDefinitionPage` 的 imperative 兜底。
 *
 * 设计要点:
 * - 继承 `SettingPage`,实现 `display()`(注:这是 SettingPage 自己的抽象方法,非 deprecated)
 * - 内部走现有 `createTabBar` + `render*Test`,不改诊断逻辑
 * - 用户从 settings 主页面点击 "Diagnostics" 条目进入此子页面
 */
export class DiagnosticsSettingPage extends SettingPage {
	app: App;
	plugin: RatelVaultPlugin;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super();
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * 渲染诊断子页面。
	 *
	 * 关键路径:SettingPage 的 abstract 方法,页面打开时调用。
	 * 内部渲染 3 个子 Tab,逻辑与原 `renderDiagnostics(containerEl)` 完全一致。
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: tNow('settings.diagnostics.intro'),
			attr: { style: 'color: var(--text-muted); margin-bottom: 16px; font-size: 13px;' },
		});

		createTabBar(containerEl, [
			{
				id: 'embedding',
				label: tNow('settings.diagnostics.tab.embedding'),
				render: (el) => renderEmbeddingTest(el, this.plugin),
			},
			{
				id: 'llm',
				label: tNow('settings.diagnostics.tab.llm'),
				render: (el) => renderLLMTest(el, this.plugin),
			},
			{
				id: 'rerank',
				label: tNow('settings.diagnostics.tab.rerank'),
				render: (el) => renderRerankTest(el, this.plugin),
			},
		], 'embedding');
	}
}

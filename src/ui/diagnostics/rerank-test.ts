/**
 * @file src/ui/diagnostics/rerank-test.ts
 * @description Rerank 测试面板 — 让用户输入 query + 候选文本,测试 BailianReranker 排序效果
 * @module ui/diagnostics/rerank-test
 * @depends obsidian, ../../adapters/reranker-bailian, ../../secrets/ratel-secrets, ../../main, ./diag-utils
 */

import { Setting } from 'obsidian';
import { BailianReranker } from '../../adapters/reranker-bailian';
import { hasRerankApiKey, resolveRerankApiKey, getRerankSecretId } from '../../secrets/ratel-secrets';
import type RatelVaultPlugin from '../../main';
import { createActionButton } from './diag-utils';

/**
 * 渲染 Rerank 测试面板。
 *
 * 设计要点:
 * - 未配置百炼密钥时显示提示 + 跳转 Keychain 引导,不渲染测试 UI
 * - 用户输入 query + 多行候选文本(一行一个)
 * - 点"测试 Rerank"按钮调 BailianReranker.rerank,展示排序结果
 *
 * @param container - 容器元素
 * @param plugin - RatelVaultPlugin 实例
 */
export function renderRerankTest(container: HTMLElement, plugin: RatelVaultPlugin): void {
	container.empty();

	// ==================== 配置状态 + 未配置引导 ====================
	if (!hasRerankApiKey(plugin.app)) {
		container.createEl('p', {
			text: '未配置百炼 rerank。请在 Obsidian 设置 → Keychain 中添加 ratel-rerank-bailian secret。',
			cls: 'ratel-rerank-warn',
		});
		return;
	}

	// 已配置 — 显示状态摘要
	const summary = container.createDiv({ cls: 'ratel-rerank-summary' });
	const s = plugin.settings;
	summary.createSpan({ text: `百炼 | Base: ${s.rerankerApiBase} | 模型: ${s.rerankerModel} | 密钥: ${getRerankSecretId()} | 状态: 已配置` });

	// ==================== 输入区 ====================
	let query = '';

	new Setting(container)
		.setName('Query')
		.setDesc('测试查询文本')
		.addText((text) => {
			text.setValue('').onChange((v) => {
				query = v;
			});
		});

	const candidatesEl = container.createEl('textarea', {
		cls: 'ratel-rerank-candidates',
		attr: { placeholder: '一行一个候选文本', rows: '6' },
	});

	// ==================== 结果区 ====================
	const resultEl = container.createEl('div', { cls: 'ratel-rerank-result' });

	createActionButton(container, '测试 Rerank', async () => {
		resultEl.empty();
		resultEl.createEl('p', { text: '测试中...' });

		// 关键路径:空 query 前置校验,避免无意义 API 调用浪费配额(对齐 embedding-test.ts)
		if (!query.trim()) {
			resultEl.empty();
			resultEl.createEl('p', { text: '请输入 Query', cls: 'ratel-rerank-warn' });
			return;
		}

		try {
			// 关键路径:每次测试重新读 secret,避免用户在 Keychain 改了密钥后旧值缓存
			const apiKey = resolveRerankApiKey(plugin.app);
			if (!apiKey) {
				resultEl.empty();
				resultEl.createEl('p', { text: '无法读取 rerank API key', cls: 'ratel-rerank-warn' });
				return;
			}
			const reranker = new BailianReranker({
				apiBase: plugin.settings.rerankerApiBase,
				apiKey,
				model: plugin.settings.rerankerModel,
			});
			// 关键路径:onClick 内直读 value,不依赖 change 事件时序(对齐 embedding-test.ts)
			const candidates = candidatesEl.value;
			// 关键路径:候选文本按行切分,每行作为独立文档,id 用索引
			const lines = candidates.split('\n').filter((l) => l.trim());
			const documents = lines.map((text, i) => ({ id: String(i), text }));
			const ranked = await reranker.rerank(query, documents, documents.length);

			resultEl.empty();
			if (ranked.length === 0) {
				resultEl.createEl('p', { text: '(无结果 — 候选为空或 API 返回空)' });
				return;
			}
			// 关键路径:ranked 返回 {id, score},需回查原 text 展示
			ranked.forEach((r, i) => {
				const originalText = lines[Number(r.id)] ?? '(missing)';
				const item = resultEl.createEl('div', { cls: 'ratel-rerank-item' });
				item.createEl('span', { text: `#${i + 1} (score: ${r.score.toFixed(4)})` });
				item.createEl('span', { text: originalText });
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			resultEl.empty();
			resultEl.createEl('p', { text: `测试失败:${message}`, cls: 'ratel-rerank-warn' });
		}
	}, 'list-ordered');
}

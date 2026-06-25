/**
 * @file src/ui/diagnostics/embedding-test.ts
 * @description Embedding 诊断测试区 — 库内检索、两两相似度
 * @module ui/diagnostics/embedding-test
 * @depends obsidian, ../../main, ./diag-utils
 */

import type RatelVaultPlugin from '../../main';
import { EmbeddingLocal } from '../../adapters/embedding-local';
import {
	clearContainer,
	cosineSimilarity,
	createActionButton,
	createResultArea,
	formatError,
	renderError,
} from './diag-utils';
import { hasEmbedApiKey } from '../../secrets/ratel-secrets';

/**
 * 渲染 Embedding 测试区。
 *
 * 两个功能块从上到下排列,各自独立:
 * 1. 库内检索 — 从 vault 真实索引检索 Top-K,展示 docId + score + chunk 摘要
 * 2. 两两相似度 — 输入两段文本,输出余弦相似度分数
 */
export function renderEmbeddingTest(container: HTMLElement, plugin: RatelVaultPlugin): void {
	container.empty();

	// ==================== 配置状态 ====================
	const statusArea = container.createDiv({ cls: 'diag-config-summary' });
	renderEmbeddingStatus(statusArea, plugin);

	// 关键路径:异步检测索引状态,索引为空时禁用整个检索区 + 顶部禁用提示。
	const indexStatusPromise = plugin.vectraStore?.status() ?? Promise.resolve({ totalDocs: 0, lastIndexTime: 0, isIndexing: false });

	// ==================== 功能1: 库内检索 ====================
	const searchSection = container.createDiv({ cls: 'diag-section' });
	searchSection.createEl('h3', { text: '① 库内检索(从 vault 真实库)' });

	// 索引状态禁用提示
	const indexWarn = searchSection.createDiv({ attr: { style: 'font-size:12px;color:var(--text-warning);margin-bottom:8px;display:none;' } });

	searchSection.createEl('label', { cls: 'diag-label', text: 'Query' });
	const searchQuery = searchSection.createEl('textarea', {
		cls: 'diag-textarea',
		attr: { placeholder: '输入查询关键字...', rows: '2' },
	});
	const topKRow = searchSection.createDiv({ cls: 'diag-row' });
	topKRow.createEl('label', { cls: 'diag-label', text: 'Top-K' });
	const topKInput = topKRow.createEl('input', {
		cls: 'diag-input',
		type: 'number',
		attr: { min: '1', max: '50', step: '1', value: '5' },
	});
	const searchBtnRow = searchSection.createDiv({ cls: 'diag-row' });
	const searchResult = createResultArea(searchSection, '检索结果');
	searchResult.createDiv({ cls: 'diag-result-empty', text: '点击"检索"开始测试' });

	const searchBtn = createActionButton(searchBtnRow, '检索', async () => {
		clearContainer(searchResult);
		const query = searchQuery.value.trim();
		const topK = Math.max(1, Math.min(50, parseInt(topKInput.value, 10) || 5));

		if (!query) {
			renderError(searchResult, formatError('请输入 Query', '输入校验失败'));
			return;
		}
		try {
			const embedding = checkEmbeddingReady(plugin);
			const vectraStore = plugin.vectraStore;
			if (!vectraStore) {
				renderError(searchResult, formatError('VectraStore 未初始化,请检查插件是否完成启动', '依赖缺失'));
				return;
			}

			const t0 = performance.now();
			const vectors = await embedding.embed([query]);
			const tEmb = performance.now();
			const queryVector = vectors[0];
			if (!queryVector) {
				throw new Error('Embedding 返回空向量');
			}
			const results = await vectraStore.search(queryVector, topK);
			const t1 = performance.now();

			if (results.length === 0) {
				const info = searchResult.createDiv();
				info.createSpan({ cls: 'diag-status-dot diag-status-warn' });
				info.createSpan({ text: `耗时 ${(t1 - t0).toFixed(0)}ms | 索引中有 0 个匹配文档。可能原因:索引为空、Query 与所有文档语义无关。` });
				return;
			}

			const info = searchResult.createDiv();
			info.createSpan({ cls: 'diag-status-dot diag-status-ok' });
			info.createSpan({ text: `命中 ${results.length} / ${topK} 个文档 | 总耗时 ${(t1 - t0).toFixed(0)}ms(embedding ${(tEmb - t0).toFixed(0)}ms + 检索 ${(t1 - tEmb).toFixed(0)}ms)` });

			const list = searchResult.createDiv({ cls: 'diag-similarity-list', attr: { style: 'margin-top: 10px;' } });
			for (const [idx, r] of results.entries()) {
				const itemDiv = list.createDiv({ cls: 'diag-similarity-item' });
				itemDiv.createSpan({ cls: 'diag-similarity-score', text: `#${idx + 1}  ${r.score.toFixed(4)}` });
				const pathSpan = itemDiv.createSpan({ cls: 'diag-similarity-text' });
				pathSpan.createEl('code', { text: r.docId });
				pathSpan.createSpan({ attr: { style: 'font-size:11px;color:var(--text-faint);' }, text: ` [${typeof r.metadata.path === 'string' ? r.metadata.path : r.docId}]` });

				// 异步加载 chunk text 摘要
				const previewDiv = itemDiv.createDiv({ attr: { style: 'font-size:12px;color:var(--text-muted);margin-top:6px;white-space:pre-wrap;' } });
				previewDiv.createSpan({ text: '加载中...', attr: { style: 'font-style:italic;' } });
				vectraStore.getDocumentText(r.docId).then((text) => {
					previewDiv.empty();
					if (text === null) {
						previewDiv.createSpan({ text: '(无法读取文档原文)', attr: { style: 'font-style:italic;color:var(--text-faint);' } });
					} else {
						const max = 200;
						const preview = text.length > max ? text.slice(0, max) + '…' : text;
						previewDiv.createSpan({ text: preview });
					}
				}).catch((err) => {
					previewDiv.empty();
					previewDiv.createSpan({ text: `[读取失败: ${err instanceof Error ? err.message : String(err)}]`, attr: { style: 'color:var(--text-error);' } });
				});
			}
		} catch (err) {
			renderError(searchResult, formatError(err, '库内检索失败'));
		}
	}, 'search');

	indexStatusPromise.then((status) => {
		if (status.totalDocs === 0) {
			indexWarn.setText('⚠️ 索引中尚无文档,无法检索。请先在主面板执行一次"重新构建索引"。');
			indexWarn.style.display = 'block';
			// 关键路径:索引为空时禁用输入区,避免空检索浪费 embedding 算力。
			searchQuery.disabled = true;
			topKInput.disabled = true;
			(searchBtn as HTMLButtonElement).disabled = true;
		}
	}).catch(() => {
		indexWarn.setText('⚠️ 索引状态读取失败,检索功能不可用。');
		indexWarn.style.display = 'block';
		searchQuery.disabled = true;
		topKInput.disabled = true;
		(searchBtn as HTMLButtonElement).disabled = true;
	});

	// ==================== 功能2: 两两相似度 ====================
	const pairSection = container.createDiv({ cls: 'diag-section' });
	pairSection.createEl('h3', { text: '② 两两文本相似度' });
	pairSection.createEl('label', { cls: 'diag-label', text: '文本 A' });
	const pairA = pairSection.createEl('textarea', {
		cls: 'diag-textarea',
		attr: { placeholder: '第一段文本...', rows: '2' },
	});
	pairSection.createEl('label', { cls: 'diag-label', text: '文本 B' });
	const pairB = pairSection.createEl('textarea', {
		cls: 'diag-textarea',
		attr: { placeholder: '第二段文本...', rows: '2' },
	});
	const pairBtnRow = pairSection.createDiv({ cls: 'diag-row' });
	const pairResult = createResultArea(pairSection, '相似度结果');
	pairResult.createDiv({ cls: 'diag-result-empty', text: '点击"计算相似度"开始测试' });

	createActionButton(pairBtnRow, '计算相似度', async () => {
		clearContainer(pairResult);
		const a = pairA.value.trim();
		const b = pairB.value.trim();
		if (!a || !b) {
			renderError(pairResult, formatError('请输入两段文本', '输入校验失败'));
			return;
		}
		try {
			const embedding = checkEmbeddingReady(plugin);
			const t0 = performance.now();
			const vectors = await embedding.embed([a, b]);
			const t1 = performance.now();
			const vA = vectors[0];
			const vB = vectors[1];
			if (!vA || !vB) throw new Error('Embedding 返回空向量');
			const sim = cosineSimilarity(vA, vB);

			const info = pairResult.createDiv();
			info.createSpan({ cls: 'diag-status-dot diag-status-ok' });
			info.createSpan({ text: `余弦相似度 | 耗时: ${(t1 - t0).toFixed(1)}ms` });

			const scoreDiv = pairResult.createDiv({ attr: { style: 'margin-top: 10px; font-size: 32px; font-weight: 700; font-family: var(--font-monospace); text-align: center; padding: 16px; background: var(--background-primary); border-radius: 6px;' } });
			scoreDiv.createSpan({ text: sim.toFixed(6), attr: { style: 'color: ' + (sim > 0.8 ? 'var(--text-success)' : sim > 0.5 ? 'var(--text-warning)' : 'var(--text-error)') } });

			const bar = pairResult.createDiv({ attr: { style: 'margin-top: 8px; height: 8px; background: var(--background-modifier-border); border-radius: 4px; overflow: hidden;' } });
			const fill = Math.max(0, Math.min(1, (sim + 1) / 2));
			bar.createDiv({ attr: { style: `width: ${fill * 100}%; height: 100%; background: linear-gradient(90deg, var(--text-error), var(--text-warning), var(--text-success)); border-radius: 4px;` } });

			const legend = pairResult.createDiv({ attr: { style: 'margin-top: 4px; display: flex; justify-content: space-between; font-size: 11px; color: var(--text-faint);' } });
			legend.createSpan({ text: '-1 (完全相反)' });
			legend.createSpan({ text: '0 (无关)' });
			legend.createSpan({ text: '1 (完全相同)' });
		} catch (err) {
			renderError(pairResult, formatError(err, '相似度计算失败'));
		}
	}, 'git-compare');

	// 默认填入一些示例文本方便快速测试
	searchQuery.value = '如何安装插件';
	pairA.value = '我喜欢吃苹果';
	pairB.value = '我喜欢吃香蕉';
}

/**
 * 检查当前 Embedding 适配器是否可用,返回可用的 EmbeddingPort。
 * @throws 当适配器未就绪或占位器未注入真实实例时,抛出描述清晰的错误。
 */
function checkEmbeddingReady(plugin: RatelVaultPlugin) {
	const emb = plugin.embedding;
	if (!emb) {
		const err = new Error('Embedding 适配器未初始化,请重新加载插件');
		(err as Error & { code?: string }).code = 'EMBEDDING';
		throw err;
	}
	if (emb instanceof EmbeddingLocal && !emb.isReady) {
		const err = new Error('本地模型尚未加载完成。请等待模型下载/初始化完毕(观察 Notice 提示),或检查模型下载是否失败。');
		(err as Error & { code?: string }).code = 'MODEL_NOT_READY';
		throw err;
	}
	return emb;
}

/**
 * 渲染当前 Embedding + 索引配置状态摘要。
 */
function renderEmbeddingStatus(container: HTMLElement, plugin: RatelVaultPlugin): void {
	const s = plugin.settings;
	const isLocal = s.embedProvider === 'local';
	const isReady = !(plugin.embedding instanceof EmbeddingLocal) || plugin.embedding.isReady;

	container.empty();
	container.createSpan({ cls: `diag-status-dot ${isReady ? 'diag-status-ok' : 'diag-status-warn'}` });
	container.createSpan({ text: '当前配置: ' });
	container.createEl('code', { text: isLocal ? '本地 ONNX' : 'API' });
	container.createSpan({ text: ' | ' });
	if (isLocal) {
		container.createSpan({ text: `模型: ${s.embedLocalModel} | 维度: ${s.embedLocalDimensions} | 状态: ${isReady ? '就绪' : '加载中...'}` });
	} else {
		// 关键路径:Key 状态从钥匙串解析,不读 settings 明文。
		const keyStatus = hasEmbedApiKey(plugin.app, s) ? '已配置' : '未配置 Key';
		container.createSpan({ text: `Base: ${s.embedApiBase} | 模型: ${s.embedApiModel} | 维度: ${s.embedApiDimensions} | Key: ${keyStatus}` });
	}
	container.createSpan({ text: ' | ' });
	// 关键路径:索引状态异步加载,先显示加载中,加载完更新 DOM。
	const idxSpan = container.createSpan({ text: '索引: 加载中...' });
	void plugin.vectraStore?.status().then((status) => {
		idxSpan.setText(`索引: ${status.totalDocs} 个文档${status.lastIndexTime > 0 ? `,最近 ${new Date(status.lastIndexTime).toLocaleTimeString()}` : ''}`);
	}).catch(() => {
		idxSpan.setText('索引: 读取失败');
	});
}

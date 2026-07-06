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
import { tNow } from '../../i18n';

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
	const statusArea = container.createDiv({ cls: 'ratel-diag-config-summary' });
	renderEmbeddingStatus(statusArea, plugin);

	// 关键路径:异步检测索引状态,索引为空时禁用整个检索区 + 顶部禁用提示。
	const indexStatusPromise = plugin.vectraStore?.status() ?? Promise.resolve({ totalDocs: 0, lastIndexTime: 0, isIndexing: false });

	// ==================== 功能1: 库内检索 ====================
	const searchSection = container.createDiv({ cls: 'ratel-diag-section' });
	searchSection.createEl('h3', { text: tNow('diag.embedding.section1') });

	// 索引状态禁用提示
	// 关键路径:样式走 ratel-index-warn class(见 styles.css),display 由 ratel-is-visible 切换。
	const indexWarn = searchSection.createDiv({ cls: 'ratel-index-warn' });

	searchSection.createEl('label', { cls: 'ratel-diag-label', text: 'Query' });
	const searchQuery = searchSection.createEl('textarea', {
		cls: 'ratel-diag-textarea',
		attr: { placeholder: tNow('diag.embedding.queryPlaceholder'), rows: '2' },
	});
	const topKRow = searchSection.createDiv({ cls: 'ratel-diag-row' });
	topKRow.createEl('label', { cls: 'ratel-diag-label', text: 'Top-K' });
	const topKInput = topKRow.createEl('input', {
		cls: 'ratel-diag-input',
		type: 'number',
		attr: { min: '1', max: '50', step: '1', value: '5' },
	});
	const searchBtnRow = searchSection.createDiv({ cls: 'ratel-diag-row' });
	const searchResult = createResultArea(searchSection, tNow('diag.embedding.searchResultTitle'));
	searchResult.createDiv({ cls: 'ratel-diag-result-empty', text: tNow('diag.embedding.searchHint') });

	const searchBtn = createActionButton(searchBtnRow, tNow('diag.embedding.searchButton'), async () => {
		clearContainer(searchResult);
		const query = searchQuery.value.trim();
		const topK = Math.max(1, Math.min(50, parseInt(topKInput.value, 10) || 5));

		if (!query) {
			renderError(searchResult, formatError(tNow('diag.embedding.errorEmptyQuery'), tNow('diag.errorInputValidation')));
			return;
		}
		try {
			const embedding = checkEmbeddingReady(plugin);
			const vectraStore = plugin.vectraStore;
			if (!vectraStore) {
				renderError(searchResult, formatError(tNow('diag.embedding.errorNoVectra')));
				return;
			}

			const t0 = performance.now();
			const vectors = await embedding.embed([query]);
			const tEmb = performance.now();
			const queryVector = vectors[0];
			if (!queryVector) {
				throw new Error(tNow('error.embedding.emptyVector'));
			}
			const results = await vectraStore.search(queryVector, topK);
			const t1 = performance.now();

			if (results.length === 0) {
				const info = searchResult.createDiv();
				info.createSpan({ cls: 'ratel-diag-status-dot ratel-diag-status-warn' });
				info.createSpan({ text: tNow('diag.embedding.emptyResult', { ms: (t1 - t0).toFixed(0) }) });
				return;
			}

			const info = searchResult.createDiv();
			info.createSpan({ cls: 'ratel-diag-status-dot ratel-diag-status-ok' });
			info.createSpan({ text: tNow('diag.embedding.searchStats', {
				hit: results.length,
				topK,
				ms: (t1 - t0).toFixed(0),
				embMs: (tEmb - t0).toFixed(0),
				searchMs: (t1 - tEmb).toFixed(0),
			}) });

			const list = searchResult.createDiv({ cls: 'ratel-diag-similarity-list', attr: { style: 'margin-top: 10px;' } });
			for (const [idx, r] of results.entries()) {
				const itemDiv = list.createDiv({ cls: 'ratel-diag-similarity-item' });
				itemDiv.createSpan({ cls: 'ratel-diag-similarity-score', text: `#${idx + 1}  ${r.score.toFixed(4)}` });
				const pathSpan = itemDiv.createSpan({ cls: 'ratel-diag-similarity-text' });
				pathSpan.createEl('code', { text: r.docId });
				pathSpan.createSpan({ attr: { style: 'font-size:11px;color:var(--text-faint);' }, text: ` [${typeof r.metadata.path === 'string' ? r.metadata.path : r.docId}]` });

				// 异步加载 chunk text 摘要
				const previewDiv = itemDiv.createDiv({ attr: { style: 'font-size:12px;color:var(--text-muted);margin-top:6px;white-space:pre-wrap;' } });
				previewDiv.createSpan({ text: tNow('diag.embedding.loading'), attr: { style: 'font-style:italic;' } });
				vectraStore.getDocumentText(r.docId).then((text) => {
					previewDiv.empty();
					if (text === null) {
						previewDiv.createSpan({ text: tNow('diag.embedding.indexReadFailed'), attr: { style: 'font-style:italic;color:var(--text-faint);' } });
					} else {
						const max = 200;
						const preview = text.length > max ? text.slice(0, max) + '…' : text;
						previewDiv.createSpan({ text: preview });
					}
				}).catch((err) => {
					previewDiv.empty();
					previewDiv.createSpan({ text: tNow('diag.embedding.readFailed', { message: err instanceof Error ? err.message : String(err) }), attr: { style: 'color:var(--text-error);' } });
				});
			}
		} catch (err) {
			renderError(searchResult, formatError(err, tNow('diag.embedding.searchFailed')));
		}
	}, 'search');

	indexStatusPromise.then((status) => {
		if (status.totalDocs === 0) {
			indexWarn.setText(tNow('diag.embedding.indexEmptyWarn'));
			indexWarn.addClass('ratel-is-visible');
			// 关键路径:索引为空时禁用输入区,避免空检索浪费 embedding 算力。
			searchQuery.disabled = true;
			topKInput.disabled = true;
			searchBtn.disabled = true;
		}
	}).catch(() => {
		indexWarn.setText(tNow('diag.embedding.indexReadFailedWarn'));
		indexWarn.addClass('ratel-is-visible');
		searchQuery.disabled = true;
		topKInput.disabled = true;
		searchBtn.disabled = true;
	});

	// ==================== 功能2: 两两相似度 ====================
	const pairSection = container.createDiv({ cls: 'ratel-diag-section' });
	pairSection.createEl('h3', { text: tNow('diag.embedding.section2') });
	pairSection.createEl('label', { cls: 'ratel-diag-label', text: tNow('diag.embedding.textA') });
	const pairA = pairSection.createEl('textarea', {
		cls: 'ratel-diag-textarea',
		attr: { placeholder: tNow('diag.embedding.textAPh'), rows: '2' },
	});
	pairSection.createEl('label', { cls: 'ratel-diag-label', text: tNow('diag.embedding.textB') });
	const pairB = pairSection.createEl('textarea', {
		cls: 'ratel-diag-textarea',
		attr: { placeholder: tNow('diag.embedding.textBPh'), rows: '2' },
	});
	const pairBtnRow = pairSection.createDiv({ cls: 'ratel-diag-row' });
	const pairResult = createResultArea(pairSection, tNow('diag.embedding.similarityResultTitle'));
	pairResult.createDiv({ cls: 'ratel-diag-result-empty', text: tNow('diag.embedding.similarityHint') });

	createActionButton(pairBtnRow, tNow('diag.embedding.calcButton'), async () => {
		clearContainer(pairResult);
		const a = pairA.value.trim();
		const b = pairB.value.trim();
		if (!a || !b) {
			renderError(pairResult, formatError(tNow('diag.embedding.errorEmptyTextPair'), tNow('diag.errorInputValidation')));
			return;
		}
		try {
			const embedding = checkEmbeddingReady(plugin);
			const t0 = performance.now();
			const vectors = await embedding.embed([a, b]);
			const t1 = performance.now();
			const vA = vectors[0];
			const vB = vectors[1];
			if (!vA || !vB) throw new Error(tNow('error.embedding.emptyVector'));
			const sim = cosineSimilarity(vA, vB);

			const info = pairResult.createDiv();
			info.createSpan({ cls: 'ratel-diag-status-dot ratel-diag-status-ok' });
			info.createSpan({ text: tNow('diag.embedding.cosineResult', { ms: (t1 - t0).toFixed(1) }) });

			const scoreDiv = pairResult.createDiv({ attr: { style: 'margin-top: 10px; font-size: 32px; font-weight: 700; font-family: var(--font-monospace); text-align: center; padding: 16px; background: var(--background-primary); border-radius: 6px;' } });
			scoreDiv.createSpan({ text: sim.toFixed(6), attr: { style: 'color: ' + (sim > 0.8 ? 'var(--text-success)' : sim > 0.5 ? 'var(--text-warning)' : 'var(--text-error)') } });

			const bar = pairResult.createDiv({ attr: { style: 'margin-top: 8px; height: 8px; background: var(--background-modifier-border); border-radius: 4px; overflow: hidden;' } });
			const fill = Math.max(0, Math.min(1, (sim + 1) / 2));
			bar.createDiv({ attr: { style: `width: ${fill * 100}%; height: 100%; background: linear-gradient(90deg, var(--text-error), var(--text-warning), var(--text-success)); border-radius: 4px;` } });

			const legend = pairResult.createDiv({ attr: { style: 'margin-top: 4px; display: flex; justify-content: space-between; font-size: 11px; color: var(--text-faint);' } });
			legend.createSpan({ text: tNow('diag.embedding.oppositeLabel') });
			legend.createSpan({ text: tNow('diag.embedding.unrelatedLabel') });
			legend.createSpan({ text: tNow('diag.embedding.identicalLabel') });
		} catch (err) {
			renderError(pairResult, formatError(err, tNow('diag.embedding.similarityFailed')));
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
		// 关键路径:throw 消息走 i18n,因为会被 formatError 捕获并展示给用户
		const err = new Error(tNow('diag.embedding.errorNotInit'));
		(err as Error & { code?: string }).code = 'EMBEDDING';
		throw err;
	}
	if (emb instanceof EmbeddingLocal && !emb.isReady) {
		const err = new Error(tNow('diag.embedding.errorModelNotReady'));
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
	container.createSpan({ cls: `ratel-diag-status-dot ${isReady ? 'ratel-diag-status-ok' : 'ratel-diag-status-warn'}` });
	container.createSpan({ text: tNow('diag.configSummary') });
	container.createEl('code', { text: isLocal ? tNow('diag.configLocalOnnx') : tNow('diag.configApi') });
	container.createSpan({ text: ' | ' });
	if (isLocal) {
		container.createSpan({ text: tNow('diag.embedding.configLocalDetail', {
			model: s.embedLocalModel,
			dim: s.embedLocalDimensions,
			status: isReady ? tNow('diag.statusReady') : tNow('diag.statusLoading'),
		}) });
	} else {
		// 关键路径:Key 状态从钥匙串解析,不读 settings 明文。
		const keyStatus = hasEmbedApiKey(plugin.app, s) ? tNow('diag.configured') : tNow('diag.notConfiguredKey');
		container.createSpan({ text: tNow('diag.embedding.configApiDetail', {
			base: s.embedApiBase,
			model: s.embedApiModel,
			dim: s.embedApiDimensions,
			key: keyStatus,
		}) });
	}
	container.createSpan({ text: ' | ' });
	// 关键路径:索引状态异步加载,先显示加载中,加载完更新 DOM。
	const idxSpan = container.createSpan({ text: tNow('diag.embedding.indexLoading') });
	void plugin.vectraStore?.status().then((status) => {
		const time = status.lastIndexTime > 0 ? `, ${new Date(status.lastIndexTime).toLocaleTimeString()}` : '';
		idxSpan.setText(tNow('diag.embedding.indexStatus', { count: status.totalDocs, time }));
	}).catch(() => {
		idxSpan.setText(tNow('diag.embedding.indexReadFailedStatus'));
	});
}

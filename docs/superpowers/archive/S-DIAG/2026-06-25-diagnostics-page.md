# S-DIAG Implementation Plan — 诊断测试页

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已有 v0 草稿的诊断测试页调整为符合 spec `2026-06-25-diagnostics-page-design.md` 的最终形态 — 删单文本预览、加库内检索、加索引未就绪禁用、加 chunk text 摘要。

**Architecture:** 诊断页只读 `plugin.embedding` + `plugin.vectraStore` 公共字段;不引入新接口;VectraStore 加 `getDocumentText(uri)` 方法以支持 chunk text 摘要;UI 状态条实时显示 Provider/模型/索引状态。

**Tech Stack:** TypeScript 5 + Obsidian Plugin API + Svelte 5 (UI 渲染) + vectra (向量库)。

**Spec:** `docs/superpowers/specs/2026-06-25-diagnostics-page-design.md`

---

## 文件影响面

| 路径 | 操作 | 行数估算 |
|------|------|----------|
| `src/ports/vector.ts` | 修改 — VectorStore 加 `getDocumentText(uri)` | +10 行 |
| `src/adapters/vector-vectra.ts` | 修改 — 实现 `getDocumentText` (基于 listDocuments + loadText) | +30 行 |
| `src/ui/diagnostics/embedding-test.ts` | 修改 — 删单文本预览,加库内检索区,加状态条 | ~250 行 |
| `src/ui/diagnostics/diag-utils.ts` | 保留 — 错误格式化工具已实现,无改动 |
| `src/ui/diagnostics/llm-test.ts` | 保留 — 已实现 |
| `src/ui/diagnostics/rerank-placeholder.ts` | 保留 — 已实现 |
| `src/ui/diagnostics/tab-bar.ts` | 保留 — 已实现 |
| `src/settings.ts` | 保留 — 已实现主 Tab 拆分 |
| `src/ports/llm.ts` | 保留 — 已加 GenerationOptions |
| `src/adapters/llm-deepseek.ts` | 保留 — 已透传生成参数 |
| `src/adapters/embedding-local.ts` | 保留 — 已加 isReady 属性 |

**测试基线:** 219 个测试必须保持通过。

---

## Task 1: VectorStore 端口加 `getDocumentText` 方法

**Files:**
- Modify: `src/ports/vector.ts:13-38` (VectorStore 接口)
- Modify: `src/ports/vector.ts:42-49` (VectorSearchResult 类型不动)

- [ ] **Step 1.1: 在 VectorStore 接口新增 `getDocumentText` 方法**

打开 `src/ports/vector.ts`,在 `VectorStore` 接口的 `status()` 方法**之后**添加 `getDocumentText`:

```typescript
	/**
	 * 取索引中指定 URI 文档的全文(用于诊断页显示命中 chunk 的原文)。
	 *
	 * @param uri - 业务层文档 ID(本项目用 vault 相对路径)。
	 * @returns 文档原文;不存在时返回 null。
	 */
	getDocumentText(uri: string): Promise<string | null>;
```

- [ ] **Step 1.2: 验证 TS 编译通过**

Run: `npx tsc --noEmit`
Expected: 失败 — 提示 `VectraStore` 缺少 `getDocumentText` 实现(类未实现接口)

这是预期的 RED 阶段(编译失败即测试未通过的等价物)。

---

## Task 2: VectraStore 实现 `getDocumentText`

**Files:**
- Modify: `src/adapters/vector-vectra.ts:33-210` (在 `status()` 后添加新方法)

- [ ] **Step 2.1: 在 VectraStore 类 `status()` 之后添加 `getDocumentText` 实现**

打开 `src/adapters/vector-vectra.ts`,找到 `status()` 方法的结束 `}` 位置,在其后插入:

```typescript
	/**
	 * 取指定 URI 文档的全文(用于诊断页 chunk 摘要展示)。
	 *
	 * 关键路径:
	 * - vectra 没有提供按 URI 直接取文本的 API,需要 `listDocuments()` 全量列举后过滤。
	 * - 诊断页只对 Top-K 命中调用,通常 1-10 次,单次 listDocuments 遍历整个 catalog。
	 * - 大库(>5000 文档)时这是性能瓶颈,但**仅诊断用**,不阻塞主流程;若成为问题,
	 *   后续可改为读磁盘 index.json(vectra 内部存储格式)。
	 *
	 * @param uri - 文档 URI(本项目即 vault 相对路径)。
	 * @returns 文档原文;URI 不存在时返回 null;底层失败返回 null(诊断场景降级,避免挂 UI)。
	 */
	async getDocumentText(uri: string): Promise<string | null> {
		try {
			const index = await this.ensureIndex();
			const docs = await index.listDocuments();
			for (const doc of docs) {
				if (doc.uri === uri) {
					const text = await doc.loadText();
					return text;
				}
			}
			return null;
		} catch (err) {
			// 修复:诊断调用降级,不让 UI 卡死。
			console.error('[VectraStore] getDocumentText failed:', err);
			return null;
		}
	}
```

- [ ] **Step 2.2: 验证 TS 编译通过**

Run: `npx tsc --noEmit`
Expected: 0 错误(接口已实现)

- [ ] **Step 2.3: 跑现有测试**

Run: `npm test 2>&1 | tail -30`
Expected: 219 tests passed, 0 failed(VectraStore 是底层实现,新增方法不影响现有逻辑)

- [ ] **Step 2.4: 提交**

```bash
git add src/ports/vector.ts src/adapters/vector-vectra.ts
git commit -m "feat(vector): VectraStore 新增 getDocumentText(uri) 供诊断页使用"
```

---

## Task 3: embedding-test.ts 删除"① 单文本向量预览"区

**Files:**
- Modify: `src/ui/diagnostics/embedding-test.ts` (整个 `// ==================== 功能1: 单文本向量预览 ====================` 块)

- [ ] **Step 3.1: 确认当前 v0 草稿结构**

读取 `src/ui/diagnostics/embedding-test.ts`,定位 `// ==================== 功能1: 单文本向量预览 ====================` 段(整个块从该注释到下一个 `// ====...` 注释之间)。

- [ ] **Step 3.2: 整段删除"① 单文本向量预览"区**

删除从 `// ==================== 功能1: 单文本向量预览 ====================` 到下一个 `// ====================` 之间的所有代码(包含 `singleInput` 变量、`singleBtnRow`、`singleResult`、`createActionButton(singleBtnRow, '生成向量', ...)` 调用及其回调)。

同时删除文件底部"默认填入一些示例文本方便快速测试"代码块中给 `singleInput.value` 赋值的行(若存在)。

- [ ] **Step 3.3: 跑构建验证**

Run: `npm run build 2>&1 | tail -10`
Expected: 0 错误

- [ ] **Step 3.4: 提交**

```bash
git add src/ui/diagnostics/embedding-test.ts
git commit -m "refactor(diag): 删除单文本向量预览区(spec 调整为以库内检索为主)"
```

---

## Task 4: embedding-test.ts 加"① 库内检索"区(主功能)

**Files:**
- Modify: `src/ui/diagnostics/embedding-test.ts` (在 `checkEmbeddingReady` 函数前插入新区)

- [ ] **Step 4.1: 添加库内检索区实现**

在 `embedding-test.ts` 中,`checkEmbeddingReady` 函数定义之前,插入以下代码(原"① 单文本向量预览"区删除后腾出的位置,或放在"② Query 候选排序"区之前):

```typescript
	// ==================== 功能1: 库内检索 ====================
	const searchSection = container.createDiv({ cls: 'diag-section' });
	searchSection.createEl('h3', { text: '① 库内检索(从 vault 真实库)' });
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
			info.createSpan({ text: `命中 ${results.length} / ${topK} 个文档 | 耗时 ${(t1 - t0).toFixed(0)}ms(embedding ${(t1 - t0).toFixed(0)}ms + 检索)` });

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
	const searchResult = createResultArea(searchSection, '检索结果');
	searchResult.createDiv({ cls: 'diag-result-empty', text: '点击"检索"开始测试' });
```

- [ ] **Step 4.2: 跑构建验证**

Run: `npm run build 2>&1 | tail -10`
Expected: 0 错误

- [ ] **Step 4.3: 提交**

```bash
git add src/ui/diagnostics/embedding-test.ts
git commit -m "feat(diag): Embedding 调试区新增库内检索功能"
```

---

## Task 5: embedding-test.ts 顶部状态条加索引状态

**Files:**
- Modify: `src/ui/diagnostics/embedding-test.ts` (`renderEmbeddingStatus` 函数)

- [ ] **Step 5.1: 修改 `renderEmbeddingStatus` 函数显示索引状态**

打开 `src/ui/diagnostics/embedding-test.ts`,找到 `renderEmbeddingStatus` 函数,整体替换为:

```typescript
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
		const keyStatus = s.embedApiKey ? '已配置' : '未配置 Key';
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
```

- [ ] **Step 5.2: 跑构建验证**

Run: `npm run build 2>&1 | tail -10`
Expected: 0 错误

- [ ] **Step 5.3: 提交**

```bash
git add src/ui/diagnostics/embedding-test.ts
git commit -m "feat(diag): Embedding 状态条显示索引文档数"
```

---

## Task 6: 库内检索区在索引为空时禁用输入

**Files:**
- Modify: `src/ui/diagnostics/embedding-test.ts` (`renderEmbeddingTest` 函数,在库内检索区之前增加 disabled 检测)

- [ ] **Step 6.1: 在 `renderEmbeddingTest` 顶部读取索引状态并应用到检索区**

打开 `src/ui/diagnostics/embedding-test.ts`,找到 `renderEmbeddingTest` 函数,定位"库内检索区"代码块(`searchSection.createEl('h3', { text: '① 库内检索(从 vault 真实库)' });`)之前。

在库内检索区代码**之前**插入以下代码(用于检测索引状态并控制检索区启用/禁用):

```typescript
	// 关键路径:异步检测索引状态,索引为空时禁用整个检索区 + 顶部禁用提示。
	const indexStatusPromise = plugin.vectraStore?.status() ?? Promise.resolve({ totalDocs: 0, lastIndexTime: 0, isIndexing: false });
```

然后在 `searchSection.createEl('h3', ...)` 这行之后、`searchQuery` 之前,插入:

```typescript
	// 索引状态禁用提示
	const indexWarn = searchSection.createDiv({ attr: { style: 'font-size:12px;color:var(--text-warning);margin-bottom:8px;display:none;' } });
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
```

- [ ] **Step 6.2: 跑构建验证**

Run: `npm run build 2>&1 | tail -10`
Expected: 0 错误

- [ ] **Step 6.3: 提交**

```bash
git add src/ui/diagnostics/embedding-test.ts
git commit -m "feat(diag): 库内检索区在索引为空时禁用输入"
```

---

## Task 7: 验收 — build/test/E2E 检查清单

**Files:** 无

- [ ] **Step 7.1: 跑完整构建**

Run: `npm run build 2>&1 | tail -5`
Expected: 0 错误,生成 `dist/main.js` + `dist/worker.js`

- [ ] **Step 7.2: 跑完整测试**

Run: `npm test 2>&1 | tail -10`
Expected: 219 tests passed(零回归)

- [ ] **Step 7.3: 手动 E2E 检查清单(在 Obsidian 中执行)**

打开 Obsidian → 设置 → 插件设置 → Ratel Vault → 顶部切换到"诊断测试"Tab。

按 [docs/superpowers/specs/2026-06-25-diagnostics-page-design.md](file:///Users/golddream/code/git-public/Ratel-CLI/docs/superpowers/specs/2026-06-25-diagnostics-page-design.md) 的"验收标准"逐项确认:

| # | 项 | 验证方法 | 通过 |
|---|----|---------|-----|
| 1 | 设置面板有"常规设置"和"诊断测试"两个主 Tab | 切换看 | ☐ |
| 2 | 诊断测试下三个子 Tab:Embedding / LLM / Rerank | 切换看 | ☐ |
| 3 | Embedding 状态条显示 Provider/模型/索引状态 | 查看状态条 | ☐ |
| 4 | Embedding ① 库内检索:输入 query,展示 docId + score + chunk 摘要 | 检索一个真实 query | ☐ |
| 5 | 索引为空时库内检索区禁用 | 清空索引(测试后恢复) | ☐ |
| 6 | Embedding ② AB 相似度:两段文本 → 余弦分数 | 填两段相近/无关文本 | ☐ |
| 7 | LLM 子 Tab 流式输出 + 参数调优 + Ctrl+Enter | 发个简单问题 | ☐ |
| 8 | Rerank 子 Tab 灰态占位 + 当前配置状态 | 查看占位 | ☐ |
| 9 | 所有错误展示为结构化错误块 | 故意关 Key / 错 Base URL 触发 | ☐ |

- [ ] **Step 7.4: 提交(若全部通过)**

如验收过程中有细节修复,在最后一次性提交:
```bash
git add -A
git commit -m "chore(diag): 诊断测试页 E2E 验收通过,提交"
```

---

## 自审

1. **Spec 覆盖**:
   - 验收标准 9 项,每项对应 Task 1-6 中的代码改动;Task 7 做总体验收。
   - "不引入新接口" — Plan 中没有在 main.ts 暴露新方法,符合 spec § 关键约束。
   - "不整好几套逻辑" — embedding-test.ts 直接调 `embedding.embed` + `vectraStore.search`,不复用 search-vault 内部。
   - "不绕过状态机" — Task 6 加索引空禁用。
   - "chunk 文本摘要" — Task 2 扩展 `getDocumentText`,Task 4 库内检索区调用它显示前 200 字。

2. **Placeholder 扫描**: 无 TBD/TODO/实现后占位。代码块完整。

3. **类型一致性**:
   - `VectorStore.getDocumentText` 在 Task 1 定义,Task 2 实现,Task 4 调用 — 一致。
   - `plugin.vectraStore` 在 Task 5/6 调用 — 已在 main.ts 持有,无需新加。

4. **TDD 适配**: UI 渲染 + 异步索引检测,单元测试价值低(spec 已说明);Task 7 用 E2E 检查清单做验收。

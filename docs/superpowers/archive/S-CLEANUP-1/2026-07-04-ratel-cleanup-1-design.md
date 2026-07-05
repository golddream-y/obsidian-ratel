# S-CLEANUP-1 — 杂项缺失修复与历史技术债清理

- **Spec ID:** S-CLEANUP-1
- **状态:** Active
- **创建日期:** 2026-07-04
- **关联:** 无前置 spec(汇总多份调研)
- **后续:** 无

---

## 1. 背景与目标

### 1.1 背景

P-PROMPTS 完成后扫描整体规划,识别出 12 项散落的"杂项缺失 + 关键硬伤 + 文档/技术债",分布在 5 个领域:

- **A 类(用户感知硬伤):** `/compact` 伪实现、命令面板缺失、Rerank 诊断占位、`/model` 半实现 — 用户能立刻发现"骗人"或"功能没做完"
- **B 类(配置/接线缺失):** Link Suggestions 裸露设置、post-tool-use hook 空注册、Worker Threads 入口 dead code
- **C 类(文档失同步):** ARCHITECTURE.md §3.1 工具清单过时、S-RAG-ARCH §12.1 状态表过时
- **E 类(测试基础设施):** svelte-eslint-parser 配置缺失,`npx eslint src/` 不覆盖 `*.svelte`
- **F 类(历史技术债):** S-PROMPTS deferred 4 项 + S-INDEX-STARTUP deferred 2 项 + S-INDEX-BLOCK deferred 4 项

### 1.2 目标

通过单 spec + 单 plan 一次性清理全部 12 项,使代码库达到"无已知硬伤、无过时文档、无悬挂设置项、无 deferred 历史债"状态,为下一轮新功能开发(如 i18n、Subagent)扫清基础。

### 1.3 非目标

- 不实现 i18n(S-I18N 独立 spec)
- 不实现 Librarian / Reviewer / Curator 三个 subagent(独立 spec)
- 不实现 Claude adapter(用户已确认无需求)
- 不引入新功能 — 全部 12 项都是修复/清理/同步
- 不重构现有架构 — 仅做点状修补

---

## 2. 改进项清单与分类

按 5 个模块组织 12 项改进。

### 2.1 A 模块 — 用户感知硬伤修复

| ID | 名称 | 文件证据 | 改造形态 |
|---|---|---|---|
| A1 | `/compact` 改 LLM 摘要 | `src/ui/chat/ChatView.svelte:139-143` `messages.slice(-2)` | 重写为 Claude Code 式"fork LLM 调用做结构化摘要 + 保留最近 3 条原文 + 重置 session" |
| A2 | 命令面板补 4 个 | `src/main.ts:339-367` 仅 2 个 `addCommand` | 加 `reindex` / `pause` / `resume` / `dropIndex` 4 个 `addCommand`,危险操作加 Modal 确认 |
| A3 | Rerank 诊断面板重写 | `src/ui/diagnostics/rerank-placeholder.ts` "功能待实现" | 文件改名为 `rerank-test.ts`,参考 `embedding-test.ts` 模式接通真实 `BailianReranker` |
| A4 | `/model` 改信息 Modal | `src/ui/chat/ChatView.svelte:130-132` 仅 `setting.open()` | 新建 `model-info-modal.ts`,展示当前 chatModel/embedModel/rerank 状态 + "打开 Ratel 设置面板"按钮(临时方案,后续完善成类似 Hermes 的模型切换体验) |

### 2.2 B 模块 — 配置与接线清理

| ID | 名称 | 文件证据 | 改造形态 |
|---|---|---|---|
| B1 | 删除 Link Suggestions 设置项 | `src/settings.ts:89-90,141-142,571-598` | 从 interface + DEFAULT_SETTINGS + render 代码中全删(真正实现需要 Librarian subagent,本次 spec 排除) |
| B2 | post-tool-use hook 注册立即索引刷新 | `src/main.ts:300-316` 仅 path-safety | 新增 `post-tool-use` 钩子,write/append/edit/delete 工具执行后调 `IndexController.enqueue(path)`,绕过 FolderWatcher 5s 去抖 |
| B3 | Worker Threads 入口 dead code 注释强化 | `src/worker/index.ts:22-30` 抛错"暂未实现" | 加更明确注释说明"此路径为未来扩展,当前不可达"(Obsidian 不支持 Worker Threads,见 ADR-002) |

### 2.3 C 模块 — 文档同步

| ID | 名称 | 文件证据 | 改造形态 |
|---|---|---|---|
| C1 | ARCHITECTURE.md §3.1 工具清单更新 | `docs/ARCHITECTURE.md:317-328` 老工具名 11 个 | 替换为当前 9 个工具(`read_note`/`search_vault`/`grep`/`glob`/`list_files`/`write_note`/`append_note`/`edit_note`/`delete_note`) |
| C2 | S-RAG-ARCH §12.1 状态表更新 | `docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md:556-596` 6 个 ❌ 实际已 ✅ | BM25/RRF/search_vault/上下文注入/RAG 提示词/引用标记 6 项更新为 ✅,加注实施 plan 与 commit |

### 2.4 E 模块 — 测试基础设施

| ID | 名称 | 文件证据 | 改造形态 |
|---|---|---|---|
| E1 | svelte-eslint-parser 配置 | STATUS.md Future execution queue 第 2 项 | 安装 + 配置 `svelte-eslint-parser`,让 `npx eslint src/` 覆盖 `*.svelte` |

### 2.5 F 模块 — 历史技术债清理

| ID | 名称 | 来源 | 改造形态 |
|---|---|---|---|
| F1 | `makeToolDef` helper 提取 | S-PROMPTS deferred | 7 个 test 文件提取到 `tests/helpers/make-tool-def.ts` |
| F2 | 7 个 tool 函数补 JSDoc | S-PROMPTS deferred | grep/glob/list-files/write-note/append-note/delete-note/edit-note 各补方法级 JSDoc |
| F3 | `read-note.test.ts` 描述中文化 | S-PROMPTS deferred | 测试描述改为"行为 - 条件 - 期望结果"中文格式 |
| F4 | `read-note.ts` 改用 `requireString` | S-PROMPTS deferred | `args.path as string` → `requireString(args, 'path', 'path')` |
| F5 | `indexDelete` FIXME 修复 | S-INDEX-STARTUP deferred | VectraStore catalog 同源 bug 修复,删除 FIXME 注释 |
| F6 | `chunkCount` incremental 路径更新 | S-INDEX-STARTUP deferred | incremental 索引后更新 manifest.chunkCount |
| F7 | `totalDocs` 语义统一 | S-INDEX-BLOCK deferred | UI 文案从"文档数"改为"块数" |
| F8 | 回滚测试补充 | S-INDEX-BLOCK deferred | 覆盖事务中失败场景 |
| F9 | EmbeddingWorkerProxy 测试补充 | S-INDEX-BLOCK deferred | init 失败、embed 业务错误、并发 embed |
| F10 | embedding-worker.ts 测试补充 | S-INDEX-BLOCK deferred | embed 成功路径、init 失败路径 |

---

## 3. 详细设计 — A 模块(用户感知硬伤)

### 3.1 A1. `/compact` LLM 摘要重写(Claude Code 式)

#### 3.1.1 设计参考

调研业界做法:

- **Claude Code `/compact`**:fork 一次 LLM 调用,把完整对话历史喂进去 + "summarize this conversation",几十轮对话 → 约 20k tokens 摘要,不强制字数,让 LLM 自由发挥。命中 prefix cache 所以只要 1/10 价格。
- **LangChain ConversationSummaryBufferMemory**:滚动压缩,新对话加入 buffer,buffer 满了就压缩最早的部分,保留最近 N 条原文 + 摘要组成 context。
- **Hierarchical Memory**:短期保留细节,长期只存关键节点;给每段历史内容打分,低分优先淘汰。

#### 3.1.2 改造方案

**新方案:全量摘要 + 保留最近 3 条原文 + 替换历史**

新建 `src/ui/chat/compact-session.ts`,导出:

```typescript
export async function compactSession(
    ctx: ContextManager,
    llm: LLMClient,
    sessionId: string,
): Promise<{ summary: string; preservedMessages: ChatMessage[] }>;
```

**流程:**

1. 从 ContextManager 拉 session 全部 messages
2. 保留最后 3 条原文(混合 user/assistant,保证上下文连续)
3. 把剩余 messages 拼成对话文本 → 单独 fork 一次 LLM 调用,要求结构化摘要
4. 摘要 prompt 走 Composer(新增 section `internal.compact`,可被 `promptOverrides` 覆盖),要求 4 段结构化输出:
   - **对话历程**(用户问了什么、助手答了什么,简述)
   - **已确认事实**(讨论中确定的结论、约束、决策)
   - **当前任务目标**(下一步要做什么)
   - **未解决问题**(还待确认的点)
5. **不限制字数**,只给上限约束("不超过 2000 tokens" 或 "用尽量精炼的语言")
6. 拿到摘要后调 `ctx.resetSession(sessionId, summary, preservedMessages)`:
   - 删除当前 session 持久化
   - 新建 session,初始化为 `[system: 摘要 + compact 标记] + preservedMessages`
   - 不需要调用方再 push 用户消息

#### 3.1.3 ContextManager 新方法

```typescript
async resetSession(
    sessionId: string,
    summary: string,
    preservedMessages: ChatMessage[],
): Promise<void>
```

- `persistence.sessions.delete(sessionId)`
- `ctx.load(sessionId)`(新建空 session)
- `ctx.addSystemMessage(`[compact 摘要]\n${summary}`)`
- `preservedMessages.forEach(msg => ctx.addMessage(msg))`

#### 3.1.4 摘要 Prompt(Composer 新增 section)

在 `src/prompts/defaults/zh.ts` 新增 `internal.compact` section,内容约束 LLM:

- 输入:历史对话文本
- 输出:4 段结构化摘要(对话历程 / 已确认事实 / 当前任务目标 / 未解决问题)
- 不限制字数,用尽量精炼的语言
- 不丢失关键决策、约束、未解决问题

#### 3.1.5 UI 流程

- `handleCompact` 改为 async
- 显示 "压缩中..." loading
- 流式展示摘要生成过程(可选,提升体验)
- 完成后更新 messages Svelte state 为 preservedMessages

#### 3.1.6 与原方案对比

| 维度 | 原方案(伪实现) | 新方案(Claude Code 式) |
|---|---|---|
| 摘要范围 | 无摘要 | 全部历史(保留最近 3 条不摘要) |
| 保留原文 | `messages.slice(-2)` | 最后 3 条原文(user + assistant 混合) |
| 字数 | N/A | 不限,只给上限约束 |
| 摘要结构 | N/A | 4 段(对话历程/已确认事实/当前任务/未解决问题) |
| Session 处理 | 只改 Svelte state,持久化未清 | 删 + 新建 + push 摘要 + push preservedMessages |
| 上下文连续性 | 差(只 2 条) | 好(3 条原文 + 摘要) |

### 3.2 A2. 命令面板补 4 个

#### 3.2.1 改造方案

`src/main.ts` `registerCommands()`(从 onload 抽出方法)新增 4 个 `addCommand`:

```typescript
// 重建索引(危险操作,带 Modal 确认)
this.addCommand({
    id: 'reindex',
    name: '重建索引(全量)',
    callback: () => showReindexConfirm(this.app, () => this.indexController.reindex()),
});

// 暂停索引
this.addCommand({
    id: 'pause-index',
    name: '暂停索引',
    callback: () => { this.indexController.pause(); new Notice('索引已暂停'); },
});

// 恢复索引
this.addCommand({
    id: 'resume-index',
    name: '恢复索引',
    callback: () => { this.indexController.resume(); new Notice('索引已恢复'); },
});

// 清空索引(危险操作,带 Modal 确认 + 二次输入"DELETE"验证)
this.addCommand({
    id: 'drop-index',
    name: '清空索引(危险)',
    callback: () => showDropIndexConfirm(this.app, () => this.vectraStore.dropIndex()),
});
```

#### 3.2.2 确认 Modal

新建 `src/ui/confirm-modal.ts`:

- `showReindexConfirm(app, onConfirm)`:Modal 显示"将删除并重建整个索引,耗时 N 分钟,期间搜索不可用"
- `showDropIndexConfirm(app, onConfirm)`:Modal + 文本输入框要求输入 "DELETE" 才能确认

### 3.3 A3. Rerank 诊断面板重写

#### 3.3.1 当前问题

- `rerank-placeholder.ts` 写"功能尚未实现"
- 实际 `BailianReranker` 已生产化(`src/adapters/reranker-bailian.ts`,100 行,真 fetch 调用),`src/main.ts:258-264` 已注入 `MultiQuerySearcher`,搜索时真的在用

#### 3.3.2 改造方案

1. 文件改名:`rerank-placeholder.ts` → `rerank-test.ts`
2. 仿 `embedding-test.ts` 模式,UI 提供:
   - Query 输入框
   - 候选文本多行输入(一行一个候选)
   - "测试 Rerank" 按钮
3. 点击按钮调 `BailianReranker.rerank(query, candidates)` → 展示排序后结果 + 分数
4. 无 rerank API key 时显示"未配置百炼 rerank,请到 Keychain 配置 `ratel-rerank-bailian`"
5. 同步更新 `diagnostics-panel.ts` 中的 import 路径与组件名

### 3.4 A4. `/model` 信息 Modal(临时方案)

#### 3.4.1 当前问题

- 描述"切换模型",实现只是 `plugin.app.setting.open()` 打开 Obsidian 全局设置面板

#### 3.4.2 改造方案(临时)

新建 `src/ui/chat/model-info-modal.ts`:

```typescript
export class ModelInfoModal extends Modal {
    constructor(app: App, private plugin: RatelVaultPlugin) { super(app); }
    
    onOpen() {
        // 展示当前配置:
        // - Chat Model: this.settings.chatModelName (来自 LiteLLM 映射)
        // - Chat Base URL: this.settings.chatBaseUrl
        // - Embed Model: this.settings.embedModelId
        // - Rerank: 已配置 / 未配置(hasRerankApiKey)
        // - Context Length: this.settings.chatModelMaxTokens
        
        // 底部按钮:"打开 Ratel 设置面板" → this.app.setting.open() + 切换到 Ratel tab
    }
}
```

`/model` 斜杠命令改为 `new ModelInfoModal(this.app, plugin).open()`。

#### 3.4.3 TODO 标记

在 `model-info-modal.ts` 文件头加注释:

```typescript
// TODO(ratel): 临时方案,后续完善成类似 Hermes 的模型切换体验
// (在 Modal 内直接选模型 + Apply,不走设置面板)
```

---

## 4. 详细设计 — B/C/E/F 模块

### 4.1 B 模块 — 配置与接线清理

#### 4.1.1 B1. 删除 Link Suggestions 设置项

**改造:**

- `RatelVaultSettings` interface 删除 `autoSuggestLinks: boolean` 与 `linkConfidenceThreshold: number`
- `DEFAULT_SETTINGS` 删除对应字段
- `renderSettings()` 删除 `renderLinkSuggestions()` 方法及调用(约 30 行)
- `styles.css` 删除对应 CSS(如有)
- 不做数据迁移(旧 data.json 里有这两个字段会被 normalizeSettings 自动忽略)

#### 4.1.2 B2. post-tool-use hook 注册立即索引刷新

**改造:**

`src/main.ts` `registerHooks()`(从 onload 抽出)新增:

```typescript
// 关键路径:写工具执行后立即触发索引刷新,绕过 FolderWatcher 5s 去抖
this.hooks.register('post-tool-use', async (toolCall: ToolCall) => {
    const writeTools = ['write_note', 'append_note', 'edit_note', 'delete_note'];
    if (!writeTools.includes(toolCall.name)) return;
    
    // 关键路径:从 toolCall.args 提取目标路径,enqueue 给 IndexController
    const targetPath = extractToolTargetPath(toolCall);
    if (targetPath) {
        await this.indexController.enqueue(targetPath, toolCall.name === 'delete_note' ? 'delete' : 'upsert');
    }
}, 'immediate-reindex');
```

**新建 `src/hooks/immediate-reindex.ts`:**

- 导出 `extractToolTargetPath(toolCall): string | null` — 从 toolCall.args 提取 path/file 等字段
- 单元测试覆盖 4 种工具的 args 结构

**IndexController 新方法:**

```typescript
async enqueue(path: string, op: 'upsert' | 'delete'): Promise<void>
```

- 已存在则复用,不存在则补一个轻量入口(不走 5s 去抖,直接调 `indexer.indexFile(path)` 或 `indexer.deleteFile(path)`)
- 加锁防并发(同一 path 短时间内多次 enqueue 只执行最后一次)

#### 4.1.3 B3. Worker Threads 入口 dead code 注释强化

**改造:**

`src/worker/index.ts:22-30` 把 `throw new Error('Worker Threads 场景下暂未实现 embeddings 注入,请使用 InlineWorker 模式')` 改为:

```typescript
// 关键路径:此分支为未来扩展预留,当前 Obsidian 渲染进程不支持 Worker Threads(见 ADR-002)
// 所有 Worker 实际走 InlineWorker 模式(主线程模拟),不进入此分支。
// 若未来 Obsidian 支持 Worker Threads,需在此实现 embeddings 注入。
throw new Error('Worker Threads 路径不可达:当前 Obsidian 不支持 Worker Threads,请使用 InlineWorker 模式');
```

### 4.2 C 模块 — 文档同步

#### 4.2.1 C1. ARCHITECTURE.md §3.1 工具清单更新

`docs/ARCHITECTURE.md:317-328` 老工具清单(11 个,`search-vault`/`read-note`/`follow-backlinks`/`create-note`/`update-note`/`tag-note`/`suggest-links`/`summarize-note`/`index-status`/`find-orphans`/`weekly-digest`)替换为:

| 工具 | 文件 | 用途 |
|---|---|---|
| read_note | src/tools/read-note.ts | 读取笔记全文 |
| search_vault | src/tools/search-vault.ts | 向量+BM25 混合检索 |
| grep | src/tools/grep.ts | 正则搜索 |
| glob | src/tools/glob.ts | 文件名匹配 |
| list_files | src/tools/list-files.ts | 列出文件 |
| write_note | src/tools/write-note.ts | 创建/覆盖笔记 |
| append_note | src/tools/append-note.ts | 追加内容 |
| edit_note | src/tools/edit-note.ts | 编辑指定行 |
| delete_note | src/tools/delete-note.ts | 删除笔记 |

#### 4.2.2 C2. S-RAG-ARCH §12.1 状态表更新

`docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md:556-596` 6 个 ❌ → ✅:

- #7 search_vault 工具 → ✅
- #9 BM25 检索 → ✅
- #10 RRF 融合 → ✅
- #11 上下文注入 → ✅
- #12 RAG 提示词 → ✅
- #13 引用标记 [1][2] → ✅

每条加注对应的实施 plan 与 commit(从 STATUS.md archive 区取)。

### 4.3 E 模块 — 测试基础设施

#### 4.3.1 E1. svelte-eslint-parser 配置

**改造:**

1. `npm install -D svelte-eslint-parser @eslint/js typescript-eslint`(如未安装)
2. 新建 / 更新 `eslint.config.js`:
   - 添加 `svelte-eslint-parser` 作为 `*.svelte` 文件的 parser
   - 添加 Svelte 推荐规则集
3. 跑 `npx eslint src/` 验证 `*.svelte` 文件被覆盖
4. 修复或登记 pre-existing lint errors(2023 个,大多来自 Svelte 5 语法,可能需要 `// eslint-disable` 标注或规则调整)

**注意:** pre-existing lint errors 数量大,本次只确保 **配置正确 + 新代码不引入新 error**,不强制清零历史 errors。

### 4.4 F 模块 — 历史技术债清理

#### 4.4.1 F1. `makeToolDef` helper 提取

新建 `tests/helpers/make-tool-def.ts`:

```typescript
import { composeToolDefinitions } from '../../src/prompts/composer';
import type { ToolDefinition } from '../../src/ports/llm';

export function makeToolDef(name: string): ToolDefinition {
    return composeToolDefinitions({}, [name])[0]!;
}
```

7 个 test 文件(`tests/tools/{read-note,search-vault,grep,glob,list-files,write-note,append-note,edit-note,delete-note}.test.ts`)删除本地 `makeToolDef`,改为 import。

#### 4.4.2 F2. 7 个 tool 函数补 JSDoc

`src/tools/` 下 7 个文件(grep/glob/list-files/write-note/append-note/delete-note/edit-note),每个 `export function createXxxTool(...)` 加方法级 JSDoc(按 AGENTS.md § 2.3 格式):

```typescript
/**
 * 创建 xxx 工具实例。
 *
 * @param vault - ObsidianVault 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createXxxTool(vault, toolDef);
 *   tools.register(tool);
 */
```

#### 4.4.3 F3. `read-note.test.ts` 描述中文化

`tests/tools/read-note.test.ts` 所有 `it(...)` 描述改为"行为 - 条件 - 期望结果"中文格式:

- `it('reads a note', ...)` → `it('read_note - 文件存在 - 返回内容', ...)`
- 等等

#### 4.4.4 F4. `read-note.ts` 改用 `requireString`

`src/tools/read-note.ts`:

```typescript
// before
const notePath = args.path as string;

// after
const notePath = requireString(args, 'path', 'path');
```

`requireString` 已存在于 `src/tools/validate-args.ts`(签名 `requireString(args, key, label)`,第三参数 `label` 用于错误消息中的字段名),其他 tool 文件已普遍使用,直接 import 即可。

#### 4.4.5 F5. `indexDelete` FIXME 修复

`src/adapters/vector-vectra.ts` `indexDelete` 方法:

- 当前:加 FIXME 注释,绕过 catalog 同源 bug
- 修复:按 vectra API 正确删除 catalog 项,删除 FIXME

#### 4.4.6 F6. `chunkCount` incremental 路径更新

`src/main.ts` `incremental` 索引路径(189-198):

- 调用 `index.incremental` 后,补 `manifest.recordEntry(...)` 更新 chunkCount

#### 4.4.7 F7. `totalDocs` 语义统一

UI 文案从"文档数"改为"块数"(更准确反映 vectra 中存储的是 chunk 而非 document)。

涉及位置:

- 诊断面板 `src/ui/diagnostics/`
- 状态条 `src/ui/status/`
- 索引进度提示

#### 4.4.8 F8. 回滚测试补充

`tests/adapters/vector-vectra.test.ts` 新增测试:

- `upsertItems 事务中失败 - 已写入的部分回滚`
- `deleteByPath 失败 - 不破坏索引状态`

#### 4.4.9 F9. EmbeddingWorkerProxy 测试补充

`tests/adapters/embedding-worker-proxy.test.ts` 新增测试:

- `init - Worker 初始化失败 - 抛 explicit error`
- `embed - Worker 业务错误 - 抛 explicit error 不静默降级`
- `embed - 并发调用 - 多请求 ID 不串扰`

#### 4.4.10 F10. embedding-worker.ts 测试补充

`tests/worker/embedding-worker.test.ts` 新增测试:

- `onmessage - embed 成功 - 返回向量`
- `onmessage - init 失败 - 返回错误`

---

## 5. 数据流 / 错误处理 / 测试策略

### 5.1 数据流(关键改造项)

#### 5.1.1 A1 `/compact` 数据流

```
用户点 /compact
    ↓
ChatView.handleCompact()
    ↓
compactSession(ctx, llm, sessionId)  ← 新模块 src/ui/chat/compact-session.ts
    │
    ├─ 1. ctx.getSessionMessages(sessionId) 拉 session 全部 messages
    │
    ├─ 2. preservedMessages = messages.slice(-3)  (保留最近 3 条原文)
    │
    ├─ 3. summaryInput = messages.slice(0, -3) 拼成对话文本
    │
    ├─ 4. llm.chat({
    │       messages: composeInternalMessages('compact', { tools: [], history: summaryInput }, overrides),
    │    })  ← Composer 新增 internal.compact section
    │
    ├─ 5. summary = 拼接流式 delta
    │
    └─ 6. await ctx.resetSession(sessionId, summary, preservedMessages)
            │
            ├─ persistence.sessions.delete(sessionId)
            ├─ ctx.load(sessionId)  (新建空 session)
            ├─ ctx.addSystemMessage(`[compact 摘要]\n${summary}`)  ← 新方法
            └─ preservedMessages.forEach(msg => ctx.addMessage(msg))
    ↓
ChatView 更新 messages Svelte state = preservedMessages
    ↓
用户可以接着问(LLM 看到:摘要 + 最近 3 条原文)
```

#### 5.1.2 B2 post-tool-use hook 数据流

```
LLM 调 write_note({path: "a.md", content: "..."})
    ↓
agent-loop 执行 write_note.execute()
    ↓
hooks.run('post-tool-use', toolCall)  ← 新注册
    │
    ├─ 1. 检查 toolCall.name ∈ {write_note, append_note, edit_note, delete_note}
    │
    ├─ 2. extractToolTargetPath(toolCall) → "a.md"
    │
    └─ 3. indexController.enqueue("a.md", 'upsert')  ← 不走 5s 去抖
            │
            ├─ 加锁:同 path 短时间内多次 enqueue 只执行最后一次
            └─ 直接调 indexer.indexFile("a.md") 或 deleteFile
    ↓
同步返回,agent-loop 继续下一步(LLM 看到工具结果)

(异步在后台:索引完成,下次 search_vault 立即可搜到 a.md)
```

### 5.2 错误处理策略

| 项 | 错误场景 | 处理 |
|---|---|---|
| A1 `/compact` | LLM 摘要调用失败(网络/超时) | 抛错给 ChatView,显示 toast "压缩失败:xxx",session 不重置(保留原历史) |
| A1 `/compact` | resetSession 持久化失败 | 抛错,session 可能处于中间状态 — 加日志,建议用户重启 |
| A2 命令面板 | reindex/dropIndex 进行中再次触发 | Modal 禁用按钮 + 显示"进行中" |
| A2 dropIndex | 用户未输入 "DELETE" | 禁用确认按钮 |
| A3 Rerank 测试 | 无 API key | 显示"未配置 ratel-rerank-bailian,请到 Keychain 配置" |
| A3 Rerank 测试 | 测试调用失败 | 显示错误堆栈 + 排查建议(参考 llm-test.ts 模式) |
| B2 post-tool-use hook | IndexController.enqueue 失败 | `devLogger.warn('hooks', ...)`,不影响主流程(工具已成功执行) |
| F5 indexDelete 修复 | 修复后 vectra 行为与预期不符 | 加测试覆盖,先在测试中复现 bug 再修 |

### 5.3 测试策略

#### 5.3.1 单元测试(必加)

| 模块 | 新增测试 | 文件 |
|---|---|---|
| A1 | `compactSession` - 正常摘要 + 保留 3 条 + session 重置 | `tests/ui/chat/compact-session.test.ts` |
| A1 | `compactSession` - LLM 失败 - 不重置 session | 同上 |
| A1 | `ContextManager.resetSession` - 删旧 session + 注入摘要 + preserved | `tests/core/context-manager.test.ts` |
| A2 | `showReindexConfirm` / `showDropIndexConfirm` - 确认/取消 | `tests/ui/confirm-modal.test.ts` |
| B2 | `extractToolTargetPath` - 4 种工具 args 提取 | `tests/hooks/immediate-reindex.test.ts` |
| B2 | hook 注册 - 写工具触发,只工具不触发 | `tests/hooks/post-tool-use.test.ts` |
| F1-F4 | 跑现有 522 测试无回归 | - |
| F8 | vector-vectra 回滚测试 | `tests/adapters/vector-vectra.test.ts` |
| F9 | EmbeddingWorkerProxy 失败路径测试 | `tests/adapters/embedding-worker-proxy.test.ts` |
| F10 | embedding-worker 测试 | `tests/worker/embedding-worker.test.ts` |

#### 5.3.2 集成验证

- A1:跑完 `/compact` 后 `search_vault` 仍可工作(不破坏 RAG 链路)
- B2:写完笔记后立即 `search_vault`,验证能搜到刚写的内容(不等待 5s)
- A3:rerank 测试面板跑真实 BailianReranker,确认结果排序正确
- A2:命令面板命令可被 Obsidian 识别(手动 E2E)

#### 5.3.3 不加测试的项

- C1/C2 文档同步:无需测试
- B3 注释强化:无需测试
- E1 lint 配置:`npx eslint src/` 自身就是验证
- F7 文案修改:无需测试

---

## 6. 影响面

### 6.1 用户可见变化

| 项 | 用户感知 |
|---|---|
| A1 | `/compact` 真的会压缩历史,不再粗暴截断 |
| A2 | 命令面板可搜到 4 个新命令(reindex / pause / resume / dropIndex) |
| A3 | 诊断面板 Rerank tab 可用,显示真实 rerank 测试结果 |
| A4 | `/model` 弹信息 Modal 而非直接跳设置面板 |
| B1 | 设置面板少了一个"自动建议链接"分组(原本无效) |
| B2 | 写完笔记后立刻 `search_vault` 能搜到(不等 5s) |
| F7 | 状态条/诊断面板"文档数" → "块数" |

### 6.2 架构层面

- 新增 `src/ui/chat/compact-session.ts`、`src/ui/chat/model-info-modal.ts`、`src/ui/confirm-modal.ts`、`src/hooks/immediate-reindex.ts`
- ContextManager 新增 `resetSession()` + `addSystemMessage()` 方法
- IndexController 新增 `enqueue()` 方法
- Composer 新增 `internal.compact` section
- `tests/helpers/make-tool-def.ts` 新建

### 6.3 文档同步

- C1 改 ARCHITECTURE.md
- C2 改 S-RAG-ARCH spec
- 不需要新 ADR(都是已有设计的实施与清理,无非显然技术选型)

---

## 7. 参考

- [Claude Code compact 机制](http://m.toutiao.com/group/7631190466792358441/)
- [Claude Code /compact 与自动压缩](http://m.toutiao.com/group/7643075536306192939/)
- [LangChain ConversationSummaryBufferMemory](https://blog.csdn.net/qq839019311/article/details/140828611)
- [Hierarchical Memory 与 Agent Memory 策略](http://m.toutiao.com/group/7641890127412757030/)
- AGENTS.md § 文档同步规则
- AGENTS.md § 编码约定 § 注释形态
- ADR-002(Worker Threads 不可达说明)

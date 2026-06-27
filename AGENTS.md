# Ratel Vault — Obsidian 插件

## 项目概述

- 目标平台:Obsidian 社区插件(TypeScript → 打包后 JavaScript)。
- 主线程入口:`src/main.ts` 编译为 `dist/main.js`,由 Obsidian 加载。
- Worker 入口:`src/worker/index.ts` 编译为 `dist/worker.js`(索引调度,InlineWorker 模拟)。
- Embedding Worker 入口:`src/worker/embedding-worker.ts` 编译为 `dist/embedding-worker.js`(ONNX 推理,Web Worker)。
- 发布产物:`dist/main.js`、`dist/worker.js`、`dist/embedding-worker.js`、`manifest.json`、可选 `styles.css`,从 `dist/` 取。

## 架构

- **Agent = Model + Harness** — Ratel Vault 是一个面向 Obsidian 知识库管理的 Harness。
- **主线程**:Agent Loop、Context Manager、Hooks、Tools、Subagents、UI(Svelte)、LLM 调用(HTTP)、Embedding 调用(HTTP)、ObsidianVault 外观、vectra 索引磁盘 IO、文本分块(`chunkMarkdown`)。
- **InlineWorker(主线程模拟)**:索引调度(`IndexProcessor`),通过 `setTimeout(0)` 异步触发。vectra 磁盘 IO 与文本分块在主线程执行(需要 `fs`)。
- **Embedding Web Worker(子线程)**:ONNX WASM 向量推理(`session.run()`)。主线程通过 `EmbeddingWorkerProxy`(实现 `EmbeddingPort`)postMessage 到 Worker,Worker 返回向量。不依赖 `fs`、不依赖 Obsidian API、不发 HTTP。
- **无原生模块** — 用 vectra(纯 JS)替代 LanceDB,用 JSON 替代 sql.js。
- **无外部服务** — 模型 API 是唯一的网络调用。

## 环境与工具

- Node.js 18+(推荐 LTS)。
- 包管理:npm。
- 打包器:esbuild + Svelte 插件。
- UI:Svelte 5(编译为原生 JS,无虚拟 DOM)。
- 类型:`obsidian` 类型定义。

### 安装

```bash
npm install
```

### 开发(监听模式)

```bash
npm run dev
```

### 生产打包

```bash
npm run build
```

## 文件与目录约定

```
src/
  main.ts           # 插件入口,生命周期管理
  settings.ts       # 设置接口与默认值
  types.ts          # TypeScript 接口与类型
  core/             # Agent Loop、Context Manager、Hooks
  ports/            # 端口接口(零实现)
  adapters/         # 适配器实现
    obsidian-vault.ts   # Obsidian API 薄包装 (TS)
    persistence-json.ts # Obsidian loadData/saveData
    vector-vectra.ts    # vectra 包装(upsertItem 支持预计算向量)
    embedding-onnx.ts   # ONNX 推理(在 Web Worker 中执行)
    embedding-worker-proxy.ts # EmbeddingPort 代理,postMessage 到 Web Worker
    llm-deepseek.ts     # DeepSeek (OpenAI 兼容)
    llm-anthropic.ts    # Claude
  tools/            # 库工具(搜索、读取、创建等)
  hooks/            # 知识治理钩子
  subagents/        # Indexer、Librarian、Reviewer、Curator
  ui/               # Svelte 视图(聊天侧栏、面板)
  worker/           # Worker 入口
    index.ts            # InlineWorker 入口(索引调度,主线程模拟)
    embedding-worker.ts # Web Worker 入口(ONNX 推理,子线程)
    inline-worker.ts    # InlineWorker 实现(主线程 Worker 模拟)
    handler.ts          # Worker 消息分发
    index-processor.ts  # 索引批处理(chunkMarkdown → 批量 embed → upsertItem)
    chunker.ts          # 文本分块(标题→段落→句子四级回退)
  utils/            # 工具函数
```

- 保持 `main.ts` 精简 — 只放插件生命周期(`onload`、`onunload`、`addCommand`)。
- 把所有功能逻辑拆到独立模块。
- Worker 代码严禁 `import 'obsidian'`。
- Embedding Web Worker 严禁使用 `node:fs` / `node:path`(纯浏览器环境,只做 ONNX WASM 推理)。

## manifest 规则

- `id`:`ratel-vault`(发布后永不修改)。
- `isDesktopOnly`:`true`(使用 Node.js Worker Threads 与文件系统 API)。
- `minAppVersion`:使用较新 Obsidian API 时必须保持准确。

## 关键约束

- **无原生模块**:用 vectra(纯 JS)替代 LanceDB;用 JSON(Obsidian loadData/saveData)替代 sql.js。
- **Worker 中严禁 `import 'obsidian'`**:Worker 只通过 `postMessage` 通信。
- **Embedding Web Worker 严禁使用 Node API**:不 `import 'obsidian'`、不用 `node:fs` / `node:path`、不发 HTTP 请求。只做纯 CPU WASM 推理。
- **InlineWorker 不允许发 HTTP 请求**:Embedding 与 LLM 调用都在主线程(或 Embedding Web Worker)。
- **所有 Obsidian API 访问必须走 ObsidianVault 外观**(`adapters/obsidian-vault.ts`)。
- **三产物**:`main.js`(主线程)+ `worker.js`(InlineWorker 索引调度)+ `embedding-worker.js`(Web Worker ONNX 推理)。
- **网络调用**:只能是模型 API(DeepSeek / Claude / Ollama),必须在 README 中写明。

## 性能

- 保持 `onload` 轻量 — 重活(ONNX 推理)推给 Embedding Web Worker。
- 文件系统事件在送给 Worker 之前必须去抖。
- Embedding 调用必须批量 — `IndexProcessor` 一次性 `embeddings.embed(allChunkTexts)`,不逐 chunk 调用。`EmbeddingOnnx` 的 `maxBatchSize=16` 自动分批。
- ONNX 推理在 Web Worker 线程执行,主线程零 CPU 阻塞。vectra 磁盘 IO 留在主线程(需要 `fs`)。

## 安全与隐私

- 默认本地 / 离线运行。
- 只有模型 API 调用会发网络请求。
- 无遥测、无数据收集。
- 库内容只发往配置的模型 API 端点。
- 所有索引数据存在 `.obsidian/plugins/ratel-vault/`。

## 版本与发布

- 升级 `manifest.json` 的 `version`(SemVer),并同步 `versions.json`。
- GitHub release 的 tag 必须严格匹配 `manifest.json` 的 `version`(不带 `v` 前缀)。
- release 上传 `main.js`、`worker.js`、`embedding-worker.js`、`manifest.json`、`styles.css`。

## 编码约定

- TypeScript 启用 `"strict": true`。
- `async/await` 优先于 Promise 链。
- Plugin 类里用 `this.register*` 帮助函数管理清理。
- 每个文件只承担一个明确职责。

## 文档与注释规范(mandatory)

> 这是硬规矩 — 非协商。所有后续创建的文档、代码注释必须遵守。

### 1. 语言:中文优先

- **文档**:所有 markdown 文档、ADR、spec、plan 主体用中文撰写。技术专有名词、库名、API 名称、文件路径、命令、代码块、URL 保持英文原样。
- **代码注释**:所有行内注释、块注释、JSDoc/TSDoc 描述都用中文。仅在代码标识符、字符串字面量、协议字段(如 HTTP header、JSON key)处使用英文。
- **代码标识符**:变量名、函数名、类名、文件名仍用英文(便于国际协作与 IDE 智能提示)。
- **错误消息**:面向用户的错误消息由 `plugin.i18n` 决定;面向开发者的 `console` / `throw new Error(...)` 用中文。
- **测试用例描述**:`it(...)` 的描述字符串统一中文,格式 `行为 - 条件 - 期望结果`。

### 2. 注释形态(comment shape)

所有源码文件必须按以下层次组织注释,**形态统一**、**可被 IDE 与工具识别**。

#### 2.1 文件头(每个 `.ts` / `.svelte` / `.js` 文件必须有)

```typescript
/**
 * @file <文件相对路径,例如 src/core/agent-loop.ts>
 * @description <本文件的核心职责,一句话说清>
 * @module <所属模块路径,例如 core/agent-loop>
 * @depends <主要依赖的其他模块或外部库,无则省略>
 */
```

#### 2.2 模块/类层级(每个 `export` 类必须有)

```typescript
/**
 * <类的职责,一段话,不要只写一行>
 *
 * 设计要点:
 * - 要点 1
 * - 要点 2
 *
 * @example
 *   const instance = new Foo();
 *   instance.bar();
 */
export class Foo { ... }
```

#### 2.3 函数/方法层级(每个 `export function` 与类 public 方法必须有)

```typescript
/**
 * <函数做什么,一段话>
 *
 * @param param1 - <说明>
 * @param param2 - <说明>
 * @returns <返回值的含义;若返回 Promise,说明 resolve 值的含义>
 * @throws <什么情况下抛错,以及错误类型>
 * @example
 *   const result = foo('bar', 42);
 */
```

#### 2.4 行内注释

- 解释"为什么"(why),而不是"做了什么"(what)。
- 复杂算法或非显然的判断必须留 1-2 行注释。
- 禁止显而易见的废话注释(`i++ // 自增`)。
- 修复 bug 时,在改动处留一行 `// 修复: <issue 描述>` 风格的注释。
- 标注性能 / 关键路径时,留 `// 性能:` 或 `// 关键路径:` 前缀。

#### 2.5 区域分隔注释

模块内功能分段时使用:

```typescript
// ==================== 区域名 ====================
```

或轻量形式:

```typescript
// --- 区域名 ---
```

#### 2.6 TODO / FIXME 形态

```typescript
// TODO(<作者简写>): <待办内容,具体到行或函数>
// FIXME(<作者简写>): <已知问题与影响范围>
```

#### 2.7 测试用例描述形态

```typescript
it('addSearchResults - 空数组 - 不抛错', () => { ... });
it('SearchVault 工具 - 嵌入失败 - 返回空结果', () => { ... });
```

### 4. 需加注释的代码判定准则

不是所有代码都需要加注释。注释的目的是**降低理解成本**,不是凑数。下列判定准则决定一段代码是否要写注释、写在哪、写多少。

#### 4.1 必须加注释(强制)

| 类型 | 例子 | 注释重点 |
|------|------|----------|
| 关键路径 / 性能敏感 | 缓存读写、并发序列化、热点循环 | `// 关键路径:` 标注,说明为什么这样写 |
| 非显然的算法判断 | lastIndexOf 回退、四级边界切分、Math.max 防负数 | 解释为什么选这条分支 |
| 端口契约约束 | `_filter` 用 `_` 前缀保留满足接口、void 抑制 lint | 标注 `// 关键路径:` 说明保留原因 |
| 修复历史 | try/catch 静默吞错、JSON 损坏降级、文件不存在 skip | `// 修复:` 写明 issue 与影响 |
| 副作用 / 状态变更 | releaseLock、release observer、clearTimeout | 标注 `// 关键路径:` 防止误删 |
| 跨线程 / 跨进程通信 | Worker postMessage、requestId 关联、超时清理 | 说明协议字段(`_requestId`)的语义 |

#### 4.2 推荐加注释(看复杂度)

- 复杂表达式(单行 ≥ 3 个运算符)用 1 行说明业务意图。
- 类型断言 / `as unknown as` 用 1 行说明为什么要绕过类型系统。
- 正则表达式用注释拆解每个子模式。
- 魔法数字(超时、阈值、overlap 等)用常量 + 注释解释取值依据。

#### 4.3 不要加注释(避免噪声)

- 显而易见的 CRUD / getter / setter。
- 类型签名已自解释的代码。
- 单元测试的 happy path(测试名已说清)。
- TODO / FIXME 必须留,其他不要为"还没写"加占位注释。

#### 4.4 注释密度经验值

- 关键逻辑文件(如 `agent-loop.ts`、`persistence-json.ts`):注释行数 ≥ 代码行数的 30%。
- 普通业务文件:15%-25%。
- 纯类型文件(`types.ts`、ports/):类型定义即文档,鼓励多写 JSDoc。

#### 4.5 注释语言一致性

- 同一文件内**不要**中英混杂:一段注释要么全中文,要么全英文。
- 修复历史类(`// 修复:` / `// 关键路径:`)前缀用中文,便于工具识别。

### 3. 文档(`.md`)形态

- 每个 `docs/superpowers/specs/*.md` 必须包含:背景、目标、非目标、详细设计、影响面、参考。
- 每个 `docs/superpowers/plans/*.md` 必须包含:目标、架构、技术栈、文件结构、任务清单(每个 task 含 file/step/code/verification)、自审。
- 章节层级 ≤ 3 级;超过 3 级请拆分文件。

## Superpowers(工程方法论)

本项目使用 [Superpowers](https://github.com/obra/superpowers) 技能约束工程纪律。技能源在 `.superpowers/`。

### 工作流(mandatory)

1. **brainstorming** — 写代码前,先搞清楚到底要建什么。要提问,分节呈现设计。
2. **writing-plans** — 把工作拆成 2-5 分钟的咬合任务。每个任务必须包含:精确文件路径、完整代码、验证步骤。
3. **test-driven-development** — RED-GREEN-REFACTOR:写失败测试 → 看它失败 → 写最小代码 → 看它通过 → 提交。
4. **subagent-driven-development** — 每个任务派遣全新的 subagent,两阶段审查(规范合规,再代码质量)。
5. **requesting-code-review** — 对照计划审查,按严重程度报告问题。Critical 阻塞进度。
6. **systematic-debugging** — 四阶段根因排查流程。禁止瞎猜。
7. **verification-before-completion** — 真正验证通过再宣布完成。

### 关键规则

- **用户指令优先于技能** — AGENTS.md 说"不用 TDD",技能说"必须 TDD",以用户为准。
- **任何动作前先看技能** — 即使只有 1% 的可能性,也要先读技能。
- **技能是强制工作流,不是建议** — 一旦触发,必须按它走。

### Spec & Plan 生命周期(mandatory)

每次 brainstorming、spec、plan 都要登记。这是硬规矩 — 不登记就找不到。

**唯一注册表:** [`docs/superpowers/STATUS.md`](docs/superpowers/STATUS.md) 是本项目所有 spec 与 plan 的唯一事实源。

**更新规则:**

1. **brainstorming** 技能结束 → 在 `docs/superpowers/specs/` 下新建 spec **并** 在 `STATUS.md` 登记(状态:Active)。
2. **writing-plans** 技能结束 → 在 `docs/superpowers/plans/` 下新建 plan **并** 在 `STATUS.md` 登记(状态:Pending),关联到它实现的 spec。
3. **executing-plans** 或 **subagent-driven-development** 启动 → 在 `STATUS.md` 更新为状态:In Progress,记录分支名。
4. plan 执行完成 → 在 `STATUS.md` 更新为状态:Completed,记录合并 commit / 分支。
5. spec/plan 废弃或被取代 → 移到 "Superseded / Archived" 区,并写明原因。

**提交规范:** STATUS.md 永远与被追踪的文件在同一次提交中更新。绝不让注册表落后于现实。

**Spec vs Plan 区分:**

- **Spec** = 要建什么(设计、架构、需求)。放在 `specs/`。
- **Plan** = 怎么建(任务、文件、测试)。放在 `plans/`。
- 一个 spec 可以有多个 plan(例如:一个实现 plan,一个独立的测试 plan)。

### 文档归档流程(mandatory)

实施完成的 spec / plan 不再留在 `specs/` / `plans/` 根目录,统一移到 `docs/superpowers/archive/<spec-id>/`,作为历史档案保留。

**触发条件(全部满足):**

1. 对应 plan 状态变为 `Completed`(所有任务完成、测试通过、分支 squash 合并到 main)
2. worktree / 分支已清理
3. 状态记录已写入执行日志

**询问机制:** plan 完成后,**执行者主动询问**「是否归档?」(不是自动归档)。归档是**手动操作**,不是 npm 脚本。

**归档结构(按 spec 分文件夹):**

```
docs/superpowers/archive/
├── S-XXX-001/
│   ├── <日期-slug>-<spec 文件原名>.md        # spec 本身
│   ├── <日期-slug>-<plan 文件原名>.md         # 该 spec 关联的所有 plan
│   ├── ...                                    # 多个 plan 文件可放一起
│   └── execution-log.md                       # 该 spec 的所有 plan 执行日志(按时间倒序)
├── S-YYY-002/
│   └── ...
└── P-DOCS-CN/                                 # 无 spec 的杂项 plan,直接用 plan-id
    └── execution-log.md
```

- **文件夹名** = `spec-id`(例:`S-ARCH-001`、`S-TEST-ARCH`)
- **无 spec 的 plan**(杂项) = 用 `plan-id` 命名(例:`P-DOCS-CN`)
- **execution-log.md** = 该文件夹下所有 plan 的执行日志**合并**,按时间倒序(最新在前)
- **保留原文件名**,不重命名(便于 git 历史追溯)

**归档操作(完整流程):**

```bash
# 1. 建文件夹
mkdir -p docs/superpowers/archive/<spec-id>   # 或 P-XXX-YY 杂项

# 2. git mv spec 文件(若有)
git mv docs/superpowers/specs/<spec>.md docs/superpowers/archive/<spec-id>/

# 3. git mv plan 文件
git mv docs/superpowers/plans/<plan>.md docs/superpowers/archive/<spec-id>/

# 4. 写 execution-log.md(必做,即使无详细日志也建空文件,记录"归档时未写日志,详见 git log")
#    - 多个 plan 的日志合并到一份
#    - 按时间倒序(最新在前)
#    - 标题格式: ## YYYY-MM-DD — <PLAN-ID>(<简短描述>)

# 5. 更新 STATUS.md「已归档」区(极简)
#    - 加 1 行:<id> | archive/<id>/ | YYYY-MM-DD
#    - **不**列「含文件」「备注」等可从子目录推出来的信息
#    - 主表**移除**该 spec / plan 行(归档的不再列在主表)
```

**STATUS.md 主表移除原则:**

- 归档的 spec / plan **不**保留在主表
- 主表只显示**当前 active / pending / in_progress** 的项
- 历史归档通过「已取代 / 归档」区的汇总行 + `archive/` 文件夹追溯
- 原因:主表要简洁,完成细节(包括执行日志)都下沉到 `archive/<id>/execution-log.md`

**execution-log.md 形态:**

```markdown
# <SPEC-ID> — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## YYYY-MM-DD — <PLAN-ID>(<简短描述>)

| Task / Group | 文件 | 状态 | Commit | 备注 |
| ... |

**测试总数:** ...
**分支:** ...
**Plan 偏差:** ...

---

## YYYY-MM-DD — <上一条 PLAN-ID>

...
```

**与 `Superseded` 的区别:**

- `Superseded` = 被新版本取代(如 S-RAG-ROADMAP → S-RAG-ARCH),写到「已取代 / 归档」区,链接替代者
- `Archived` = 实施完成、不是被取代,而是「开发指导已落地,转历史档案」

**归档后:**

- 主表不再出现该 spec / plan
- 「已取代 / 归档」区有汇总行指向 `archive/<id>/`
- `archive/<id>/execution-log.md` 包含完整执行历史(commit SHA / 偏差 / 测试数据)
- 后续若该 spec 衍生了 v2(例:新决策),开新 spec `S-XXX-XXX-v2`,旧 spec 保持 Archived 状态,新 spec 状态 `Active`

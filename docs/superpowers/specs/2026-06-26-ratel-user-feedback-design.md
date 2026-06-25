# S-FEEDBACK — 用户反馈与开发者日志分离设计

> **状态:** Active
> **创建日期:** 2026-06-26
> **作者:** brainstorming (与用户协作)
> **关联:** S-I18N(Draft,后续接入文案 key)、S-DIAG(诊断页承接 error 详情)
> **优先级:** High

---

## 背景

Ratel Vault 当前用户可见反馈分散且不一致:

- `main.ts` 手写 `new Notice` + `ref.notice` 管理模型下载/索引进度,逻辑臃肿
- `ModelManager.status$`、`IndexManager.status$` 已有状态机,但只有模型下载接了 Notice
- `IndexBanner.svelte` 已实现但未挂载到 Chat 侧栏
- 大量运行时错误仅 `console.error`,用户无感知
- 诊断页 `diag-utils.formatError` 有结构化错误,但与主流程脱节

用户诉求:

1. 插件**关键状态**应对使用者有清晰提示(持久状态条 + 里程碑 Notice)
2. **开发者日志**与**用户反馈**严格分离,工具按目的拆分,互不混用
3. `main.ts` 只做接线,业务逻辑放入独立控制器

## 目标

### 目标一:三模块用户/开发者通道分离

| 模块 | 路径 | 面向 | 职责 |
|------|------|------|------|
| `DevLogger` | `src/logging/dev-logger.ts` | 开发者 | `debug/info/warn/error` → `console` |
| `UserNotice` | `src/user-feedback/user-notice.ts` | 使用者 | Obsidian `Notice`(一次性 toast / 长任务进度) |
| `UserStatus` | `src/user-feedback/user-status.ts` | 使用者 | `statusBar$` 持久状态 store |

### 目标二:FeedbackController 集中接线

- 新建 `src/core/feedback-controller.ts`
- 订阅 `ModelManager.status$`、`IndexManager.status$` 等,翻译为 `UserStatus` 字段
- 在里程碑事件调用 `UserNotice`(下载完成、全量索引失败、Worker 降级等)
- `main.ts` 仅:构造 `FeedbackController` → `start()` → `onunload` 时 `destroy()`

### 目标三:Chat 侧栏持久状态条

- 新建 `src/ui/StatusBar.svelte`,订阅 `statusBar$`
- 挂载到 `ChatView`(侧栏顶部)
- 吸收/替代未挂载的 `IndexBanner.svelte`(避免双 banner)
- 全绿时收成一行摘要(如 `模型就绪 · 索引 128 篇`),非 ready 或 `degraded` 时展开详情

### 目标四:v1 覆盖全链路关键状态(D 档)

- 启动:模型下载/初始化、全量索引、失败
- 运行时索引:队列积压、处理中、暂停、单文件失败(状态条)、全量失败(Notice)
- Agent:索引未就绪 — StatusBar 黄点提示 + **软拦**(见 § Chat);`search_vault` 在工具行失败,不弹 Notice
- 配置:API 模式无自动索引、缺 Key(打开相关流程时 Notice 一次)
- 基础设施:InlineWorker 降级(Notice 一次 + 状态条 `worker: inline`)

## 非目标

- 不把 `DevLogger` 输出同步到 Notice(用户已明确拒绝混用)
- v1 不实现 `S-I18N` 全文案切换(先中文硬编码,API 预留 `key + params` 形状)
- 不做日志文件落盘 / 远程遥测
- 不改造诊断页 `formatError`(保持独立;失败 Notice 可引导用户去诊断 Tab)
- 不在 v1 用 ESLint 规则强制 ban `new Notice`(代码审查 + 迁移完成后二期加 rule)

---

## 详细设计

### 架构

```
main.ts
  ├─ new DevLogger()          (可选:挂 plugin.devLogger 供全局 import 单例)
  ├─ new FeedbackController(deps)
  │     ├─ subscribe modelManager.status$
  │     ├─ subscribe indexManager.status$
  │     ├─ watch embedding.isReady / workerMode / settings
  │     ├─ → userStatus.patch(...)
  │     └─ → userNotice.toast* / toastProgress*(里程碑)
  └─ feedbackController.start()

ChatView.svelte
  ├─ <StatusBar status$={userStatus.statusBar$} />
  └─ ChatErrorPresenter — 消费 AgentEvent.error,会话内结构化展示

业务模块 (index-processor, hooks, vectra, …)
  └─ devLogger.error('module', msg, data)   // 仅开发者

Worker 线程
  └─ devLogger.*  // 仅 console,用户提示由主线程 FeedbackController 转发
```

### 硬规矩(不可妥协)

1. 业务代码**禁止** `new Notice(...)`,只能 `userNotice.*`
2. 业务代码**禁止**裸 `console.*`( `dev-logger.ts` 内部实现除外),只能 `devLogger.*`
3. `src/logging/*` 与 `src/user-feedback/*` **禁止互相 import**
4. `UserNotice` / `UserStatus` **禁止**写 `console`
5. `DevLogger` **禁止**调 Notice、禁止写 `statusBar$`
6. Worker 内不 import `user-feedback/*`

6. Worker 内不 import `user-feedback/*`
7. **`agent-loop` / `ChatView` 轮次错误禁止 `userNotice.*`** — 对话异常只在 Chat 内展示(见 § Chat)

### § Chat 对话异常分流

Chat 是用户反馈的**第三界面**(与 StatusBar、Notice 并列),专责**与会话轮次绑定**的异常。`FeedbackController` **不处理**轮次错误。

#### 三种界面分工

| 界面 | 职责 | Chat 对话异常是否使用 |
|------|------|----------------------|
| **StatusBar** | 插件整体就绪态(模型/索引/Embedding/降级) | 仅作背景提示,不替代错误详情 |
| **Chat 内 UI** | 本轮用户消息 → 助手回复 / 工具调用中的异常 | **主通道** |
| **UserNotice** | 用户可能没在看 Chat 的全局里程碑 | **禁止**用于轮次错误 |

#### 发送门禁策略(已决策:B 软拦)

| 条件 | 策略 | UI 行为 |
|------|------|---------|
| **索引未就绪 / Embedding 加载中 / 索引为空** | **软拦(B)** | Send **可用**;StatusBar 黄点 + 输入区上方轻提示「检索暂不可用,纯对话仍可继续」;`search_vault` 失败在**工具行**展示 |
| **Chat API Key 缺失** | **硬拦** | Send 禁用 + 行内提示「请配置 Chat API Key」;与 B 不冲突(无 LLM 则无法对话) |
| **Embedding 本地模式加载失败** | **软拦(B)** | 同索引未就绪;纯 LLM 可继续,检索类工具在工具行失败 |
| **LLM 服务不可用** | 不拦发送 | 发出后由 `LLM_ERROR` 在 Chat 内展示 |

**选 B 的理由:**
- Ratel 兼具「问 vault」与「纯聊天」;硬拦会在索引构建期间完全封死侧栏,体验差
- 检索失败是**可预期的局部降级**,应在工具调用上下文说明,而非全局 Notice
- StatusBar 已持续告知就绪态,无需再用 Notice 重复

#### Chat 内错误展示(按 `AgentEvent.error.code`)

| code | 展示位置 | 样式 |
|------|----------|------|
| `CANCELLED` | 当前 assistant 气泡底部 | 灰色轻提示「已停止生成」,非错误块 |
| `LLM_ERROR` | 当前 assistant 气泡内 | 结构化错误块(类型 + 说明 + 可折叠详情);保留已流式文本 |
| `TOOL_ERROR` | 对应 **工具行** `failed` 态 | 工具名 + ✗ + 简短原因;可选 assistant 底部摘要 |
| `INDEX_NOT_READY` 等检索前置失败 | 工具行 `failed` | 说明「索引未就绪,请稍候或前往诊断页」 |

工具调用状态扩展为三态:`calling` | `done` | `failed`。

#### 禁止用 Notice 的 Chat 场景

- LLM 流中断、工具失败、用户取消、search 无结果/失败
- **原则:**用户正在看 Chat 时,错误必须留在消息流内

#### 仍用 Notice 的场景(与 Chat 无关)

- 后台全量索引失败、模型下载完成、Worker 降级(用户可能未打开 Chat)

#### ChatErrorPresenter(新建)

路径:`src/ui/chat-error.ts`(或 `src/user-feedback/chat-error.ts` — 仅 UI 渲染,不写 console)

- 输入:`AgentEvent` 的 `error` payload + 可选 `Error` 对象
- 输出:供 `ChatView` 挂载的 DOM 结构(`.ratel-chat-error-*` 前缀)
- 复用 `diag-utils.formatError` 的**分类启发式**(config/network/model),但不 import `renderError` DOM 逻辑(样式独立)
- `DevLogger.error('agent', ...)` 由 `agent-loop` / 工具层调用,与 Presenter 并行

#### agent-loop 约定

- 工具失败继续 yield `error` 事件(供 Chat UI) + 把 `Error: msg` 给 LLM(供自我修正) — 保持现有双通道
- 新增/规范 error code:`CANCELLED` | `LLM_ERROR` | `TOOL_ERROR` | `INDEX_NOT_READY`(检索类工具可抛)

### DevLogger API

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogModule = 'index' | 'model' | 'worker' | 'agent' | 'vectra' | 'hooks' | 'vault' | 'main';

interface DevLoggerOptions {
  /** 默认 false;true 时输出 debug 级 */
  debugEnabled?: boolean;
}

class DevLogger {
  debug(module: LogModule, message: string, data?: unknown): void;
  info(module: LogModule, message: string, data?: unknown): void;
  warn(module: LogModule, message: string, data?: unknown): void;
  error(module: LogModule, message: string, data?: unknown): void;
}
```

输出格式:`[Ratel:<module>] <message>` + 可选结构化 `data`(仅 debug/info 附对象,warn/error 附 `Error` stack)。

`settings.debugLog`(新增 boolean,默认 false)控制 `debug` 级是否输出。

### UserNotice API

```typescript
class UserNotice {
  /** 普通 toast,默认 4000ms */
  toast(message: string, durationMs?: number): void;

  /** 失败 toast,默认 8000ms,样式偏警示 */
  toastError(message: string, durationMs?: number): void;

  /**
   * 长任务进度 — 返回句柄,调用方负责 update/hide。
   * 用于模型下载、全量索引等。
   */
  toastProgress(initialMessage: string): {
    update(message: string): void;
    hide(): void;
  };
}
```

v1 文案中文硬编码;方法签名预留后续 `toast(key: NoticeKey, params?: Record<string, string>)` 重载。

### UserStatus API

```typescript
interface UserStatusSnapshot {
  model: 'idle' | 'checking' | 'downloading' | 'initializing' | 'ready' | 'failed';
  modelDetail?: string;

  index: 'idle' | 'init' | 'scanning' | 'queueing' | 'processing' | 'ready' | 'paused' | 'failed';
  indexDetail?: string;
  indexDocCount?: number;

  embedding: 'loading' | 'ready' | 'unavailable';
  worker: 'thread' | 'inline';

  /** 降级说明,有人话一行;存在时状态条展开 */
  degraded?: string;
}

class UserStatus {
  readonly statusBar$ = writable<UserStatusSnapshot>({ ...defaults });

  /** 浅合并 patch,供 FeedbackController 增量更新 */
  patch(partial: Partial<UserStatusSnapshot>): void;

  /** 插件卸载时重置 */
  reset(): void;
}
```

### FeedbackController

```typescript
interface FeedbackControllerDeps {
  modelManager: ModelManager;
  indexManager: IndexManager;
  userNotice: UserNotice;
  userStatus: UserStatus;
  getEmbeddingReady: () => boolean;
  getWorkerMode: () => 'thread' | 'inline';
  getSettings: () => Pick<RatelSettings, 'embedProvider' | 'embedApiKey' | 'chatApiKey'>;
}

class FeedbackController {
  start(): void;    // 注册 status$ 订阅 + 一次性检查(Worker 降级、API 模式)
  destroy(): void;  // 退订 + hide 进行中的 progress notice
}
```

**职责清单:**

| 输入 | UserStatus 更新 | UserNotice 触发 |
|------|----------------|-----------------|
| `ModelManager` Downloading | `model=downloading`, `modelDetail=67%` | `toastProgress` 更新 |
| `ModelManager` Ready | `model=ready` | progress hide |
| `ModelManager` Failed | `model=failed`, detail=reason | `toastError` |
| `IndexManager` Queueing/Processing | `index=queueing/processing`, detail | 不弹(防吵) |
| `IndexManager` Ready | `index=ready`, docCount | 仅**全量索引完成**时 `toast`(由 controller 区分首次 full vs 增量) |
| `IndexManager` Failed | `index=failed` | `toastError` |
| `IndexManager` Paused | `index=paused` | 不弹 |
| 启动检测到 InlineWorker | `worker=inline` | `toast` 一次 |
| `embedProvider=api` 且无自动索引 | `degraded=...` | `toast` 一次 |
| `embedding` 未就绪 | `embedding=loading` | 不弹(模型进度已覆盖) |

`main.ts` 中现有 `onLayoutReady` 内 Notice 逻辑**整体迁入** `FeedbackController`,`onLayoutReady` 只保留模型下载与 `indexController.onLayoutReady()` 调用。

### StatusBar UI

- 位置:`ChatView.svelte` 顶部,消息列表之上
- 样式:`.ratel-status-bar`,与 `.diag-*` 一样用前缀避免污染
- 状态色:绿(ready)、黄(processing/degraded)、红(failed)
- 全绿:单行 `模型就绪 · 索引 N 篇 · Embedding 就绪`
- 非绿:多行展示 `modelDetail` / `indexDetail` / `degraded`
- 点击(可选 v1.1):跳转设置 → 诊断测试 Tab

`IndexBanner.svelte` 在 StatusBar 落地后删除或标记 deprecated 并移除文件(实施 plan 中二选一,推荐删除避免死代码)。

### 用户 vs 开发者分流表

| 场景 | 使用者 | 开发者 |
|------|--------|--------|
| 模型下载进度 | UserNotice progress + UserStatus | `devLogger.info('model', ...)` |
| 全量索引完成 | UserNotice toast + UserStatus | `devLogger.info('index', ...)` |
| 单文件增量失败 | UserStatus 黄点(可选 detail) | `devLogger.error('index', path, err)` |
| Vectra 内部降级 | 不展示 | `devLogger.error('vectra', ...)` |
| Hook 失败 | 不展示 | `devLogger.error('hooks', ...)` |
| 搜索索引未就绪 | StatusBar 黄点 + Chat 工具行 failed(软拦 B) | `devLogger.warn('agent', ...)` |
| ratelignore 解析失败 | 不展示 | `devLogger.warn('vault', ...)` |
| Worker 消息 debug | 不展示 | `devLogger.debug('worker', ...)` |

### 与现有模块关系

| 模块 | 变更 |
|------|------|
| `main.ts` | 删除内联 Notice;构造并 `start/stop` FeedbackController |
| `IndexBanner.svelte` | 由 StatusBar 替代 |
| `ChatView.svelte` | 挂载 StatusBar;接入 ChatErrorPresenter;工具行三态;软拦提示条 |
| `src/ui/chat-error.ts` | 新建 — Chat 内结构化错误渲染 |
| `agent-loop.ts` / `search-vault.ts` | 规范 error code;检索未就绪返回 `INDEX_NOT_READY` |
| `settings.ts` | 新增 `debugLog` toggle(开发者选项区) |
| `hooks.ts` / `index-processor.ts` / `vector-vectra.ts` 等 | `console.*` → `devLogger.*` |
| `S-I18N` | 后续把 UserNotice 文案迁到 `Strings` 表,DevLogger 保持英文/中文开发者消息均可 |

### 错误处理

- `UserNotice.toastError` 文案面向用户:简短 + 可行动(如「请打开设置 → 诊断测试」)
- `DevLogger.error` 保留完整 stack 与上下文对象
- FeedbackController 订阅回调内 try/catch,自身失败只 `devLogger.error`,不抛给用户

---

## 影响面

| 路径 | 操作 |
|------|------|
| `src/logging/dev-logger.ts` | 新建 |
| `src/user-feedback/user-notice.ts` | 新建 |
| `src/user-feedback/user-status.ts` | 新建 |
| `src/core/feedback-controller.ts` | 新建 |
| `src/ui/StatusBar.svelte` | 新建 |
| `src/ui/chat-error.ts` | 新建 |
| `src/ui/ChatView.svelte` | 修改 — StatusBar + Chat 异常 UI + 软拦提示 |
| `src/main.ts` | 修改 — 瘦身,接线 FeedbackController |
| `src/settings.ts` | 修改 — `debugLog` 开关 |
| `src/ui/IndexBanner.svelte` | 删除(或 deprecated) |
| 多处 `console.*` | 迁移至 DevLogger |

---

## 验收标准

- [ ] 存在 `dev-logger`、`user-notice`、`user-status` 三模块,且互相无 import
- [ ] `FeedbackController` 承接全部 `status$` → 用户反馈翻译,`main.ts` 无 Notice 业务逻辑
- [ ] Chat 侧栏顶部 StatusBar 实时显示模型/索引/embedding/worker 状态
- [ ] 全绿时状态条收成一行;失败/降级时展开
- [ ] 启动链路:下载、全量索引、Worker 降级、API 无自动索引 — 用户可感知
- [ ] 运行时增量索引:状态条更新,不频繁弹 Notice
- [ ] 业务代码中无新增裸 `console.*` / `new Notice`(迁移范围内)
- [ ] `settings.debugLog` 控制 debug 级日志
- [ ] `npm run build` 成功
- [ ] `npm test` 全通过;新增 `dev-logger` / `user-status` / `feedback-controller` 单测
- [ ] Chat 软拦(B):索引未就绪时可发送,`search_vault` 在工具行 failed,不弹 Notice
- [ ] Chat API Key 缺失时 Send 硬拦
- [ ] `LLM_ERROR` / `TOOL_ERROR` / `CANCELLED` 在 Chat 内分样式展示,非纯文本拼接
- [ ] 工具调用支持 `calling` | `done` | `failed` 三态
- [ ] `agent-loop` / `ChatView` 无 `userNotice` 调用

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Notice 过多打扰用户 | 里程碑才 toast;增量只更状态条 |
| FeedbackController 与 onLayoutReady 时序竞争 | `start()` 在 `onload` 末尾调用;progress notice 由 controller 独占管理 |
| Worker 内无法 UserNotice | 主线程监听 Worker 事件/状态机转发 |
| Chat 软拦时用户困惑「为什么不能搜」 | StatusBar 黄点 + 输入区轻提示;工具行 failed 给可行动文案 |
| 与 S-I18N 重复劳动 | v1 中文硬编码 + API 预留 key;I18N plan 只改 user-notice 文案层 |

---

## 参考

- `src/main.ts` — 当前 Notice 散落点
- `src/ui/IndexBanner.svelte` — 未挂载的状态条原型
- `src/core/model-manager.ts` / `index-manager.ts` — status$ 状态机
- `docs/superpowers/specs/2026-06-14-ratel-i18n-design.md` — 后续文案接入
- `docs/superpowers/specs/2026-06-25-diagnostics-page-design.md` — 错误详情承接
- AGENTS.md § 错误消息 — 用户消息 vs 开发者 console 约定

# S-RENDER-STABILITY — 渲染进程稳定性：崩溃面包屑与发送路径内存纪律

> 日期: 2026-09-15
> 状态: Active
> Spec ID: **S-RENDER-STABILITY**
> 关联: [ADR-006](../../adr/) 构建产物约束（embedding worker 内联）、[S-CTX-TRIM](../archive/S-CTX-TRIM/)（上送预算）、[S-COMPACT-V2](../archive/S-COMPACT-V2/)（自动压缩）、[S-SR-LAYERING](../archive/S-SR-LAYERING/)（记忆主题自动注入）

---

## 1. 背景

近一周内 Obsidian 整窗白屏 4–5 次，macOS 诊断报告一致：`Obsidian Helper (Renderer)` 主线程 `EXC_BREAKPOINT / SIGTRAP`，V8 在跑 microtask 时致命断点；进程连续运行 17 小时至 3 天半；Chromium Memory Tag 253 虚占 30–48 GB、region 上万。最近一次用户按下发送的瞬间白屏。

Ratel 现有日志只有 `devLogger` → 渲染进程 `console`。渲染进程一死，Console、插件 JS 状态一起消失；`obsidian.log` 不含插件输出。**没有任何机制能证明崩在哪一段。**

对发送路径逐段审查后，以下几处是老代码且与「累积内存 + 发送瞬时峰值」形态吻合：

| 位置 | 现状 |
|---|---|
| `ChatView.sendMessage` 预发送压缩判断 | `plugin.createContext()` + `preCtx.load()`，整份 session JSON 解析一遍 |
| `main.ask` | 再 `new ContextManager`；`agentLoop` 内 `ctx.load()` **第三次**解析同一 session |
| `main.ask` 记忆主题自动注入 | 每句都 `embedding.embed([message])`，本地模式即每句一次 ONNX 推理；ORT WASM 线性内存只涨不缩，Worker 自插件加载起常驻 |
| `EmbeddingWorkerProxy` | `error` 事件只 reject 挂起请求，Worker 不重建；仅切 provider 时 `terminate` |
| `VectorVectra` | `index.json`（实测 32 MB）解析后常驻主线程堆 |

本 spec 先解决「崩了留下证据」和「发送路径不做重复大分配」两件事。vectra 常驻、会话窗口、动效审计放到后续分期，等面包屑数据出来再定。

## 2. 目标

1. **崩溃面包屑**：发送/回合各阶段写入磁盘追加日志，渲染进程被杀后仍可读；`onload` 检测上次异常退出并在诊断页展示最后阶段。
2. **内存采样**：面包屑每行附带 `process.memoryUsage()` 的 rss / heapUsed / external，能区分 JS 堆增长与 WASM/ArrayBuffer 增长。
3. **发送路径单次加载**：一次发送对同一 session 只解析一次 JSON。
4. **Embedding Worker 生命周期**：空闲回收、崩溃自动重建；记忆索引为空时不做自动注入 embed。
5. 以上全部本地、不出网、不写正文；默认开启，可在「开发者」区关闭面包屑。

## 3. 非目标

- 不修改 Obsidian / Electron；不尝试捕获渲染进程崩溃本身（不可能）。
- 不把 Console 全量镜像到磁盘；不记录消息正文、笔记路径、密钥。
- 不新增遥测或任何出站通道。
- 不改 vectra 存储格式、不做会话分片、不改动效实现（后续分期，见 §7）。
- 不改 `AgentEvent` 判别联合、消息持久化结构。
- 不改重试策略、压缩策略、上送预算。

## 4. 详细设计

### 4.1 面包屑（`src/logging/breadcrumbs.ts`）

**文件位置**：`<pluginDir>/diag/breadcrumbs.log`，追加写；超过 256 KB 轮转为 `breadcrumbs.1.log`（只保留 1 份旧文件）。`<pluginDir>/diag/last-alive.json` 心跳文件，整文件覆盖。

**写入方式**：`fs.appendFileSync`（同步，几十字节；异步写在崩前可能丢）。任何 IO 异常静默吞掉，不影响主流程。

**行格式**（单行、`|` 分隔、无正文）：

```
<isoTime>|<phase>|<sessionShort>|<n>|<rssMB>|<heapMB>|<externalMB>
```

- `sessionShort`：session id 末 6 位。
- `n`：该阶段的计数上下文（消息条数 / embed 文本数 / step），无则 `-`。
- 内存三项取 `process.memoryUsage()`，`process` 不可用时写 `-`。

**阶段 ID**（集中声明，`as const` 元组 + 类型推导，禁止散落字面量）：

```ts
export const BREADCRUMB_PHASES = [
  'plugin.load', 'plugin.unload', 'heartbeat',
  'send.enqueue', 'send.precheck', 'send.compact',
  'ask.begin', 'ask.embed.begin', 'ask.embed.end',
  'loop.load', 'loop.classify', 'llm.request', 'llm.first-delta',
  'loop.tool', 'ask.end', 'ask.error',
  'crash.suspect',
] as const;
export type BreadcrumbPhase = (typeof BREADCRUMB_PHASES)[number];
```

`ask.end` / `plugin.unload` 为**终态**；其余为进行中态。

**心跳**：插件加载后每 30 s 往 `breadcrumbs.log` 追加一行 `heartbeat`，并覆盖写 `last-alive.json`：`{ ts, lastPhase, sessionShort, rssMB, heapMB, externalMB, uptimeMs }`。`heartbeat` **不改**内存中的 `lastPhase`（刷新 `ts` / 内存采样即可）。若心跳也把 `lastPhase` 写成 `heartbeat`，空闲 30s 后正常退出或强杀都会被误判为 `crash.suspect`。非 `heartbeat` 的 `mark` 才更新 `lastPhase`。`onunload` 写终态并停止心跳。

**异常退出检测**（`onload`）：读 `last-alive.json`；若 `lastPhase` 非终态，写一行 `crash.suspect|<lastPhase>` 到面包屑，并把结果放进 `plugin.diagnostics`（诊断页现有「复制诊断摘要」一并带出最近 40 行面包屑）。诊断页新增一段「上次运行」：显示上次最后阶段、距心跳多久、当时内存。i18n key：`diag.lastRun.*`。

**开关**：`settings.crashBreadcrumbs: boolean`，默认 `true`，放「开发者」分组；不进 `ratel-config` 白名单。关闭时不写文件、不跑心跳，但 `onload` 仍读取历史文件做检测。

### 4.2 内存阈值提示

常量（代码注释写取值依据，不进设置页）：`MEMORY_WARN_RSS_MB = 4096`、`MEMORY_WARN_EXTERNAL_MB = 1536`。心跳采样超阈值时，每个插件生命周期**只提示一次**：诊断页顶部横幅 + 状态条一次性 Notice（i18n `diag.memoryHigh`），建议重启 Obsidian。不自动做任何回收动作。

### 4.3 发送路径单次加载

- `plugin.ask(...)` 的 `opts` 新增可选 `preloadedContext?: ContextManager`。ChatView 预发送判断建的 `preCtx` 原样传入；`ask` 内若 `preloadedContext.sessionId === sessionId` 则直接使用，不再 `new ContextManager`，但仍执行 goal anchor / env / skills / memory 注入（这些是 setter，对已加载 session 幂等）。
- `ContextManager.load(id)`：若 `this.session` 已存在且 id 相同，直接返回（幂等）。`agentLoop` 保持调用 `ctx.load`，自然变成 no-op。
- 压缩重试路径（`attempt > 0`）与 `compact.applied` 后的 rehydrate 不受影响：它们操作的是同一个 ctx 实例。
- 不跨发送缓存 ctx；一次发送结束即丢弃。

### 4.4 Embedding Worker 生命周期

`EmbeddingWorkerProxy` 改为惰性持有 Worker：

- 构造参数改为 `createDeps: () => Promise<WorkerInitDeps>`（`main.ts` 现有读模型/词表/wasm 的逻辑抽成工厂），不再在构造时 `new Worker`。
- `embed()` 前 `ensureWorker()`：无 Worker 则创建并 init。
- **空闲回收**：无挂起请求且距最后一次 `embed` 超过 `IDLE_TERMINATE_MS = 5 * 60_000`，`terminate()` 释放 WASM 线性内存；下次 `embed` 重建。索引批处理期间频繁调用不会触发。
- **崩溃重建**：`error` 事件 reject 挂起请求后置空 Worker；下次 `embed` 重建。连续 2 次 init 失败则进入 `dead` 态，`embed` 直接抛错（与现网行为一致），`devLogger.error` 一次。
- 写面包屑：Worker 创建/回收/崩溃各一行（`ask.embed.*` 之外单独的 `n` 标注即可，不新增 phase）。

### 4.5 记忆主题自动注入跳过

`main.ask` 中：`indexEntries.length === 0` 或 `memoryTopicsAutoInjectK <= 0` 或 embedding 未 ready 时，不调用 `embedding.embed`，`relatedTopics` 为空。现有 `globalContent.trim()` 判断保留。

### 4.6 测试

- `breadcrumbs.test.ts`：行格式；轮转（超 256 KB 生成 `.1.log` 且只保留一份）；IO 抛错不外泄；`process` 缺失写 `-`。
- 异常退出检测纯函数：`lastPhase` 终态 → 无；进行中态 → `crash.suspect`。
- `context-manager.test.ts`：`load` 同 id 二次调用不再触发 `persistence.sessions.get`。
- `ask` 传 `preloadedContext` 时 `persistence.sessions.get` 只被调用一次（现有 agent-loop 测试夹具可复用）。
- `embedding-worker-proxy.test.ts`：fake timers 下空闲 5 min 触发 `terminate`；`error` 后下一次 `embed` 重建；连续两次 init 失败进入 `dead`。
- 记忆索引为空时 `embedding.embed` 不被调用。

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `src/logging/breadcrumbs.ts`（新） | 面包屑写入、心跳、异常退出检测、阶段 ID 登记 |
| `src/main.ts` | 加载/卸载写终态；心跳；`ask` 接 `preloadedContext`；各阶段打点；embedding 依赖工厂 |
| `src/core/agent-loop.ts` | `loop.*` / `llm.*` 打点（通过注入的 `breadcrumb` 回调，不 import 文件系统） |
| `src/core/context-manager.ts` | `load` 幂等 |
| `src/adapters/embedding-worker-proxy.ts` | 惰性创建、空闲回收、崩溃重建 |
| `src/ui/chat/ChatView.svelte` | `send.*` 打点；`preCtx` 传入 `ask` |
| `src/ui/diagnostics/*` | 「上次运行」段；诊断摘要附最近 40 行面包屑；内存横幅 |
| `src/settings.ts` / i18n | `crashBreadcrumbs` 开关；`diag.lastRun.*`、`diag.memoryHigh`、设置文案 |
| `docs/architecture/` | **不改**（无新子系统目录、无端口契约变更；`logging/` 已存在） |
| README / user-guide | 隐私说明补一句：诊断文件仅存本地插件目录、不含正文；user-guide 诊断页说明 |
| 网络 / Worker 协议 / 持久化结构 | 无 |

## 6. 分期

- **分期 A（本 spec 首个 plan）**：§4.1 面包屑 + §4.2 阈值提示 + §4.5 跳过空索引 embed。改动最小、先取证。
- **分期 B**：§4.3 单次加载 + §4.4 Worker 生命周期。
- **分期 C（待面包屑数据，另开 spec 或本 spec 增订）**：vectra 索引空闲卸载 / `Float32Array` 存储；`messages` 内存窗口 + 上翻加载；WebGL/canvas 动效 context 数量与释放审计。

## 7. 参考

- 崩溃报告形态：`Obsidian Helper (Renderer)` `EXC_BREAKPOINT` / `SIGTRAP`，主线程 `CrRendererMain`，`v8::MicrotasksScope::PerformCheckpoint`；V8 `FatalProcessOutOfMemory` 走同一信号。
- 现网发送路径：`src/ui/chat/ChatView.svelte` `sendMessage`、`src/main.ts` `ask`、`src/core/agent-loop.ts`。
- 现网日志：`src/logging/dev-logger.ts`（仅 console）。

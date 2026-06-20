# ADR-002:Ratel Vault Worker 运行时策略

**状态**:Accepted
**日期**:2026-06-18
**更新**:2026-06-20 — 决策从"try/catch 降级"改为"Obsidian 环境直接使用 InlineWorker"

---

## Context(背景)

在 Obsidian 桌面版加载 Ratel Vault 时,插件在 `main.ts:onload` 中调用 `new Worker(workerPath, { workerData: ... })` 启动索引 Worker,控制台直接抛出:

```
app.js:1 Plugin failure: ratel-vault Error: The V8 platform used by this instance of Node does not support creating Workers
    at new Worker (node:internal/worker:213:21)
    at O1.onload (plugin:ratel-vault:3709:599)
```

插件加载失败,所有依赖 Worker 的功能(索引、向量检索)全部不可用。

### 根因(三层)

- **L1 环境**:Obsidian 桌面版是 Electron 应用,社区插件 `main.js` 运行在**渲染进程**(Renderer Process)
- **L2 平台限制**:渲染进程的 V8 平台禁用了 Node.js `worker_threads` 的 Worker 创建,`require('worker_threads')` 存在,但 `new Worker()` 会抛上述错误
- **L3 代码假设**:Ratel Vault 设计时假设 Worker Threads 可用,`src/main.ts:97` 直接 `new Worker()` 且无降级路径

### 关键环境事实

| 能力 | 状态 | 说明 |
|---|---|---|
| Node.js `fs` / `path` | ✅ 可用 | 渲染进程保留部分 Node API,大量 Obsidian 插件依赖 |
| `worker_threads` | ❌ 不可用 | V8 平台级限制,不是"偶尔失败",是**永远不可用** |
| Web Worker(无 Node 集成) | ⚠️ 可创建 | 但 vectra 需要 `fs`,无 Node 集成就无法运行 |
| Web Worker + Node 集成 | ❌ 不可用 | 需要 Electron `webPreferences.nodeIntegrationInWorker: true`,Obsidian 不会为第三方插件开启 |
| `child_process.fork` | ❓ 不确定 | 渲染进程可能受沙箱限制,且跨平台 Node 可执行文件位置复杂 |

### 调研覆盖

- Electron 官方文档 [Multithreading](https://www.electronjs.org/docs/latest/tutorial/multithreading):确认 `nodeIntegrationInWorker` 是 BrowserWindow 级开关,第三方插件无法控制
- Obsidian `manifest.json` 语义:`isDesktopOnly: true` 仅表示插件使用 NodeJS/Electron API,不代表 Worker Threads 可用
- 社区经验:Obsidian 社区插件中无成熟使用 `worker_threads` 的先例;重索引类插件普遍在主线程执行或用外部服务
- 错误堆栈:直接指向 `node:internal/worker:213:21`,确认是 V8 平台级限制,非路径/参数问题

---

## Decision(决策)

**采用方案 A:InlineWorker(主线程内 Worker 模拟),Obsidian 环境下直接使用,不做 try/catch 降级。**

原决策(2026-06-18)是"先尝试 Worker Threads,失败再降级 InlineWorker"。经分析,Worker Threads 在 Obsidian 渲染进程中**永远不可用**,try/catch 分支是死代码。改为直接创建 InlineWorker。

`InlineWorker` 复用 `main.ts` 已创建的 `VectraStore` 实例,避免主线程与 Worker 各持一个 `VectraStore` 写同一个 `indexDir`。

### 决策变更理由

1. **Worker Threads 在 Obsidian 渲染进程中是硬限制**,不是"偶尔失败"或"将来会修复"的问题——Electron 架构决定了渲染进程 V8 不支持创建 Worker
2. **try/catch 降级是误导性代码**:每次运行都走 catch 分支,try 分支永远不执行,增加阅读负担
3. **`import { Worker } from 'worker_threads'` 在渲染进程中无意义**:esbuild 标 external 后运行时 require 不到;不标 external 则打包时触发 `.node` loader 错误
4. **保留 `worker.js` 产物**:作为独立产物,如果将来有非 Obsidian 环境(如 CLI 模式)需要真正的 Worker,仍然可用

### 具体改动

1. `src/worker/inline-worker.ts` — 已实现,无需修改
   - 实现 `WorkerLike` 接口:`postMessage` / `on` / `terminate`
   - 内部调用 `handleMessage`,响应通过 `message` 事件回调返回
2. `src/worker/manager.ts` — 已实现 `WorkerLike` 接口,无需修改
   - 替换了 `WorkerManager` 对 `worker_threads.Worker` 的强依赖
3. `src/worker/handler.ts` — 已实现 `initProcessorWithStore`,无需修改
4. `src/main.ts` — **需修改**:
   - 移除 `import { Worker } from 'worker_threads'`
   - `createWorkerManager()` 直接创建 `InlineWorker`,不再 try/catch Worker Threads
   - 移除 `workerData` 构造(InlineWorker 不需要)

### 不采纳

- **方案 B:`child_process.fork` 独立进程**:渲染进程沙箱限制不确定,跨平台打包复杂,需重写 IPC,风险高
- **方案 C:Web Worker + fs 代理**:vectra 深层 fs 调用难完全代理,工作量大,性能差
- **方案 D:完全放弃 Worker 抽象**:需大量改动 `IndexController` / `main.ts`,不如 InlineWorker 保留协议层干净
- **方案 E:等待 Obsidian 开放 Worker Threads**:不可控,无法解决当前插件无法加载的问题
- **方案 F:保留 try/catch 降级**:try 分支是死代码,误导读者,增加不必要的 `worker_threads` import

---

## Consequences(后果)

**正面**:

- 插件在 Obsidian 桌面版能立即加载并运行,解决当前阻塞性故障
- 保留现有 `WorkerManager` + postMessage 协议,后续切真 Worker 时改动小
- `InlineWorker` 复用主线程 `VectraStore`,避免双写冲突
- 代码意图清晰:Obsidian 环境 = InlineWorker,不做无意义的 try/catch

**负面**:

- 索引/向量计算在主线程执行,大 vault 全量索引时会阻塞 UI
- 这是 Electron 环境限制下的 trade-off,不是代码 bug
- 后续需要额外优化(任务切片、分批 yield、进度条)来缓解阻塞

**影响面**:

- `src/main.ts`:移除 `worker_threads` import,`createWorkerManager()` 直接创建 InlineWorker
- `src/worker/manager.ts`:无变化(已用 `WorkerLike` 接口)
- `src/worker/inline-worker.ts`:无变化
- `src/worker/handler.ts`:无变化
- 测试:现有 `inline-worker.test.ts` / `manager.test.ts` / `handler.test.ts` 应继续通过
- 文档:README 增加「桌面版索引在部分系统上可能短暂阻塞 UI」的说明

**安全与隐私**:

- 无新增网络调用
- `InlineWorker` 仍不导入 `obsidian`,与 Worker 约束一致
- 不暴露 vault 外路径

---

## 参考

- [Electron Multithreading 官方文档](https://www.electronjs.org/docs/latest/tutorial/multithreading)
- `src/main.ts`(Worker 启动逻辑)
- `src/worker/manager.ts`(`WorkerLike` 接口与 `WorkerManager`)
- `src/worker/inline-worker.ts`(InlineWorker 实现)
- `src/worker/handler.ts`(`initProcessorWithStore`)
- 报错堆栈:`node:internal/worker:213:21`

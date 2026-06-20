# ADR-002:Ratel Vault Worker 运行时策略

**状态**:Accepted  
**日期**:2026-06-18

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
| `worker_threads` | ❌ 不可用 | 本次报错根源 |
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

**采用方案 A:InlineWorker(主线程内 Worker 模拟)**

在 `main.ts` 中对 `new Worker()` 做 try/catch:

- **成功**:继续使用 Node.js Worker Threads(保留未来在支持环境中回退可能)
- **失败**:构造 `InlineWorker`,在同一线程内直接调用 `src/worker/handler.ts` 的 `handleMessage`,并通过 `setTimeout(..., 0)` 模拟 postMessage 异步

`InlineWorker` 将复用 `main.ts` 已创建的 `VectraStore` 实例,避免主线程与 Worker 各持一个 `VectraStore` 写同一个 `indexDir`。

### 具体改动

1. 新增 `src/worker/inline-worker.ts`
   - 实现 `WorkerLike` 接口:`postMessage` / `on` / `terminate`
   - 内部调用 `handleMessage`,响应通过 `message` 事件回调返回
2. 新增 `src/worker/worker-like.ts` 或直接在 `manager.ts` 中定义 `WorkerLike` 接口
   - 替换 `WorkerManager` 对 `worker_threads.Worker` 的强依赖
3. 修改 `src/worker/handler.ts`
   - 新增 `initProcessorWithStore(store: VectraStore): void`,避免 `InlineWorker` 重复创建 store
4. 修改 `src/main.ts`
   - `new Worker()` 加 try/catch
   - catch 分支创建 `InlineWorker` 并传入 `this.vectraStore`

### 不采纳

- **方案 B:`child_process.fork` 独立进程**:渲染进程沙箱限制不确定,跨平台打包复杂,需重写 IPC,风险高
- **方案 C:Web Worker + fs 代理**:vectra 深层 fs 调用难完全代理,工作量大,性能差
- **方案 D:完全放弃 Worker 抽象**:需大量改动 `IndexController` / `main.ts`,不如 InlineWorker 保留协议层干净
- **方案 E:等待 Obsidian 开放 Worker Threads**:不可控,无法解决当前插件无法加载的问题

---

## Consequences(后果)

**正面**:

- 插件在 Obsidian 桌面版能立即加载并运行,解决当前阻塞性故障
- 保留现有 `WorkerManager` + postMessage 协议,后续切真 Worker 时改动小
- `InlineWorker` 复用主线程 `VectraStore`,避免双写冲突
- 默认行为是「能用 Worker 就用 Worker,不能用就降级」,对未来环境变化友好

**负面**:

- 索引/向量计算在主线程执行,大 vault 全量索引时会阻塞 UI
- 这是 Electron 环境限制下的 trade-off,不是代码 bug
- 后续需要额外优化(任务切片、分批 yield、进度条)来缓解阻塞

**影响面**:

- `src/main.ts`:Worker 启动逻辑加 try/catch + fallback
- `src/worker/manager.ts`:Worker 类型从 `worker_threads.Worker` 改为 `WorkerLike` 接口
- `src/worker/inline-worker.ts`:新增文件
- `src/worker/handler.ts`:新增 `initProcessorWithStore`
- 测试:新增 `tests/worker/inline-worker.test.ts` 验证消息转发；现有 `manager.test.ts` / `handler.test.ts` 应继续通过
- 文档:README 增加「桌面版索引在部分系统上可能短暂阻塞 UI」的说明

**安全与隐私**:

- 无新增网络调用
- `InlineWorker` 仍不导入 `obsidian`,与 Worker 约束一致
- 不暴露 vault 外路径

---

## 参考

- [Electron Multithreading 官方文档](https://www.electronjs.org/docs/latest/tutorial/multithreading)
- `src/main.ts:92-103`(当前 Worker 启动逻辑)
- `src/worker/manager.ts:54`(当前 `WorkerManager` 强依赖 `worker_threads.Worker`)
- `src/worker/handler.ts:26-29`(当前 `initProcessor` 会新建 `VectraStore`)
- 报错堆栈:`node:internal/worker:213:21`

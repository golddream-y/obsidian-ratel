# T0 线程能力实验记录

> 计划：[P-ADAPTIVE-INDEX](2026-11-02-adaptive-indexing.md) · 里程碑 M0。本记录只登记实际执行过的读数，未执行项明确写未验证。

## 状态

进行中，且已出现**方向性负结果**：真实 Obsidian 渲染进程无法创建 Node `worker_threads` 子线程。按计划 T0 不通过，不得进入 T1；替代路径（Web Worker 承担 CPU + 主线程异步 IO + 分片存储）正在验证。

## 真实 Obsidian 首次执行（v1）

- 时间：2026-11-02 14:00（本地）。
- 宿主：Obsidian 沙箱库（临时库），插件为实验构建（`RATEL_INDEX_EXPERIMENT=1`）。
- 结果：命令 `运行索引线程实验(调试)` 失败，提示
  `Failed to construct 'Worker': The V8 platform used by this instance of Node does not support creating Workers`。
- 判读：这不是脚本错误，而是宿主的 Node 运行时未启用 worker 支持。插件内既有的 Worker 是 **Blob URL Web Worker**（`EmbeddingWorkerProxy`、Skill 脚本沙箱），不是 `worker_threads`。
- 影响：架构提案中「独立 Node 能力索引 Worker 承载 Vectra 与 JSON 提交」的前提不成立；不能靠 Node 子线程迁出存储与文件 IO。

## 替代路径（v2，验证中）

在 Web Worker 内做纯 CPU（构造、序列化、hash、分块），文件 IO 留在主线程用异步 API，存储改为分片以避免整库一次序列化。v2 实验测量：

1. Node 子线程是否可用（保留负结果，供证据链闭合）；
2. 同一份 12.2 MB 序列化在主线程与 Web Worker 的主线程迟到对比；
3. 主线程异步整文件写入的迟到；
4. 主线程 400 片异步写入的迟到。

## Node 侧读数（v1）

| 项 | 值 |
| --- | --- |
| 系统 | macOS（开发机） |
| Node | v24.11.0 |
| 运行方式 | `npx vitest run tests/worker/index-thread-capability.test.ts` 与同源 TS 脚本 |
| 向量来源 | 确定性替身，不加载 ONNX、不访问网络 |

| 场景 | 最大迟到 | p95 迟到 | 样本数 |
| --- | --- | --- | --- |
| 探针自检（注入 300 ms 忙等） | 检出同量级迟到（用例断言 ≥250 ms） | — | — |
| 主线程直跑 12.2 MB 提交 | 98.0 ms | 98.0 ms | 1 |
| 子线程执行同一提交 | 1.7 ms | 1.7 ms | 13 |

- 两侧 `bytes` 一致（12,197,537），排除两边造了不同负载。
- 该读数只证明 Node 运行时内隔离有效，**已被宿主负结果推翻其可迁移性**。


## 真实 Obsidian 执行（v2 修正探针 + v3 Worker 文件能力）

- 时间：2026-11-02 14:12（本地），Obsidian 1.15.0，macOS，沙箱库。
- 探针自检：291.5 ms（注入 300 ms 长任务被如实检出），本组读数有效。
- 注：实验期间沙箱库同时在跑索引并反复报「2 个文件处理失败」，存在 CPU 竞争，读数偏高。

| 项 | 最大迟到 | p95 | 说明 |
| --- | --- | --- | --- |
| 主线程序列化 12.2 MB | 38.0 ms | 38.0 ms | 整库 `JSON.stringify` 的主线程成本 |
| Web Worker 序列化同一份 | 434.7 ms | 32.9 ms | 峰值来自 Worker 创建/首次编译；常态约 33 ms |
| 主线程异步整文件写入 | 1.7 ms | 1.7 ms | 单次 12 MB 异步写不阻塞 |
| 主线程 120 片顺序异步写入 | 428.5 ms | 422.7 ms | **分片写反而阻塞约 0.4 s**，不能留在主线程 |
| Node `worker_threads` | 不可用 | — | 动态导入失败，与 v1 结论一致 |

- **Web Worker 内 `hasRequire=true`、`hasProcess=true`、`fsOk=true`**：Blob Worker 具备 Node 文件能力，可写文件并读回校验。

## 结论（v3）

1. Node `worker_threads` 路线终止；**改用 Blob Web Worker 作为独立线程载体**，它同时具备 CPU 与 Node 文件能力，架构目标不变。
2. 「CPU 搬走、IO 留主线程」不成立：主线程分片写实测阻塞约 0.4 s，写放大问题必须随 IO 一起迁入 Worker。
3. 主线程整库序列化 38 ms 与 Worker 创建峰值 434 ms 需在 T1 消除：前者迁入 Worker，后者用常驻 Worker 避免重复创建。
4. T0 结论：方向可行，载体修正。仍需在 T1 验证 Worker 内 Vectra 与原子存储可用、以及常驻 Worker 的稳定读数。

## 结论（更新）

- 方向需要修正：不能依赖 Node 子线程。宿主可用的独立线程只有 Web Worker，且没有文件能力。
- 因界阻塞的主因仍须实测：整库 `JSON.stringify`（v1 实测约 98 ms/12.2 MB）与同步写入路径。若 Serialize 迁到 Web Worker、写盘走异步并以分片替代整库重写，界面阻塞可显著下降——待 v2 宿主读数确认。
- 在拿到 v2 宿主证据前，T0 仍未通过，T1 不启动。

## 被测对象（v1 Node 侧）

- 同一份整库 JSON 提交：4000 篇笔记 × 512 维确定性向量，序列化后约 12.2 MB（与生产「整库 `index.json` 一次写入 + fsync」同形态）。
- 对照组：主线程直接构造并序列化；实验组：真实 `worker_threads` 子线程落盘脚本、构造、序列化并 fsync。
- 观测量：主线程心跳（10 ms 间隔）迟到量。同步长任务期间定时器排不上队，迟到量即可观测的界面阻塞量级。
- 探针自检：人为注入 300 ms 同步忙等，必须被检出，否则读数不作数。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS（开发机） |
| Node | v24.11.0 |
| 运行方式 | `npx vitest run tests/worker/index-thread-capability.test.ts` 与同源 TS 脚本 |
| 向量来源 | 确定性替身，不加载 ONNX、不访问网络 |

## 读数

| 场景 | 最大迟到 | p95 迟到 | 样本数 |
| --- | --- | --- | --- |
| 探针自检（注入 300 ms 忙等） | 检出同量级迟到（用例断言 ≥250 ms） | — | — |
| 主线程直跑 12.2 MB 提交 | 98.0 ms | 98.0 ms | 1 |
| 子线程执行同一提交 | 1.7 ms | 1.7 ms | 13 |

- 两侧 `bytes` 一致（12,197,537），排除两边造了不同负载。
- 子线程身份断言通过：`isMainThread=false` 且 `threadId>0`。

## 结论

- Node 环境证明：把构造、序列化与 fsync 放到真实子线程后，主线程心跳几乎不迟到；同一负载在主线程会形成接近 100 ms 的单次阻塞。方向可行。
- 这只证明 Node 运行时内的隔离有效，**不证明 Obsidian 渲染进程能加载 Node 子线程**。真实宿主能力与界面响应仍属未验证。

## 真实 Obsidian 待执行步骤

实验入口只在 `RATEL_INDEX_EXPERIMENT=1` 构建时进包，正常产物不含该命令。

1. `RATEL_INDEX_EXPERIMENT=1 node esbuild.config.mjs production`
2. 链接开发预览库，重载 Obsidian 插件。
3. 命令面板运行「运行索引线程实验(调试)」，保持 Obsidian 在前台。
4. 报告写到系统临时目录 `ratel-index-thread-experiment-*.json`，含 `mainThread`、`workerThread`、`selfCheck` 三组读数与线程 ID。

完成前不得勾选 T0，也不得以 Node 读数替代宿主结论。

# T0 线程能力实验记录

> 计划：[P-ADAPTIVE-INDEX](2026-11-02-adaptive-indexing.md) · 里程碑 M0。本记录只登记实际执行过的读数，未执行项明确写未验证。

## 状态

进行中。Node 侧实验已通过；**真实 Obsidian 运行时尚未执行**，因此 T0 未通过，不得进入 T1。

## 被测对象

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

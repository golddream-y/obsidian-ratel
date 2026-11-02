# T9 三区分验收协议

> 计划：[P-ADAPTIVE-INDEX](2026-11-02-adaptive-indexing.md) · 证据入口：[T0 记录](2026-11-02-adaptive-indexing-t0-evidence.md) · 进度：[实施进度](2026-11-02-adaptive-indexing-progress.md)

本文件固定「怎么量、量到什么算过」，避免事后挑口径。**没有宿主读数的项一律记为未验证。**

## 采集入口

实验包（仅调试构建入包，正常产物不含该命令）：

```bash
RATEL_INDEX_EXPERIMENT=1 node esbuild.config.mjs production
node scripts/link-vault.mjs "<preview-vault>"
```

在预览库重载插件 → 命令面板「运行索引线程实验(调试)」→ 报告写到系统临时目录 `ratel-index-thread-experiment-*.json`。

报告字段：`selfCheck`（探针自检）、`channel`（init + 受限文件读写）、`runtime`（线程内索引两篇 → 查询 → 状态）、`mainThreadIndex`（同负载在主线程切块 + 写入的对照）、`webWorker`/`mainThread`（序列化对照）、`asyncWholeWrite`/`shardedWrite`。

## 正确性组

| 检查 | 判据 | 数据来源 |
| --- | --- | --- |
| 探针可信 | 自检注入 300 ms 被检出（≥250 ms） | `selfCheck` |
| 单文件提交 | 线程内写入后可查回同一路径，块数为正 | `runtime.hits` / `runtime.totalDocs` |
| 旧块替换 | 内容变短后旧块不残留 | Node 用例（`index-runtime-session`） |
| 崩溃恢复 | 未决事务输入未变则重放产出完成记录；内容已变不重放 | Node 用例（会话恢复 2 例） |
| 写权撤销 | 撤销后写入失败 | Node 用例（入口 + 会话） |

## 流畅度组

| 检查 | 判据 | 数据来源 |
| --- | --- | --- |
| 序列化不占主线程 | 线程执行期间主线程最大迟到 < 主线程直跑 | `webWorker` vs `mainThread` |
| 索引不占主线程 | 线程索引期间主线程迟到 < 主线程直跑切块写入 | `runtime.stall` vs `mainThreadIndex.stall` |
| 交互可操作 | 采集期间人工输入/滚动不卡顿（主观确认，单独记录，不替代读数） | 人工 |

## 效率组

| 检查 | 判据 | 数据来源 |
| --- | --- | --- |
| 构建耗时不劣化 | 与 1.3.0 基线同机同数据对照，中位不超 1.5 倍 | `RATEL_EFFICIENCY=1` 基准（已可跑，见下） |
| 峰值内存 | 不超基线 1.25 倍 | 同上（采样堆内存） |
| 磁盘写入量 | 累计写入字节如实记录，不设通过线但必须给出数字 | 同上（索引目录最终字节） |

## 效率基准（当前实现路径）

```bash
RATEL_EFFICIENCY=1 RATEL_EFFICIENCY_FILES=100 npx vitest run tests/core/index-efficiency-baseline.test.ts
```

本机一次读数（macOS，单次运行，非中位）：100 篇 → 总耗时 8536 ms（85.4 ms/篇），峰值堆 81.3 MB，索引目录 94 KB。20 篇档为 1656 ms / 76.2 MB。

关键点:基准**必须带文件日志与完成记录**,否则测到的只是 Vectra 落盘（同规模仅 54 ms），会漏掉每条完成记录一次原子写的成本 —— 这正是不带日志的读数与真实路径差两个数量级的原因。

线程版对照必须在宿主内采集,不能用这里的数字冒充。

## 当前状态

- 已具备：实验入口、线程链路、主线程对照、Node 侧正确性用例。
- 未执行：宿主内一次完整采集。
- 未编写：效率组的「构建耗时 / 峰值内存 / 累计写量」专项基准；这三项没有数字之前，效率组不得标通过。
- 不得用「界面不卡」替代正确性或效率结论；也不得用 Node 读数替代宿主读数。

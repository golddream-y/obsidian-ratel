# M1 实施回执（致设计）

面向 `S-ADAPTIVE-INDEX` 的设计方。计划：[P-ADAPTIVE-INDEX](2026-11-02-adaptive-indexing.md) · 进度：[实施进度](2026-11-02-adaptive-indexing-progress.md) · 验收：[T9 协议](2026-11-02-adaptive-indexing-t9-protocol.md) · 切换与复用：[cutover](2026-11-02-adaptive-indexing-cutover.md) · 写放大与待办：[write-amplification](2026-11-02-adaptive-indexing-write-amplification.md)

需要你裁定三件事（§1），确认四处偏差（§2），并知悉验收只差流畅度一组（§3）。

代码面已按 spec 完成：全量 323 文件 / 3008 passed / 24 skipped / 0 failed，lint 0 error，tsc 保持 241 条既有基线、相对本轮新增 0。T9 三组中正确性与效率已有独立证据，**流畅度缺一次宿主内采集**，实施方无法驱动，故 T9 不标通过。

## 1. 需要裁定的三件事

### Q1. 写入量 O(N²) 怎么修

效率基准在文件系统层统计实际写入（含临时文件与完成记录）：

| 文件数 | 累计写入 | 每篇 | 目录终态 |
| --- | --- | --- | --- |
| 50 | 722 KB | 14.8 KB | 47 KB |
| 100 | 2691 KB | 27.6 KB | 94 KB |
| 200 | 10392 KB | 53.2 KB | 189 KB |

文件数翻倍、写入涨约 3.8 倍。根因是 Vectra 本地索引每写一条就重写整份索引文件。三条候选方案，风险由低到高：

1. **批量提交**：用 `beginUpdate/endUpdate` 合并 N 条写入，写量降到 O(N)。代价是「批内单文件失败」的语义要重新定义，当前是逐文件完成记录。
2. **日志追加 + 定期压实**：写量接近线性，但检索要跨段合并，读路径复杂度上升。
3. **分片索引**：按路径哈希切片，写量按片摊薄；改动最大，检索需多片查询。

建议 M1 不修：界面流畅与存储效率是两件事，当前规模每篇耗时仍平坦（74–77 ms），且修法会动存储格式。若采纳，建议单独立 spec，验收口径为「每篇写入 ≤ 3× 单篇数据量」。

### Q2. 效率组要不要设通过线

现状只记录数字、不设通过线（协议原文即「如实记录，不设通过线」）。若要求三组都有可判定条件，需要给出写量与内存的判定线，否则效率组永远只能算「有数据」。

### Q3. 体积代价是否接受

主包 11.9 MB → **15.5 MB**（+3.6 MB），来源是 Worker 产物必须内联进单文件（发版三件套约束）。已把 vectra 全文检索分支带进来的 wink 英文模型打桩，从 19.1 MB 降回 15.5 MB。

一条不能踩的线：`gpt-tokenizer` **不能**打桩——`LocalDocumentIndex` 构造时默认用它做块切分，替身会让构造直接抛错，且只在宿主暴露、Node 用例测不到。

## 2. 与设计的四处偏差

| 编号 | 偏差 | 理由 | 需确认 |
| --- | --- | --- | --- |
| D1 | 载体是 Blob Web Worker，不是 Node 线程 | Obsidian 渲染进程内 `node:worker_threads` 不可用；Blob Worker 可用且带 Node 集成（`require`/`process`/`node:fs` 全通） | spec 中「线程」是否已全面理解为 Web Worker 语义（结构化克隆成本、无同步阻塞、无共享内存） |
| D2 | 代际解析留在宿主，线程只收解析结果 | 代际决策要读写控制指针、跑迁移与回收，属装配决策；进线程会让两处都持有写权语义 | 是否要求代际管理也进线程 |
| D3 | 只读模式不迁入线程 | 只读不涉及索引写入；`VectraStore` 初始化默认落地索引文件，需先加只读打开模式；无日志时 `listCommitted` 只能拒绝，可见性门会长期 `unjudgeable` | 是否纳入后续 spec（前置条件见 cutover §5） |
| D4 | 缺口 D 从「遗漏」改判为「非缺陷」 | 配置指纹含分块器版本/块大小/块重叠/嵌入文本模板，任一项变化都会改变送进模型的文本，向量必须重算；跨配置复用向量数学上不成立 | 是否把「切回仍保留的旧配置代际不重嵌」升级为显式验收项 |

D4 保留的真实机会：切回旧配置时旧代际仍有完成记录，`resolveIndexGeneration` 会按指纹取回该代际，理论上不该重嵌；目前**尚无测试证明**，仅登记为待验证要求。

## 3. T9 三组现状

| 组 | 已有证据 | 结论 |
| --- | --- | --- |
| 正确性 | 未变文件零重复嵌入（同批三篇跑两轮，第二轮嵌入 0 次）；关闭重开后仍可检索；崩溃后重启恢复写入与查询；撤销不等于失败；旧块替换不残留；写权撤销后拒写 | 有据 |
| 流畅度 | 无宿主读数。Node 隔离代理 50/300/800 篇读数为 10.2/41/51 ms 对 13.8/25/55 ms，**不稳定，已判定不可作依据** | 未通过 |
| 效率 | 线程 76.9 ms/篇 vs 主线程 85.4 ms/篇（100 篇，同分块、同日志与完成记录），峰值堆 82.6 对 81.3 MB；另有 Q1 的写放大 | 有据（含未修问题） |

流畅度的采集方式（需人工执行）：`RATEL_INDEX_EXPERIMENT=1 node esbuild.config.mjs production` 后链接预览库并重载插件，5 秒后自动采集；报告内含 `gates.{selfCheckOk, fluidity, reopenOk}` 三个机械判读字段。

判读要点：`selfCheckOk` 为 false 时整份报告作废；`fluidity` 为 `not-better` 时不能宣称线程化解决卡顿，应加大负载重测（该负载下本来就不卡）。

## 4. 实施中修掉的缺陷

供设计复核语义，这几条都属「开关打开后才会暴露」，且都不是界面问题。

| 缺陷 | 后果 | 处置 |
| --- | --- | --- |
| 线程会话无条件重嵌 | 每次启动或重建索引把整库重嵌一遍，违反「未变文件零重复嵌入」 | 先比内容 hash，命中完成记录则返回 `skipped: true` |
| `abortActive` 只停调度不停在途 | 用户看到「已暂停」但磁盘仍在写 | 宿主取消信号真正撤销在途请求；协调器把取消重排队、不记失败 |
| 增量收敛后阶段不刷新 | 状态永远显示「处理中」 | 抽出 `refreshPhase()`，`drain` 收尾刷新 |
| `started` 早于线程启动置位 | 启动失败后事件被派给不存在的线程，并记成「文件索引失败」 | 线程真正起来后才置位 |
| 暂停与计数只看主线程协调器 | 线程模式下暂停撤不到线程、进度永远显示 0 | 引入 `activeTaskCoordinator` 统一入口 |
| 实验入口抽成实例方法 | 生产产物重新带上探针代码（命令虽不注册） | 改回 `define` 保护内内联，生产产物复查为 false |

## 5. 交付清单

- 线程侧模块：`src/worker/index-runtime-{protocol,host,worker,entry,fs-handlers,session,journal,browser,client,embedding-bridge}.ts`；宿主侧：`src/core/index-thread-{coordinator,assembly,backend,candidate-source,visibility-gate}.ts`、`src/core/index-runtime-identity-guard.ts`；共享落盘：`src/adapters/index-write-flush{,-node}.ts`；恢复与仲裁：`src/core/index-manifest-recovery.ts`、`src/core/index-embedding-arbiter.ts`
- 开关：`settings.indexThreadMode`（默认 `false`），启动失败完整回落主线程，检索随之回落 Worker
- 测试：线程相关 27 文件 / 222 用例；全量 323 文件 / 3008 passed / 24 skipped / 0 failed
- 关键提交：`986436a`（端到端组合）、`1d98c29`（产物瘦身）、`ef96204`（开关与回落）、`ac4c5e2`（撤销语义）、`a39a124`（崩溃重启）、`7cbf451`（未变不重嵌）、`f35056e`（二次核对零嵌入）、`ec879de`（收尾挂账）
- 分支：`main` / `develop` / `feat/index-reliability` 三者一致；预览库链接指向生产构建（线程模式关闭，行为与 1.3.0 一致），未安装生产库

## 6. 未验证项

1. T9 流畅度（唯一阻塞，需宿主一次采集）。
2. 「切回旧配置不重嵌」（D4 的待验证要求）。
3. 只读线程版（D3，不在 M1 范围）。
4. 真实 ONNX 推理下的线程链路（默认套件不跑真实模型）。

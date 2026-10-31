# T3 证据记录：文件日志与恢复状态机

> 本文件是 P-INDEX-RELIABILITY 的 T3 执行证据。数字均为本机实测；未验证项明确标注。
> 前置证据：[T0](2026-10-31-index-reliability-t0-evidence.md)、[T1/T2](2026-10-31-index-reliability-t1-t2-evidence.md)。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线：T1/T2 提交 `1cf1ebd`

## 1. 结论

T3 完成，7 个 checkbox 全部落地。全量 **288 文件 / 2400 passed / 5 skipped**；`tsc` **241 条存量、新增 0**。

| 产物 | 规模 | 用例 |
|---|---|---|
| 新建 `src/core/index-file-journal.ts` | 约 2308 行 | 55 例（`tests/core/index-file-journal.test.ts`） |
| 修改 `src/core/persistent-index-backend.ts` | +197/−23 | 26 例（含新增 6 例） |
| 修改 `src/adapters/atomic-index-storage.ts` | **纯新增 23 行 / 0 删除** | —（导出共享临时文件谓词） |

核心保证：**「向量已提交、完成记录未写」这类中断点，重启后经日志重放或补记录恢复，嵌入调用数为 0**（每条恢复用例都断言 `port.callCount === 0`）。

## 2. 恢复决策表覆盖（spec §2 六行，逐行有用例）

| spec 行 | 实现动作 | 结论 |
|---|---|---|
| prepared 无效但可可信归属 → 隔离该路径并重算 | `quarantined-path/invalid-prepared` | 已验证 |
| 无法归属 → 隔离代际 | `quarantined-generation/unattributable-prepared` | 已验证（判据已按第 3 节修正） |
| receipt revision 高于 prepared → 清理，禁止覆盖后继 | `cleanup-only/receipt-ahead` | 已验证 |
| prepared 有效且输入匹配 → 检查完整块集合 → 补 receipt 或重放 | `replayed/input-matches-replay`、`repaired-receipt/receipt-missing-vectors-present` | 已验证 |
| prepared 过期且磁盘仍是旧提交 → 保留旧结果，排队当前版本 | `requeue-current/expired-input-old-disk` | 已验证 |
| prepared 过期且磁盘含过期新提交 → 持久过滤并排队 | `blocked-current/expired-input-committed` | 已验证 |
| receipt 与实际块匹配且仅清理未完成 → 只清理，不再嵌入 | `cleanup-only/receipt-matches-prepared` | 已验证 |

退出位置覆盖：prepared 前、首个分片写入前、向量提交前后、receipt 前后、日志清理时、向量提交失败。每例都**重建全部对象后读取真实磁盘**（块 ID、hash、数量、维度、向量值）。

## 3. 两阶段审查的阻断与修复

两阶段审查（规范符合性 / 代码质量）**均判不通过**，阻断互相印证。

### 阻断 A：空的原状事务目录被误判为「无法归属」→ 整个代际永久隔离
- 机制：`prepare` 先建事务目录再写分片，而**删除事务 / 空文件事务零分片**；若在两步之间退出（或在写 `prepared.json` 时遇到 ENOSPC——审查者的确定性复现），目录既无记录也无分片 → 归属为 null → 写代际隔离 → 此后所有写入以 `generation-quarantined` 拒绝，且当时**无任何解除入口**。
- 修复：区分「空事务（无内容、无依据）」与「有记录不可信 / 有分片却无法归属」；前者按 `cleanup-only/empty-transaction` 直接清理，不再升级为代际隔离；`mkdir` 推迟到第一次实际写入前；新增显式 `clearGenerationQuarantine({ confirm: true })`。
- 回归：4 条定向用例 + 仓库外探针 12 项全 PASS；「有分片但无法归属仍隔离代际」的**真分支未被放宽**（有专门用例锁死）。

### 阻断 B：`commit()` 清零本轮失败计数 → 假「全库完成」
- 机制：`commit()` 成功保存清单后无条件 `round.failures = 0`，而它是增量与删除的唯一提交出口 → A 文件失败后，B 文件成功提交即把失败清掉，`isIndexComplete()` 回到 true，`index-manager` 据此置 Ready，而失败文件既不在向量也不在清单里。
- 修复：失败计数只在 `runScan` 成功分支重置；补「失败后另一文件成功仍不完成」回归用例，并做反向验证（临时还原旧行为 → 恰好对应用例失败）。
- 顺带修复：`commit()` 回滚原先**无条件删除既有构建戳**，会把其他文件的有效凭据一并抹掉；现改为按原样恢复旧戳（无旧戳才删除），并有专门用例。

## 4. 已修的影响项（12 条，摘要）

1. 决策 2（receipt 领先但磁盘不匹配）返回 `searchable:false` 却不落盘 → 改为持久化不可用状态，重启后仍排除该路径。
2. `recover` 写出代际隔离后仍继续恢复其余事务（`break` 是死代码）→ 隔离后立即停止本代际恢复，写操作前复查隔离。
3. `predecessor-unresolved` 可永久卡死单一路径 → 增加自愈出口（磁盘提交可由同路径另一未决事务或路径状态解释时按该事务结算）；`prepare` 增加 per-path 在途守卫（`path-in-flight`）；命名改为 `prior-version-*`，与写所有权的 `predecessor-not-closed`（插件前驱实例）区分。
4. `quarantine/transactions/` 无界累积（违反 spec §6「成功后及时回收」）→ 新增枚举/显式回收/孤儿回收，并在「当前版本成功提交且路径状态清除」后自动回收。
5. `recover` 单点失败中断整轮（A6 要求失败范围可定位）→ 逐事务 try/catch，返回部分结果与 `failures` 报告。
6. 裸 fs 错误（英文 errno + 绝对路径）无稳定码 → 收敛为 `io-failure`，保留 `errno`/`cause`，消息不含绝对路径。
7. 性能：`isIndexComplete()` 被每文件调用导致 O(N²) 目录读 → 完成记录与路径状态清单增加实例内缓存并在自家写后失效；`findTransactionsOfPath` 先用 `prepared.json` 的 `next.path` 预筛，不再读无关事务的全部分片字节。
8. `.tmp-` 命名跨模块耦合 → 由 `atomic-index-storage.ts` 导出共享谓词（纯新增）。
9. 两条无效断言（自比自、`typeof === 'function'`）→ 替换为真实磁盘快照比对与真实行为契约。
10. `verifyReceipt` 使用 store 内存视图 → JSDoc 明确「唯一可能陈旧的只读通道，交接后必须先 `reload()`」。
11. `cleanup()` 是唯一不登记在途提交的写入口 → 补齐登记与结算。
12. 补缺失用例：receipt 写入失败、未声明多余分片、删除后重建 + 陈旧删除事务、隔离记录损坏。

## 5. 存量 flaky 夹具修复

`tests/core/persistent-index-backend.test.ts` 的 `drainUntil` 用**固定 1000 次 `setImmediate`** 当超时上界，在真实磁盘争用下抛「真实磁盘操作未完成」。该用例与 helper 在 T3 的 diff 中逐字未改，但 T3 新增的真实磁盘用例提高了触发概率。

| 场景（3 轮 × 3 份 journal + 3 份 backend 并发） | backend 结果 |
|---|---|
| 修复前 | **4/9 失败**（全部为「活动超时」） |
| 修复后 | **9/9 全绿**（墙钟超时失败 0/9） |

修复方式：固定迭代预算改为墙钟预算（默认 15s），两个定时器用例加显式 `timeout: 30_000`；夹具在条件恒假时仍会失败（不是恒真假守卫）。

## 6. 契约面变更（T4/T7 必须同步）

- 新增错误码：`confirmation-required`（显式解除确认）、`path-in-flight`（同路径并发 prepare）、`io-failure`（fs 错误收敛）。
- 改名：`predecessor-mismatch` → `prior-version-mismatch`，`predecessor-unresolved` → `prior-version-unresolved`。
- 新增恢复原因：`empty-transaction`。
- `recover()` 报告新增字段 `failures`（部分失败可定位）。
- 新增 `FileRecordReader.listTombstones()`（**必需**成员）：`listReceipts` 只返回 present 完成记录，删除凭据走 `listTombstones`，两者语义互斥。此前接口注释写「含删除凭据」而实现只回 present，属编译期不可见的语义分歧，已由后端侧修正并注入真实 journal 断言。

## 7. 裁定与归属登记

| 项 | 裁定 | 归属 |
|---|---|---|
| 只读 API 免租约 | 原则可接受，但**理由当前不成立**：`IndexWriteOwner` 构造器私有、唯一工厂 `acquire()` 必写 `owner.lock`，所以「关闭自动索引时零写入地只读」在生产装配下无法实现 | **T4/T6 补只读门面** |
| `quarantine/` 布局（`<pathHash>.json`、`generation.json`、`transactions/<id>/`） | 接受为 T3 局部扩展 | T6 目录/代际管理 + **T8 回收**必须覆盖 |
| `JournalPathState` / `JournalGenerationQuarantine` | 登记为 **T3 局部 schema**（复用 T1 的 schema 版本，但宽松 parse、损坏一律视为坏记录）；未并入 T1 的 24 码表 | T6 若需集中再迁移 |
| `isGenerationQuarantined()` 改为「记录文件存在即隔离」（损坏也失败关闭） | 接受：写入门禁应失败关闭，出口是显式解除 | 已实现 |
| `fileRecords` 未注入时 `isIndexComplete` 回退旧凭据语义 | 接受为**临时口径**（现在收紧会让每次启动判不完整并触发重建）；守卫用例已把 `main.ts:443` 登记为待注入装配点，T7 注入后清单自动收缩 | **T7 注入并收紧** |
| `reclaimOrphanQuarantinedTransactions()` 无生产调用点 | 接受（提交后已自动回收）；周期调用归 T7/T8 | T7/T8 |
| 缓存为实例级，跨实例并发写要求调用方串行 | 接受（已在类 JSDoc 注明）；多 journal 实例共享同一代际由 T4/T7 约束 | T4/T7 |
| `verifyReceipt` 仅文档化 reload 要求 | 接受（避免破坏纯只读语义） | T7 若需硬约束再升级 |
| **`dropIndex()` 递归删除与 `indexDir` 布局** | **T6 硬约束**：日志与 `control` 必须在 `.index/` 根、Vectra 数据在 `.index/generations/<generationId>/`，`dropIndex` 只能删代际目录；否则一次全量扫描会连带清空日志与删除凭据（T3 的契约用例已实测撞到该行为） | **T6** |
| `isIndexComplete()` 内调用方的 `manifest.load()` / 凭据读盘未缓存 | journal 侧 O(N²) 已消除；后端侧缓存视 T7 实测再定 | T7 |
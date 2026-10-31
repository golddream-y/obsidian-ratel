# T4 证据记录：流式扫描、变更队列与文件新鲜度

> 本文件是 P-INDEX-RELIABILITY 的 T4 执行证据。数字均为本机实测；未验证项与需裁定事项明确标注。
> 前置证据：[T0](2026-10-31-index-reliability-t0-evidence.md)、[T1/T2](2026-10-31-index-reliability-t1-t2-evidence.md)、[T3](2026-10-31-index-reliability-t3-evidence.md)。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线：T3 提交 `26e2bd4`
- 状态：**未提交 git**；未改 `index-file-journal.ts` / `persistent-index-backend.ts` / `atomic-index-storage.ts` / `main.ts`

## 1. 结论

T4 的 5 个 checkbox 全部落地；只读门面按 T3 §7 的指派交付，并暴露一处需要 Lead 裁定的接口缺口（见 §6.1）。

| 产物 | 规模 | 用例 |
|---|---|---|
| 新建 `src/core/index-task-coordinator.ts` | 930 行 | 22 例（`tests/core/index-task-coordinator.test.ts`） |
| 新建 `src/core/index-search-visibility.ts` | 608 行 | 28 例（`tests/core/index-search-visibility.test.ts`） |
| 修改 `src/core/index-manager.ts` | +225 / −21 | 新增 9 例（共 34 例） |
| 修改 `src/core/index-controller.ts` | +99 / −9 | 新增 6 例（共 12 例） |

核心保证：**重启后仅修改一篇文件时只有该文件进入嵌入调用**（实测 4 篇 → 1 次嵌入 / 1 次落盘），且 **`autoIndex=false` 下零扫描、零嵌入、零写入**（目录快照逐字不变、无 `owner.lock`、`freshness=unknown`）。

## 2. 改动清单

- 新建 `src/core/index-task-coordinator.ts`：流式扫描、按路径合并的事件队列、单调事件序号、新鲜度视图、单文件 durable 提交、`canMarkReady`。
- 新建 `src/core/index-search-visibility.ts`：新鲜度词汇、只读记录来源（`createJournalVisibilitySource`）、快照捕获、`SearchVisibilityGate`（融合/重排前的唯一闸门）、`ReadOnlySearchView`、只读装配哨兵 `createReadOnlyOwnerGuard`。
- 修改 `src/core/index-manager.ts`：`IndexBackend` 补 `searchableFileRecords?()`（T3 因锁定文件未加）；新增 `IndexTaskCoordinatorPort`；注入协调器后由协调器驱动扫描/事件/终态，不再走 `smartReindex`/`fullReindex` 的「整批成功才存清单」路径；状态展示区分总文件数/已提交数/待处理/失败与阶段。
- 修改 `src/core/index-controller.ts`：`IndexControllerOptions`（`coordinator` / `readOnlyView`）；事件装配拆成「写路径」「只读」两条；`autoIndex=false` 不再装配写路径监听。
- 新增/扩展测试 4 个文件（见 §1 表格）。未新增依赖、无网络访问、全部用例只使用系统临时目录。

## 3. T4 checkbox 逐条

**T4-1 先写失败测试（事件时序与提交竞态）**

先写并先运行到红：`index-task-coordinator.test.ts` 的「枚举与监听之间的空隙」「mtime/size 不变但正文变化」「推理期间删除」「提交期间再次修改」「连续编辑热点路径」五组用例；`index-search-visibility.test.ts` 的过滤位置用例配了反向对照（不先过滤时重排确实会收到过期路径）。实现后转绿。

- 证据：`src/core/index-task-coordinator.ts:702`（`processUpsert` 三段核对）、`:840`（`verifySnapshot`）
- 测试名：「枚举与监听之间的空隙 - 期间变更没有事件 - 扫描结束后按内容 hash 补齐」；「mtime 与 size 不变但正文变化 - 仍重新入队嵌入」；「推理期间删除 - 丢弃未提交结果 - 不落过期事务并按删除收尾」；「提交期间再次修改 - 保留队列项 - 旧快照不标记为最新版且新内容继续提交」；「连续编辑热点路径 - 其他文件不被饿死 - 队列按顺序交替推进」

**T4-2 枚举前注册事件；路径事件序号单调增长；按路径合并队列；初始单文件在途；无变化文件核对 hash 后复用**

- 监听先于枚举：「`start()` 在首次枚举之前调用 `options.subscribe`」——`src/core/index-task-coordinator.ts:301-311`；测试名「启动扫描 - 首次枚举之前装配监听 - 装配顺序为 subscribe 先于 enumerate」。
- 事件序号 + 按路径合并：`recordEvent`（`:476`）/`mergeQueued`（`:495`）/`takeNextEntry`（`:518`）；测试名「同路径连续事件 - 队列按路径合并 - 只保留一项且序号持续增长」（50 次事件 → 队列长度 1、一次嵌入、最终完成记录为第 50 版）。
- 单文件在途与有界核对：`activeCount`、`drain()`（`:361`）、`reconcile()`（`:596`，并发上限 `scanConcurrency`）；测试名「初始扫描 - 只读轻量路径列表并逐文件读取 - 核对并发受有界上限约束」（峰值读并发 ≤ 2）。
- 无变化复用：`reconcilePath`（`:627`）与 `processUpsert` 的 receipt 比对；测试名「再次启动且无任何变化 - 零嵌入调用且向量零重写」。

**T4-3 读取前后/推理后/提交前核对内容+事件序号+配置；提交后保留新事件；读失败区分删除与无法读取**

- 三段核对：读取前捕获序号（`:704-706`），推理后 `verifySnapshot`（`:737`），提交前再次 `verifySnapshot`（`:764`）。
- 提交后保留队列项：`processEntry` 的收尾（`:687-695`）与 `retain`（`:555`）；只有本次输入 hash 完成后才移除队列项。
- 读失败分类：`readFileSafely`（`:856`）只把 `ENOENT`（或无 errno 且 `stat` 明确不存在）判为删除，其余为 `unreadable` 并计入失败；测试名「读取失败 - 区分无法读取与已删除 - 不把读取错误当成空文件提交」（断言嵌入 0 次、prepared 0 条、完成记录与块集合保持旧版本）。

**T4-4 普通修改先 known-stale；删除/排除/损坏立即 deny；扫描中逐文件解锁；ready 判据；删除与空文件事务**

- `canMarkReady` 与计划片段逐字一致：`src/core/index-task-coordinator.ts:173-181`；测试「全部条件满足 - 返回 true」「扫描未结束 / 有队列 / 有在途 / 有未决事务 / 有失败 - 任一成立即 false」。
- known-stale / 立即 deny：`recordEvent`（`:476-491`）、`freshnessOf`（`:404`）；测试「普通修改未提交 - 先标记 known-stale - 检索立即过滤旧版本」「删除事件 - 立即 deny - 不等提交也不进入嵌入」「黑名单排除 - 立即 deny 并排队删除」。
- 扫描中逐文件解锁：`reconcilePath` 的 `markVerified`；测试「扫描进行中 - 已核实文件立即解锁 - 未核实文件不阻止检索且不标记扫描完成」。
- 删除 durable 事务与空文件零块 receipt：`processDelete`（`:782`）；测试「空文件 - 提交零块 present 完成记录 - 再次启动零嵌入复用」「删除已提交文件后再次启动 - 删除凭据持久 - 不重新嵌入」「删除未提交过的路径 - 无完成记录可删除 - 不写事务也不计入嵌入」。
- 改名：控制器按 rename = delete(old) + upsert(new) 拆分发；测试「自动索引开启 - 改名事件 - 旧路径删除立即入队且新路径去抖后入队」。

**T4-5 只读门面（T3 §7 指派）与 `searchableFileRecords?()`**

- 只读装配哨兵：`createReadOnlyOwnerGuard`（`src/core/index-search-visibility.ts:184`）——不创建 `owner.lock`，任何写入口调用立即失败。
- 只读通道：`createJournalVisibilitySource`（`:146`）+ `ReadOnlySearchView`（`:506`）；不取锁、不写盘、不嵌入，新鲜度一律 `unknown`。
- 测试名：「只读消费 - 不取锁不写盘 - 目录快照逐字不变且零嵌入」「只读装配 - 用哨兵构造日志实例 - 读取可信记录且不创建锁文件也不写盘」「新鲜度显示 unknown - 未扫描不假装已核对」「未解决事务路径全部过滤 - 只读模式由调用方传入已知在途集合」。
- `IndexBackend.searchableFileRecords?()`：`src/core/index-manager.ts:105`；`PersistentIndexBackend` 已有同名方法且结构兼容（未改动该文件）；测试「部分检索可用性 - 后端未实现记录视图 - 返回 null 而不是空集」「部分检索可用性 - 后端实现记录视图 - 原样透传」。

**可见性门（融合/重排之前过滤）**

- `SearchVisibilityGate.decide`（`:391`）与 `filter`（`:453`）；`index-controller`/`main.ts` 的检索接线属 T7，本任务只交付闸门与放置契约。
- 测试名：「原始向量候选 - 先过滤再进入重排 - 被拒绝路径不出现在重排输入」（含反向对照）；「可信 present 记录且已核实 - 允许进入融合与重排」；「未解决事务路径 - 一律过滤」；「路径状态为隔离或不可用 - 拒绝为 blocked」；「代际隔离 - 全部候选拒绝」。

**manager / controller 接入**

- 协调器驱动：`runCoordinator`（`index-manager.ts:213`）不调用 `smartReindex`/`fullReindex`；测试「启动扫描 - 注入协调器 - 由协调器驱动且不再调用整批重扫入口」。
- 事件转发：`enqueue`（`:331`）把事件交给协调器且不调用后端单文件入口；测试「增量事件 - 注入协调器 - 转发给协调器且不调用后端单文件入口」。
- 状态展示与不污染新任务：`publishCoordinatorStatus`（`:244`）；测试「状态展示 - 协调器 ready - 区分总文件数、已提交数与失败数」「状态展示 - 新一轮 taskId 递增且未收敛 - 不沿用旧任务完成统计」「状态展示 - 协调器报告失败 - 不进入 Ready」。
- 事件装配顺序与只读契约：`index-controller.ts:99-170`；测试「自动索引开启 - 注入协调器 - vault 事件订阅先于协调器启动」「关闭自动索引 - 事件触发后仍不读文件不嵌入不写盘 - 目录快照逐字不变」。

## 4. 验收实测数字

**4.1「再次启动且只修改一篇文件时，只有该文件进入嵌入调用」（验收原文）**

合成 4 篇（`a.md`/`b.md`/`c.md`/`d.md`），真实临时磁盘 + 真实 `IndexFileJournal`（真实分片、完成记录、prepared 事务）+ 可计数嵌入端口。探针原始输出：

```text
[probe] 首轮:            {"embeds":["a.md","b.md","c.md","d.md"],"counters":{"committed":4,"committedThisRound":4,"queued":0,"active":0,"pendingTransactions":0,"failures":0,"phase":"ready"},"replaceCalls":4}
[probe] 零变化重启:      {"embeds":[],"counters":{"committed":4,"committedThisRound":0,"queued":0,"active":0,"pendingTransactions":0,"failures":0,"phase":"ready"},"replaceCalls":0}
[probe] 只改 c.md 重启:  {"embeds":["c.md"],"counters":{"committed":4,"committedThisRound":1,"queued":0,"active":0,"pendingTransactions":0,"failures":0,"phase":"ready"},"replaceCalls":1}
```

即：首轮 4 次嵌入 / 4 次向量落盘 → 零变化重启 0 次嵌入 / 0 次落盘 → 只改 `c.md` 时嵌入调用 **1 次且路径为 `c.md`**、向量落盘 **1 次**，其余 3 篇完成记录复用。同一场景的正式用例断言 `embeddedPaths === ['c.md']` 与 `preparedOperations === [{path:'c.md',operation:'replace'}]`（`tests/core/index-task-coordinator.test.ts:703`）。

**4.2 空文件与删除**

- 空文件：完成记录 `state=present`、`chunkCount=0`、`inputHash=sha256('')`；再次启动零嵌入复用。
- 删除：完成记录 `state=deleted`、`inputHash=null`、`chunkCount=0`，块集合清空；第三轮启动不重新嵌入也不重写删除事务。

**4.3 `autoIndex=false` 零写入证据**

探针在真实临时目录上的原始输出：

```text
[probe-ro] {"snapshotEntries":2,"snapshotIdentical":true,"recordsKind":"known","visibleRecords":1,"tombstones":1,
            "ownerLockPresent":false,"visible":["a.md"],"denied":[{"path":"gone.md","reason":"deleted"},{"path":"never.md","reason":"not-committed"}],
            "freshness":"unknown","embedCalls":0}
```

- 目录快照（相对路径 + mtime + 逐字内容）前后**完全相同**（2 个条目：两份完成记录）。
- 嵌入调用 0 次；未创建 `owner.lock`；未解决事务路径由调用方传入的集合过滤（测试断言 `a.md` 被 `unresolved-transaction` 拒绝）。
- 控制器层：`autoIndex=false` 下 `readFile` / `incrementalIndex` / `deleteFile` / `fullReindex` / `smartReindex` / `dropIndex` 全部 0 次调用，写盘替身后端在临时目录里没有产生任何文件（「关闭自动索引 - 事件触发后仍不读文件不嵌入不写盘 - 目录快照逐字不变」）。
- 检索只用可信完成记录：`recordsKind='known'` 时 `a.md` 可见、`gone.md`（tombstone）与 `never.md`（无记录）被拒绝；新鲜度为 `unknown`（不声称已核对当前 Vault）。

## 5. `searchableFileRecords()` 返回 `null` 的处理口径与理由

**口径：失败关闭（deny）。** `null` 表示「不可判定」（记录端口未装配或读取失败），与「空集已判定」严格区分：

- 快照层保留 `recordsKind: 'known' | 'unjudgeable'`（`index-search-visibility.ts:201`、`:240`）；`unjudgeable` 时所有候选以 `unjudgeable` 拒绝（`:421`），而不是以 `not-committed` 拒绝。
- 只读视图构造后未 `refresh()` 时同样是 `unjudgeable`（`:601`），避免「构造即已核对」。

理由：spec A11 要求关闭自动索引时不得假装已核对；把 `null` 当空集会让「记录端口未装配」被静默呈现为「0 篇可检索」，既无法区分故障与空索引，又会把恢复写入的诱惑留在状态之外。失败关闭 + 显式 `unjudgeable` 让调用方（T7）能显示「索引状态未知」，而不是伪造一个合法的空索引。

顺序风险（T7 必须遵守）：`PersistentIndexBackend.fileRecords` 目前仍未注入，`main.ts` 下 `searchableFileRecords()` 返回 `null`。**可见性门与 `fileRecords` 注入必须在同一批装配**，否则检索会全量被拒。

## 6. 未做项与需要 Lead 裁定的事项

**6.1 只读模式无法枚举未决 prepared 事务（需裁定：是否允许改 `index-file-journal.ts`）**

T3 §7 把「只读门面」指派给 T4，但 `IndexFileJournal` 只导出 `listPendingTransactions()` 的**私有**实现，没有任何只读的「列出未决事务路径」入口：`recover()` 需要写所有权（`assertOwned`），`listQuarantinedTransactions()` 只覆盖隔离区。T4 在不改该文件的前提下，只读模式只能拿到：

- 持久路径状态 `listPathStates()`（`quarantined` / `unavailable`，即 T3 已登记的「该路径不得作为检索依据」）；
- 调用方传入的运行期在途集合（`ReadOnlySearchView.refresh(unresolvedPaths)`），可写装配下由协调器 `unresolvedPaths()` 提供。

缺口：**尚未提交 prepared 事务、但向量已替换且路径状态尚未写入**这一类事务的路径，只读模式枚举不到（T3 的写入路径在同一提交内会写 `unavailable` 状态，因此该窗口很窄，但存在）。最小改法（一行方法、纯读、不校验所有权）：在 `index-file-journal.ts` 增加只读 `listPendingPaths(): Promise<string[]>`（读 `pending/*/prepared.json` 的 `next.path`，无 `assertOwned`），T4 不擅自改该文件。

**6.2 `autoIndex=false` 的行为变化需要 T7 配套（跨任务影响）**

按 spec §5/A11「零自动扫描/嵌入/恢复写入」，控制器在关闭自动索引时**不再**把 vault 事件送进增量写路径（旧行为：`FolderWatcher` 始终启动、手动改文件仍增量）。T4 已把它改为内存记录（`IndexController.readOnlyChanged()`）。因此 T7 必须：注入 `ReadOnlySearchView`（否则 `searchVisibilityView()` 为 `undefined`）、显示「需要恢复/未核对」状态、并提供显式的清理/重建入口。用户可见文案与 i18n 仍归 T7；本任务未新增任何用户可见字符串。

**6.3 未做的范围（按任务边界）**

- T5（活动/停滞/取消）、T6（代际/迁移）、T7（宿主装配与 i18n）：未动。协调器的 `phase` 已能表达 `paused`/`partial-failure`/`failed`，但没有活动序号、watchdog 或取消语义。
- `main.ts` 未改（不在 T4 文件列表内）：生产装配仍走既有的 `IndexController(vault, backend, vaultBase)` 三参数形态，因此协调器与只读视图在**生产**尚未生效（默认路径语义完全向后兼容）；`autoIndex=false` 的只读契约变化在生产是即时生效的。
- 未提交 git、未动 node_modules、未访问网络、未读写真实 Vault。

**6.4 其他记录**

- `scanConcurrency > 1` 时嵌入顺序不保证与枚举顺序一致（并发核对的自然结果）。顺序敏感的断言一律使用 `scanConcurrency: 1`；验收用例的两组数字与顺序均在该口径下断言。
- 过期输入的事务结算口径：提交前核对失败时，协调器调用 `journal.cleanup(transactionId)` 主动丢弃自己尚未提交的事务（磁盘仍是旧提交），而不是把前驱留给后继 `prepare` 去结算。因此 T3 的 `prior-version-*` 分支不会被协调器触发；`path-in-flight` 也因「同路径只在单条队列项里串行处理」而不触发（两者仍是日志侧的兜底契约）。
- 复用 T3 契约面：删除凭据经 `listTombstones`/`listSearchableReceipts` 消费；同路径串行 `prepare` 由协调器的单飞队列保证；协调器不重新发明这些语义。
- 协调器的队列上界以「路径数」为界（同路径合并后不超过文件数）；`maxQueueEntries` 是防御性上界，越界事件计数可在 `overflowedEvents()` 观察。
- `PendingTransactions` 计数与 `unresolvedPaths()` 只在 snapshot 之前写入的路径上提供；协调器运行期的未决路径由 `unresolvedPaths()` 直接提供。

## 7. 验证结果

```text
npx vitest run tests/core/index-task-coordinator.test.ts tests/core/index-search-visibility.test.ts \
  tests/core/index-manager.test.ts tests/core/index-controller.test.ts
→ 4 files passed / 96 tests passed

npx vitest run
→ 290 files passed / 2465 passed | 5 skipped（基线 288 / 2400；新增 2 个测试文件，协调器 22 + 可见性 28 + manager +9 + controller +6 = 65 例）

npx tsc -noEmit -skipLibCheck 2>&1 | grep -c "error TS"
→ 241（与 T1～T3 的存量一致，新增 0；`index-controller.test.ts` 的 8 条为存量）

npx eslint src/core/index-task-coordinator.ts src/core/index-search-visibility.ts \
  src/core/index-manager.ts src/core/index-controller.ts
→ 0 error / 0 warning
```

临时目录（`os.tmpdir()` 下的 `ratel-t4-*`）在每条用例的 `afterEach` 中递归清理；失败路径同样执行清理。
---

## Lead 复核、裁定与归属登记（2026-10-31）

本文件此前由实施者写入；以下为两阶段审查（规范符合性 / 代码质量）结论、修复轮结果与裁定。

### 审查结论

| 阶段 | 结论 | 阻断 | 影响 |
|---|---|---|---|
| 规范符合性 | 有条件通过 | 1（exhausted 队列项永不清除，已实测复现） | 5 |
| 代码质量 | 有条件通过 | 0 | 10 |

### 修复轮（两个互斥 subagent）

- **协调器侧**：`index-task-coordinator.ts` 930 → 1262 行，用例 22 → 34。
  - 阻断修复：`exhausted` 三条收敛路径（成功即清除并出队 / 新事件重置预算 / `start()` 重置并重新排队）；探针对照「修复前 committed=1 却 queued=1 永久不可达」→「修复后 phase=ready 且零嵌入复用」。
  - `failures` 口径改为「按路径未清除失败数」（旧累计口径下瞬时失败自愈后 `ready` 恒不可达）；`resume()` 不清除失败（不假装成功）。
  - 队列溢出：记入 `overflowedPaths`、计入 `queued`、阻止 `isReady`、阶段落 `partial-failure`，并由收敛循环回收；**`canMarkReady` 逐字未动**（计划锁定契约）。
  - 协调器口径新增 corrupt/deleted（只读消费日志路径状态与代际隔离），`markVerified` 成为最后闸门。
  - `total` 口径明确为「本轮已知文件数」，收敛后回收 `knownPaths`/`sequenceByPath`/`freshness`。
  - 补「读取后」内存检查点（零额外读盘）并说明与计划原文的等价性。
- **可见性/管理器侧**：全量修复，25 条新用例，每项均有红证（临时还原 → 用例必红 → 还原）。

### 修复后验证

- 全量：`290 files / 2502 passed / 5 skipped`（修复前 2465）。
- `tsc`：241 条存量，新增 0；`eslint`：改动源文件 0 问题。
- Lead 复核时替换了一处同义反复的「反向对照」（`index-search-visibility.test.ts` 原以 spy 回显自身入参充当对照），改为「同一批候选在新鲜度全部 verified 且无删除凭据时整体可见」，证明拒绝来自门的输入而非候选列表本身；替换后该文件 46 passed。

### 裁定与归属登记

| 项 | 裁定 | 归属 |
|---|---|---|
| 只读需过滤「已 prepared、未写 receipt」的未决事务 | 已修：journal 新增纯读 `listPendingPaths()`；查询口径下无 `assertOwned`、无写盘、不动缓存 | 已完成 |
| 「配置已变」必须可判定 | 已修：journal 新增 `countConfigMismatchedReceipts()`；门返回稳定原因 `config-mismatch` | 已完成 |
| `recordsConfig='mismatch'` 时 `recordsKind` 仍为 `known` + 独立信号 | 接受：「已判定当前配置下没有有效记录」比「不可判定」更精确 | 保持 |
| 只读快照默认 5 分钟最大有效期 | 接受；超期按失败关闭（`unjudgeable`） | 保持 |
| 门接线与 `fileRecords` 注入必须同批 | 已落成**双向装配守卫**：未登记新漏点会红，登记项在注入后未删除也会红 | **T7 注入后收缩登记表** |
| `main.ts:1149` 过时注释 | 未改（T7 文件） | **T7** |
| `readOnlyChanged()` 无消费者 | 归 T7 检索侧消费，且应按 `known-stale` 而非 `unresolved-transaction` 处理 | **T7** |
| `failures` 语义由「累计」改为「按路径未清除」 | 接受（是同一实例内 `ready` 可达的必要条件）；T5/T7 若需要「曾经失败过」的累计值须另设计数 | **T5/T7 复核** |
| `queued` 现含「被上界丢弃待回收路径」、`total` = 本轮已知文件数 | T5/T7 复核状态展示文案是否按旧口径写死 | **T5/T7** |
| 隔离路径的解除依赖日志恢复动作 | 安全方向；「谁来清」属 T6 | **T6** |
| `listPendingPaths()` 无法归属「缺失/损坏 prepared.json」的事务 | 已知边界；若要更严格的失败关闭需再增只读信号 | **T6 决定** |
| 两套装配登记守卫冗余 | 接受现状，T7 注入时**合并为一套双向守卫** | **T7** |
| 过期重排不消耗 `maxReadAttempts` | 每轮都由真实事件驱动且有 await IO；极端持续编辑下的停滞判定属 T5 | **T5** |
| 测试用例写入 `tests/core/persistent-index-backend.test.ts`（超出可改清单 1 处） | 接受：I7 证据必须复用该文件的真实磁盘/Worker 夹具，且该文件当时无并发编辑者 | 保持 |

# T6 证据记录：配置代际与旧索引迁移

> 本文件是 P-INDEX-RELIABILITY 的 T6 执行证据。数字均为本机实测；未接线项与移交给 T7 的前置条件明确标注。
> 前置证据：[T0](2026-10-31-index-reliability-t0-evidence.md)、[T1/T2](2026-10-31-index-reliability-t1-t2-evidence.md)、[T3](2026-10-31-index-reliability-t3-evidence.md)、[T4](2026-10-31-index-reliability-t4-evidence.md)、[T5](2026-10-31-index-reliability-t5-evidence.md)。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线：T5 提交 `db1fa03`

## 1. 结论

T6 完成，7 个 checkbox 落地（其中 4 项经审查判为「部分通过」，缺口已在本轮或明确移交 T7 处理）。全量 **292 文件 / 2669 passed / 5 skipped**；`tsc` **241 条存量、新增 0**。

**计划的核心验收已达成**：升级一个有效且未变化的旧索引时，**嵌入调用数为 0**（迁移引擎结构上不接嵌入端口；用例用可计数端口 + `verifyReceipt` 双重证明，并有「未迁移目录会真实调用嵌入」的对照证明计数非恒真）。

| 产物 | 规模 |
|---|---|
| 新建 `src/core/index-generations.ts` | 约 2230 行 |
| 新建 `tests/core/index-generations.test.ts` | 74 例 |
| 修改 `src/core/index-manifest.ts` / `index-build-stamp.ts` | +60 / +62 |
| 修改 `src/core/persistent-index-backend.ts` | 702 → 约 980 行（含 T5 登记债接线） |
| 修改 `src/adapters/vector-vectra.ts` | 766 → 约 880 行 |

## 2. 目录布局（已实测）

```
.index/
  control.json                schema 2 + activeGenerationId + generations 表
  owner.lock                  T2
  owner.recovery.lock         T2
  generations/
    gen-<fingerprint[0:16]>/
      generation.json         入口（归属校验依据）
      config.json             代际配置快照
      index.json / catalog.json / <uuid>.json    Vectra 数据
      files/<pathHash>.json   T3 完成记录
      pending/                T3 事务
      quarantine/             T3 隔离（<pathHash>.json / generation.json / transactions/<id>/）
      migration.json          迁移可重入进度
```

递归删除只有两个入口：`dropSafeGeneration`（三重归属校验：拒绝 `.index` 根与 `generations/` 聚合目录、`dirname` 必须等于 `generationsRoot`、目录名须为 `gen-<16hex>`、入口记录形状自洽且已登记 `control` 且非活动代际）与 `VectraStore.dropIndex()`（形状白名单守卫）。其余 `recursive rm` 均由 T3 的 `assertPathWithinRoot` + `assertSafePartName` 约束。

## 3. 两阶段审查与修复

| 阶段 | 结论 | 阻断 |
|---|---|---|
| 规范符合性 | 有条件通过 | 2 |
| 代码质量 | 有条件通过 | 2 |

四个阻断与其修复：

1. **旧清单 `chunkerVersion` 被当前配置补造（违背 spec）**：原实现回退当前值 → 「旧身份 === 当前配置」恒真 → 旧分块器产出的块被判可复用，且 receipt 的 `blockSetHash` 由迁移自算，**后续 `verifyReceipt` 必然匹配，错误永不可发现**。修复：缺失即身份不可确认，走 `config-identity-unconfirmed`，**整个 `.index` 目录都不建**（定向复审独立确认：`published=false`、`files=[]`、旧目录摘要逐字不变）。
2. **`index.batch` 的迟到终态不落盘却回调报成功**：原批提交闭包只改内存，落盘在调用方，等待因停滞结束时永不执行。探针证据：回调报 `indexed:1`，而磁盘清单未更新、构建戳为 null。修复：迟到路径从磁盘真值重载后落盘；定向复审确认回调触发时磁盘已是最终态。
3. **`pendingWrites` 以 taskId 为键**：协调器 `taskId` 轮内恒定 → 同轮第二个写请求覆盖前一个上下文 → 旧终态用新请求的 commit 执行、新请求自己的终态永不提交。修复：每请求唯一键 + 重复键显式抛错。
4. **递归删除守卫未在唯一 `rmSync` 边界闭合**：`dropStore()` → `VectraStore.dropIndex()` 无任何归属校验。修复：适配器硬守卫 + 后端归属断言（注入端口优先）。

修复轮还处理了 9 项影响与多条建议，其中值得记录的三条：

- **删除路径写放大**：单文件删除 2 → **1** 次写盘；一轮删 N 个文件 N+1 → **1** 次。
- **O(N²) 迁移枚举**：新增 `inspectFiles(paths)`（一次 `listItems()` 分组）；实测 3 路径从 3 次全枚举 → **1 次**；迁移侧合规对接并在缺失/失败时回退逐条。审查者实测原曲线：250 文件 6.4ms → 500 → 24.8ms → 1000 → 96.3ms → 2000 → 365.4ms。
- **O(N²) 状态写盘**：`copyLegacyFiles` 改为按 16 文件 / 256KiB 阈值刷新；实测 42 个文件从 42 次 → **3** 次。

## 4. 定向复审（第三轮）

修复轮之后做了定向复审，结论「有条件可信」：**4 个阻断经独立构造的输入/探针全部确认关闭**，并发现 2 项高影响缺口 + 若干中低项；随后又做了一轮补强，全部关闭：

| 补强项 | 修复前（实测） | 修复后 |
|---|---|---|
| 缺省 `dropIndex` 守卫非白名单 | pluginDir 形状目录（`main.js`/`data.json`/`attachments`）被**静默递归删除**（`main.js 仍在=false`） | 收紧为形状白名单（不存在 / 空 / 含 `index.json`、`generations/`、`control.json` 之一才允许）；pluginDir 形状被拒且**零删除**；合法索引目录仍可删 |
| `getEpoch` 缺省 fail-open 且告警默认不可见 | `debugLog:false` 是缺省 → 实测 `console.warn` 调用数 0，「不静默放过」不成立 | 结构化暴露 `roundState().epochSourceMissing`；**T7 必须注入 `getEpoch`** 才能关闭 |
| `assertWritable` 遗漏 | `writeGenerationConfig` / `writeGenerationEntry` 在 owner 不可写时**均成功写盘**（与类注释矛盾） | 两者补断言；孤儿回收的递归删除在动作紧邻处再断言（关 TOCTOU 窗口） |
| 逆序投递未 settle-once | 逆序时 `manifest.save` 被调用 **2 次**、磁盘 keys=`[]` | 批量子路径结算后核对本批是否真落在工作副本上，否则从磁盘真值重建；逆序与正序均 **1 次** |
| 「batch 成功 + 删除停滞」清单镜像落后 | 迟到删除落盘后本轮 batch 条目丢失（磁盘 keys=`[]`） | 混合轮进入删除前先落一次批量结果；写盘次数为**常数 2**（仅删除轮仍 1 次），未回到 N+1 |

补强取证方式：把当前源码复制到隔离 `/tmp` 目录、逐条还原 5 项修复 → **8 个新增/扩展用例全部失败**；修复后同一批全绿。

## 5. flaky 处理

审查者在 4～6 次全量里复现到低频失败（`tests/adapters/vector-vectra.test.ts`、`tests/worker/handler.test.ts`、`tests/worker/index-processor.test.ts`），根因是**固定共享临时目录** `tests/tmp/<固定名>` + 整目录 `rmSync` 在并发负载下互相踩。用 `git archive HEAD` 快照做基线对照确认**不是 T6 模块代码**引起。修复：这三处全部改为每例 `mkdtemp` + `afterEach`。修复后连续多次全量（含并发负载）未再复现。

`tests/tmp/` 下遗留 3 个陈旧目录（mtime 均早于事故时间，当前测试已不再写入），属 gitignored 垃圾，由 T8 清理。

## 6. 过程事故：共享 worktree 上的 `git stash`

代际侧 subagent 为量 tsc 基线，对**被并行占用的共享 worktree** 执行了一次 `git stash -q -u` + `pop`，并删除了后端侧 subagent 的临时探针文件。

复审的独立评估：**未造成可检出损失，但存在不可证的窗口**——依据为 `git stash list` 为空、`refs/stash` 不存在、`git status` 无任何已跟踪文件被删除、两位 subagent 的 6 个文件全在位且行数一致、三个源文件无冲突标记、相应测试全绿；唯一无法证实的是**他人未跟踪临时文件的内容完整性**（未跟踪文件不留 git 痕迹）。

纪律：后续任务书一律写明「**不得在共享 worktree 上执行 `git stash`/`checkout --`/`restore`/`reset`；需要基线用 `git archive HEAD` 到独立临时目录**」。

## 7. 裁定

| 项 | 裁定 |
|---|---|
| `upgrade` 模式在「已有活动代际」时拒绝发布 | 接受；首次建库仍允许 building 发布（spec §5「首个文件持久提交后原子登记」）。若要禁止任何 building 发布需新增状态并改 spec 措辞 |
| 删除 `default-limit-reached`、`orphan-blocks`、`countCopies`、`migrationPhase`/`phase` | 接受（与「一个都回收不了」同条件、或只写不读）；T7 若需迁移阶段进度用仍导出的 `MigrationResult.phase` |
| 结构元数据只校验「起点随 chunkIndex 单调不倒退」，**不要求相邻区间不相交** | 接受：旧分块器按 `chunkOverlap` 故意共享尾部，要求不相交会把合法旧索引整体误判重算；已写入代码注释 |
| 迁移写入自实现等价 flush（未复用 T1 `flushPath`） | 接受：T1 的 `flushPath` 把目标限制在单个 generationRoot 内，而 `control.json` 在 `.index/` 根；目录 fsync 采用了与 T1 相同的降级码表 |
| 缺省 `dropIndex` 守卫只到「形状白名单」 | 接受为过渡态；**严格版必须由 T7 注入** |
| `getEpoch` 缺省保留告警而非硬拒绝 | 接受（硬拒绝会让现网装配全部失败）；**T7 必须注入** |
| `deleteVectors` 用必填 `stamp` 形参而非对象参数 | 接受（可变元组的歧义已消失） |
| 文件体积（2230 行）本轮不拆 | 接受；拆分建议已记录（types / control / lifecycle / reclaim / legacy+migration / atomic-json-write） |

## 8. 移交给 T7 的硬前置（必须关闭）

1. **目录切换（硬依赖）**：`main.ts` 必须把 `VectraStore` / `PersistentIndexBackend` / `AtomicIndexStorage` 的目录从 `.index` 根切到 `generations/<activeGenerationId>`；`src/worker/handler.ts` 的 `initProcessor` 同。否则一次全量或手动重建会递归删除 `control.json`、两个锁文件与全部代际。
2. **注入 `assertDropOwnership` 严格版**（basename 必须是本索引根 `generations/` 下的 `gen-[0-9a-f]{16}`），缺省只到形状白名单、会把 pluginDir 形状目录删光。
3. **注入 `getEpoch: () => owner.epoch`**，否则 `roundState().epochSourceMissing` 恒 true、旧实例活动不被校验。
4. 装配 owner 后重跑「参数变更重建 / 手动 reindex」：`.index/` 根此时含 `owner.lock`（+`control.json`/`generations`），缺省守卫会拒绝根目录的 `dropIndex`，必须确认严格断言指向**代际目录**而非根。
5. 消费 `MigrationResult` 的新结论面：`statePersisted`、`orphanDirectories`、`quarantinedTransactions`、`GenerationRecord.verifiedAt`/`quarantineReason`、`IndexRoundState.epochSourceMissing`。
6. 新错误码的 zh/en 文案：`index-directory-not-owned`、`drop-refused`、`owner-not-writable`（现在会经 `String(err)` 直接进 Failed 状态）。
7. 迁移的「不可复用文件」目前只标记 `reindex`，**逐文件检查点由 T4/T3 机制在接线后生效**；`IndexGenerations`/`migrationLegacyIndex` 目前在 `src/` 内**零生产调用方**，A9/A10 与「首个文件提交即登记活动代际」只有库级证据。
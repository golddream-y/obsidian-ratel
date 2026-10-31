# T1/T2 证据记录：持久契约、原子存储与安全替换

> 本文件是 P-INDEX-RELIABILITY 的 T1（持久数据契约与原子存储）与 T2（写所有权与安全替换）执行证据。
> 数字均为本机实测；未验证项明确标注。T0 的证据见 [T0 证据记录](2026-10-31-index-reliability-t0-evidence.md)。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线：T0 提交 `b2204fd`（其父 `6b9da92` 为文档导入，`09028bc` 为 develop）

## 1. 结论

| 任务 | 状态 | 全量验证 |
|---|---|---|
| T1 持久数据契约与原子存储 | 完成（4 个 checkbox 全部落地） | 定向 92 passed（61 + 31） |
| T2 写所有权与安全替换 | 完成（4 个 checkbox 全部落地，T0 的 6 个缺陷断言已翻转） | 全量 287 文件 / 2336 passed / 5 skipped |

`npx tsc -noEmit -skipLibCheck` = **241 条存量**，本轮新增 0 条（`main.ts` 3 条为存量，行号因插入位移）。

## 2. T1 交付

新增 `src/core/index-persistence-types.ts`（约 830 行）与 `src/adapters/atomic-index-storage.ts`（约 690 行），测试 61 + 31 例。

- **契约**：`FileCommitBase` / `FileCommit`（`present` / `deleted` 判别式）/ `PreparedFile` / `IndexPhase` 与计划片段逐字一致；`generationId`（目录身份）与 `configFingerprint`（配置身份）并列且分别校验。
- **配置指纹**：7 字段显式白名单按固定顺序序列化后 SHA-256；凭证（`apiKey`/`baseUrl`）与临时任务状态（`taskId`/`phase`/`completedUnits`）是构造性排除（塞入后指纹不变）。
- **校验矩阵**：未知 `schemaVersion`、路径越界（绝对/空/NUL/`..`/解析逃逸/符号链接逃逸）、指纹不匹配、非有限向量、重复块 ID、损坏 checksum、分片缺失/多余/计数不符——均按稳定错误码拒绝，24 个错误码集中为 `as const` 元组。
- **原子写**：`wx` 临时文件（同目录唯一名）→ 写入 → 文件 fsync → close → rename → 目录 fsync；写失败清理不遮蔽原始错误。
- **四类故障注入**实测：短写（循环补齐 → `renamed`）、短写 0 字节 / ENOSPC / rename `EACCES`（→ 完整旧版 + `failed-before-rename`）、rename `EIO`（→ `unknown-after-rename`，磁盘可能是新版）、目录 sync `EIO`、`openDirectory` `EPERM`（平台不支持降级成功）。**不存在半截文件**：失败后重新读回必为完整旧版或完整新版。
- `deleteFolder` 拒绝代际根；`createTempPath` 结果二次校验包含性（拼接路径不会落到根外）；`flushPath` 提供显式落盘（T3 写 receipt 用）。

## 3. T2 交付

新增 `src/core/index-write-owner.ts`（约 1887 行）与测试 48 例；修改 `vector-vectra.ts`、`worker/index-processor.ts`、`persistent-index-backend.ts`、`main.ts`、`worker/handler.ts`。

- **`replaceFile` / `inspectFile` / `reload`**：删除与插入在**同一** `beginUpdate/endUpdate` 内完成；空数组也完成删除；每块写 `commitId`；枚举全部走 `listItems()`（零向量相似度查询已从生产路径移除）。
- **`documentId` = 块 ID**：三条写入路径一致（曾误写成文件路径，会让 `indexBatch` 的 `topK` 从片段级变成文件级，已回退并有断言锁定）。
- **三个索引入口统一**：`indexFull` / `indexIncremental` / `indexBatch` 都走 `reembedFile` → `replaceFile`，空内容提交「零块替换」。这修掉了 live-edit 路径的幽灵块（实测：修复前 12 块缩短为 1 块后**仍剩 12 块**且清单已按新计数写入）。
- **T0 的 6 个缺陷断言已翻转为通过**，断言强度保持「数量 + 块 ID 集合」；新增 201 块用例（直接观察 `deleteItems` 实收 ID 集合）与「其他文件完整块集合（ID/向量/metadata）不变」用例。
- **单文件增量落盘 2 次 → 1 次**（基线用例断言 `toHaveLength(1)`）。
- **写所有权**：`Symbol.for('ratel.index.write-owner.v2')` 注册在 `globalThis`，以规范化根目录为 key；接管撤销前任 epoch、等待 closing、永久挂起只报占用；owner 锁排他创建并记录进程身份/实例令牌/协调器版本；创建/释放/回收**都经过同一排他恢复门**，门内重读核对旧令牌；**无 TTL/过期抢锁**。
- **原子 + 排他同时满足**：进入目录项用 `link` 而非 `rename`（`link` 在目标存在时以 EEXIST 原子失败，`rename` 会覆盖）；平台不支持硬链接时按稳定错误码失败，不退化成建空文件。
- **真实跨进程用例**：`node --experimental-strip-types` 跑临时脚本、import 同一份实现，父进程持锁时子进程得 `owner-busy`、释放后取得；另有 4 进程并发抢占恰 1 个成功且绝不出现 `owner-lock-corrupt`。
- **损坏锁/门不再永久占用**：默认仍拒绝（不自动抢锁），提供显式隔离 API（`quarantineCorruptOwnerLock` / `quarantineCorruptRecoveryGate`，需 `confirm: true`）。
- **生产装配**：5 个 `new VectraStore` 构造点全部注入 `AtomicIndexStorage`，由源码守卫用例锁定（新增构造点缺 `storage:` 即失败）。

## 4. 两阶段独立审查与修复

| 任务 | 规范符合性 | 代码质量 | 阻断 | 影响 |
|---|---|---|---|---|
| T1 | 有条件通过 | 有条件通过 | 0 | 规范 4 + 质量 7 |
| T2 | 有条件通过 | **不通过** | 3 | 规范 5 + 质量 9 |

T2 的三条阻断均已关闭并复验：

1. **B1 live-edit 幽灵块**——`indexIncremental`/`indexFull` 改为统一走 `replaceFile`，并补变短/变空/清单一致用例。
2. **B2 锁与门非原子写导致永久占用**——改为临时文件 + fsync + `link` 落项；损坏文件走显式隔离，不再永久占用。
3. **B3 生产未注入原子存储 + `needsReload` 单向闩**——5 个构造点全部注入；失败分支自动 `reload()`，重载失败则中止本批并如实计数（不得把未处理算成已索引）。

修复轮额外发现并修正：`VectraStore.init()` 声称幂等但第二次调用不 await 同一 promise（真实陷阱，已改 `this._ready ??= …`）；`classifyOwnerLock` 的根目录逐字比较会在符号链接/大小写差异下误判 corrupt（已加规范化比较）；门句柄「先标记后删除」导致释放失败后门仍在磁盘；`only-throw-error` 触发的 lint 失败。

实施者对所有修复做了**负向验证**（逐个还原修复，确认对应用例真的转红），覆盖 I2/I3/I4/I6 与原子性窗口。

## 5. 后续任务的硬约束

1. **T3**：写操作必须走 `IndexWriteOwner` 门面（先 epoch 再锁）；prepared 校验要求 `next.revision > previousRevision`（单调，不要求 +1）且 `sum(parts[].count) === next.chunkCount`；`deleted` 记录的 `blockSetHash` 固定为 `EMPTY_BLOCK_SET_HASH`；receipt 写完后用 `flushPath` 强制落盘。
2. **T6**：`dropIndex()` 目前仍 `fs.rmSync(索引根, { recursive:true })`，会绕过原子存储的代际根保护与锁/门文件。一旦 `.index/` 根下承载 `control`/`owner`/`generations`，该路径必须改为「只清理代际内部」，**绝不可递归删除 `.index/` 根**。
3. **T7**：坏锁/空锁/外机锁按 spec 保守拒绝且不自动回收，需要用户可见的处置入口；协调器版本不符应呈现为「占用/暂不可写」而不是重试循环；可能的 `IndexValidationError` 错误码需映射 i18n。
4. **T8**：`tests/helpers/index-reliability-production.ts` 目前未注入 storage，用它验证「提交失败可判别」前必须补注入，否则会重演「状态不明」；轻微变化时 `replaceFile` 落盘 0 次，断言「单文件提交只落盘 1 次」需把无变化计为 0 次；基准需在同一空载口径下与 T0 对比（T0 是带载采集）。
5. **`tests/**` 不在 eslint 覆盖内**（`eslint.config.mts` 的 ignores），测试质量只能靠 `tsc` 与人工审查，不能以 lint 通过作为测试质量证据。
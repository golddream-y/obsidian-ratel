# T0 证据记录：Vectra 原子替换能力验证

> 本文件是 P-INDEX-RELIABILITY 的 T0 执行证据，供 T1 起实施与 T8 复测引用。所有数字来自本机实测，不是设计推断；未执行的项目明确标注「未验证」。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线提交：`09028bc`（develop）
- 环境：Node v24.11.0 / npm 11.6.1 / macOS 桌面端 / 系统临时目录
- 产物（未提交时）：`tests/adapters/vector-vectra-atomicity.test.ts`、`tests/helpers/index-reliability-fixture.ts`

## 1. 结论

公开 API 足以实现 T0 要求的「完整枚举 + 同事务替换 + 原子存储注入」，**门槛成立，可进入 T1**。现有实现存在 6 个已固化的缺陷，其中 1 个会导致数据丢失。

复跑命令与结果：

```bash
npx vitest run tests/adapters/vector-vectra-atomicity.test.ts   # 6 failed（预期失败）/ 18 passed
npx vitest run tests/adapters/vector-vectra-baseline.test.ts    # 2 passed / 5 skipped（重负载默认跳过）
npx vitest run tests/adapters/vector-vectra.test.ts             # 17 passed，无回归
```

基线采集已从原子性测试拆到 `tests/adapters/vector-vectra-baseline.test.ts`（审查修复轮，见第 10 节）：
原子性文件只保留缺陷固化、行为记录、实验路径、存储注入与门槛守卫，两个文件可独立运行。

大样本基线由 `RATEL_T0_BASELINE=1` 门控，默认测试不执行（约 14 分钟）；
512 维写入量对比由 `RATEL_T0_DIM512=1` 门控（约 3.4 秒，见第 10 节）。

## 2. 已固化的现有缺陷

6 个用例断言正确行为、当前实现必然失败；未使用 `skip` / `it.fails` 掩盖。

| # | 用例 | 实测结果 | 期望 | 后果 |
|---|---|---|---|---|
| 1 | `deleteByPath` 单文件 150 块 | deleted=100，remaining=50 | 150 / 0 | 旧块残留 |
| 2 | 目标块位于索引数组第 100 项之后 | deleted=0，remaining=30 | 30 / 0 | 完全删不掉 |
| 3 | `indexBatch` 文件变短 | remaining=30 | 7 | 幽灵片段 |
| 4 | `indexBatch` 文件变空 | remaining=20 | 0 | 旧内容仍可被检索 |
| 5 | 768 维 + >100 块 | remaining=25 | 13 | 维度混写叠加漏删 |
| 6 | 推理阶段失败 | remaining=0 | 6 | **旧版本已删除，数据丢失** |

机制证据（由「行为记录」用例给出，当前实现下通过）：

- `deleteByPath` 用 512 维全零向量做 `queryItems(..., 100)`。零向量范数为 0，余弦恒为 `NaN`，堆比较恒 false，`topK` 退化为「索引数组前 100 项」，与相似度、文件归属无关。
- 调用链 `PersistentIndexBackend.smartReindex → index.batch → IndexProcessor.indexBatch → reembedFile → deleteByPath → 分块/embed`；推理回调执行时该路径磁盘块数已为 0（先删后推理）。
- vectra 不校验向量维度，512/768 混写被接受。
- 外置 metadata 场景下，`path` 未列入 `metadata_config.indexed` 时 `listItems` / `listItemsByMetadata` 都拿不到 path（删除枚举约束）。

## 3. 原子替换实验

| 项 | 实测 |
|---|---|
| 落盘时机 | 事务期间 `index.json` 字节完全不变；`endUpdate` 先写 `index.json`、再写 `catalog.json`，各一次 rename |
| 写入前失败 | 原索引文本与字节逐字节一致，无 `.tmp-` 残留 |
| rename 后抛错 | 磁盘=新版、内存=旧版；`_update` 未清空，同实例 `beginUpdate` 抛 `Update already in progress`；`cancelUpdate` 不重读磁盘；只有重建实例才能读到新版 |
| 错误包装 | 抛出的错误被包装为 `Error saving index: ...`，原始类型丢失，调用方无法据此区分「提交前失败」与「rename 后状态不明」 |
| catalog 失败 | index 已提交（磁盘+内存新版），catalog 失败 → index 与 catalog 不是跨文件事务 |
| 回滚 | 删除+插入后抛错再 `cancelUpdate`，磁盘与内存均为完整旧版本，无新块残留 |
| 外置 metadata | `upsertItem` 阶段即落盘（早于 `endUpdate`）；事务取消后成孤儿；`deleteItems` 不回收 |

## 4. 基线（确定性假嵌入 64 维，分块 maxTokens=100 / overlapTokens=20 / 字符计数）

| 样本 | 三次耗时(ms) | 中位 | 峰值 heap | 峰值 RSS | 索引文件 | 零变化启动 | 单文件更新 | 写入次数/字节 |
|---|---|---|---|---|---|---|---|---|
| 100 | 296 / 295 / 288 | 295 | 163.0 MiB | 372.9 MiB | 471.5 KiB | 14 ms，嵌入 0 | 29 ms，嵌入 1/4 文本 | 101 次 / 21.7 MiB |
| 1000 | 22027 / 26878 / 25357 | 25357 | 85.4 MiB | 377.8 MiB | 4.6 MiB | 447 ms，嵌入 0 | 385 ms，嵌入 1/4 文本 | 1001 次 / 2.1 GiB |
| 3000 | 205412 / 185235 / 194605 | 194605 | 111.3 MiB | 610.5 MiB | 13.9 MiB | 683 ms，嵌入 0 | 693 ms，嵌入 1/4 文本 | 3001 次 / 19.0 GiB |

写放大 ≈1300×（每文件一次全量重写）。

口径限制（必须在 T8 继承）：

- **两组数字来源不同，不得混为一个口径**：耗时、峰值 heap/RSS、嵌入调用次数来自生产链路（`runProductionIndex`：`VectraStore` + `InlineWorker` + `PersistentIndexBackend` + `IndexManager`）；「写入次数/字节」来自 `LocalDocumentIndex` + `AtomicTestFileStorage` 的等价事务循环（生产 `VectraStore` 没有 storage 注入点）。等价循环只证明 vectra 的持久化行为，不是生产链路直接测得的数字。
- 维度用 64 而非生产 512（`src/adapters/embedding-onnx.ts:77`），字节量低估约 8 倍；100 篇 512 维探针为 1.48 s，未入表；512 维字节量比值由第 10.1 节的门控用例复现。
- 1000/3000 运行期间有并行短测试，方差 22–27 s（约 10%）；写入量在独立空载 run 复测。
- **耗时不可复现**：审查者复跑 100 篇为 597/476/481 ms（中位 481 ms），写入量 101 次 / 21.7 MiB 与索引 471.5 KiB 完全一致，说明差异只来自负载与冷热缓存。T0 是带载采集，T8 计划空载复测；直接对比会让 1.25×/1.5× 门槛偏松。T8 必须**同一口径**（空载、单进程、固定冷/热）做 A/B。
- `maxTokens=100` 是测试配置，不是生产默认分块；本表的绝对耗时与字节**不得当作生产启动数字**引用。
- 旧缺陷路径失败单独记录，未混入成功基线。

## 5. 写放大归属（Lead 核实，已按审查订正）

写放大**不是本计划引入的**，但两条路径的写入次数不同：

| 路径 | 每次文件更新写 `index.json` | 原因 |
|---|---|---|
| 全量 `IndexProcessor.indexFull` | 1 次 | 每文件一次 `beginFileUpdate` → `endUpdate` |
| 增量 `IndexProcessor.reembedFile` | **2 次** | 先调 `deleteByPath`，它在事务外经 `deleteItems` 由 vectra 自行 `begin/endUpdate` 提交一次（`LocalIndex.js:180-195`）；随后 upsert 事务再提交一次 |

`endUpdate` 每次全量重写 `index.json`（`LocalIndex.js:208`）。因此 19 GiB 是现网已付出的成本，增量路径还多一倍。

本计划约束：T1/T2 不得增加每提交写入次数；**T2 必须把删除与插入合并进同一事务，把增量路径从 2 次降为 1 次**，并在 T8 断言单文件提交只落盘 1 次。T8 用 512 维实测并如实报告，不以「换存储」作为本轮手段（spec 明确不换数据库）。

## 6. 外置 metadata 适用范围（Lead 核实）

现网不会产生 metadata 孤儿：生产 `createIndex()` 不传 `metadata_config`，`indexed` 为空数组，vectra 只在 `indexed` 非空且存在非索引键时才写外置 metadata 文件（`LocalIndex.js:509-527`）。该风险仅在将来启用 `metadata_config.indexed` 时成立，作为前置条件记录。

## 7. T1 必须继承的实测约束

1. 生产 `VectraStore` 目前没有 storage 注入、全量枚举与替换入口，T2 补；T1 只做适配器与契约。
2. vectra 不校验维度与向量合法性（非有限值、维度不一致都被接受），T1 自行校验。
3. `endUpdate` 的错误被包装，且失败后同实例不可继续；storage 层必须自行记录结果以区分「提交前失败」与「rename 后状态不明」，并强制重建实例。
4. `LocalFileStorage(rootFolder)` 会与 vectra 传入的绝对路径二次拼接，生产适配器**不要传 root**。
5. index 与 catalog 是两次独立写入；提交语义只能建立在 `index.json` 上，不能宣称跨文件事务。

## 8. 遗留风险与裁定

| # | 风险 | 裁定 |
|---|---|---|
| 1 | 写放大 3000 篇 19 GiB / 3.2 分钟 | 不阻断。存量成本；本计划不得增加每提交写入次数；T8 用 512 维实测并记录绝对值 |
| 2 | 基线用 64 维 | T0 数据保留为相对比较口径；512 维复测归 T8；T1 起夹具统一 512 维 |
| 3 | `LocalFileStorage(rootFolder)` 二次拼接 | T1 硬约束：不传 root，只接受绝对路径 |
| 4 | 外置 metadata 孤儿 | 现网不适用（见第 6 节），记录为将来启用 indexed 配置的前置条件 |
| 5 | 3000 篇约 10% 方差 | 门槛一律用相对值；T8 在空载机器复测，禁止用并发跑的数值过门 |

## 9. 两阶段独立审查记录（2026-10-31）

按 plan 要求执行「先规范、后代码质量」两阶段审查，审查者均只读、未改文件、未提交。

| 阶段 | 结论 | 阻断 | 影响 | 主要发现 |
|---|---|---|---|---|
| 规范符合性 | 有条件通过 | 0 | 8 | 守卫用例偏弱；3 个失败用例只断言计数不断言块身份；1000/3000 写入量来自等价循环而非生产链路；**增量路径实际 2 次全量落盘**（`deleteByPath` 在事务外提交）；512 维数据点不可复现 |
| 代码质量 | 有条件通过 | 0 | 10 | `process.cwd()` 定位仓库文件；守卫依赖 vectra 内部路径与英文文案；夹具含零引用导出与 `delayMs` 计时赛跑；基线代码与实验证据混在一个 1018 行文件；`runProductionIndex` 清理不在 `finally` |

两项审查都独立复跑了测试（6 failed / 19 passed / 4 skipped，`vector-vectra.test.ts` 17 passed），并回到 vectra 源码核实原子行为与 metadata 结论。

审查后新增的硬约束：

1. **T0 不得单独合入**：6 个预期失败用例会让 `npm test` 在 T2 之前保持红色。T2 修复生产路径时把这 6 个断言转换为通过断言，在此之前只允许在分支上推进。
2. 增量路径的 2 次落盘必须在 T2 消除（删除与插入进入同一事务），T8 断言单文件提交只落盘 1 次。
3. 守卫用例需覆盖 `src/worker/index-processor.ts`，且不能依赖 vectra 内部路径或上游英文文案。
4. `tests/**` 在 `eslint.config.mts` 的 ignores 内，测试代码只有 `tsc` 与人工审查兜底，不能以 lint 通过作为测试质量证据。

## 10. 审查修复轮：落地与实测（2026-10-31）

第 9 节审查意见的落地结果。**6 个预期失败用例仍然失败**，本轮没有把任何缺陷断言改成通过、没有 skip、没有放宽断言；改动只涉及可移植性、断言强度、夹具质量与可复现性，`src/` 未改动。

### 10.1 512 维写入量（门控用例）

命令与结果：

```bash
RATEL_T0_DIM512=1 npx vitest run tests/adapters/vector-vectra-baseline.test.ts -t '512 维'
# [T0 512 维] 样本=100 | 64维=21.7 MiB | 512维=157.5 MiB | 比值=7.25
```

同一份合成数据、同一套分块与事务循环，只改向量维度。比值 7.25 低于 8，因为块 ID 与 metadata 不随维度增长；用例断言区间 `(6.5, 9.5)`，同时排除「没写向量」与「维度没生效」两种退化。默认不跑（保持默认测试快），门控变量写在用例标题里，随时可按上面的命令复现。

### 10.2 增量路径落盘次数（默认执行，通过）

`reembedFile` = `deleteByPath`（事务外，`deleteItems` 自行 `beginUpdate`/`endUpdate` 提交一次）+ `beginFileUpdate`/`endFileUpdate`（提交一次）⇒ 单文件增量落盘 **2 次**。

用例 `单文件更新 - reembedFile 先删后写 - 索引文件落盘 2 次` 实测：阶段 1 直接 `deleteByPath` 后 `index.json` 写入 1 次；阶段 2 走生产 `indexBatch` 单文件后 2 次。计数方式为拦截 vectra `LocalFileStorage.upsertFile` 原型并调用原实现，只观察真实落盘，不改行为、不访问私有字段。

### 10.3 断言强度

- 三个只比剩余数量的缺陷用例改为「数量 + 块 ID 集合」同时断言。实测残留证明旧块确实还在：文件变短用例 `expected=7 / remaining=30`，残留 `#chunk-7`～`#chunk-29`；768 维用例 `expected=13 / remaining=25`，残留 `#chunk-13`～`#chunk-24`；推理失败用例 `remaining=0`、ID 集合为空（数据丢失的直接证据）。
- 空文件用例同步补 `remainingIds=[]`，不再只断言计数。

### 10.4 门槛守卫

- 覆盖 `src/adapters/vector-vectra.ts`、`src/worker/index-processor.ts`、`tests/helpers/index-reliability-fixture.ts`、`tests/helpers/index-reliability-production.ts`、原子性测试与基线测试；检测点访问、下标访问（单/双引号/模板）与解构三种形式；正则不带 `g`/`y`，`test` 无 `lastIndex` 状态。
- node_modules 守卫改为「`vectra/package.json` 版本落在仓库声明的 caret 范围内 + 包目录内无补丁文件/项目名痕迹」，并明确标注为**记录性断言**：它不能证明 node_modules 未被原地修改，权威校验是用 lockfile 重装（`npm ci`）后比对 integrity。不再依赖 `lib/LocalIndex.js` 内部路径与上游英文文案。

### 10.5 可移植性与清理

- 守卫用例的仓库文件定位改为 `fileURLToPath(new URL(..., import.meta.url))`，不再依赖 `process.cwd()`。
- `runProductionIndex` 的 `sampler.stop()` / `worker.destroy()` 移入 `finally`；装配中途失败也会销毁 worker。
- 夹具删除零引用导出 `createCountingEmbeddingsModel` / `CountingEmbeddingsModel` 与 `delayMs` 选项；`failWhenTextMatches` 拒绝带 `g`/`y` 的正则并在匹配前重置 `lastIndex`；受保护的非空断言改为局部变量。
- 「合成 Vault + 生产链路装配」上移到 `tests/helpers/index-reliability-production.ts`（`createSyntheticVault` / `createProductionIndexStack` / `runProductionIndex`），T8 的崩溃/规模测试可直接复用。
- 基线段拆到 `tests/adapters/vector-vectra-baseline.test.ts`，与原子性测试互不依赖。

### 10.6 复跑计数

| 文件 | 用例数 | 结果 |
|---|---|---|
| `vector-vectra-atomicity.test.ts` | 24 | 6 failed（预期失败）/ 18 passed |
| `vector-vectra-baseline.test.ts` | 7 | 2 passed / 5 skipped |
| `vector-vectra.test.ts` | 17 | 17 passed |

`npx tsc -noEmit -skipLibCheck`：本轮新增/修改文件 0 错误（仓库存量 241 条不计）。

## 11. 修复轮遗留项的裁定（Lead，2026-10-31）

| # | 待裁定项 | 裁定 | 理由 |
|---|---|---|---|
| 1 | `MemorySampler` / `formatBytes` / `median` / `generateSyntheticNotes` 留在夹具而非迁入基线测试 | 维持现状 | T8 复用的 `tests/helpers/index-reliability-production.ts` 需要 `MemorySampler`；搬进测试文件会造成 helper → test 的依赖倒挂。基线段已整体迁出原子性测试，职责已分离 |
| 2 | 守卫是静态文本扫描，`index[fieldName]` 与模板拼接的字段名检不出 | 接受并保持注释声明 | 覆盖动态访问需要 AST 规则；本轮目标是防止「顺手写下 `_data`」而不是对抗刻意规避。注释已写明能力边界，不假装覆盖 |
| 3 | node_modules 守卫只是记录性断言 | 接受 | 权威校验是用 lockfile 重装（`npm ci`）后比对 integrity；单测内无法证明原地改文件。已在注释与本记录中声明 |
| 4 | 行为记录用例断言上游英文文案 `Error saving index` | 已改 | 改为只断言 `toBeInstanceOf(Error)`，包装事实与实测文案记在本文件第 3 节。避免 vectra 升级导致无谓失败，同时不丢失「错误被包装、原始类型丢失」这一 T1 关键事实 |
| 5 | 证据文件在修复期间被并发追加 §9 | 已合并 | §9 由 Lead 写入审查记录，§10 由修复者写入落地实测，两节内容不冲突；§5 的「每文件一次事务」表述已由 Lead 订正为「全量 1 次 / 增量 2 次」 |

## 12. T0 收口结论

T0 完成。四项准入门槛（公开 API 完整枚举、同事务替换、原子存储注入、失败重载可判定）均由通过态用例在真实临时磁盘上实证；6 个缺陷已用预期失败用例固化，并将在 T2 翻转为通过断言。

进入 T1 的约束汇总：第 7 节的 5 条实测约束、第 9 节的 4 条审查硬约束，以及本文件第 5 节的「T2 把增量路径从 2 次落盘降为 1 次」。

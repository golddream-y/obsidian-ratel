# T7 证据:检索消费、状态与宿主装配(审计 + 补完 + 验证)

> 读者:本项目的 T7 收口者与 Lead。范围:`feat/index-reliability` 工作树上未提交的 T7a/T7b 改动(HEAD `71556d9` + 工作树改动)。
> 本文只记录**实测**结论;未在本机复现的部分在第 5 节显式标注为未验证,不填成通过。

## 1. 审计结论

| T7 清单 | 结论 | 关键证据 |
| --- | --- | --- |
| 1 检索消费:过滤在融合/重排之前 | 已完成 | `src/core/multi-query-searcher.ts:248`、`:352-401`;`tests/core/multi-query-searcher.test.ts:413-465` |
| 2 `autoIndex=false` 只读契约(A11) | 已完成 | `src/main.ts:2100-2135`、`:2265-2318`、`:2736-2744`;`src/core/index-controller.ts:122-133` |
| 3 状态展示(计数/阶段/重新核对/完成通知/epoch) | 已完成 | `src/core/feedback-controller.ts:265-398`;`src/main.ts:1298-1311`、`:2351-2394` |
| 4 i18n(阶段/错误码,取消复用既有入口) | 已完成 | `src/core/feedback-controller.ts:427-492`;`src/i18n/zh.ts:786-803`、`:1028-1052` |
| 5 命令语义(drop-index 收窄 + 重建入口) | 已完成 | `src/main.ts:1096-1110`、`:1141-1162`、`:2560-2598`;`src/core/index-manager.ts:365-375`、`:422-450` |
| 6 报告项(不改代码) | 已完成核实,见第 3 节 | 见第 3 节 |

工作树上没有发现「写了一半」的功能路径:本次改动新增的导出符号里,只有 `FeedbackController.refreshIndexStatus()` 全仓无调用方(第 6 节第 1 条),其余均有生产或测试消费点。

## 2. 证据:T7 清单逐条

### 2.1 检索消费:被拒候选不进融合与重排

数据流在召回循环内先过滤、后融合:第 3 步的召回循环里 `filterBeforeFusion(...)`(`src/core/multi-query-searcher.ts:248`)产出可见列表,RRF 只吃可见列表(`:258-261`),精排输入来自融合后的 `finalResults`(`:291-334`),因此被拒路径既不进 RRF 也不进 rerank,更不会被 `vault.readFile` 读全文。

- 可失败断言(不只是查最终 UI):`tests/core/multi-query-searcher.test.ts:413-465`「search - 原始候选含 stale/deleted/excluded/unresolved - 被拒路径进入融合与重排的命中数为 0」
  - `:451-452` rerank 恰调用 1 次;
  - `:456` `sentIds.filter(deniedIds)` 长度为 0;
  - `:458` 精排输入精确等于 4 个可见候选;
  - `:459` 被拒路径从未被 `readFile`;
  - `:464` 每个路径只判定一次(8 个候选 → 8 次 `decide`)。
  - 反证:删掉 `:248` 的过滤后,`sentIds` 会含 4 个被拒 `docId`,`:456` 立即失败 —— 断言非恒真。
- 补足 topK 的补取:`tests/core/multi-query-searcher.test.ts:467-512`(抓取量 `4 → 8`,且 `embedding.embed` 只调用 1 次)。
- 引用定位只对已核实版本:`src/tools/search-vault.ts:87-98`;`tests/tools/search-vault.test.ts:126-160`(unknown 剥离 `chunkIndex`/`startOffset`,verified 保留)。
- 「没有可信记录 ≠ 空集」:`src/tools/search-vault.ts:70-79` 抛 `INDEX_UNVERIFIED`;`tests/tools/search-vault.test.ts:164-186`。

### 2.2 `autoIndex=false` 的只读契约

- 装配只读:`setupIndexRuntime` 只在 `autoIndex === false` 判定**之后**才分流,因此只读通道**不执行 legacy 清单迁移**(该迁移含 `mkdir`/`rename`/`unlink`,只存在于写路径 `migrateLegacyManifestIntoIndexRoot`);进入 `setupReadOnlyIndexRuntime` 后只 `generations.readControl()`,不取写所有权(`createReadOnlyOwnerGuard()`)、`createVectraStore(false)`(`autoInit:false`)、门注入 `createJournalVisibilitySource(journal)` + `isExcluded` + `exists: (p) => this.vault.fileExists(p)`(仅候选存在性,不扫全库)。装配级「目录快照逐字不变」由 `tests/core/index-processor-port.test.ts`「只读装配 - 存在旧版清单 - 目录快照逐字不变且不执行写迁移」在真实临时根上固定,并以「写路径装配 - 同一份旧版清单 - 迁入 `.index/`」作反向对照(证明用例非恒真)。
- 无活动代际时不装配存储:同一函数在上半段提前 `return`(`this.indexDirUsable` 保持 `false`),因此模型就绪也不会初始化 Worker 存储(`src/main.ts:2736-2744`);恢复写入 `recoverIndexJournal()` 只出现在写路径(`setupIndexRuntime` → `assembleIndexPipeline` 之后)。
- 零全库扫描:`src/core/index-controller.ts:122-133`(`autoIndex=false` → `wireReadOnlyEvents()` + `restoreCommittedState()`,不跑 `smartReindex`/`scan`);只读事件装配 `:184-201` 只写内存集合。
- 黑名单清理只排队:`src/core/index-controller.ts:11-13`、`:186-193`;`src/core/index-task-coordinator.ts:204`、`:1402`;`tests/core/index-task-coordinator.test.ts:703`。
- 门的三态:`src/main.ts:2265-2318` —— 只读模式下内存变更集按 `known-stale` 拒绝(不是 `unresolved-transaction`),只读视图缺失时按 `unjudgeable` 拒绝,`recordsKind()` 直读视图;写路径缺日志同样按 `unjudgeable` 拒绝。
- 库级零副作用与语义:`tests/core/index-search-visibility.test.ts:524-551`(目录快照逐字不变、`embeds` 未被调用、不生成 `owner.lock`)、`:554-587`(只读哨兵日志下 `prepare` 必抛且目录不变)、`:591-603`(新鲜度 `unknown`)、`:664-676`(黑名单立即收回)、`:680-700`(未决事务过滤)。
- 装配级:`tests/main-index-lifecycle.test.ts:184-239`(三例:`readOnlyChanged` 归类、无可信记录 = 不可检索、写路径缺日志 = 不可检索)。

### 2.3 状态展示

- 计数与阶段:`src/core/feedback-controller.ts:265-381`(`:291-301` Scanning 区分总数/已提交/待处理/失败;`:302-315` Queueing 且 `reverifying` 走「重新核对」;`:319-333` Ready 时 `indexPartial = committed < total`)。
- 「重新核对」的生产者:`src/core/index-manager.ts:287-297`(`taskId` 未记入 `lastTaskId` 或本轮已有提交)。
- 须知优先级:`src/core/feedback-controller.ts:384-398`(迁移中 > 缺少 epoch 保护 > 记录配置不符 > 记录不可判定 > 恢复 > 停滞 > 正在停止)。
- Notice 只在真实全库完成时发:`src/main.ts:1298-1311`(`errors === 0` **且** `isIndexComplete()`);`tests/main-index-lifecycle.test.ts:121-169`(`false` 不宣告 / `true` 才宣告)。
- `epochSourceMissing` 如实呈现:`src/main.ts:2351-2368`、`:2375-2394`;`src/core/feedback-controller.ts:389`;`src/ui/chat/feedback-modal.ts:103-105`;测试 `tests/core/feedback-controller.test.ts`「getIndexSignals - epochSourceMissing …」与 `tests/ui/chat/feedback-diagnostics.test.ts:31-54`。
- 展示面类型与 UI:`src/user-feedback/user-status.ts:9-58`、`src/ui/status/StatusDrawer.svelte:72-131`、`:180-198`。

### 2.4 i18n

- 错误码表:`src/core/feedback-controller.ts:427-464`(覆盖 `WORKER_MANAGER_ERROR_CODES` 6 码、`index-directory-not-owned`、`drop-refused`、`owner-not-writable`、T1 的 4 个可能上屏码、T3 journal 10 码),`describeIndexError` 在 `:483-492`。
- 逐码断言「有专门文案、不落带码兜底」:`tests/core/feedback-controller.test.ts:366-394`(对 4 个码表逐项循环);`:317-334`(T2/T6 三码)、`:336-345`(T1 四码 + 其余带码兜底)、`:347-353`(T3)。
- 新阶段/须知 zh 与 en 成对:`src/i18n/zh.ts:786-803` 与 `en.ts` 同段;`src/i18n/strings.test.ts:55-93`(含 drop/rebuild 文案语义断言)。
- 取消复用既有入口、不新增设置页导航:`src/main.ts:1113-1123`(pause-index 复用 `cancelIndexRun`,定义在 `:2540-2549`,不 terminate 共享 Worker);本次 diff 未触及 `src/ui/settings/*`。

### 2.5 命令语义

- `drop-index` → 「清理非活动索引代际」:`src/main.ts:1141-1162`(无写所有权 → 如实提示拒绝)与 `:2560-2598`(跳过活动/`building`/`verifying` 代际,经 `dropSafeGeneration` 的三重归属校验);文案 `src/i18n/zh.ts:635-637`、`:651-657` / `src/i18n/en.ts:634-655`;`src/i18n/strings.test.ts:56-63`。
- 「重建当前索引」不清库:`src/main.ts:1096-1110`;语义在 `src/core/index-manager.ts:422-450`(注入协调器时 `abortActive` + `resume` + `runCoordinator`,只有未注入协调器才回退清库);文案 `src/i18n/zh.ts:646-650` + `src/i18n/strings.test.ts:65-70`;测试 `tests/core/index-manager.test.ts`「重建 - 注入协调器 - 不清库 - 撤销在途调用后重新核对」(断言 `dropIndex` 未被调用、`abortCount === 1`)。
- 直接 drop/rebuild 旁路已删除:HEAD 的 `this.indexBackend.dropIndex!()`(HEAD `src/main.ts:1022`)在当前 `src/main.ts` 中不存在;`grep "indexBackend.dropIndex|\.fullReindex()"` 在 `src/main.ts` 只命中注释。
- 暂停顺序(先撤销在途、再停止调度):`src/core/index-manager.ts:365-375`;`tests/core/index-manager.test.ts`「暂停 - 注入协调器 - 先撤销在途调用再停止调度」(断言调用序列 `['abortActive','pause']`)。
- 代际装配已接线:`resolveIndexGeneration` / `new IndexGenerations` 在 `src/main.ts:2047-2065`、`:2102` 有生产调用(T6 证据第 8 节硬前置 7 关闭)。

## 3. 第 6 条独立核实

### 3.1 `src/worker/index-processor.ts:197` 单参 `embed(texts)` 丢失 processor 级 options —— 成立

- 该行:`await this.embeddings.embed(chunks.map((c) => c.embedText))`,不传第二参;对照新装配 `src/core/index-processor-port.ts:88` 显式传 `options`(类型 `EmbedOptions = { signal?, onBatchComplete? }`,见 `src/core/index-persistence-types.ts:81-86`)。
- 影响:Worker 侧 `reembedFile` 拿不到取消信号、也不上报批次活动,即 T5 的取消与停滞看护在该入口为零收益。
- 归属建议:**不修**(本轮明确要求)。归 `src/worker/index-processor.ts` —— 方法需接受 `options` 并由 `handler` 的 `index.full` / `index.batch` / `index.file` 请求透传;是否仍值得修,取决于该入口在生产是否还有调用方(协调器装配后主线程走 `index-processor-port`,需由 T8 或装配收口者判定后再排期)。

### 3.2 API 模式 `vector.search` 是否真的以 `NULL_PROCESSOR` 失败并被仅告警吞掉 —— 成立

读源码得到的调用链唯一性:

- `src/main.ts:2610` `createWorkerManager()` 恒定构造 `InlineWorker`(不做 provider 分支);
- `src/main.ts:1237` `if (this.settings.embedProvider === 'local')` 才进入模型下载块,`:1270-1274` 只在 `inlineWorker` 存在时调 `initEmbeddingWorkerProxy`;
- `src/main.ts:2743` 是唯一的 `initWithStore` 生产调用点(全仓 `grep initWithStore|initProcessorWithStore` 只命中此处与 `src/worker/inline-worker.ts:55-57`);
- 未初始化时 handler 直接返回错误:`src/worker/handler.ts:553-557`(`code: 'NULL_PROCESSOR'`);
- 检索侧只告警:`src/core/multi-query-searcher.ts:230-237`(`response.type !== 'vector.search.result'` → `devLogger.warn` + `continue`,诊断里不留失败位)。

最小实测(临时取证用例,取证后已删除,工作树无残留):用真实 `handleMessage({ type: 'vector.search', … })`(未初始化 processor)得到 `{ type: 'error', payload: { code: 'NULL_PROCESSOR' } }`,再把这条**真实响应**喂给 `MultiQuerySearcher`(`recordsKind: 'known'` 的门)→ 返回 `[]`,诊断 `{ recordsKind: 'known', denied: 0, recallAttempts: 1 }`,`createSearchVaultTool(...).execute()` 返回 `[]`,不抛 `INDEX_UNVERIFIED`。即:与「真的没有命中」在工具层完全不可区分。

归属建议:**不修**。这是装配层通路缺口(Worker 存储初始化只在 local 分支),不是 `multi-query-searcher` 的过滤契约问题,二者不宜混在一处改。候选归属:(1) API 模式也建立 InlineWorker 存储(嵌入端口换成 `EmbeddingApi`);或(2) 让 `vector.search` 走主线程 store、不依赖 processor。另可考虑让 `multi-query-searcher` 把 `error` 响应记入诊断以便上屏,但那属于检索契约变更,应由 Lead 裁定归 T7 收尾还是 T8。

### 3.3 `journal.verifyReceipt` 无生产使用点 —— 成立

- 定义:`src/core/index-file-journal.ts:723`。
- 全部调用点只在测试:`tests/core/index-file-journal.test.ts:939`、`1009`、`1028`、`1059`、`1076`、`1157`、`1213`;`tests/core/index-generations.test.ts:352`、`887`、`1006`、`1608`、`1635`、`2021`。
- `src/` 内除定义外只有两处注释引用(`src/core/index-generations.ts:1850`、`:1893`),没有生产调用。
- 归属建议:不修。保留为库级 API(语义已由测试固定);接线或删除留待迁移「逐文件核对」路径收口时决定。

### 3.4 `reclaimOrphanQuarantinedTransactions` 无周期调用 —— 成立,且零调用

- 定义:`src/core/index-file-journal.ts:1089-1090`(`assertOwned`)。全仓(含测试)没有任何其它引用。
- 对照:同族的 `reclaimOrphanGenerationDirectories` 有生产调用(`src/core/index-generations.ts:1164`)。
- 归属建议:不修。属 T8(崩溃/规模/交付验证)或独立的回收策略任务。

## 4. 补完清单

**本轮未新增或修改任何产品源码。** 判断依据:清单 1–5 在源码与测试两侧均已完成并复核(第 2 节);找到的两个真实缺口分别落在「不得改动的宿主文件」(`main.ts` 未接 `refreshIndexStatus`)与「仅登记不修」(`index-processor.ts` 的 options)约束内;第 6 条明确要求不改代码。

对工作树做过的唯一改动:新增临时取证用例 `tests/tmp-null-processor-probe.test.ts` 用于第 3.2 节实测,取证后已删除(`git status` 无残留)。

## 5. 验证结果

环境:本机 4 核,验证期间 1 分钟负载持续在 31–48,故所有失败都按「串行重跑该文件判定是否负载所致」处理(第 5.2 节)。

### 5.1 定向与补充

- 定向:`npx vitest run --no-file-parallelism tests/tools/search-vault.test.ts tests/core/feedback-controller.test.ts tests/core/multi-query-searcher.test.ts tests/main-index-lifecycle.test.ts tests/ui/chat/feedback-diagnostics.test.ts tests/i18n` → **5 个文件 / 67 passed**。
  - ⚠️ 命令中的 `tests/i18n` 在仓库里不存在(i18n 测试实际在 `src/i18n/strings.test.ts`),vitest 对不匹配路径静默忽略并以 exit 0 结束 —— 即「67 例」里**不含** i18n 测试,前一轮的「i18n 已通过」并未真的运行过。
- 补跑 i18n:`npx vitest run --no-file-parallelism src/i18n/strings.test.ts` → **9 passed**。
- 补跑 T7 计划指定的 `tests/subagents/indexer.test.ts` → **4 passed**。

### 5.2 全量(两次)

| | 全量 #1(03:47 起,4140.95s) | 全量 #2(06:40 起,2141.20s) |
| --- | --- | --- |
| Test Files | 4 failed / 289 passed(293) | 6 failed / 287 passed(293) |
| Tests | 5 failed / 2732 passed / 5 skipped(2742) | 10 failed / 2727 passed / 5 skipped(2742) |

两次失败集合几乎不重叠(仅 `skill-script-sandbox`、`embedding-onnx`、`index-search-visibility` 三次出现),失败内容全部是 `Test timed out in 5000ms`、临时目录竞态(`ENOTEMPTY: directory not empty`)、`create-files-dir` IO 失败或墙钟时间断言 —— 没有任何一条是关于 T7 行为语义的断言。逐条判定:

- `tests/core/index-search-visibility.test.ts`(两轮各 1 例超时,且例不同)→ 单独重跑该文件 **45/45 passed,1.49s**。判定:负载假红。
- `tests/core/persistent-index-backend.test.ts`(全量 #1 有 1 例超时)→ 与上一文件同批重跑时全过。判定:负载假红。
- `tests/adapters/embedding-onnx.test.ts`(两轮共 3 例,均为 5s 超时)→ 单独重跑仍超时;`--testTimeout=120000` 单独重跑 **11/11 passed**。判定:负载假红(纯超时)。
- `src/skills/skill-script-sandbox.test.ts`(两轮共 4 例)→ 单独重跑仍失败,其中 1 例是墙钟阈值断言 `expected 25508 to be less than 900`、另 2 例是心跳分类在 CPU 饥饿下被判成 `timeout/stalled`。该文件与其被测源码均未被本次改动触及,也不 import 任何被改模块。判定:负载假红,且该用例本身对机器负载敏感(既有属性,不是本次回归)。
- `tests/core/index-write-owner.test.ts`(只在全量 #2 出现 1 例超时)→ 单独重跑 **48/48 passed,5.5s**。判定:负载假红。
- `tests/core/index-file-journal.test.ts`(全量 #2 出现 4 例:2 超时 + 1 `ENOTEMPTY: directory not empty` 临时目录竞态 + 1 `create-files-dir` IO 失败)→ 单独重跑除 1 例 5s 超时外全过,且此次超时的用例(「同路径重建 - 删除后重新创建」)与全量 #2 的失败用例**不是同一批**;该用例再用 `-t` 隔离运行 **passed,482ms**。判定:负载假红(失败用例在三次运行间漂移,且都落在临时目录 IO 上)。
- `tests/core/index-generations.test.ts`(全量 #2 出现 1 例超时「migrate - 构建戳存在但损坏」)→ 单独重跑整文件除 1 例超时(940s,又是另一个用例)外全过;全量 #2 的那一例用 `-t "构建戳存在但损坏"` 隔离运行 **passed,79ms**。判定:负载假红。

结论:**未能证明全量全绿**;可归因的失败全部指向超时/临时目录竞态/墙钟阈值,未发现与 T7 改动相关的功能性失败。空载机上的全量复跑仍待补。

### 5.3 静态检查

- `npx tsc -noEmit -skipLibCheck | grep -c "error TS"` = **241**,与存量基线一致(新增 0)。错误清单里涉及被改文件的三条均为存量类型问题(`src/main.ts:404`、`:1437` 的 `LLMClient`/`OpenAICompatLLM`、`:1822` 的 `LogModule 'noteAgents'`),与本次改动无关。
- `npx eslint` 覆盖本次改动涉及的 16 个源文件(`src/main.ts`、`src/core/multi-query-searcher.ts`、`src/tools/search-vault.ts`、`src/core/feedback-controller.ts`、`src/core/index-controller.ts`、`src/core/index-manager.ts`、`src/core/index-generations.ts`、`src/core/persistent-index-backend.ts`、`src/core/index-processor-port.ts`、`src/user-feedback/user-status.ts`、`src/ui/chat/feedback-modal.ts`、`src/ui/status/StatusDrawer.svelte`、`src/worker/handler.ts`、`src/i18n/{zh,en,types}.ts`)→ **exit 0,无输出**。
- `git diff --check` → **exit 0**(无空白错误)。

## 6. 未做项与需 Lead 裁定

1. **`FeedbackController.refreshIndexStatus()` 未接线**(`src/core/feedback-controller.ts:165`)。全仓唯一引用是它自己的定义;对照 `refreshEmbeddingStatus()` 在 `src/main.ts:1475` 有生产调用。其文档写明「这些信号不随 `IndexStatus` 变化,但必须立即上屏……允许宿主在装配完成后主动刷新一次」,而宿主从不调用,也没有测试。影响面有限(只读装配下的须知仍会在下一次状态派发时上屏;`disk-failure` 另有 `src/main.ts:2595` 直接 patch),但这是一个**新增的公开入口没有消费者**。一行修复位置在 `src/main.ts`(宿主文件,本轮按约束未改)。裁定:补这一行(由谁做)还是删掉该 API。
2. **`INDEX_NOTICES` 中的 `'reverifying'` 无生产者**(`src/user-feedback/user-status.ts:26`)。`composeIndexNotice`(`src/core/feedback-controller.ts:384-398`)只会产出 `migrating` / `epoch-missing` / `config-mismatch` / `records-unknown` / `resumed` / `stalled` / `stopping`;`'reverifying'` 只作为 `indexDetail` 文案使用,故 `src/ui/status/StatusDrawer.svelte:99` 的该分支不可达。i18n key 本身仍被使用,风险低。裁定是否删除该枚举项。
3. **陈旧 JSDoc**:`src/main.ts:1329` 仍写「3. 全局参数(embedModelId/chunkSize)变 → 清 `.index/` + manifest → 全量」,与代际语义不符(现在不可能清 `.index/` 根,`assertDropOwnership` 会拒绝)。仅注释问题,建议同批修正。
4. **装配级「零写入」回归测试已补**(零扫描仍由 `src/core/index-controller.ts:122-133` 与只读通路测试覆盖)。2026-11-01 收口:修掉「只读装配先执行 legacy 清单写迁移」后,`tests/core/index-processor-port.test.ts` 的「只读装配 - 存在旧版清单 - 目录快照逐字不变且不执行写迁移」在真实临时根上固定「零写入」(逐字节快照 + `owner.lock` 不存在 + 旧清单未迁移 + `createVectraStore(false)` 调用 1 次 + `initWithStore` 0 次),并有写路径迁移用例作反向对照与 `autoIndex=true` 的阳性对照。修正前 §2.2 的「零写入」表述与实际行为**不一致**(只读装配会先 `mkdir`+`rename`,存在旧清单时还会 `unlink`)——这正是规范审查的 I3;修正后表述为真。
5. **全量未在空载机复现全绿**(第 5.2 节)。建议在负载回落后复跑一次全量,作为 T7 收口的正式证据。
6. **计划与状态未更新**:`docs/superpowers/plans/2026-10-31-index-reliability.md` 的 T7 复选框仍为空、`docs/superpowers/STATUS.md` 仍是「下一步 T7」。按项目管理边界,由 Lead 决定何时更新。
7. **T7a 的工作树范围超出本清单**:`src/core/index-generations.ts` 的 legacy `embedModelId` 归一化与「迁移时写代际作用域的清单/构建戳」、以及新文件 `src/core/index-processor-port.ts`、`tests/core/index-processor-port.test.ts`、`tests/core/index-generations.test.ts`(+527)均不在我收到的 6 条清单内。我只确认它们在全量中通过,未逐行复核设计正确性;若 T7a 已有独立审查记录,请以那份为准。
---

## Lead 复核、裁定与收口（2026-11-01）

本文件此前由 T7b 核验单写入；以下为两阶段审查结论、修复轮、Lead 复核与裁定。

### 两阶段审查

| 阶段 | 结论 | 阻断 | 主要发现 |
|---|---|---|---|
| 规范符合性 | 有条件通过（无阻断） | 0 | 14 处目录注入点逐处通过；硬前置 1～4、7 关闭；硬前置 5、6 部分关闭；C1～C4 四项通过条件 |
| 代码质量 | 不通过 | 1 | 真实 ONNX 用例留在默认套件且超时口径不当；`main.ts` 达 3010 行；4 项未接线/死代码；1 项 O(N) 热路径 |

### 修复轮（三个互斥单）

1. **数据安全与主流程**：删除公共 `smartReindex()`（T7 引入的活动代际删除风险）；装配失败改为降级 + 重试命令 + 用户可见出口；`Failed` 携带稳定 `errorCode` 并经码表上屏；只读装配不再执行 legacy 清单写迁移；迁移/回收结论面接入诊断；会话内配置漂移显式拒绝；`createFirstCommitPromoter` 加一次性闩锁（消除每次提交的 `readControl()`）；`refreshIndexStatus()` 接线；删 `'reverifying'` 死枚举与 `createEmbeddingsVectraStore` 死代码；修 3 处陈旧/不实注释。
2. **测试门禁与守卫**：真实 ONNX 用例移出默认套件并**由 `RATEL_ONNX=1` 门控**（无条件 exclude 会让显式路径静默 `exit 0`——`passWithNoTests` 假绿，已实测）；共享 `maxBatchSize=2` 会话（ORT 会话 7→2，927 秒病态消失）；装配守卫改为**按注入点分类计数**；补装配级零写入用例（含阳性对照）；清理 `tests/tmp`。
3. **代际配置指纹切换**：`resolveIndexGeneration` 在存在活动代际时**必须比较指纹**；不一致时建隔离代际、本轮核对完成后才原子切指针（部分失败不切）；切回曾用配置先 `beginVerification` 降级；指纹一致仍走原复用路径。**未新增 API**（T6 三接口够用）。

### 修复期间发现并修复的关键缺陷

- **`resolveIndexGeneration` 不比较指纹（spec 级）**：修复前「跨会话改配置并重启」的实际后果是**零提交 + 1 个失败 + `partial-failure`**（journal 用新指纹在旧代际目录读完成记录 → 指纹不符反复失败并耗尽重试），且 `configured-switch`/隔离代际在生产启动路径**完全不可达**。TDD 红证：修复前 6 failed，修复后 36 passed。
- **公共 `smartReindex()` 可删除活动代际（T7 引入）**：目录切到代际后，它在清单缺失/不兼容时 `dropStore()` 会递归删除活动代际（而指针仍指向它）。已整方法删除，并补「真实装配 + 一轮真实任务」的端到端守卫。
- **`Object.create(Plugin.prototype)` 替身的类字段陷阱**：跳过构造函数使带初始化器的类字段为 `undefined`，`!== null` 判定误入降级分支并使既有 6 例全红。测试侧补 `barePlugin()` 显式补齐默认值。**纪律：插件替身必须补齐类字段默认值**（已写进测试约定）。

### Lead 复核

- 默认套件（`--no-file-parallelism`，负载 17～31）：**292 文件 / 2752 passed / 5 skipped**，exit 0，109.34s（`tests` 56.96s；门控前 347s）。
- 门控套件：`RATEL_ONNX=1` → 11/11 通过、10.8～20.4s、最慢单例 4.2s。
- `tsc` **241**（存量，新增 0）；`eslint` 改动源文件 0 error；`git diff --check` 干净。
- Lead 亲自替换了一处**弱断言**：`tests/core/index-processor-port.test.ts` 的 `aborted === false` 对「完全未转发 options」同样成立 → 改为断言**同一 `AbortSignal` 对象**（`options?.signal === controller.signal`）并加 `forwarding` 布尔；替换后该文件 36 passed。
- 修正本文件 §2.2 与 §6.4 的「零写入」表述（修正前与实现不符，即规范审查 I3）。

### 裁定

| 项 | 裁定 |
|---|---|
| 只读装配的 legacy 清单迁移 | 已修：迁移移到 `autoIndex` 判定之后；只读通道零写入 |
| `Failed` 路径错误码上屏 | 已修：`IndexStatus.Failed` 携带 `errorCode`，经 `describeIndexFailure` 映射；无码时原样用 `reason`（避免把已本地化文案再包一层） |
| 装配失败降级 | 已修：不再 reject `onload`；降级 + 重试命令 + 状态/Notice（经码表，不带开发向 message） |
| 降级 catch 覆盖全部错误 | 接受：列举可降级码太脆；代价是装配期编程错误被吞成「索引不可用 + ERROR 日志」 |
| 派生视图写入口的 flush 不对称 | 接受现状；登记「抽共享 durable writer（`atomic-json-write.ts`）并让 `IndexManifest.save`/`writeBuildStamp`/`PersistentIndexBackend.commit` 共用」为后续项 |
| `'reverifying'` 枚举与 StatusDrawer 分支 | 已删（i18n 的 `status.detail.reverifying` 键保留，仍被 `indexDetail` 使用） |
| 弱断言与守卫粒度 | 已修（同一 `AbortSignal` 身份断言；守卫改逐点计数） |
| `main.ts` 3010 行 / 装配与策略混合 | **登记 T8 前置**：抽 `src/core/index-runtime-assembly.ts`（不 import `obsidian`），这正是 T8 crash/scale 夹具能直接构造管线的前提 |
| 回收阻断时整库降级 vs spec「保留可用活动索引 / 旧配置只读搜索」 | **登记为 spec 偏差 + 后续项**：`ResolveIndexGenerationResult` 缺少「旧代际继续可读、新配置暂不写」的通道；当前实现为整库降级（旧活动代际也不再提供检索）。需新增该模式或在 spec 中写明 |
| 只读装配不经 `resolveIndexGeneration` | 登记：配置不符时仍指向旧活动代际且 `indexDirUsable=true`，靠门按 `config-mismatch` 拒绝（安全零写入，但状态可能说「可用」而实际检不到）；可复用新增的 `allowCreate:false → resolved:null` 语义 |
| `beginVerification` 兜底分支已成第二道防线 | 保留并注明 |
| 指纹计算位置上移 | 接受：非法配置现在会在迁移之前抛 `config-invalid`；`allowCreate:false` 也会算指纹（纯 sha256、零写入，有用例断言目录逐字不变） |
| 代际查找口径 | 接受 `deriveGenerationId(fingerprint)` + 记录自洽断言（比 `getGenerationByFingerprint` 更严格，后者会接受「指纹匹配但 ID 不自洽」的损坏记录） |

### 移交给 T8 的项

1. **`main.ts` 装配下沉**（T8 crash/scale 夹具的前置）。
2. 后端**以 receipt 为优先口径**：清单被删而 receipt 仍在时不得 `dropStore()`（会连 receipt 一起删）。
3. 「回收阻断时保留可用活动索引 / 旧配置只读搜索」模式（spec §5）。
4. 只读装配走解析函数以复用 `allowCreate:false → resolved:null` 语义。
5. 迁移兼容校验的 O(N²) 大库实测与必要优化。
6. durable writer 抽共享模块。
7. `index-processor.ts:197` 单参 `embed(texts)`；`reclaimOrphanQuarantinedTransactions` 无调用；`verifyReceipt` 无生产使用点。
8. **API 模式 `NULL_PROCESSOR` 静默空集**（预存严重缺陷，T7b 已用真实 `handleMessage` + 真实检索链路实测；建议单独立项）。
9. 架构文档（`worker-protocol.md` 等）、用户指南、CHANGELOG、STATUS。

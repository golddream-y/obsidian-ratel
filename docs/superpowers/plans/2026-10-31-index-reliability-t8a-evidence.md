# T8a 证据:装配下沉 + 崩溃恢复验收基础设施

> 读者:本任务的 Lead 与 T8b 执行者。范围:`feat/index-reliability` 工作树(HEAD `0cd4ebf`)上**未提交**的改动。
> 本文只记录本机**实测**结论;未在本机复现的部分在第 8 节显式标注为未验证,不填成通过。
> 本次做的是计划 T8 的 checkbox 1 与 3,以及 `main.ts` 装配下沉(T7 证据末节「移交给 T8 的项」第 1 条)。

## 1. 交付物与改动清单

| 文件 | 动作 | 行数 | 说明 |
|---|---|---|---|
| `src/core/index-runtime-assembly.ts` | **新增** | 976 | 索引运行时装配/检索门/代际登记/清理/日志恢复,不 import `obsidian`,依赖全部参数注入 |
| `tests/helpers/index-crash-child.ts` | **新增** | 562 | 宿主无关管线装配(父/子共用)+ 独立子进程入口 + 阶段崩溃点 |
| `tests/core/index-reliability-crash.test.ts` | **新增** | 744 | 12 个崩溃/重启用例,断言全部落在真实临时磁盘 |
| `vitest.index-reliability.config.ts` | **新增** | 52 | 专用配置:显式 include、继承基础别名与 setupFiles、`passWithNoTests:false` |
| `src/main.ts` | 修改 | 3333 → **2980**(-353) | 只留生命周期与接线;删除已下沉的实现 |
| `tests/adapters/vector-vectra.test.ts` | 修改 | — | 装配守卫账本:构造点位置随下沉更新为逐文件计数 |
| `tests/helpers/index-assembly-registry.ts` | 修改 | — | 可见性门接线账本:两处接线点从 `main.ts` 迁到 `index-runtime-assembly.ts` |
| `eslint.config.mts` | 修改 | +1 行 | 新配置文件不在 tsconfig include 内,与 `vitest.config.ts` 同样列入 ignores |

无新增依赖(`esbuild` 已是 devDependency)。未提交 git、未动 `node_modules`、未触碰主工作树。

## 2. 装配下沉结果

### 2.1 `main.ts` 保留面(只做接线)

`setupIndexRuntime`(编排 + 降级 catch)、`migrateLegacyManifestIntoIndexRoot`、`degradeIndexRuntime`、
`assembleIndexObjects`(清单/后端/控制器/Indexer)、`applyWritableIndexRuntime`(把装配结果写回字段)、
`createSearchCandidateGate` / `assertIndexDropOwnership` / `cancelIndexRun` / `dropInactiveGenerations` /
`summarizeIndexConclusion`(均为一行转发)、`createVectraStore` / `createIndexStorage`(保留工厂转发,
因为既有守卫按注入点分类计数)。

### 2.2 `index-runtime-assembly.ts` 入口面与注入参数

导出的装配入口与纯函数:

- `setupWritableIndexRuntime(deps)` → `{ indexDir, generationId, activeGenerationId, migrated, conclusion, lease, generations, pipeline }`
- `setupReadOnlyIndexRuntime(deps)` → `{ indexDir, indexDirUsable, activeGenerationId, generations, journal?, readOnlySearchView?, store? }`
- `assembleIndexPipeline(deps)` → `{ store, journal, readOnlySearchView, processorPort, coordinator, stallWatchdog }`
- `createSearchCandidateGate(deps)` / `createIndexStallSource(coordinator)` / `createActiveFileStore(...)`
- `describeLegacyIndex(...)` / `readCurrentInputHashes(vault)` / `recoverIndexJournal(...)` / `dropInactiveGenerations(...)`
- `assertIndexRuntimeDropOwnership(...)` / `summarizeIndexConclusion(...)` / `configIdentityOf(config)`
- `GenerationActivationPublisher`(活动代际登记)/ `cancelIndexRun(...)`
- 常量 `INDEX_RUNTIME_STALL_AFTER_MS`

注入参数(全部由调用方给,模块自身不读宿主):

| 类别 | 参数 |
|---|---|
| 路径与身份 | `indexRoot` / `config` / `configFingerprint` / `expectedDimension` / `chunkLimits` |
| 端口 | `vault`(枚举/读取/stat)、`embedding`、`getChunkOptions()`、`getActiveStore()` |
| 宿主判定 | `isExcluded(path)`、`fileExists(path)`(支持 async,`ObsidianVault.fileExists` 是 async) |
| 工厂接缝 | `createStorage(root)`、`createStore(dir, {autoInit, storage})`、`wrapJournal(journal)`(缺省恒等) |
| 回调 | `onGenerationPromoted(record)`、`publishConclusion(summary)`、`stallAfterMs` |

`wrapJournal` 是本次唯一新增的生产接缝,缺省恒等;它把「协调器提交返回」变成可观测点,正是崩溃夹具在
**不复制生产接线**的前提下覆盖「日志清理后」阶段的手段。

### 2.3 零行为变化的证据

- 既有测试是唯一判据:`npx vitest run --no-file-parallelism tests/main-index-lifecycle.test.ts tests/core/index-processor-port.test.ts tests/core/index-manager.test.ts tests/core/index-controller.test.ts` → **4 文件 / 102 passed**,7.7s。
  这 4 个文件覆盖 `setupIndexRuntime` / 只读装配零写入 / 严格归属断言 / 协调器端口 options 转发 /
  首个提交登记 / 降级与重试 / 状态与 Notice 语义。
- 需要逐字保真的点已按原顺序保留:写路径「先取锁、解析、结论面、`beginVerification`、装配、恢复」,
  失败必释放租约(`setupWritableIndexRuntime` 的 try/catch 包裹,失败即 `lease.release()` — 迁移前由
  `degradeIndexRuntime` 释放,算法下沉后由模块兜底,「失败即不占锁」不变);
  只读装配三条早退分支的 `indexDir` 取值与字段副作用逐一对应;
  沿用 `main.ts` 的工厂(`createIndexStorage` / `createVectraStore`)作为注入点,只读装配仍是
  「日志存储与 store 存储两个实例 + `autoInit:false`」。
- 装配守卫账本按新位置更新(不是放宽):`tests/adapters/vector-vectra.test.ts` 由「≥5 处 + 文件集合」
  改为逐文件计数 `{index-runtime-assembly:2, main.ts:1, handler:1}`;`index-assembly-registry` 的门接线
  计数改为 `index-runtime-assembly.ts {视图 2, 来源 3, controller 0}` + `main.ts {0,0,1}`。
  两处都是**精确相等**断言,新增/删除接线点仍会红。

## 3. 崩溃用例矩阵(阶段 × 验收项)

`tests/core/index-reliability-crash.test.ts`,12 个用例;子进程阶段由 `RATEL_CRASH_CHILD_STAGE` 指定,
父进程在**新进程**里经 `setupWritableIndexRuntime` 重建完整管线后断言真实磁盘。

| 用例 | 强制退出点(现场断言) | A1 | A2 | A3 | A4 | A5 | A6 |
|---|---|---|---|---|---|---|---|
| 阶段 `prepared-before` | 分片已落盘、`prepared.json` 缺失、无完成记录 | ✓ | ✓ | — | — | — | ✓ |
| 阶段 `prepared-after` | `prepared.json` 已落盘、目标路径磁盘块数 0 | ✓ | ✓(重放暂存向量,零重复嵌入) | — | — | — | ✓ |
| 阶段 `vector-after` | 向量已在磁盘(块数=chunkCount)、无完成记录 | ✓ | ✓(补写记录,零重复嵌入) | — | — | — | ✓ |
| 阶段 `receipt-after` | 完成记录已落盘 + 事务目录仍在(清理前) | ✓ | ✓(只清理,零重复嵌入) | — | — | — | ✓ |
| 阶段 `commit-after-cleanup` | 完成记录已落盘 + 事务目录已清空 | ✓ | ✓ | — | — | — | ✓ |
| 先完整提交两篇再崩第三篇 | 崩溃时磁盘上恰有 2 份完成记录 | ✓ | ✓ | — | — | — | — |
| prepared 后崩溃 + 内容改写 | 崩溃时确实留有未决事务;重启后旧快照向量不在盘上 | ✓ | ✓ | ✓ | ✓ | — | — |
| 完整一轮后再启动 | 无崩溃;`index.json` 存在 | ✓(零嵌入 + 目录逐字节不变) | — | — | — | — | — |
| mtime/size 不变但正文变化 | 不涉及崩溃 | — | — | ✓ | — | — | — |
| 删除与改名 | 不涉及崩溃 | — | — | ✓ | — | — | — |
| 变短与变空 | 不涉及崩溃(原文件确有多块作前置) | ✓ | — | — | — | ✓ | — |
| 单文件推理失败 | 不涉及崩溃(注入嵌入抛错) | — | — | — | — | ✓ | ✓ |

每个阶段用例的三段式断言(全部落在真实磁盘):

1. **现场**:完成记录数 / 待提交事务目录 / `prepared.json` 字段 / 该路径磁盘块数,逐阶段证明「确实停在
   该边界」;全部非临时 JSON 必须可解析(无半截文件)。
2. **重建后**:每篇文件的磁盘块 ID 序列、维度与向量值必须与「当前内容经同一分块器」的期望**逐块相等**
   (重复块会让序列变长而失败);完成记录存在且 `inputHash`/`chunkCount` 与当前内容一致。
3. **零重复嵌入**:崩溃时已持久化的路径(有完成记录,或有输入 hash 匹配的可重放 prepared)不得出现
   在重启的嵌入输入里;未持久化的路径必须出现(反恒真);再跑一次**零变化启动**必须 `embedCalls === 0`。

补充实测事实(第 2 段的「先提交两篇」用例暴露):**协调器的文件处理顺序不是枚举顺序**
(3 篇时第一份完成记录属于 `notes/b.md` 而非 `a.md`)。因此矩阵的期望值全部由**崩溃现场磁盘**推导
(`noReembedPaths`),不按文件名写死 —— 这既是更强的断言,也避免了「假设顺序」的脆弱性。

## 4. 子进程入口的构建方式与实测

- 入口:`tests/helpers/index-crash-child.ts`,由 `tests/core/index-reliability-crash.test.ts` 的 `beforeAll`
  **用 esbuild 现场构建**到 `fs.mkdtempSync(os.tmpdir()/ratel-t8-child-build-)`,
  产物 `index-crash-child.cjs`(`bundle:true, platform:'node', format:'cjs', target:'es2021'`)。
- 别名与 `esbuild.config.mjs` 一致:`vectra → node_modules/vectra/lib/browser.js`、
  `@huggingface/transformers → src/adapters/empty-transformers.cjs`、
  `onnxruntime-node → src/adapters/empty-module.cjs`;`external: ['obsidian','electron',...builtinModules]`。
- 退出机制:`fs.writeSync(1, "RATEL_CRASH <stage> <path>\n")` → 写临时目录下的标记文件 →
  `process.kill(process.pid,'SIGKILL')`。**不注册也不依赖任何退出回调**;父进程断言
  `close(signal) === 'SIGKILL'` + stdout 含该阶段 + 标记文件阶段一致,任一不成立即失败(不会静默假绿)。
- 子进程只读 `RATEL_CRASH_CHILD_VAULT_DIR` 指定的合成目录,不访问真实 Vault;所有产物只写临时目录。
- 实测命令与输出(节选):
  `npx vitest run --config vitest.index-reliability.config.ts` → **12 passed**,8.60s;逐阶段用例 766~808ms。

## 5. `vitest.index-reliability.config.ts`

- `include`:显式列出 `tests/core/index-reliability-crash.test.ts` 与后续的
  `tests/core/index-reliability-scale.test.ts`(T8b);`passWithNoTests: false`。
- 继承:直接从 `vitest.config.ts` 读 `resolve.alias` 与 `test.setupFiles`(取不到即抛错),不复制清单。
- `exclude` 保留基础配置的 `tests/integration/**` 与 `RATEL_ONNX` 门控;**本配置的 include 面从不包含
  `tests/adapters/embedding-onnx.test.ts`**,因此不需要真实 ONNX、不会隐式下载模型(嵌入端口是确定性假实现)。
  将来若在此配置跑真实 ONNX,必须显式加入该文件并显式 `RATEL_ONNX=1`。
- `environment:'node'`、`fileParallelism:false`、`testTimeout/hookTimeout:120000`(esbuild 构建 + 子进程真崩溃)。

## 6. 验证结果(本机实测)

| 命令 | 结果 |
|---|---|
| `npx vitest run --no-file-parallelism tests/main-index-lifecycle.test.ts tests/core/index-processor-port.test.ts tests/core/index-manager.test.ts tests/core/index-controller.test.ts` | **4 文件 / 102 passed**,7.7s |
| `npx vitest run --config vitest.index-reliability.config.ts` | **1 文件 / 12 passed**,8.6s |
| `npx vitest run --no-file-parallelism`(默认全量) | **293 文件 / 2764 passed / 5 skipped**,exit 0,125.8s(T7 基线 292 / 2752 / 5;+1 文件 +12 例即本任务新增) |
| `npx tsc -noEmit -skipLibCheck \| grep -c "error TS"` | **241**,与存量基线一致,新增 0(涉及改动文件的三条仍为 T7 记录的存量错误) |
| `npx eslint src/main.ts src/core/index-runtime-assembly.ts` | exit 0,无输出 |
| `git diff --check` | exit 0 |
| `npm run build` | exit 0(18 条既有 Svelte 警告);构建后已删除 `dist/`,工作树恢复原状 |

装配守卫的两次定向复跑:`tests/adapters/vector-vectra.test.ts tests/core/index-search-visibility.test.ts tests/core/persistent-index-backend.test.ts` → **3 文件 / 127 passed**。

## 7. 附带实测事实(供 T8b/Lead)

- **子进程持锁被杀 → 父进程重新取锁成功**:每个阶段用例里子进程都是在持有 `owner.lock` 时被 `SIGKILL`,
  父进程随后 `setupWritableIndexRuntime` 一次成功(失败会直接让用例红),即跨进程「确认进程已退出才回收」
  在真实退出场景下成立(A7/A8 的进程交接面获得一次额外真实证据,非 mock)。
- **不完整准备数据不可重放**:`prepared-before` 现场只有分片、没有 `prepared.json`,重启必须重算该文件;
  实测确实重算且最终块集合完整,无旧块残留。
- **崩溃点都在原子替换完成之后**:12 个用例的 `expectNoHalfWrittenJson` 全绿。

## 8. 未验证项与需 Lead 裁定

未在本轮验证(如实标注,不填通过):

1. **A4 的并发面**(提交期间再次修改、连续编辑同一路径、可控时钟下的队列收敛):由 T4/T5 套件覆盖,
   本轮只验证了「推理/落盘后内容变更 → 旧快照不发布」的崩溃形态。
2. **A6 的 IO 错误注入**(短写、磁盘满、rename/sync 失败):由 T1~T3 套件覆盖;本轮注入的是**进程退出**
   而不是 IO 错误。
3. **A7/A8 的停滞、取消、卸载与实例交接**:由 T2/T5 套件覆盖;本轮只有第 7 节的跨进程锁回收证据。
4. **A9/A10 的旧索引迁移与代际切换**:由 T6 套件覆盖;崩溃夹具从空索引根开始,不含 legacy 清单。
5. **A11 的检索消费/黑名单/`autoIndex=false`**:由 T7 套件覆盖
   (`index-search-visibility`、`multi-query-searcher`、`search-vault`、`main-index-lifecycle`);本轮未复测。
6. **A12 数千篇规模与性能门槛**:属 T8b(计划 checkbox 2、4~6),本轮未做,`:index-reliability-scale.test.ts` 尚不存在。
7. **Sandbox 图形验证**:不在本轮范围。
8. **`npm run lint` 全量**:本轮只对改动源文件跑了 eslint;新配置文件已加入 ignores(与 `vitest.config.ts` 同口径),
   避免 `npm run lint` 因「不在 tsconfig include 内」报解析错误。
9. **本机负载**:验证期间 1 分钟负载 8~19,全量与定向均一次通过,未出现需要隔离重跑的失败。

需 Lead 裁定:

- **`wrapJournal` 接缝的去留**:它是本次唯一为夹具新增的生产注入点(缺省恒等、类型为既有端口)。
  若 Lead 不接受生产代码出现测试接缝,替代方案是让夹具自行构造协调器(会复制生产接线),
  但那会削弱「夹具与生产同一条装配路径」的保证 —— 我方建议保留。
- **`main.ts` 仍在 2980 行**:本轮只下沉索引运行时。`onload`/工具注册/命令面板等与索引无关的装配
  是否需要继续拆分,属 T8b 或后续任务的范围,本轮不擅自扩大。
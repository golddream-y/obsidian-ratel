# T8b-2 证据:文档同步与交付收尾

> 本文件是 P-INDEX-RELIABILITY 的 T8b-2 执行证据,覆盖计划 T8 的 checkbox 6(文档同步)与 checkbox 7 的文档部分。
> 本轮**只改文档**:未改 `src/**`、未改 `tests/**`、未改其它 plan/spec、未改 `STATUS.md`、未提交 git、未动 `node_modules`、未触碰主工作树。
> 前置证据:[T0](2026-10-31-index-reliability-t0-evidence.md)、[T1/T2](2026-10-31-index-reliability-t1-t2-evidence.md)、[T3](2026-10-31-index-reliability-t3-evidence.md)、[T4](2026-10-31-index-reliability-t4-evidence.md)、[T5](2026-10-31-index-reliability-t5-evidence.md)、[T6](2026-10-31-index-reliability-t6-evidence.md)、[T7](2026-10-31-index-reliability-t7-evidence.md)、[T8a](2026-10-31-index-reliability-t8a-evidence.md)、[T8b-1](2026-10-31-index-reliability-t8b1-evidence.md)。

- 执行日期:2026-11-01
- 分支/工作树:`feat/index-reliability`,worktree `.worktrees/index-reliability`,HEAD `0cd4ebf` + 未提交的 T8a/T8b-1/T8b-2 改动

## 1. 改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `docs/architecture/rag/vector-index.md` | 修改 | 目录布局、配置代际、文件级提交、恢复决策表、原子存储、协调器阶段、组件协作;改写已过期的 `smartReindex` / 清单路径描述 |
| `docs/architecture/host/worker-protocol.md` | 修改 | 活动包、`index.cancel`、迟到终态通道、读写车道与提交窗口、epoch 校验、停滞/恢复/运行时重置、诊断边界 |
| `docs/architecture/host/index-controller.md` | 修改 | 协调器驱动扫描/队列/终态、只读通道、装配降级与重试、命令语义、部分可用与重新核对 |
| `docs/user-guide.md` | 修改 | 首次检索的部分可用、新增「索引如何跟上你的改动」、新增「关闭自动索引之后」、状态条与命令说明、排障表更新 |
| `docs/user-guide.en.md` | 修改 | 与上列中文条目逐一对应 |
| `CHANGELOG.md` | 修改 | 新建 `## [Unreleased]` 小节,只写未发布事实与已知限制 |
| `docs/superpowers/plans/2026-10-31-index-reliability-t8b2-evidence.md` | **新增** | 本文件 |

未新增依赖,未执行构建,未访问网络,未读写真实 Vault。

## 2. 每份文档的更新要点与证据来源

### 2.1 `docs/architecture/rag/vector-index.md`

| 更新要点 | 来源 |
|---|---|
| 目录布局:`.index/control.json`、`owner.lock`、`owner.recovery.lock`、`generations/gen-<fingerprint[0:16]>/`(含 `generation.json`、`config.json`、Vectra 数据、`ratel-manifest.json`、`build-stamp.json`、`files/<pathHash>.json`、`pending/`、`quarantine/`、`migration.json`) | T6 §2 已实测;`src/core/index-generations.ts` 的常量与类注释;`src/core/index-file-journal.ts` 的目录常量 |
| 递归删除的两个入口与三重归属校验、`.index` 根与 `generations/` 聚合目录被拒 | T6 §2、§4 |
| 配置代际:指纹白名单、`control.json` 活动指针、`configured-switch` 原子切换、部分失败不切、切回先 `beginVerification` 降级、首个文件提交即可登记活动代际、回收上界与暂停新建 | T6 checkbox 逐条与 §7;T7「修复期间发现并修复的关键缺陷」第 3 条 |
| 旧索引迁移:只读复制、核对摘要后逐文件写完成记录、旧数据保留、空间不足只报失败不先删、身份无法确认则整个代际不建 | T6 checkbox 第 3 条与阻断 1 |
| 文件级提交:prepare(分片 + `prepared.json`)、commit(`replaceFile` 后写完成记录)、receipt(`present` / `deleted`)、`revision` 单调、`parts` 计数 = `chunkCount`、同路径单一在途、空文件零块 present | T3 §2 与 §6;`src/core/index-file-journal.ts` 的 `prepare` / `commit` 关键路径注释 |
| 恢复决策表(spec 六行 + 空事务行) | T3 §2 逐行用例表;T3 阻断 A 的 `cleanup-only/empty-transaction` |
| 恢复的失败范围可定位、代际隔离后立即停止恢复、`io-failure` 稳定码、隔离区三种内容与回收(自动回收 + `reclaimOrphanQuarantinedTransactions` 的 `{ reclaimed, retained }`) | T3 §4 第 5/6 条与 §7;T8b-1 §6.5 五步实测 |
| 原子存储:`wx` 唯一临时名 → 写入 → 文件 fsync → close → rename → 目录 fsync;三态判定;失败后必须重载;锁与门用 `link` 而非 `rename`;`flushPath`;故障注入矩阵 | T1 §2;T2 §3 的 `link` 与「原子 + 排他同时满足」 |
| 协调器阶段 `IndexPhase` 八值、`stalled` 不丢终态、`canMarkReady` 四条件、状态展示区分计数 | 计划 T1 契约片段;T4 checkbox T4-4;T7 §2.3 |
| 组件协作表新增 `IndexTaskCoordinator`、`SearchVisibilityGate`、`IndexFileJournal`、`IndexGenerations`、`IndexWriteOwner`、`AtomicIndexStorage` | T1~T7 各自的新增产物;T7 §2.1 的门位置 |
| `smartReindex` 路径标注为历史形态、公共方法已删除 | T7 §5「修复期间发现并修复的关键缺陷」第 2 条 |
| `index-processor.ts` 单参 `embed(texts)` 的已知缺口 | T7 §3.1 |

### 2.2 `docs/architecture/host/worker-protocol.md`

| 更新要点 | 来源 |
|---|---|
| `IndexActivity` 六字段(逐字与计划片段一致)、三个 stage、`sequence` 只在真实完成点递增、UI 计时器与存活消息不算活动、`index.progress` 不再恢复停滞 | T5 §3 第 1 行 |
| `index.cancel` / `index.cancel.done` 请求表条目;取消不终止共享 Worker、写保护保留到真实终态、只读请求取消后窗口关闭也不派发 | T5 §3「取消」行;`src/worker/manager.ts` 的 `cancelIndex` |
| `onLateTerminal`:按 `requestId` 匹配投递,不匹配则既不投递也不释放写保护;旧代码保留写保护、丢的是终态投递(事实更正) | T5 §2 事实更正与真对照用例 |
| 事实更正:不得把「旧代码永久丢掉提交路径」写成事实 | T5 §2 |
| 读写车道与提交窗口:`StoreAccessGate.commitChain` 保证两个提交不重叠、查询在提交窗口内等待、写事务类型集合登记约定 | T5 §3「互斥拆分」行与修复轮 B1 |
| `resetRuntime` 是永久挂起的唯一出口、已启动操作保留写通道到真实结束、`destroy()` 行为 | T5 §6 裁定;`src/worker/manager.ts` |
| 活动序号上界校验与 `requestId` 校验 | T5 §3 修复轮「另修」段 |
| epoch:每次实例接管产生新 epoch、旧 epoch 不能开始提交、前驱未结算时以 `predecessor-not-closed` 拒绝 | T2 §3;T5 §3「卸载与接管」 |
| 诊断只含 id / 阶段 / 序号 / 数量 / 时长,无正文/向量/路径/密钥 | T5 §3「隐私」行 |
| `NULL_PROCESSOR` 在 API 嵌入模式下的静默空集缺口 | T7 §3.2(真实 `handleMessage` 实测) |

### 2.3 `docs/architecture/host/index-controller.md`

| 更新要点 | 来源 |
|---|---|
| 协调器驱动扫描/队列/终态;`IndexManager` 只展示与转发;`runCoordinator` 不再调 `smartReindex` / `fullReindex` | T4 §2、§3「manager / controller 接入」 |
| 监听先于枚举、事件序号单调、按路径合并 | T4 checkbox T4-2 与测试名 |
| 三段核对(读取前 / 推理后 / 提交前)、提交后保留队列项、读失败区分删除与无法读取、不把读取错误当空文件 | T4 checkbox T4-3 与 `src/core/index-task-coordinator.ts` 行号 |
| `canMarkReady` 契约与 `partial-failure` | T4 checkbox T4-4 与 Lead 复核段 |
| 只读通道:`autoIndex=false` 不装配写路径监听、只记录变更路径集合(`readOnlyChanged()`)、零扫描零嵌入零写入、不执行 legacy 清单写迁移、新鲜度 `unknown`、内存变更按 `known-stale` 判定 | T4 §4.3 与 §6.2;T7 §2.2 与 §6.4(「零写入」表述修正记录) |
| 「没有可信记录 ≠ 空集」、`unjudgeable` 失败关闭、门接线与 `fileRecords` 注入必须同批 | T4 §5;T7 §2.2 |
| 状态展示:计数/阶段/重新核对/Notice 仅在真实全库完成时发送/须知优先级/`epochSourceMissing` 如实呈现 | T7 §2.3 |
| 装配降级 + 重试命令 + 稳定错误码上屏、不 reject `onload` | T7 修复轮第 1 条与裁定表 |
| 命令语义:「重建当前索引」注入协调器时不清库(撤销在途 + 逐文件核对)、旧清库分支已不可达;「清理非活动索引代际」跳过活动/`building`/`verifying`、无写所有权时如实拒绝;「重试索引装配」;暂停先撤销在途再停止调度;恢复时 `resetRuntime` | T7 §2.5;`src/core/index-manager.ts:439-470`;`src/main.ts:1082-1160` |
| 部分可用、重新核对、不自动清库重试 | T4 §4.1;T7 §2.3 |

### 2.4 `docs/user-guide.md` 与 `docs/user-guide.en.md`

| 更新要点 | 来源 |
|---|---|
| 首次索引的部分可用(不必等整库) | T7 §2.3 的 `indexPartial = committed < total` |
| 新增「索引如何跟上你的改动」:只处理变化过的笔记 / 不暴露未完成内容 / 部分可用 / 会话内配置变更需重载后重建 | T4 §4.1 实测;T7 §2.3「重新核对」生产者;T7/I6 的 `notice.indexConfigChanged` |
| 新增「关闭自动索引之后」:零写入、只用可信完成记录、新鲜度未知、无可信记录则检索关闭 | T4 §4.3 探针;T7 §2.2;`error.search.indexUnknown` |
| 状态条与命令说明:计数与阶段文案、`stalled` / `stopping`、「重建当前索引」「清理非活动索引代际」「重试索引装配」「暂停/恢复索引」 | `src/i18n/zh.ts` 的 `status.*` / `modal.rebuildIndex.*` / `modal.dropIndex.*` / `notice.*`;`src/main.ts` 命令回调 |
| 索引不可用时的降级与恢复路径 | `notice.indexUnavailable` / `notice.indexRetryOk` / `notice.indexRetryFailed`;T7 修复轮降级条目 |
| 排障表更新:重启不再「全量」、部分可用、状态未知、索引暂不可用、停滞 | 同上 |
| 命令表 `/reindex` 语义改为「逐文件重新核对(不清空)」;命令面板列表按实际 9 条命令核对 | `cmd.rebuildIndex` / `cmd.dropIndex` / `cmd.retryIndex` 文案;`src/main.ts` 的 `addCommand` 调用 |

**对齐检查:** 两文件逐条对应(新增两节、排障表、状态与命令表、`/reindex` 行);中文用中文文案,英文用 `src/i18n/en.ts` 的对应英文文案。

### 2.5 `CHANGELOG.md`

新建 `## [Unreleased]` 小节(原文件首节为 `## [1.2.1] - 2026-10-29`,无 Unreleased 节)。内容见第 3 节。历史带 tag 条目逐字未改;未编造版本号或发布日期。

## 3. `Unreleased` 条目全文

> 下列小标题在 `CHANGELOG.md` 中为三级标题(`### Changed` / `### Fixed` / `### 已知限制`)。

**Changed**

- **索引中断后可以接着做，不必再从头重建。** 索引现在会为每篇笔记保存一条完成记录；中断、崩溃或关闭重开之后，已经完成的笔记直接复用，未完成的部分重新开始，不会让已提交的内容回退。
- **只有真正改动过的笔记会重新嵌入。** 改一篇笔记只影响这一篇，其余笔记的结果继续沿用。
- **尚未完成的改动不会进入检索结果。** 你刚保存的笔记在新的内容写完之前先从检索结果里排除，避免给出旧文本。

**Fixed**

- **抽出时间不再清空索引。** 原先长时间索引或连续编辑后可能反复重建、进度回退；现在进度只统计真实完成的部分，并按总文件数、已提交、待处理、失败和当前阶段分别显示。
- **长时间没有有效进展时如实显示「停滞」。** 停滞不再丢弃任务和队列，恢复后继续核对；状态条会显示扫描中、排队中、处理中、停滞、正在停止等阶段。持续推进的长索引仍可超过 10 分钟。
- **索引装配失败不再让插件整体不可用。** 现在降级为「索引暂不可用」并说明原因（如磁盘空间不足、控制记录损坏、写所有权被其他窗口占用），插件其余功能照常，并可在命令面板运行「重试索引装配」恢复。
- **索引目录只会清理未生效的代际。** 原「清空索引」命令替换为「重建当前索引」：逐文件重新核对，**不会先清空索引**，现有可检索版本在核对期间保持可用。新增「清理非活动索引代际（危险）」只删除当前未生效的代际，活动索引不受影响。
- **在一次会话里改嵌入配置会被显式拒绝。** 状态条提示「嵌入配置已在本次会话内变更」，并暂停索引写入以避免新旧参数混写；重新加载插件后可重建索引。跨会话改配置会为新配置建立独立代际，逐文件核对完成后才切换，核对期间旧代际仍可搜索。
- **关闭「自动索引」后确认零写入。** 该模式只读：不扫描库、不嵌入、不写入索引目录，检索只用已有的完成记录并核对候选仍存在，新鲜度显示为「未知」；没有可信记录时如实提示索引状态未知，而不是假装索引为空。

**已知限制**

- **小库档的首次索引耗时未达目标。** 为使中断可恢复，索引落盘改用了耐久写入（每次写入后同步文件与父目录）。这带来的固定开销在**小库（约一百篇）首次建立索引**时最明显；按相对门槛衡量，该档的完整构建与零变化启动都未达标，随着库变大差距收敛（本机实测完整构建对同口径对照臂约 2.90 ×／1.85 ×／1.44 ×，随 100／1000／3000 篇递减）。这是为恢复与原子性付出的代价，不是回归；门槛口径本身也需修订——把同一套耐久写入放到未改动的旧路径上，100 篇就已是原基线的 4.67 倍。同时，这些数字来自负载高于核数时的采样，**未在同一口径下复测**，不作为最终结论。

## 4. 未验证项

1. **Sandbox 图形验证未执行。** 计划 T8 checkbox 6 的五项（前台/后台、系统暂停恢复、取消再启动、关闭重开、索引期间编辑）本轮**未验证**。原因见第 5 节，可执行清单见第 6 节。**不得记为通过。**
2. **真实 ONNX 耗时未验证。** 沿用 T8b-1 §8.1 第 1 条：本分支没有任何真实模型耗时数字;文档中未引用任何 64/512 维假嵌入耗时作为真实模型耗时。
3. **性能门槛的同一口径判定未验证。** 沿用 T8b-1 §5.1;文档与 CHANGELOG 均写明「未在同一口径下复测」,未把带载读数写成达标。
4. **`npm run build` / `npm run lint`(全量)未执行。** 本轮只改文档,未执行构建,未新增 `dist/`。T8b-1 §7.6 已记录同一限制。
5. **文档渲染未做视觉核对。** 新写内容已按 `docs/AGENTS.md` 控制到三级标题以内,但未在渲染器中逐页查看图表排版。
6. **未校验文档中引用测试名的可执行性。** 本轮文档没有引用具体测试用例名(只引用证据文档与源文件行号);所引源文件与符号已逐一 `grep` 确认存在。

## 5. 刻意未写的内容

| 未写的内容 | 原因 |
|---|---|
| **「回收阻断时旧配置代际继续只读搜索」模式** | **该模式未实现**。T7 裁定表明确登记为 spec 偏差:当前实现是整库降级(旧活动代际也不再提供检索)。架构文档把它写在「未交付的形态」里,用户指南完全不提。 |
| 「后台继续建立索引」「关闭 Obsidian 后继续」 | 未实现,且与实现相反。用户指南明写「核对过程在 Obsidian 运行时进行,关闭 Obsidian 后不会继续」。 |
| 小库档首次构建耗时达标 / 「性能已验证通过」 | 未达标且未在同一口径下复测。CHANGELOG 单列「已知限制」并给出比值,**不淡化**。 |
| 具体性能数字(毫秒、MiB、GiB、1.25 ×/1.5 × 门槛的达标结论) | 带载采集,不作为门槛依据;只在 CHANGELOG 给出可用作「量级与来源」的相对比值,并声明口径限制。 |
| 真实 ONNX 推理耗时 | 未验证;假嵌入耗时不得冒充真实模型耗时。 |
| 版本号、发布日期、Release 链接 | 未发布,不编造。Unreleased 节不写日期。 |
| 「索引在后台运行不阻塞 UI」 | InlineWorker 在主线程调度;worker-protocol 文档已明写「InlineWorker 不代表这些索引工作全部移出了主线程」。 |
| API 嵌入模式的检索可用性 | T7 §3.2 实测该模式下 `vector.search` 以 `NULL_PROCESSOR` 静默返回空集,与「真的没有命中」不可区分。文档只在架构层写明该已知缺口,用户指南不宣称该模式可用。 |
| 「清空索引」命令仍存在 | 该命令已不在命令面板中(原 `drop-index` 已收窄为「清理非活动索引代际」);用户指南按实际命令列表改写。 |
| 文档内部的具体耗时机测试名与用例数 | 交付文档面向维护者与用户,不是测试报告;测试事实留在证据文档。 |

## 6. Sandbox 验证清单(供后续在有宿主环境时执行)

**前置条件(当前不满足,需先补齐):**

1. 用一个不含真实笔记内容的 Sandbox 库(不得使用日常主库)。
2. 把当前分支构建产物链接到该库:构建 `main.js` / `manifest.json` / `styles.css` 并只对该 Sandbox 生效。
3. 准备一个**合成库**:约 300～2000 篇短 Markdown,以及 1 篇超过 200 块的长文档,便于观察阶段变化。
4. 打开状态条,确认索引部分显示文件计数与阶段。

**逐项执行:**

| # | 场景 | 操作 | 观察与判定 |
|---|---|---|---|
| 1 | 前台索引 | 打开 Sandbox,等待首次索引 | 状态条出现扫描中→处理中;已提交计数单调上升;出现「部分可用」时能立即检索到已提交笔记 |
| 2 | 后台索引 | 索引进行中切到另一个库 / 关闭所有笔记窗口,保持 Obsidian 前台 | 索引继续推进;切回后计数不回退、不重复从头开始 |
| 3 | 系统暂停恢复 | 索引进行中让系统睡眠(合盖或 `pmset sleepnow`),数分钟后唤醒 | 唤醒后阶段如实变化:停滞显示停滞、恢复后继续核对;已完成笔记仍可检索,计数不回退 |
| 4 | 取消再启动 | 索引进行中点「暂停索引」,再点「恢复索引」 | 暂停时阶段为正在停止/已暂停;恢复后继续核对,已提交部分不丢失;不出现永久挂起(若挂起,用「恢复索引」应能重置运行时) |
| 5 | 关闭重开 | 索引进行中完全退出 Obsidian,重新打开 | 重新打开后从上次完成记录继续;**零变化文件不重复嵌入**(用诊断或日志核对);已完成笔记可检索 |
| 6 | 索引期间编辑 | 索引进行中修改一批笔记(含新增、删除、改名、清空一篇) | 被改笔记先退出检索、提交后重新出现;删除的笔记不再可检索;改名拆为旧路径删除 + 新路径入队;其他未改笔记不重复嵌入 |
| 7 | 配置变更(会话内) | 会话内改嵌入模型或分块参数 | 状态条提示「嵌入配置已在本次会话内变更」;索引写入暂停;按提示重新加载插件后重建索引 |
| 8 | 配置变更(跨会话) | 改配置后完全重启 Obsidian | 为新配置建立独立代际;核对完成前旧代际仍可检索;核对完成后切换;`generations/` 下出现两个代际目录 |
| 9 | 清理非活动代际 | 完成上一步后运行命令面板的「清理非活动索引代际」 | 需输入 `DELETE` 确认;只删除未生效代际;活动索引与检索结果不变;`control.json`、`owner.lock`、未知文件保留 |
| 10 | 索引不可用与重试 | 人为制造装配失败(如把 `.index/control.json` 改坏)后重启 | 插件其余功能照常;状态条说明原因(带稳定错误码文案,不是裸 message);运行「重试索引装配」后如实报告恢复或仍不可用 |
| 11 | 关闭自动索引 | 关闭「自动索引」,编辑若干笔记,比较索引目录快照 | 目录快照逐字节不变(含无 `owner.lock` 新增);检索只用可信完成记录且新鲜度为「未知」;无可信记录时提示索引状态未知 |

## 7. 验证结果(本机实测)

```bash
npx tsc -noEmit -skipLibCheck 2>&1 | grep -c "error TS"   # → 241
git diff --check                                          # → exit 0,无输出
git status --short                                        # → 仅文档改动
```

- **`tsc`:241**,与 T1~T8b-1 记录的存量基线一致,新增 0。按计划要求如实表述:**这不是「类型检查通过」,而是「存量 241 条、本轮新增 0 条」。**
- **`git diff --check`:** exit 0,无输出。
- **`git status --short`:** 本轮改动为 6 个已跟踪文档(`CHANGELOG.md`、`docs/architecture/host/index-controller.md`、`docs/architecture/host/worker-protocol.md`、`docs/architecture/rag/vector-index.md`、`docs/user-guide.md`、`docs/user-guide.en.md`)加 1 个新增证据文档;`src/**`、`tests/**` 在工作树中的改动均为 **T8a / T8b-1 的既有未提交改动**,本轮未新增任何 `src/` 或 `tests/` 改动。

## 8. 需要 Lead 裁定的事项

1. **Sandbox 图形验证的执行者与时机。** 本轮由实施 subagent 执行,无法完成 GUI 交互式验证(见第 6 节前置条件);建议由 Lead 或在有宿主环境的后续任务里逐项执行。是否接受「记录未验证 + 给出清单」作为本期交付形态,请裁定。
2. **小库档门槛的最终口径。** 文档与 CHANGELOG 已按 T8b-1 的建议写明「门槛口径需修订」且未把带载读数写成达标;是否要单独修 spec/plan 的门槛措辞,属 Lead 范围(本轮不改 plan/spec)。
3. **「回收阻断时旧配置只读搜索」的处置。** 文档已标注为未实现。是否补实现或在 spec 中改写该条,需 Lead 决定。
4. **`docs/architecture/**` 的修改授权。** `docs/AGENTS.md` 要求修改 `architecture/` 前核对授权;本任务书明确把三份架构文档列入可改清单,故按授权执行;若需补记授权来源,请 Lead 在合并说明中标注。
5. **`CHANGELOG.md` 的「已知限制」小节是否保留。** 它如实记录了小库档未达标这一事实。若 Lead 认为 Unreleased 节不应承载限制声明,可移到 plan/证据或 Release note;本轮主张保留。
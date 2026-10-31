# 索引可靠性实施计划

> **面向执行 Agent：** 执行时按 `subagent-driven-development` 逐任务推进，每个实现任务使用新的 subagent，并进行规范、代码质量两阶段独立审查。本轮用户授权 Agent 自审裁定设计，不再设置用户设计确认节点；T0 已实施并完成两阶段审查。

**目标：** 已持久提交的文件在重启后零重复嵌入，变更和失败仅影响对应文件，检索不读取未完成或已知过期结果。

**架构：** 文件级写前日志保存可重放向量，Vectra 原子存储适配器负责磁盘替换，文件完成记录决定可用性。持久任务协调器统一扫描、事件、恢复、取消和写所有权，查询仅在短提交阶段串行等待。配置代际隔离不同向量空间。

**技术栈：** TypeScript、现有 Vectra `FileStorage` 扩展点、Node 文件 API、Embedding Web Worker、Svelte store、Vitest；不新增数据库或原生模块。

关联：`P-INDEX-RELIABILITY` → [S-INDEX-RELIABILITY](../specs/2026-10-31-index-reliability.md) → `BUG-1-INDEX-001`。状态：**In Progress，T0～T6 已完成（证据见 `2026-10-31-index-reliability-t{0,1-t2,3,4,5,6}-evidence.md`），进入 T7**。全量 292 文件 / 2669 passed / 5 skipped；tsc 241 条存量、新增 0。T7 的硬前置清单见 T6 证据第 8 节。合并与发布仍另行授权。

## 执行边界与依赖

这是涉及持久化和协议的大档任务。T0 是独立技术实验，只依赖现有公开 API 和测试内的最小存储替身，不依赖 T1 的生产适配器。T0 未给出可行性证据不得推进其余实现；T1～T8 按依赖顺序执行。文件持久化、恢复和检索是同一交付链，不将单个基础任务宣称为已交付功能。

提交按三个可审查组组织：T0～T2 存储基础；T3～T5 文件任务与恢复；T6～T8 消费、迁移和验收。组内保持定向测试，不为了提交拆散无法工作的协议两端。实现完成后再决定合并、归档与发布。

执行前读取沿途 AGENTS、编码约定及各阶段 Skill；基线仅采集当前工作树，不使用其他目录的未提交改动。新源码注释与测试描述用中文，所有用户错误和状态同步中英文翻译。只使用临时目录及 Sandbox；禁止操作日常库。

## 文件结构

下表是本计划锁定的职责拆分；新增文件不是当前已存在的实现。

| 文件 | 动作与职责 |
| --- | --- |
| `src/core/index-persistence-types.ts` | 新建，持久记录、任务状态和活动消息的唯一类型声明 |
| `src/adapters/atomic-index-storage.ts` | 新建，通过公开 FileStorage 扩展点提供原子替换和 flush |
| `src/core/index-write-owner.ts` | 新建，跨插件实例交接和进程排他写锁 |
| `src/core/index-file-journal.ts` | 新建，prepared 分片、完成记录、校验和恢复决策 |
| `src/core/index-task-coordinator.ts` | 新建，流式扫描、路径队列、epoch、取消与任务终态 |
| `src/core/index-generations.ts` | 新建，配置指纹、活动指针、迁移与代际回收 |
| `src/core/index-search-visibility.ts` | 新建，统一候选可见性判定，不复制正文 |
| `src/adapters/vector-vectra.ts` | 修改，完整枚举/事务替换、注入原子存储、故障后重载 |
| `src/worker/index-processor.ts` | 修改，分离推理准备与持久替换，禁止提前删除 |
| `src/core/persistent-index-backend.ts`、`src/core/index-manager.ts`、`src/core/index-controller.ts` | 修改，接入协调器，替换整批成功才存清单的路径 |
| `src/ports/embedding.ts`、`src/adapters/embedding-api.ts`、`src/adapters/embedding-onnx.ts`、`src/adapters/embedding-worker-proxy.ts`、`src/worker/embedding-worker.ts` | 修改，批次活动、取消与运行时终态；保持端口兼容 |
| `src/types.ts`、`src/worker/manager.ts`、`src/worker/handler.ts`、`src/worker/inline-worker.ts`、`src/worker/index.ts` | 修改，请求/任务活动、准备/提交协议及两端串行规则 |
| `src/core/multi-query-searcher.ts`、`src/core/search-result-mapper.ts`、`src/tools/search-vault.ts` | 修改，在重排/模型消费前过滤不安全候选 |
| `src/user-feedback/user-status.ts`、`src/core/feedback-controller.ts`、`src/ui/chat/feedback-modal.ts`、`src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts` | 修改，部分可用、停滞/恢复、未知新鲜度与取消反馈 |
| `src/main.ts` | 仅装配、注册监听与销毁；移除旧全量/清库旁路 |
| `tests/helpers/index-reliability-fixture.ts` | 新建，临时磁盘、合成 Vault、可计数嵌入、可控故障点的公共夹具 |
| `tests/helpers/index-crash-child.ts` | 新建，独立进程写入和指定阶段退出，不访问真实 Vault |
| `tests/core/index-reliability-crash.test.ts`、`tests/core/index-reliability-scale.test.ts` | 新建，不放在默认排除的 `tests/integration/` 下 |

## T0：验证 Vectra 的原子替换能力

**文件：** 新建 `tests/adapters/vector-vectra-atomicity.test.ts`、`tests/helpers/index-reliability-fixture.ts`；本任务先不改变线上索引路径。

- [x] 记录现有 `deleteByPath` 的固定 512 维/top 100 查询和 `reembedFile` 提前删除行为，新增大于 100 块、不同维度、文件变短及空文件用例，先运行看到真实失败。
- [x] 通过公开 `listItems()` 或完整 metadata 枚举取出目标文件全部 ID，不用相似度查询做删除枚举；构造「旧块 → 一个事务删除并写新块 → 抛错回滚」实验。
- [x] 在测试夹具中提供 `LocalFileStorage` 的薄封装，仅覆盖 `upsertFile` 的临时文件/rename 实验，通过 `LocalDocumentIndex` 的 `storage` 配置注入；确认 `endUpdate` 的落盘时机、外置 metadata 和失败后的内存视图。测试原文件保持、rename 后抛错与新实例重载；T1 再将验证过的机制实现为生产适配器。
- [x] 证明可以不改 node_modules、不访问私有 `_data/_update` 实现契约。若公开 API 不足，停止计划并修改 spec，不能以先删旧块绕过。
- [x] 固定确定性假嵌入、分块配置和合成数据，在同机临时目录采集现有成功路径基线：100/1000/3000 篇分别运行三次，记录中位耗时、峰值 heap/RSS、向量文件写入字节数与次数。全量完成后再测零变化启动和单文件更新；旧缺陷路径失败则单独记失败，不用超时耗时伪造成功基线。

核心实验顺序必须为：

```text
准备完整新向量 → beginUpdate → 枚举并删除目标路径全部块
→ 插入全部新块 → endUpdate → 重建存储实例读取确认
```

**验证：** `npx vitest run tests/adapters/vector-vectra-atomicity.test.ts`。现有缺陷用明确的预期失败断言记录，实验路径用普通断言验证通过，不能跳过用例制造通过。进入 T1 的条件为：公开 API 可完整枚举/同事务替换、注入原子存储后磁盘为完整版本、失败重载能确定结果；不要求尚未实现的生产路径在 T0 就已修好。T2 修复生产路径时将预期失败断言转换为成功断言。

## T1：建立持久数据契约与原子存储

**文件：** 新建 `src/core/index-persistence-types.ts`、`src/adapters/atomic-index-storage.ts`；新建 `tests/adapters/atomic-index-storage.test.ts`、`tests/core/index-persistence-types.test.ts`。

- [x] 先写 schema 校验失败测试：未知版本、路径越界、指纹不匹配、非有限向量、重复块 ID、损坏 checksum 均拒绝。
- [x] 在唯一类型文件定义下列契约；`generationId` 和 `configFingerprint` 分别用于目录身份和配置身份，不混用。配置 fingerprint 使用稳定字段顺序序列化后 SHA-256，排除凭证和临时任务状态。

```typescript
interface FileCommitBase {
  schemaVersion: 2;
  generationId: string;
  path: string;
  configFingerprint: string;
  commitId: string;
  revision: number;
  chunkCount: number;
  blockSetHash: string;
}
export type FileCommit = FileCommitBase & (
  | { state: 'present'; inputHash: string }
  | { state: 'deleted'; inputHash: null; chunkCount: 0 }
);
export interface PreparedFile {
  schemaVersion: 2;
  operation: 'replace' | 'delete';
  next: FileCommit;
  previousCommitId: string | null;
  previousRevision: number;
  parts: Array<{ name: string; hash: string; count: number }>;
}
export type IndexPhase =
  | 'scanning' | 'processing' | 'stalled' | 'stopping'
  | 'paused' | 'partial-failure' | 'failed' | 'ready';
```

- [x] 实现原子存储：唯一临时文件以 `wx` 创建 → 写入 → 文件 sync → 关闭 → 同目录 rename → 支持的平台上同步目录。通过公开 `FileStorage` 注入，所有路径限定在所属代际目录；临时文件失败清理不能遮蔽原错误。
- [x] 区分提交前失败与 rename 后状态不明；调用者重载验证，不能一律按旧版仍在磁盘继续搜索。对原子替换失败注入短写、磁盘满、rename 错误及目录 sync 错误。

**验证：** `npx vitest run tests/adapters/atomic-index-storage.test.ts tests/core/index-persistence-types.test.ts`；断言失败后重新读取的 JSON 为完整旧版或完整新版，不存在半截文件。

## T2：写所有权与安全替换

**文件：** 新建 `src/core/index-write-owner.ts`、`tests/core/index-write-owner.test.ts`；修改 `src/adapters/vector-vectra.ts`、`src/worker/index-processor.ts`、`tests/adapters/vector-vectra.test.ts`。

- [x] 先写同 renderer 两次插件实例交接、旧实例推理迟到、跨进程竞争锁用例；确认现有实例内排队不能保护重载后的新实例。
- [x] 共享协调器以 `Symbol.for('ratel.index.write-owner.v2')` 注册在 renderer 的 `globalThis`，内部以规范化根目录为 key。每次实例接管有新 epoch；旧 epoch 不能开始提交，新实例必须等待旧 closing Promise。永久挂起只显示占用，不抢写。
- [x] 根目录 owner 锁用排他创建保存本机进程身份、实例令牌与协调器版本。锁的创建/释放/死亡回收经过同一排他恢复门，在门内重新读取并核对旧令牌；两恢复者竞争、PID 存活但身份不明、外机锁、空锁和无权限检查均有明确失败测试。不得按过期时间抢锁，释放前核对令牌，避免旧回收者误删后继实例的锁；无法确认恢复门持有者已退出时也拒绝强抢。
- [x] 实现 `replaceFile` 的公共适配器方法，删除和插入在同一事务，空数组也完成删除；为块写入 `commitId`。报错后存储进入需重载状态，不继续拿旧缓存服务查询。

```typescript
export interface PreparedBlock {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}
export interface FileReplacement {
  path: string;
  commitId: string;
  blocks: PreparedBlock[];
}
// VectraStore 新增公共契约，实现在 T0 验证的公开 API 上。
export interface FileReplaceStore {
  replaceFile(input: FileReplacement): Promise<void>;
  inspectFile(path: string): Promise<PreparedBlock[]>;
  reload(): Promise<void>;
}
```

**验证：** `npx vitest run tests/core/index-write-owner.test.ts tests/adapters/vector-vectra.test.ts tests/adapters/vector-vectra-atomicity.test.ts`。覆盖至少 201 个目标块及其他文件，删除数必须等于全部目标块，其他文件完全不变。

## T3：文件日志与恢复状态机

**文件：** 新建 `src/core/index-file-journal.ts`、`tests/core/index-file-journal.test.ts`；修改 `src/core/persistent-index-backend.ts`、`tests/core/persistent-index-backend.test.ts`。

- [x] 先为 prepared 前、向量提交前后、receipt 前后、日志清理时分别写失败测试，重建全部对象后读取真实磁盘。
- [x] 实现日志 API：`prepare` 按批落分片，所有分片完整后原子写 `prepared.json`；`commit` 替换目标向量后保存 `files/<pathHash>.json`；`recover` 先校验事务及磁盘，再重放或清理。每个 API 在入口检查持有的 owner/epoch。
- [x] `PreparedFile.next.commitId` 同时写入块和完成记录。对零块/删除事务用目标路径已无块、prepared 和 receipt 共同证明，不以查到块作为唯一恢复依据。
- [x] 删除以 `state=deleted/inputHash=null` receipt 持久化，空文件以 present 和实际内容 hash 持久化；同路径重建递增 revision。清单视图排除 tombstone，但不能在事务完成前删除其证明。
- [x] 同路径只允许一个未决 prepared；后继提交必须核对并结算前驱，重放比较 previousRevision/commitId。receipt 已是更新 revision 时旧日志只能清理，不能重放。测试前驱清理持续失败、后继成功、重启后旧日志仍在以及「删除后同路径重建」。
- [x] 过期输入且已替换向量时，先持久化该路径不可用状态并保留恢复依据，再处理当前版本；不丢日志后使用旧 receipt。普通日志清理失败只重试清理，不重复嵌入。
- [x] 移除 `invalidateMetadata()` 对整个库的失效操作；整批返回只汇总统计，不承担唯一提交。`isIndexComplete` 检查本轮扫描/队列/失败，部分检索可用性读取文件记录。

恢复决策必须完整覆盖：

```text
prepared 无效但可可信归属 → 隔离该路径并重算；无法归属 → 隔离代际
receipt revision 高于 prepared → 验证后清理旧日志，禁止覆盖后继
prepared 有效且当前输入匹配 → 检查完整块集合 → 补 receipt 或重放
prepared 已过期且磁盘仍是旧提交 → 保留旧完整结果，排队当前版本
prepared 已过期且磁盘含过期新提交 → 持久过滤路径，排队当前版本
receipt 与实际块匹配且仅清理未完成 → 只清理，不再嵌入
```

**验证：** `npx vitest run tests/core/index-file-journal.test.ts tests/core/persistent-index-backend.test.ts`。所有恢复用例检查实际块 ID、hash、数量、维度与嵌入 spy 调用数，不仅检查 UI 状态。

## T4：流式扫描、变更队列与文件新鲜度

**文件：** 新建 `src/core/index-task-coordinator.ts`、`src/core/index-search-visibility.ts`、`tests/core/index-task-coordinator.test.ts`、`tests/core/index-search-visibility.test.ts`；修改 `src/core/index-manager.ts`、`src/core/index-controller.ts` 及对应测试。

- [x] 先写枚举与监听间变更、mtime/size 不变但正文变化、推理中删除、提交中再次修改、连续编辑不饿死其他文件的测试。
- [x] 在枚举前注册事件，路径事件序号持续单调增长；按路径合并队列。初始仅一个文件在准备/提交，不为吞吐擅自并发写入；无变化文件核对 hash 后复用。
- [x] 读取前后、推理后及提交前检查内容/事件序号/配置。提交后若仍有新事件，保留对应队列项；只有本次输入 hash 完成，不能清空后来事件。读失败区分文件已删除和无法读取，不把读取错误当成空文件提交。
- [x] 普通修改先标记 known-stale；删除、排除和损坏立即 deny。扫描期间逐文件核实后可解锁已提交部分，`ready` 要求扫描结束且无待处理失败/事务/事件。
- [x] 删除/改名落 durable 事务；空文件提交零块 receipt。初次扫描使用轻量路径列表和逐文件内容，不调用旧 `snapshot()` 生成全库正文数组。

队列完成的检查规则：

```typescript
export function canMarkReady(s: {
  scanComplete: boolean; queued: number; active: number;
  pendingTransactions: number; failures: number;
}): boolean {
  return s.scanComplete && s.queued === 0 && s.active === 0
    && s.pendingTransactions === 0 && s.failures === 0;
}
```

**验证：** `npx vitest run tests/core/index-task-coordinator.test.ts tests/core/index-search-visibility.test.ts tests/core/index-manager.test.ts tests/core/index-controller.test.ts`。再次启动仅修改一篇文件时，只有该文件进入嵌入调用。

## T5：活动、停滞恢复与取消

**文件：** 修改文件结构表中的 Worker/Embedding 协议两端、`src/ports/embedding.ts`；修改 `tests/worker/worker-bridge.test.ts`、`tests/worker/inline-worker-lifecycle.test.ts`、`tests/worker/embedding-worker.test.ts`、`tests/adapters/embedding-worker-proxy.test.ts`、`tests/adapters/embedding-api.test.ts`。

- [x] 先用可控时钟复现「停滞 → 有效活动 → 迟到成功仍提交」，并确认旧代码会永久丢掉提交路径；独立验证普通查询超时仍 reject。
- [x] 在集中类型文件定义活动包，并扩展准备/提交消息；两端同时修改。单调活动序号由真正完成的批次/IO 步骤产生，UI 计时器和 Worker 存活消息不算活动。

```typescript
export interface IndexActivity {
  taskId: string;
  requestId: string;
  epoch: number;
  sequence: number;
  stage: 'chunk' | 'embed' | 'persist';
  completedUnits: number;
}
export interface EmbedOptions {
  signal?: AbortSignal;
  onBatchComplete?: (done: number, total: number) => void;
}
```

- [x] `EmbeddingPort.embed(texts, options?)` 保持旧调用可用；ONNX 每个真实完成批次回报，API 适配器正确传递 AbortSignal，代理按 request ID 转发。跨 Worker 不直接传函数或 AbortSignal，通过消息表达取消与活动。
- [x] 索引 watchdog 更新 stalled 状态，任务由协调器继续持有；真实终态只有一条。拆开长推理与短存储互斥，禁止为了支持查询让两个提交重叠。
- [x] 暂停/取消先撤销 epoch、停止新文件，再取消可取消调用并等待活动提交。共享 Worker 不能在取消单项任务时直接终止其他查询；运行时重置必须 reject 所有受影响 pending，不留下永不结束 Promise。
- [x] 构造卸载期间推理迟到、磁盘仍在提交、新实例立即启动的测试；存储保护经 T2 共享协调器交接，旧 UI 回调全部失效。

**验证：** `npx vitest run tests/worker tests/adapters/embedding-worker-proxy.test.ts tests/adapters/embedding-api.test.ts tests/core/index-write-owner.test.ts`。同时保留 index/full/batch 兼容测试，直到没有旧调用方再删旧消息。

## T6：配置代际与旧索引迁移

**文件：** 新建 `src/core/index-generations.ts`、`tests/core/index-generations.test.ts`；修改 `src/core/index-manifest.ts`、`src/core/index-build-stamp.ts`、`src/core/persistent-index-backend.ts` 及迁移测试。

- [x] 先写有效旧清单、零块数但实际有块、缺 stamp、块残留、API 同名异端点、迁移中断及控制指针损坏测试。
- [x] 配置指纹使用实际模型来源/身份/可确认修订/维度及分块输入；API 身份不可追溯时不假设兼容。兼容旧文件对照内容 hash 与当前分块集合验证，不调用模型；不兼容文件单独重算。
- [x] 在 owner 锁内只读复制旧 Vectra 数据及引用外置 metadata 到独立代际目录，核对复制摘要后逐文件写 receipt，最后原子发布 control；旧文件保留，复制中断可重入且不重复嵌入。空间不足只报告迁移失败，不先删旧数据腾空间。旧半成品的重算也逐文件保存检查点。
- [x] legacy 清理仅按迁移时验证的旧 Vectra 文件白名单执行，禁止任何路径将 `.index/` 根目录传给递归 dropIndex；保留 control、owner、generations 和未知文件。新增清理测试，断言这些文件和新代际摘要不变。
- [x] 首次无活动代际时首个文件提交即可登记活动代际并部分检索；配置变化则建隔离代际，全部核对/提交后切活动指针。切回配置先复核当前文件，不直接恢复旧 ready。
- [x] 默认最多活动加一个待建/回退代际。第三配置只回收无活动提交和未解决事务的非活动代际；不能回收时暂停新建，保留可用活动索引。所有清理持有 owner 锁并校验目录归属。

**验证：** `npx vitest run tests/core/index-generations.test.ts tests/core/index-manifest.test.ts tests/core/index-manifest-migrate.test.ts tests/core/index-build-stamp.test.ts tests/core/persistent-index-backend.test.ts`。升级有效且未变文件的嵌入调用数必须为零。

## T7：检索消费、状态和宿主装配

**文件：** 修改文件结构表中的搜索、反馈、i18n 和 main；修改 `tests/tools/search-vault.test.ts`、`tests/core/feedback-controller.test.ts`、`tests/main-index-lifecycle.test.ts`、`tests/ui/chat/feedback-diagnostics.test.ts`。

- [ ] 先写原始向量候选中包含 stale/deleted/excluded/unresolved 时不能进入 rerank 输入的测试；不仅检查最终 UI 结果。
- [ ] 将统一 visibility gate 放在向量候选进入融合/重排前，必要时继续取候选补足 topK；不得用后置工具过滤掩盖已发送给模型的片段。引用只对当前核实版本提供定位。
- [ ] `autoIndex=false` 仅读取可信完成记录并核验本次候选存在性/黑名单，新鲜度显示 unknown；零全库扫描、零嵌入、零恢复写入。黑名单清理只排队，显式启用或授权清理后执行；没有可信记录则不可检索。
- [ ] 状态展示区分总文件数、已提交数、待处理/失败数和当前阶段；变更导致待处理量增加时说明重新核对，不让旧任务进度污染新任务。Notice 仅真实全库完成时发送。
- [ ] 增加停滞/恢复、部分可用、正在停止/已暂停、迁移和磁盘失败的 zh/en 文案及类型；取消操作复用现有控制入口，不新增设置页导航。
- [ ] main 仅装配协调器与销毁；删除直接 drop/rebuild 旁路，确认模型切换、手动重建、Indexer Subagent 均经相同 owner/代际流程。手动强制重建不静默丢弃当前有效索引。

**验证：** `npx vitest run tests/tools/search-vault.test.ts tests/core/feedback-controller.test.ts tests/main-index-lifecycle.test.ts tests/ui/chat/feedback-diagnostics.test.ts tests/subagents/indexer.test.ts`。模型/重排 spy 对被排除路径的输入命中数为零。

## T8：进程崩溃、大库与交付验证

**文件：** 新建上述 crash/scale/fixture 文件、`tests/helpers/index-crash-child.ts`、`vitest.index-reliability.config.ts`；修改 `docs/architecture/rag/vector-index.md`、`docs/architecture/host/worker-protocol.md`、`docs/architecture/host/index-controller.md`、`docs/user-guide.md`、`docs/user-guide.en.md`、`CHANGELOG.md`。

- [ ] 使用子进程在 prepared、向量 rename、receipt rename、清理前后各阶段强制退出，父进程重新创建完整实例，验收 spec A1～A11。通过 esbuild 构建临时 child 入口，产物只放临时目录；不依赖退出回调保存状态。
- [ ] 大库 fixture 使用确定性假嵌入统计重复计算，覆盖 3000 篇短文档与一个超过 200 块文件、512/不同维度、连续编辑及多次重启。真 ONNX 另在 Sandbox 合成库验证，不能用假推理基准冒充真实模型耗时。
- [ ] 专用 Vitest 配置明确包含 crash/scale 文件，继承基础别名和 setup，将 `passWithNoTests` 设为 false；默认测试不隐式下载模型。执行日志保存配置、commit、测试数量和基准分布。
- [ ] 在 T0 相同数据、机器、模型替身与三次中位数口径下复测：零变化启动耗时不得超过成功基线的 1.25 倍，完整首次构建耗时和峰值 RSS 不得超过成功基线的 1.5 倍；这些是本设计的验收目标，不是实测结论。旧路径没有成功基线的场景记录绝对值和失败原因，不填相对通过；需用可成功的更小样本比较，并保留大样本未获相对验证的限制。未达标则优化或修订存储设计，不在实施日志中静默放宽门槛。
- [ ] 验证零变化启动不写向量数据、单文件变化只提交一次该文件事务；队列只存路径/序号，不保留全库正文；未结算事务只保留活动文件，已结算但清理失败的分片需可定位回收。性能记录必须列出逐文件重写大 JSON 的累计字节数与耗时，不能只报告重复嵌入为零。
- [ ] 在 Sandbox 验证前台/后台、系统暂停恢复、取消再启动、关闭重开和索引期间编辑。若系统暂停场景无法复现，记录未验证，不填通过。
- [ ] 代码通过两阶段独立审查后同步用户指南和架构说明，CHANGELOG 仅写未发布事实。更新 STATUS/Project 为真实节点，不在本任务打 tag、发布或操作日常库。

**最终验证命令：**

```bash
npx vitest run --config vitest.index-reliability.config.ts
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

预期：定向和全量测试确实执行并通过，lint/build 无新增阻断，类型检查记录实际结果。现有分支曾有存量 typecheck 错误，执行时重新采集基线并按文件/错误码比较；无新增错误不能写成 typecheck 通过。

## 自审与验收映射

| spec 验收 | 任务与证据 |
| --- | --- |
| A1～A2 中断续建/提交恢复 | T1、T3、T8：真实磁盘、子进程退出、重新构造、调用计数 |
| A3～A5 变更/空文件/局部失败 | T2、T4：完整块集合和事件序号；T8 重启复测 |
| A6 IO 故障 | T0～T3：原子写与状态不明后的重载；T8 故障矩阵 |
| A7～A8 停滞/取消/实例交接 | T2、T5：时钟、共享 owner 和子进程竞争证据 |
| A9～A10 迁移/代际 | T6：有效索引零重复嵌入、半成品不冒用、切回重新核对 |
| A11 检索/隐私/关闭自动索引 | T4、T7：消费前过滤、关闭后零隐式副作用 |
| A12 大库 | T8：合成与真实推理分别记录、队列/暂存内存/写入量证据 |

计划自审：没有将旧 top 100 删除当完整枚举；没有依赖卸载耗时落盘；没有以请求超时抛弃任务终态；没有以全库完成凭据替代文件检查点；首次部分检索和配置切换的门槛分开。T0 存储验证尚未执行，实际吞吐、原子写的平台行为、系统暂停和旧索引样本兼容均未验证，不能从本计划推断已解决。

设计独立审查记录（2026-10-31）：读者为持久化实现者，审查覆盖 spec 全文与相关现役代码；首轮 3 个阻断、4 个影响、2 个建议，集中在过期事务、实例写交接、首次部分检索与旧删除实现。复跑确认原 3 个阻断关闭，并指出关闭自动索引时清理副作用、无法归属坏日志两处歧义；本文与 spec 已分别限定为清理排队、隔离代际。复跑仅检查原卡点及 plan 任务映射，不代表 plan 全文工程审查或实现验收；实际存储和性能留到 T0/T8 验证。

整体自审记录（2026-10-31）：用户将设计裁定委托 Agent，不再等待用户确认。主代理检查 spec/plan 一致性，并由独立审查者核查全文及现役代码，发现 4 个阻断、3 个影响：删除状态缺失、旧日志覆盖后继版本、锁回收竞态、legacy 根清理风险，以及 T0 依赖环、坏日志归属冲突和性能判据缺失。修订后对原 7 项复跑，剩余 0 阻断、0 影响；主代理裁定设计/计划审查通过。plan 仍为 Pending，只允许按依赖从 T0 开始验证；存储原子性、进程恢复、真实 ONNX、Sandbox 和大库性能尚未运行验证。本轮仅修改需求说明、spec、plan 与 STATUS，未改源码、未运行产品测试、未操作日常库。

本计划保存 Agent 裁定后的任务与接口，代码片段用于锁定契约和关键判断，未将正文复制为源码实现。执行每个任务仍须先写失败用例，再实现并验证，不得跳过 T0 或将计划中的预期结果填成实测。

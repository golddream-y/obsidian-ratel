# T8 收口记录：进程崩溃、大库与交付验证

> 本文件是 T8 的**统一收口**。三份分阶段证据（`t8a` 装配下沉与崩溃验收、`t8b1` 规模与性能、`t8b2` 文档与交付）各自记录实测细节；本文件只记两阶段审查结论、修复轮、Lead 复核与裁定，以及**未闭环项**。

## 一、交付面

| 交付 | 位置 | 说明 |
|---|---|---|
| 装配下沉 | `src/core/index-runtime-assembly.ts`（971 行） | 不 import `obsidian`，依赖全参数注入；`main.ts` 3333 → 2980 行 |
| 崩溃验收 | `tests/helpers/index-crash-child.ts`、`tests/core/index-reliability-crash.test.ts` | 独立子进程入口（esbuild 现场构建）、`SIGKILL` 强制退出、5 个阶段 + 17 例 |
| 规模验收 | `tests/helpers/index-reliability-scale.ts`、`tests/core/index-reliability-scale.test.ts` | 3001 篇（含 1 篇 600 块）、512/768 维、连续编辑、多次重启 |
| 专用配置 | `vitest.index-reliability.config.ts`、`npm run test:index-reliability` | `passWithNoTests:false`、别名/setupFiles 取自基础配置（取不到即抛错） |
| 自动化入口 | `.github/workflows/index-reliability.yml` | `workflow_dispatch` 手动触发（理由写在文件头：本机 10 核约 13 分钟，托管 4 核更久） |
| 文档 | `docs/architecture/{rag/vector-index,host/worker-protocol,host/index-controller}.md`、`docs/user-guide{,.en}.md`、`CHANGELOG.md` | 与源码逐点一致；用户指南 zh/en 成对；CHANGELOG 仅 `[Unreleased]` |

## 二、两阶段审查

| 阶段 | 结论 | 阻断 | 主要发现 |
|---|---|---|---|
| 规范符合性 | 有条件通过 | **1（B1）** | checkbox 4 未闭环（三种出口一个都没落地）；checkbox 1 的「验收 A1～A11」字面范围大于实际（A7～A11 由前序套件覆盖）；「T0 相同数据」未执行；逐文件重写大 JSON 的**耗时**未记录；3000 篇零变化订正读数不可复现；STATUS/Project 未更新 |
| 代码质量 | 有条件通过 | 0 | 装配下沉 14 项逐条等价；崩溃夹具无子进程超时（超时会泄漏目录与子进程）、入口判据依赖可继承环境变量、JSDoc 声称 `fsyncSync` 但未调用、`receipt-after` off-by-one；规模用例失去默认覆盖且专用配置未接入自动化；`judgeGate` 只校验被测臂负载；内存探针断言偏弱；`snapshotDirectory` 只比字节数却写成「逐字节」 |

## 三、修复轮

**崩溃夹具与装配侧**：子进程显式超时 90s + `SIGKILL` + **在 `close` 回调内独立清理**场景目录（有挂起用例实测）；入口判据改为**命令行参数**（新增「环境变量齐备但不传入口参数 → 不自杀」用例）；`fsync` 注释改正为「SIGKILL 不丢 page cache，故不做 fsync」；`receipt-after` 改为先判定后自增并补 **N≥1** 用例；25ms 固定窗口改为**写收敛条件**（在途写计数归零 + 连续 2 轮无新写，超上限抛错）——换回旧睡眠即红（`dispose` 在 120ms 在途写结算前返回）；删除未用的 `isPublishing()`；修正 `confirm-modal.ts`/`subagents/indexer.ts` 中「reindex 清空重建」的陈旧注释。

**规模与口径侧**：100 篇档 A/B **移出** `RATEL_SCALE` 重门控（计划命令默认口径即产出 checkbox 4 判定）；`judgeGate` 改为**分子臂与分母臂都记录并校验负载**，任一侧超核数即 `not-comparable`；写入计量补**按类别累计耗时**；3000 篇零变化启动改为**仓库内三连测**（订正读数可复现）；内存探针降级为观测、不作独立结论；`snapshotDirectoryContents` 改名并注明此前误标；工作区改为逐用例释放；删除死代码；3000 篇档新增**嵌入文本摘要多重集合**断言。

## 四、Lead 复核

| 命令 | 结果 |
|---|---|
| `npx vitest run --config vitest.index-reliability.config.ts` | **2 文件 / 29 passed \| 6 skipped**，859s，exit 0 |
| `npm test` | **294 文件 / 2774 passed \| 18 skipped**，exit 0 |
| `npm run lint` | **0 error / 20 warning**（15 条可自动修复，均为存量 `hardcoded-config-path` 类） |
| `npm run typecheck` | **未通过**：`tsc` 存量 241 → `&&` 短路，`svelte-check` 未执行。单独执行 `svelte-check` 得 **253 errors / 21 warnings / 71 files** = 存量 241 + Svelte 侧既有 12；抽查本计划改过的文件**无新增** |
| `npm run build` | exit 0（18 条既有 Svelte 警告），产物 `dist/` 已清理 |
| `git diff --check` | 干净 |
| `/tmp` 与 `tests/tmp` 残留 | 0 |

`tsc` 的 241 条经三路核对（两位审查者与主检出逐条 diff、Lead 抽查可疑行）：**集合与基线一致、仅行号位移、新增 0**。

## 五、门槛判定的实际口径

计划命令现已产出判定。同一用例在两种窗口下的结果：

| 窗口 | 两侧负载 | 判定 |
|---|---|---|
| 带载（Lead 复核） | 分子 13.91 / 分母 15.17，核数 10 | 两行均 `not-comparable`（**不用带载读数过门**） |
| 空载（规范审查复跑） | 9.18～9.51 ≤ 10 | `plan`：完整构建 **fail 27.52×**、峰值 RSS pass、零变化 **fail 3.04×**；`durable-matched`：完整构建 **fail 3.06×**、零变化 **fail 4.16×** |

读数一致性：Lead 带载复跑 `t0=542ms / t0-durable=2667ms / coordinator=7840ms`；空载复跑 `447.9 / 2653.9 / 8117.8`。两组的相对关系一致（耐久臂相对非耐久臂 4.9～5.9×，本次设计相对耐久臂 2.9～3.1×）。

## 六、未闭环项（唯一）

**checkbox 4：小库档性能未达标，且三种出口一个都没有落地。**

- **未达标事实**（空载口径）：100 篇对计划基线 27.52×（完整构建）/ 3.04×（零变化），对耐久性对齐臂 3.06× / 4.16×；1000 篇对耐久臂 1.85× 仍未达标；3000 篇对耐久臂 1.44× 达标；峰值 RSS 三档 0.85～1.29× 达标。
- **两个独立成因**：① **耐久性溢价**——把 T1 原子存储注入**未改动的旧路径**，100 篇即 4.67～5.93×，而 T0 基线完全不含耐久写入，故该门槛对任何耐久实现都不可达（小库档）；② **记录基线与本轮口径落差**——全档约 1.5～2×（T0 约 4.7 块/篇 vs 本轮 7 块/篇；100 篇索引 471.5 KiB vs 1.09 MiB）。大库档的门槛不可达主要由 ② 造成，不能与 ① 混为一谈。
- **成本来源**：每文件耐久原子写次数（本次设计 5 次 vs 旧路径+同存储 2 次，每次含 `fsync` + 父目录同步）。**写放大没有增加**：每篇仍 1 次全量重写，`index.json` 写入字节仅比对照臂多 0.7～0.79%，新增 4 次小型耐久写只占总字节 0.07%。
- **未选定出口，需用户裁定**：
  - (a) **修订门槛口径**：分母改为同分支/同数据/同窗口的耐久性对齐对照臂，小库档另设绝对预算；修订后 100/1000 篇仍未达标。
  - (b) **优化存储**：分片与 `prepared.json` 保留原子 rename 但跳过 `fsync` 与父目录同步。**不削弱 A2 的进程终止保证**（`SIGKILL` 不丢 page cache），但把「掉电后不重复嵌入」从隐含保证降为尽力而为，**需重新论证 A6**（而非 A2）并订正 `vector-index.md` §6.5 与 CHANGELOG；且该建议算术应订正为 **5→3**（要到 2 必须连 catalog 一起放宽，而 catalog 在对照臂两侧都存在、并非新增写），故「压到 1.5× 内」的预计收益被高估。
  - (c) 维持现状，改用绝对成本预算并在 spec 写明。

## 七、未验证项

| 项 | 原因 |
|---|---|
| Sandbox 图形验证（checkbox 6，11 项） | 本机无 GUI 驱动；Sandbox 的 `ratel-vault` 仍是 Oct 29 旧布局、本分支无 `dist/`。已给出 11 项可执行清单（`t8b2` 证据 §6） |
| 真实 ONNX 耗时 | 全部读数用确定性假嵌入，未用假推理冒充真实模型耗时 |
| 3000 篇 @512 维 | 未跑（外推约 330 GiB 写入），已标未验证 |
| A4 并发面 / A6 的 IO 注入 / A7～A11 | T8 未独立复跑；由 T2/T4/T5/T6/T7 套件覆盖并在全量中通过 |
| `npm run typecheck` 通过 | 存量 241 条，按计划要求记实际结果，不写成通过 |

## 八、移交给后续的登记债

1. 后端**以 receipt 为优先口径**：清单被删而 receipt 仍在时不得 `dropStore()`（会连 receipt 一起删）。
2. 「回收阻断时旧配置只读搜索」模式（spec §5）——当前为整库降级，文档已标「尚未实现」。
3. 只读装配走解析函数以复用 `allowCreate:false → resolved:null` 语义。
4. 迁移兼容校验的 O(N²) 大库实测与必要优化。
5. durable writer 抽共享模块（消除迁移侧与运行期写入口的 flush 不对称）。
6. `index-processor.ts:197` 单参 `embed(texts)` 丢 processor 级 options；`reclaimOrphanQuarantinedTransactions` 无周期调用；`verifyReceipt` 无生产使用点。
7. **API 模式 `NULL_PROCESSOR` 静默空集**（预存严重缺陷，已用真实 `handleMessage` + 真实检索链路实测；建议单独立项）。
8. `main.ts` 其余装配（工具注册/命令/模型链路）是否继续拆分。
9. `tests/**` 不在 eslint 覆盖内，建议补一条仅 `no-unused-vars`/`no-explicit-any` 的轻量规则。

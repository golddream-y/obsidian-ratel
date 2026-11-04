# P-ADAPTIVE-INDEX 暂停收尾

> 日期：2026-11-04。用户要求暂停推进；本文只登记已有证据，不把暂停写成验收通过。

## 现在停在哪

- 计划共 62 个 checkbox，本次按证据勾选 **4 条**，保留 **58 条**。勾选的是 T0 载体与实验包、T-REL 配置切换、T4 查询仲裁；证据已写在各条目旁。
- T4 查询仲裁已提交 `7c49f23`：定向 **46/46**；T5 `before` 故障注入已提交 `35af592`：真实子进程定向 **23/23**。T5 条目仍不勾，因为子进程证据不等于真实 Worker 生命周期验收。
- 分块迁移一致性已提交 `602a07d`：真实旧/新链路 **6/6**，覆盖边界、正文、嵌入输入及多类文件差异。
- 设置页 `indexThreadMode` 已提交 `4b635f0`，默认仍为 `false`，需重载插件生效；未改成默认开启。
- 类型口径沿用交付基线：**241 条存量、新增 0**，不写成全仓 typecheck 通过。当前工作树另含未提交的类型清零改动，不作为已交付结果。
- 最后一次全量运行在 `35af592`：**3033 passed / 1 failed / 25 skipped**。失败归因与跳过分类见下节；其后提交未再跑全量，因用户要求停止长任务。
- 写放大在 `64e40fb` 落地两阶段提交，后续修正仍未提交；当前暂停在代码审查阶段，不登记为完成。

## 最后一轮全量明细

### 1 failed

- 文件：`tests/core/index-file-journal.test.ts`。
- 用例：`文件日志 - 写所有权与在途提交 > 写所有权 - 提交成功与失败 - 在途提交凭据都被结算`。
- 关键输出：

```text
AssertionError: expected 4 to be 3
- Expected  3
+ Received  4
tests/core/index-file-journal.test.ts:1322:33
expect(harness.gate.acquired).toBe(3)
```

- **不是既有基线失败，是当时未提交改动引入。** 干净 `d87d42b` 与干净 `35af592` 上跑同一单用例均为 **1 passed / 54 skipped**；只在 `35af592` 重放当时 `src/core/index-file-journal.ts` 的未提交 `prepare → settlePredecessor` 外围 `owner.beginCommit()` 补丁后，稳定复现 **1 failed / 54 skipped**，同为期望 3、实际 4。原因是 prepare 多登记一次凭据，不是 T4/T5 提交导致。
- 该补丁后来已撤下；当前暂停点复跑同一用例为 **1 passed / 54 skipped**。失败只涉及获取次数断言，两个提交后的 `pendingCommits` 都为 0。

### 25 skipped

| 分类 | 数量 | 明细 |
| --- | ---: | --- |
| 环境门控 | 24 | 重规模/性能 13、迁移规模 3、Vectra 大样本 5、效率基准 2、隔离代理 1 |
| 待真机验收 | 0 | 真实 ONNX 由 `vitest.config.ts` 排除，不占这 25 条 |
| 可删陈旧用例 | 0 | 未发现可据此删除的用例 |
| 未归因 | 1 | 旧全量只保留汇总；静态清点与门控复算均为 24，剩余 1 条无逐条名单，不能猜分类 |

### 对暂停点的影响

**不影响可续做性，也不影响核心索引正确性结论**：失败来自临时补丁的凭据计数变化，当前单用例已通过；真实 Vault、ONNX 与宿主流畅度仍是独立未验收项。

## 未完成与原因

- **真实 Vault、真实 ONNX、宿主流畅度未验收**：需要人工在 Obsidian Sandbox 重载、操作并采集；Node 与确定性嵌入不能替代。
- **T4 只读线程版未交付**：需要只读打开存储、可信记录来源及切写不双开验证；既有 cutover 已明确不属 M1。
- **T5 完整生命周期未闭环**：消息损坏、取消、丢 ACK、真实 Worker 退出与宿主接管仍缺对应证据。
- **写放大未收尾**：审查仍指出批量回退可能覆盖在途新事件，以及全批 prepare 平方级重读 pending；相关未提交改动保留在 `index-runtime-session.ts`、`index-runtime-session.test.ts`、`index-thread-coordinator.test.ts`、`index-thread-efficiency.test.ts`，不抢提交、不勾效率项。
- **全量套件不是全绿**：仍有上述 1 条日志计数失败；后续提交只做了定向验证。
- **用户验收未执行**：默认开关未开，未安装到日常库，也未做发布。

## 下次怎么续

1. 先读 [主计划](2026-11-02-adaptive-indexing.md)、[实施进度](2026-11-02-adaptive-indexing-progress.md) 与本文，再用 `git diff` 核对上述四个写放大未提交文件，保留其他工作树改动。
2. 先处理批量回退事件覆盖与 pending 重读，再跑 `npx vitest run tests/worker/index-runtime-query.test.ts tests/worker/index-runtime-session.test.ts tests/core/index-thread-coordinator.test.ts tests/adapters/vector-vectra-batch.test.ts`。
3. 写放大复测入口：`RATEL_EFFICIENCY=1 RATEL_EFFICIENCY_FILES=100 npx vitest run tests/core/index-efficiency-baseline.test.ts tests/core/index-thread-efficiency.test.ts --reporter=verbose --silent=false`；50/200 档只改环境变量。
4. 宿主入口：`RATEL_INDEX_EXPERIMENT=1 node esbuild.config.mjs production`，按预览库流程链接 `<sandbox>` 后重载；手动开启 `indexThreadMode`，采真实 Vault、查询与流畅度证据。真实 ONNX 仍走既有 `RATEL_ONNX` 门控，不在默认套件自动下载或推理。
5. 最后才补全量 `npm test`、`npm run lint`、typecheck 诊断集合对比；有 Sandbox 证据前不勾 T9，不改默认开关。

已释放：本轮启动的子代理、定向测试与临时取证 worktree 均已结束或删除。残留检查发现另一会话正在运行全量 Vitest，并非本轮启动，未擅自终止。

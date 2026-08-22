# Agent 任务机制(S-TASK)

> 日期: 2026-08-19
> 状态: Active
> 作者: Erwin(从 S-EVOLUTION Phase C 摘出——task 是通用 Agent 基建,非图谱能力)
> 关联: S-EVOLUTION(其 Phase C 子代理模板化消费本 spec 的 task 机制)

---

## 1. 背景

S-EVOLUTION 原 Phase C 把「任务闭环」与「图谱治理」捆在一起推进,但二者正交:

- **task_plan / TaskStore / 落盘恢复 / GC** = 通用 Agent Loop 基建,不依赖 metadataCache / 结构工具
- 捆绑的代价:task 机制被 Phase A/B 阻塞,图谱侧被 task 设计拖累,排期互相绑架

对标:Claude Code 的 TodoWrite 是「会话内草稿纸」(内存态,重启即丢);笔记 Agent 的任务天然跨天(「整理整个文件夹」不是一次谈话能干完的),需要「库里的工单本」。

## 2. 目标

- Agent 可为多步任务显式建 checklist(`task_plan` 工具:创建/更新/勾选),渲染进 chat work-bar
- 任务落盘 `.obsidian/plugins/ratel-vault/tasks/<id>.json`,插件重载可恢复
- 完成任务自动 GC,长期零熵增

## 3. 非目标

- **任务历史归档**——完成的成果沉淀进笔记本体(daily note / 笔记),task 文件随时可删;task 是工作记忆,不是归档系统
- 后台自动续跑(恢复必须用户确认)
- 多任务并发(见 D1)

---

## 4. 详细设计

### 4.1 数据模型与落盘

```typescript
interface AgentTask {
  version: 1;
  id: string;               // 短 id,文件名即 <id>.json
  title: string;
  steps: Array<{ text: string; done: boolean }>;
  status: 'active' | 'completed' | 'archived';
  birthSessionId: string;   // 仅溯源,session 删除不删 task
  createdAt: string; updatedAt: string;
}
```

- 原子写;损坏即丢弃不崩溃(与索引清单同思路)
- 生命周期与 session 解耦:task 记 `birthSessionId`,session 删除**不**级联删 task

### 4.2 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **全局单活** — 同一时刻仅一个 active task | 防混的根源:没有并发 task,就没有「这条消息属于哪个 task」的归属问题;新会话默认不带 task,恢复须从状态条显式点选 |
| D2 | 恢复 = 提示 + 注入,非自动续跑 | onload 扫描未完成任务 → 状态条提示「是否继续」→ 确认后计划+已完成步骤注入新会话;避免重载后无人监督的写操作 |
| D3 | **成果与载体分离** | 成果走 S-EVOLUTION 的沉淀通道(append_to_daily 等);task 文件本身随时可删 |
| D4 | GC 双阈值 | onload 扫描时顺手做:completed 超 7 天删文件;`tasks/` 总数上限 50 兜底(超限按 updatedAt 淘汰最老 completed) |

### 4.3 恢复流程

```
onload → 扫 tasks/*.json → 有 active?
  → 状态条提示「有未完成任务: <title>,是否继续」
  → 用户点继续 → 新会话注入(计划 + 已完成步骤 + 原始目标)
  → 用户忽略 → task 保持 active,下次再提示(不做打扰升级)
```

## 5. 影响面

| 区域 | 影响 |
|---|---|
| `src/tools/task-plan.ts` | 新工具(权限:默认 allow,纯内部状态) |
| `src/core/task-store.ts` | 状态管理 + 落盘 + GC |
| `src/ui/` work-bar | checklist 渲染(复用 StatusLine 基建);恢复提示 |
| S-EVOLUTION Phase C | 子代理模板化消费本机制(预置 task_plan + 工具序列),沉淀通道仍归 S-EVOLUTION |

## 6. 参考

- S-EVOLUTION spec §4.3(原设计出处)
- Claude Code TodoWrite(对标:会话内存态,我们加落盘恢复)

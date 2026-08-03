# ADR-015:能力池 — 统一意图选择,按类型路由执行链路

**状态**:Accepted  
**日期**:2026-08-03  
**关联**:
- [ADR-009](2026-07-06-skill-mechanism.md)(Skill 三源加载 / Discovery — 本 ADR 把 Discovery 并入能力池语义)
- [ADR-010](2026-07-21-skill-vs-builtin-capability.md)(产品边界:何为内置、何为 Skill — 不变)
- [ADR-012](2026-07-23-skill-activation-claude-aligned.md)(Skill 激活写入 Session — 执行语义不变)
- [ADR-014](2026-08-03-mcp-host-platform.md)(MCP 作为能力池的一类供给)
- [S-EVOLUTION](../superpowers/specs/2026-07-15-evolution-graph-agent.md)(Agent 平台总纲)

---

## Context(背景)

Ratel 面向模型暴露的能力,目前**形态分裂**:

| 形态 | 模型看到 | 怎么触发 |
|---|---|---|
| 内置工具 | `tools[]` function(`search_vault`、`read_note`…) | 直接 `tool_call` |
| 元工具 | `activate_skill` / `deactivate_skill` | 调它→把 Skill 指令写入 Session(ADR-012) |
| Skill 包 | system 中「## 可用 Skills」清单(仅 name + description) | **非** function;激活后才获得指令 |

模型在「查能力」时要同时理解两套并存表述(tools[] vs Skills 清单),意图选择层不统一。  
新项目无历史包袱,且用户已明确治理目标:**模型面对一个能力池;系统按能力类型路由到不同执行链路**,而不是让模型在三种平行机制里猜。

业界对照:主流 Agent(Claude / Cursor 等)对模型也多以「统一工具/能力面」呈现;Skill 类机制偏指令与工作流,与「可执行工具」不同构。Ratel 采纳同一心智,但把「池」显式化,便于 MCP / 内置 / Skill 共同治理。

---

## Decision(决策)

### 1. 对模型:单一能力池(意图层统一)

- 模型可见的「能用什么」收敛为**一个能力池**:内置工具、MCP 工具、可用 Skill 都在池中,以**统一元信息**描述:`name` + `description` + `kind`
- `kind ∈ { tool | mcp | skill }`(或实现等价字段),供模型理解与系统路由;**池负责「发现与选择」,不负责「怎么执行」**
- 取消「tools[] 一套说法 + Skills 清单另一套说法」的并存叙事;system 与 function calling 由同一装配层描述「池里有什么、何时用哪类」

### 2. 对系统:按 kind 路由执行链路(执行层分流)

| kind | 执行链路 | 说明 |
|---|---|---|
| `tool` | 现有 **ToolRegistry.execute** | 本地 TS 实现;权限 / `tool.result` / 写钩子不变 |
| `mcp` | **ToolRegistry.execute → MCP Client `tools/call`** | 与内置同形入册;ADR-014;权限默认可更严(如 `mcp__*` 默认 ask) |
| `skill` | **元工具 `activate_skill` / `deactivate_skill`** → SkillRegistry + Session 注入 | 不产生新的「业务工具」;ADR-012 语义不变 |

- **ToolRegistry 仍是唯一可执行工具面**:MCP 与内置一样注册为 `Tool{definition, execute}`;Skill **不**往 Registry 灌业务工具,只通过元工具触达
- 治理成本更低:权限、事件、引用、日志都挂在统一 Registry 与 Agent Loop 上;池只在「描述与选择」层合并,执行仍分通道

### 3. 边界与不变量

- **Skill ≠ MCP ≠ Function Calling**:MCP 是能力供给协议;FC 是模型→Host 调用协议;Skill 是指令/行为扩展 — 池层可统一呈现,概念层不混同
- **不采纳**:为 MCP 另建并行执行总线、或把 Skill 包直接注册成大批可调工具名(本期)
- **远期(非本期)**:若 Skill 需要「像工具一样被直接调用」,可演进为 Skill 暴露入口工具或脚本;当前仅通过元工具激活

### 4. 与 ADR-014 的关系

- MCP Host 落地后,每个 Server 的工具**入能力池**(`kind=mcp`),与内置同级出现在模型可选集
- 平台级接入、不自建 websearch 的决策**不变**;本 ADR 补的是「模型如何看见与选择」以及「系统如何路由执行」

### 5. 明确不做(本期)

- 不实现 Skill scripts 沙箱(仍属 S-SKILL P-SKILL-2,另行评估)
- 不要求所有 Skill 都包装成 function;Discovery 并入池语义,激活仍走元工具
- 不引入跨 Host 的「市场/注册中心」;池是进程内模型视角,不是多租户目录

---

## Consequences(后果)

### 正面

- 模型意图选择一致:一个池、一套描述,降低误选与 prompt 分叉
- 系统治理集中:执行仍经 ToolRegistry / 权限 / Agent Loop,MCP 与 Skill 各有明确通道,无第三条旁路
- 与 ADR-014 对齐:MCP 入池即与内置同形;Skill 激活语义不返工
- 文档可读:能力侧一张总图(池 + 三类链路),新贡献者不必先分清「三种扩展」再谈架构

### 负面 / 风险

- 需改 prompt 装配与可能的工具列表生成逻辑,使「池」单一来源;过渡期内文档与代码要同步,避免又出现双轨话术
- `kind` 若泄漏给模型过多实现细节,可能引导其死记硬背「这是 MCP」而非按 description 选 — 池描述应以**能力与场景**为主,kind 主要服务路由与少量 UX 标注

### 后续影响

- 新建/更新「能力面」架构文档(池 + 三条链路),作为 tools.md / skills.md / 未来 mcp 文档的公共入口
- S-MCP-HOST spec 须写明:MCP 工具如何入池、kind 标注、与 activate_skill 的并存关系
- S-SKILL 后续修订时,Discovery 表述与能力池对齐(清单不再独立于池叙事)

---

## 参考

- 会话结论(2026-08):模型面对能力池;按类型路由执行;治理成本更低
- ADR-012(激活写 Session)· ADR-014(MCP 平台)· 业界 Host/Client/Server 与 Skills 分层惯例

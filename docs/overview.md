<!-- 覆盖：系统业务背景、领域定位、平台边界、核心实体、行业标准 -->
<!-- meta:
  extracted_at: 2026-08-15
  git_hash: 370dc68d59998849cbe06d0867c6e9f3d95db4d1
  extracted_by: neu-domain-briefing
  freshness_threshold: 20 commits
  status: confirmed
-->

# 概述与目标

## 业务领域

Ratel 属于个人知识管理与主动式 AI Agent 领域，服务于同时具备以下两种特征的 Obsidian 用户：

- 长期使用双链、日记、项目笔记等方式积累个人知识；
- 希望自由选择模型，并通过 Skill、MCP 与 Subagent 定制 Agent 工作流。

产品不把“聊天问答”作为终点，而是让知识库在授权范围内主动参与复盘、提醒、知识治理与知识挖掘。

## 底座与二次开发边界

- 底座：Obsidian，提供 Markdown Vault、双链、反链、标签、frontmatter、Daily Notes、Keychain、Workspace 与社区插件运行时。
- 通知底座：Obsidian Notice、状态栏与插件视图，负责当前阶段的本地提醒与洞察处理。
- Ratel 二次开发：Agent Loop、融合检索、图谱知识管理、记忆、Heartbeat、洞察收件箱、通知策略、权限审计、模型适配、Skill、MCP 与 Subagent。
- 外部消息通道不属于当前阶段；本地主动闭环稳定后再单独评估。

## 核心业务实体

| 实体 | 业务定义 | 代码或设计映射 |
|---|---|---|
| 用户 | 管理个人 Vault 并配置 Agent 工作方式的人 | Obsidian 用户 |
| Vault | 用户拥有的 Markdown 知识库 | `ObsidianVault` 外观 |
| 笔记 | 知识、任务、日记与项目上下文的基本载体 | Markdown `TFile` |
| 记忆约定 | 用户告诉 Agent 的长期偏好、常用位置与工作规则 | `.ratel/memory/` |
| 日记 | 当天工作与回顾的主要入口 | Obsidian Daily Notes 约定 |
| 主动洞察 | Heartbeat 基于证据生成、等待用户处理的建议 | 洞察收件箱中的待处理项 |
| 证据 | 支撑回答、提醒或治理建议的笔记片段与结构关系 | 可点击引用 / 来源记录 |
| 通知投递 | 一次洞察在 Obsidian 内的展示与处理记录 | Notice / 状态栏 / 洞察收件箱 |
| 能力 | Agent 可选择的模型、工具、Skill、MCP 与 Subagent | 能力池 / ToolRegistry |

## 行业标准

| 标准名称 | 影响范围 | 规则 |
|---|---|---|
| Markdown / Wikilink | 笔记内容与关系 | 保持普通 Markdown 与 `[[wikilink]]` 可移植性 |
| YAML frontmatter | 结构化属性 | 写入必须走 Obsidian API，避免破坏正文 |
| Obsidian Plugin API | Vault 与 Workspace 操作 | 所有 Vault 访问走项目外观层 |
| MCP | 外部工具供给 | MCP 工具进入统一能力池与权限链路 |

## 核心业务能力

| 能力 | 说明 | 对应模块或产品域 |
|---|---|---|
| 主动智能 | 基于 Heartbeat、记忆与日记约定生成复盘、提醒与建议 | Proactive Intelligence |
| 图知识管理 | 融合检索、链接理解、引用、知识熵治理与知识挖掘 | Graph Knowledge Management |
| 开放 Agent 底座 | 模型自由、Skill、MCP 与 Subagent | Agent Platform |
| 本地通知 | 通过 Notice、状态栏与洞察收件箱交付主动结果 | Local Notification |
| 信任与隐私 | 黑名单、证据最小披露、工具权限与全链路审计 | Trust Guardrails |

## 架构约束

- Ratel Core 是唯一 Agent、权限与 Vault 操作中枢。
- 黑名单内容不索引、不进入候选、不发送给模型或 MCP。
- 通知只能提示和导航，不得绕过工具权限直接修改 Vault。
- 不要求用户采用新的任务数据库；优先复用记忆约定、Daily Notes 与现有笔记结构。

## 约束与已知风险

| 类型 | 约束/风险 | 影响 | 来源 |
|---|---|---|---|
| 生命周期 | Obsidian 未运行时插件无法计算或投递新洞察 | 当前阶段只承诺 Obsidian 运行期间的主动能力 | 产品边界确认 |
| 通知疲劳 | Heartbeat 过于频繁会降低信任 | 必须去重、分级、支持忽略与安静时段 | 用户讨论 |
| 记忆过时 | 日记或目标位置可能变化 | 只有用户主动更新时替换负向或位置记忆 | 用户讨论 |
| 通知能力 | Obsidian Notice 容量有限，无法承载完整洞察 | Notice 只做摘要，详情进入洞察收件箱 | 产品边界确认 |

## 安全红线与关键路径

| 类型 | 内容 | 约束 |
|---|---|---|
| 隐私红线 | 用户明确排除的目录、标签与笔记 | 索引、候选、模型与 MCP 路径全部不可读 |
| 外发红线 | 远程模型与 MCP 只接收当前任务必要证据 | 默认最小披露，记录来源与去向 |
| 写入红线 | 主动洞察不能自动修改 Vault | 用户接受后仍走工具权限与 Write Gate |
| 关键路径 | Heartbeat → 洞察 → 通知 → 用户反馈 | 必须可去重、可恢复、可审计 |

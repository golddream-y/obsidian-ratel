# 指标、传播、竞品与验收

> 产品总纲入口：[overview.md](overview.md)。

## 成功指标

### Dogfood 指标

- 连续 14 天中，至少 10 天成功生成一次不重复的每日洞察。
- 每日洞察被接受、写入、继续追问或主动稍后的比例达到 60% 以上。
- 被标记“无关/打扰”的比例低于 10%。
- 用户回答“没有该约定”后，重复主动询问次数为 0。
- 被接受教训对应的偏好，重复犯错次数为 0。
- 黑名单泄漏和未确认写入次数均为 0。
- 生态变更（安装/更新/卸载/配置修改）100% 留有日志与备份；回滚成功率 100%。
- 未经确认的 `.obsidian` 路径写入次数为 0。

### 产品质量指标

- 100% 主动洞察显示触发原因和来源。
- 100% 由主动洞察发起的写操作经过现有权限确认。
- Obsidian 运行期间，洞察持久化与本地通知投递成功率达到 95% 以上；失败可见且可恢复。
- 插件重载和任务重试导致的重复 Notice 次数为 0。
- 知识挖掘结论至少由两个独立来源支撑；单一来源时必须明确标注。
- 100% 生态变更可在对话中追溯动作与备份位置，并可完成回滚。

这些指标用于验证价值与信任，不上传遥测；由本地诊断面板汇总，用户自行查看。

## README 与传播设计

### 当前问题

现有 README 已清楚说明图谱、检索、扩展、模型与隐私，但仍存在以下传播问题：

- 首屏“图谱原生 AI Agent”偏技术类别，未直接描述用户每天获得什么；
- “为什么是 Ratel”把产品能力与底座能力平铺，缺少层级；
- 缺少一个能在十秒内理解的完整主动场景；
- Skill、MCP、模型可换等高级能力出现过早，容易让普通知识工作者觉得配置复杂；
- 缺少真实 UI 截图或短动图证明简报、来源、工具和收件箱体验。

### 建议首屏

- **中文主标题:** 让你的 Obsidian 知识库主动工作。
- **中文副标题:** Ratel 会理解你的日记、目标和双链笔记，在合适时间带着来源复盘、提醒、治理并协助行动。
- **英文主标题:** Make your Obsidian knowledge work proactively.
- **英文副标题:** Ratel understands your journals, goals, and linked notes, then brings you sourced reviews, suggestions, and actions inside Obsidian.

首屏 CTA：`Install from Obsidian`、`See how it works`、`Read the privacy model`。

### README 信息架构

1. Hero：一句结果 + 一张“昨日简报/洞察通知”真实截图。
2. 一个完整场景：月度目标 → 昨日日记 → 今日建议 → Obsidian Notice → 确认写入。
3. 三个产品支柱：主动智能、图知识管理、场景生态。
4. 为什么可信：本地筛选、黑名单、最小披露、来源与确认。
5. 开放底座：模型自由、Skill、MCP、Subagent；放在价值之后。
6. 能做什么：找回、治理、挖掘、主动复盘、搭环境（“说一声就装好”）五类真实 prompt。
7. 安装与五分钟上手。
8. 隐私数据流图。
9. 文档、Roadmap、贡献与 License。

### 文案语气

- 自信但不夸大：不把 wikilink 宣称为高质量领域知识图谱。
- 具体而非抽象：使用“昨天完成了什么、今天该关注什么”等场景语言。
- 技术细节作为证据，不作为首句：先讲用户收益，再讲 ONNX、MCP 与能力池。
- 主动但克制：强调“在合适时间”“带着来源”“修改前确认”。

## 竞品与差异化

| 类别 / 代表 | 强项 | Ratel 不应复制的主叙事 | Ratel 的差异方向 |
|---|---|---|---|
| Smart Connections | 本地语义关联与写作流中的相关笔记 | “更好地找到相关笔记” | 在可靠找回之上主动复盘、治理和挖掘 |
| Obsidian Copilot | Vault Agent、模型自由、Skills 与知识工作流 | “功能最全的 Obsidian AI” | 把开放底座服务于主动图知识管理 |
| Agentic Chat / Intelligence Assistant | 工具、图谱、记忆、MCP、Subagent 与安全执行 | “Obsidian 内的通用自主 Agent” | 记忆约定 + Heartbeat + 洞察收件箱 + 克制的本地通知 |
| NotebookLM / 独立研究助手 | 来源驱动研究与多种成果格式 | “上传资料后做一次研究” | 直接生长在长期 Vault 与日常工作上下文中 |

差异化必须靠真实闭环证明，不能只在 README 中声明“主动”。最小可信演示是：用户无需发起提问，Ratel 基于既有记忆与日记生成带来源的昨日简报，通过 Obsidian Notice 提醒，用户进入洞察详情追问并批准写入今日日记。

生态管理是竞品均未覆盖的空档：现有 Obsidian AI 把插件组合留给用户手工完成。Ratel 当管家：环境场景声明底座，平台装/配/调，生态作者能按平台能力快速写出新场景，变更可回滚。定时总结不在这条线。

## 影响面

| 区域 | 预期影响 |
|---|---|
| `src/core/` | Heartbeat、规则状态、洞察、通知策略与审计；生态变更日志（EcosystemChange）与备份管理 |
| `src/ports/` | Scheduler/Heartbeat、Audit、Insight、Notification 等契约 |
| `src/adapters/` | 本地持久化与 Obsidian 通知适配；生态路径白名单校验、商店清单缓存与 release 下载 |
| `src/ui/` | 洞察收件箱、来源/披露详情、通知设置与审计 UI |
| `src/memory/` | 记忆约定解析、负向记忆与 supersede 语义；教训沉淀与分层注入 |
| `src/tools/` | 治理候选与知识挖掘能力；生态管理工具组（探索/安装/配置/更新/回滚） |
| `src/subagents/` | 研究、审查与治理角色边界 |
| `src/i18n/` | 新功能全量中英文 namespace |
| 文档 | README、user-guide、隐私说明、架构与新 ADR 均需同步 |

本 PRD 会触发主动智能工程规格：Heartbeat 调度、洞察与投递数据模型、通知状态和隐私策略均不能直接从本文件开始实现，必须按垂直闭环拆分 spec 与 plan。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 通知疲劳 | 用户关闭主动能力 | 本地预筛、每日上限、安静时段、冷却和反馈学习 |
| 黑名单泄漏 | 严重隐私事故 | 单一策略入口、全链路测试、默认拒绝与审计 |
| Prompt Injection | 笔记或 MCP 文本诱导越权 | 不可信输入标记、权限不由文本改变、工具参数验证 |
| Notice 容量有限 | 完整洞察被截断或难以处理 | Notice 只放摘要，点击进入洞察收件箱 |
| 插件重载 | 重复提醒或状态丢失 | 投递状态持久化、稳定洞察 id 与去重 |
| 记忆约定过时 | 错误简报或持续失效 | 来源可见、用户主动 supersede、失败不反复追问 |
| 错误教训被接受 | 持续错误行为被固化 | 教训必经用户审阅、标注来源会话、可随时编辑删除 |
| Obsidian 未运行 | 无法生成新洞察 | 当前阶段明确只承诺应用运行期间主动能力 |
| 恶意/低质插件被安装 | 用户环境受损或数据风险 | 只装商店清单内插件、确认弹窗展示作者与下载量、决定权在用户 |
| 配置修改破坏其他插件 | 目标插件行为异常 | 点名 key 最小 diff、事前备份、一键回滚 |
| GitHub 限流或不可用 | 安装/更新失败 | 清单缓存、明确错误提示、可重试；本地管理与回滚不受影响 |
| 路径白名单被绕过 | 越权写入 `.obsidian` | 白名单为 adapter 层唯一物理入口，测试覆盖路径穿越用例 |
| 产品范围过大 | 长期无法形成可用闭环 | 后续 plan 按完整用户旅程垂直切片，不按技术组件横切堆积 |

## PRD 验收标准

下列条目是总纲目标态，**尚未整体达成**。

- 产品定位明确为“主动智能的 Obsidian 知识与环境管理 Agent”。
- 主动智能、图知识管理与场景生态是产品支柱；模型、工具/Schema、Skill、MCP、Subagent 是开放底座。
- 知识挖掘被纳入图知识管理，不被当作首要日常刚需。
- 当前阶段以 Heartbeat、洞察收件箱、状态栏和 Obsidian Notice 形成完整本地主动闭环。
- 生态管理形成“点名环境场景 → 预览 → 用户选确认方式 → 装/配/铺模板 → 底座可基础使用 / 可回滚”闭环；同时交付创建场景的 Skill 与能力接口手册。环境变更的信任链完整：路径白名单物理校验 + 事前备份 + append-only 变更日志 + 一键回滚。确认方式是逐个或「这次全部同意」（仅本份清单）。
- 网络出站扩展（GitHub 清单与 release）有独立 ADR 评审；README 隐私说明同步更新。
- 外部消息通道不属于当前范围，待本地主要特性稳定后再单独评估。
- 黑名单 + 最小披露 + 工具权限 + 审计形成完整信任链。
- 主动场景复用现有记忆与 Obsidian 日记，不新增强制任务数据库。
- README 传播从功能清单改为结果、场景、产品支柱、信任证据与开放底座的层级。

## 参考

- [Smart Connections 官方介绍](https://smartconnections.app/smart-connections/)
- [Copilot for Obsidian 官方介绍](https://www.obsidiancopilot.com/en)
- [Agentic Chat — Obsidian Community](https://community.obsidian.md/plugins/agentic-chat)
- [Intelligence Assistant — Obsidian Community](https://community.obsidian.md/plugins/intelligence-assistant)
- [NotebookLM 研究能力更新](https://blog.google/innovation-and-ai/products/notebooklm/better-research-notebooklm/)
- [ADR-013](../adr/2026-08-03-graph-retrieval-minimize-human-curation.md)
- [ADR-014](../adr/2026-08-03-mcp-host-platform.md)
- [ADR-015](../adr/2026-08-03-capability-pool.md)

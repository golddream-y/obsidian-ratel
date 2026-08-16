# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**让你的 Obsidian 知识库主动工作。**

Ratel 是主动智能的图知识管理 Agent。它理解你的日记、目标和双链笔记，在合适的时间带着来源复盘、提醒、发现知识问题，并在你确认后协助行动。

---

## 从等待提问，到主动参与

普通的 Vault Chat 只有在你发问后才开始工作。Ratel 的目标是让知识库在合适的时间主动参与：

1. Heartbeat 检查新的日记、目标、近期修改和知识关系。
2. 本地规则先判断是否真的有值得提醒的内容。
3. Ratel 生成带来源的昨日简报、今日建议或知识治理洞察。
4. 洞察进入收件箱；高价值内容通过 Obsidian Notice 提醒。
5. 你可以查看来源、继续追问、稍后处理、忽略，或确认写入笔记。

主动不等于擅自行动。通知可以自动出现，Vault 修改仍由你决定。

---

## Ratel 如何让知识库主动工作

### 在合适的时候，带来值得处理的信息（正在建设）

Ratel 不要求你维护第二套任务数据库。你可以通过普通 Markdown 记忆告诉它日记、月度目标和常用位置。

- 每日首次触发时生成昨日简报；
- 同时存在月度目标和今日日记时，补充今日建议；
- 找不到常用位置时只询问一次；你回答“没有”后不再重复打扰；
- 所有主动结果先进入洞察收件箱；
- 状态栏提供稳定入口，高价值洞察才弹出 Obsidian Notice；
- 支持安静时段、每日上限、稍后、忽略和继续追问。

### 不只搜索笔记，也理解它们之间的关系

Ratel 把检索、链接、引用、治理和知识挖掘组织成一条完整知识工作流。

- **融合检索**：语义与关键词多路召回，并利用双链、反链和属性补充结构信号；
- **可点击引用**：回答中的 `[1][2]` 可以直接打开原笔记；
- **知识熵治理（正在建设）**：发现断链、孤儿笔记、重复内容、过时信息和长期未完成事项；
- **知识挖掘（正在建设）**：从分散笔记发现主题、关系、冲突与知识缺口，生成带来源的综述；

### 从发现问题，到协助行动

你可以查看来源、继续追问、稍后处理、忽略，或让 Ratel 整理、补链并写入笔记。任何 Vault 修改仍然遵循你的权限设置。

---

## 当前可以做什么

**找回记过但忘了位置的内容**

> 「性能优化相关笔记写了什么？」

Ratel 组合语义、关键词和笔记关系检索，回答保留可点击来源。

**完成多步知识工作**

> 「把产品规划相关笔记整理成一份背景文档。」

Agent 可以检索、阅读、归纳并写入；改删操作遵循当前权限档位。

**理解当前 Obsidian 环境**

> 「概括当前这篇，并告诉我它和最近修改的项目笔记有什么关系。」

活动笔记、日记路径、最近修改和标题大纲都是 Agent 可用的上下文。

**打开正在聊的那篇笔记**

> 「打开那篇读书笔记，跳到它的第二章。」

说一声「打开那篇」，`open_note` 直接在 Obsidian 里翻开并定位到你说的标题或块。

**对话式配置与排障**

> 「帮我换个模型。」「索引怎么不跑了？」

内置 ratel-config skill 读取配置现状、在白名单内代改，并引导你去对应设置面板；密钥只引导去钥匙串，不会代填。

**记住偏好并扩展工作流**

> 「记住我更喜欢先给结论，再列证据。」

记忆以普通 Markdown 保存在 `.ratel/memory/`。你还可以添加 `SKILL.md`、MCP Server 或使用 Subagent 扩展复杂工作流。

---

## 开放 Agent 底座

- **模型自由**：对话、嵌入与重排模型可以独立选择；支持 DeepSeek、Claude、Ollama 和自定义兼容端点。
- **Skill**：用 Markdown 定义可复用的工作方法。
- **MCP**：接入网页搜索和其他外部工具，Server 与工具分别授权。
- **Subagent**：把复杂研究拆给检索、审查和整理角色。
- **Prompt 可定制**：按区段覆盖默认提示词，不需要 fork 插件。

这些能力是底座。它们服务于主动智能和图知识管理，而不是要求用户先搭建一套复杂系统。

---

## 隐私与安全

| 数据或操作 | 默认行为 |
|---|---|
| Vault 索引 | 保存在本机 |
| Embedding | 默认在本机生成 |
| 检索证据 | 只发送给你配置的模型端点 |
| MCP 参数 | 只在调用已启用的 MCP 工具时发送 |
| 主动洞察 | 先本地筛选，再构建当前任务需要的最小证据 |
| Vault 修改 | 遵循安全 / 自动 / 危险权限档位；主动通知不能绕过权限 |
| 遥测 | 无 |

黑名单能力落地后，被排除的内容将不会进入索引、候选检测、模型上下文、MCP 参数、日志或通知。

---

## 安装

Obsidian → **设置** → **社区插件** → **浏览** → 搜索 **Ratel** → **安装** → **启用**。

需要 **Obsidian 1.13.0+**，**仅桌面端**。

然后打开 **设置 → Ratel → 对话模型**，选择 DeepSeek / Ollama 场景预设或自定义 Base，等待首次索引完成，再点击侧栏 🦡 或运行 **Ratel: Ask vault**。

完整说明见 [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [产品全貌](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/PRD.md) | 产品定位、完整能力与发展方向 |
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 上手、场景、斜杠命令、FAQ |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 完整发版历史 |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | 端口、Agent Loop、工具与 Worker |

问题与建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**面向链接笔记的图谱原生 AI Agent。**

能对话、能检索、能在双链知识库上办事。问它记过什么，让它翻资料写综述；回答带来源编号，点一下打开原文。

---

## 为什么是 Ratel

- **图谱原生** — 为双链笔记设计，不是通用文件聊天框
- **融合检索** — 语义 + 关键词多路召回，自动顺着笔记链接把相关笔记也带进结果；引用编号可点开
- **高度可扩展** — 内置技能与子代理，并可挂 MCP 服务（HTTP 或 stdio）接入网页搜索等外部生态
- **深度可定制** — 聊天 / 嵌入 / 重排模型可换，提示词逐段可覆盖，MCP 生态自己选
- **隐私与安全** — 本地嵌入；网络只连你配置的模型 API 和你显式添加的 MCP 服务；工具默认询问，可在对话里切安全 / 自动 / 危险三档

---

## 安装

Obsidian → **设置** → **社区插件** → **浏览** → 搜索 **Ratel** → **安装** → **启用**。

需要 **Obsidian 1.13.0+**，**仅桌面端**。

然后：打开 **设置 → Ratel → 对话模型**，选场景预设（DeepSeek / Ollama）或自定义 Base → 等首次索引完成 → 点侧栏 🦡（或命令面板 **Ratel: Ask vault**）。

完整说明见 [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md)。

---

## 能做什么

**问答带出处**  
「性能优化相关笔记写了什么？」—— `[1][2]` 引用，一点跳转。

**多步派活**  
「把产品规划相关笔记整理成背景文档」—— 检索、阅读、归纳、写入（改删按当前权限档位确认）。

**懂当前环境**  
每轮对话注入本地时间。「概括当前这篇」走活动笔记；日记路径、最近修改、标题大纲都有专用工具。

**记得住，可扩展**  
说「记住我偏好 Tailwind…」→ 写入 `.ratel/memory/`。把 `SKILL.md` 放进 `.ratel/skills/` 教会新流程；挂上 MCP 服务（Tavily、Brave…）就能让 Agent 联网搜索、调外部工具。

---

## 隐私

- 索引与默认嵌入在本地
- 网络访问：默认只连你设置的模型 API（DeepSeek / Claude / Ollama）
- MCP 服务：只有你显式添加的 MCP 端点会收到请求；工具确认跟安全 / 自动 / 危险档位走（默认安全会询问）
- 无统计、无回传

---

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 上手、场景、斜杠命令、FAQ |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 完整发版历史（连续小版本可合并成区间） |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | 端口、Agent Loop、工具、Worker |

问题与建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

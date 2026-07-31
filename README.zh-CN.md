# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**面向链接笔记的图谱原生 AI Agent。**

能对话、能检索、能在双链知识库上办事。问它记过什么，让它翻资料写综述；回答带来源编号，点一下打开原文。

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
「把产品规划相关笔记整理成背景文档」—— 检索、阅读、归纳、写入（改删前会按权限确认）。

**懂当前环境**  
每轮对话注入本地时间。「概括当前这篇」走活动笔记；日记路径、最近修改、标题大纲都有专用工具。

**记得住，可扩展**  
说「记住我偏好 Tailwind…」→ 写入 `.ratel/memory/`。把 `SKILL.md` 放进 `.ratel/skills/` 就能教会新流程。

**模型与密钥你做主**  
DeepSeek / Claude / Ollama。密钥在 Obsidian 钥匙串，不进配置文件。默认本地 ONNX 嵌入。

**权限与状态可控**  
每个工具可设允许 / 询问 / 禁止。状态条 + 诊断面板。无遥测；网络只打你配置的端点。

---

## 为什么是 Ratel

- **图谱原生** — 为双链笔记设计，不是通用文件聊天框  
- **回答有出处** — 带编号引用，一点跳转原文  
- **默认本地** — 本地嵌入；网络只连你配置的模型  
- **改库先确认** — 按工具权限，动手前你说了算  

---

## 特性

- 语义检索 + 正文 `[n]` / 芯片可点开出处  
- 对话优先侧栏：细工具时间线，状态条贴在输入区  
- 图谱能力：出链反链、标签、属性、库概览  
- Agent 工具：读写 / grep / glob、记忆、Skill、当前笔记与日记路径  
- 私有语义检索 — 默认本地 ONNX 嵌入；可选 API 嵌入 / 百炼重排  
- 设置页场景预设（DeepSeek / Ollama / 自定义）；密钥在 Obsidian 钥匙串  
- 按工具权限 + 信任模式；仅桌面；无遥测  

---

## 隐私

- 索引与默认嵌入在本地  
- 远端对话 / 嵌入 / 重排仅在你主动配置时发生  
- 无统计、无回传  

---

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 上手、场景、斜杠命令、FAQ |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 完整发版历史（连续小版本可合并成区间） |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/ARCHITECTURE.md) | 端口、Agent Loop、工具、Worker |

问题与建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

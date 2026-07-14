# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**让你的 Obsidian 知识库能对话、能办事。**

问它记过什么，让它翻资料写综述；回答带来源编号，点一下打开原文。

---

## 安装

Obsidian → **设置** → **社区插件** → **浏览** → 搜索 **Ratel** → **安装** → **启用**。

需要 **Obsidian 1.13.0+**，**仅桌面端**。

然后：配置对话模型（或本机 Ollama）→ 等首次索引完成 → 点侧栏 🦡（或命令面板 **Ratel: Ask vault**）。

完整说明见 [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md)。

---

## 能做什么

**问答带出处**  
「性能优化相关笔记写了什么？」—— `[1][2]` 引用，一点跳转。

**多步派活**  
「把产品规划相关笔记整理成背景文档」—— 检索、阅读、归纳、写入（改删前会按权限确认）。

**懂当前环境**  
每轮对话注入本地时间。「概括当前这篇」走活动笔记；日记路径、最近修改、标题大纲都有专用工具；反链 / 标签仍用已有 `read_note`。

**记得住，可扩展**  
说「记住我偏好 Tailwind…」→ 写入 `.ratel/memory/`。把 `SKILL.md` 放进 `.ratel/skills/` 就能教会新流程。

**模型与密钥你做主**  
DeepSeek / Claude / Ollama。密钥在 Obsidian 钥匙串，不进配置文件。默认本地 ONNX 嵌入。

**权限与状态可控**  
每个工具可设允许 / 询问 / 禁止。状态条 + 诊断面板。无遥测；网络只打你配置的端点。

---

## 隐私

- 索引与默认嵌入在本地  
- 远端对话 / 嵌入 / 重排仅在你主动配置时发生  
- 无统计、无回传  

---

## 文档

| | |
|---|---|
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 上手、场景、斜杠命令、FAQ |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/ARCHITECTURE.md) | 端口、Agent Loop、工具、Worker |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 发版说明 |

问题与建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

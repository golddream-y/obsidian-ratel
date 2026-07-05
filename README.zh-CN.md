# Ratel — Obsidian AI Agent

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)

> **让你的 Obsidian vault 能对话、能办事。** 问它记过什么，让它帮你翻资料写综述，回答会标明出处，点一下就能打开原文。

---

## 快速开始

1. **安装** — 从 [GitHub Release](https://github.com/golddream-y/obsidian-ratel/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `.obsidian/plugins/ratel-vault/`，启用插件。也可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安装，后续升级更省事。
2. **配对话** — 设置 → Ratel → 选端点与模型。钥匙串添加 `ratel-chat-openai-compatible`，或用本机 Ollama 免 Key。
3. **等索引** — 首次启动状态条显示索引进度；之后重启通常很快。
4. **提问** — 侧边栏 🦡 或命令面板 → **Ratel: Ask vault**。

详细配置见 [使用手册](docs/user-guide.md)。

> **要求：** Obsidian 1.13.0+，仅桌面端。默认本地嵌入首次需联网下载模型（~37 MB），之后缓存本地。

---

## 功能

**问答，带出处**

问它 vault 里记过什么——"我上次关于性能优化的笔记写了什么？"回答会列出要点，并标上 `[1][2]` 编号，点一下跳到那篇笔记的对应位置。回答边生成边显示，不会等半天才出结果。

**派活，多步搞定**

不是简单的一问一答。你可以说"把 vault 里跟产品规划相关的笔记整理成一份项目背景文档"——它会自己去搜多篇笔记、阅读理解、归纳，最后把结果写成新笔记。需要改或删笔记时会先问你，不会擅自操作。

**自带索引，不卡主界面**

安装后自动为全库笔记建索引。索引在后台线程跑，不影响你用 Obsidian 做其他事。以后改了笔记会自动更新索引，重启也不会重头扫。

**用什么模型你定**

对话模型支持 DeepSeek、Claude 或本地 Ollama。Ollama 模式下 Prompt 完全不出本机。密钥存 Obsidian 钥匙串，不会写进配置文件。上下文长度提供 128k / 200k / 256k / 1M 预设，也可以从公开模型库一键获取推荐值。

**权限可控，状态可见**

读、搜、写、改、删等一系列 vault 工具，每个都能单独设成"每次都问""直接允许"或"禁止"。状态条实时显示索引是否就绪、上下文用了多少、Token 数据是否来自模型 API。内置诊断面板，模型连不通或索引异常时能看到具体原因。

---

## 安装

从 [GitHub Release](https://github.com/golddream-y/obsidian-ratel/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入 vault 的 `.obsidian/plugins/ratel-vault/` 目录，重启 Obsidian 后启用插件。

也可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)（社区插件可搜到）添加 `golddream-y/obsidian-ratel`，后续发新版会自动提示升级。

---

## 技术架构

Ratel 为 vault 构建**本地检索索引**，由**多步 Agent** 按需调度读写，而非把笔记全文塞进 prompt：

| 层 | 做法 |
|------|------|
| 索引 | ONNX 向量（Web Worker）+ BM25 关键词 + 反向链接；首次全量后 hash diff 增量 |
| 检索 | 多查询改写 → 混合召回 → RRF 融合 → 可选 Rerank 精排 |
| Agent | 上下文管理 + vault 工具 + 工具权限 + 读写钩子；多步闭环可配置 |
| 发布 | 符合 Obsidian 三文件约束；Worker 内联、WASM 懒下载 |

详见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [CHANGELOG](CHANGELOG.md)。

---

## 反馈

- [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues) — Bug 与建议
- [使用手册 FAQ](docs/user-guide.md#29-faq)

---

## License

[Apache-2.0](LICENSE)

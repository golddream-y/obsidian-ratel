# Ratel — Obsidian AI Agent

> 让 Obsidian vault 变成可对话、可检索、可治理的第二大脑。
> 隐私优先,支持本地 Ollama,零服务零终端。

## 它能做什么

- **问答 vault** — 自然语言提问,带引用带来源
- **多步闭环** — 自动检索多篇笔记,生成综述写入新笔记
- **混合检索** — 向量召回 + BM25 + Backlinks 增强
- **增量索引** — 文件变更毫秒级响应,后台 Worker 不阻塞主线程

## 演示

![chat-demo](docs/screenshots/chat-demo.gif)

## 安装

1. Obsidian → 设置 → 社区插件 → 浏览 → 搜索 "Ratel"
2. 安装并启用
3. 设置 → Ratel → 配置模型(DeepSeek / Claude / 本地 Ollama,任选其一)
4. 首次启动自动扫描 vault 生成索引
5. 侧边栏 🦡 图标开始使用

> 商店未上架前,可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安装。

## 隐私

- 数据全部本地存储
- 模型 API 是唯一外发通道,使用 Ollama 则零外发
- API Key 存储于 Obsidian 1.11.4+ SecretStorage,不出现在配置文件中
- 无遥测、无数据收集

## 文档

- [使用手册](docs/user-guide.md)
- [架构设计](docs/ARCHITECTURE.md)(开发者向)
- [更新日志](CHANGELOG.md)

## 反馈

- [GitHub Issues](https://github.com/golddream-y/ratel-vault/issues):提交 bug 或 feature request
- 使用前请先查阅[使用手册 FAQ](docs/user-guide.md#29-faq)

## 不做什么

- 不做独立服务(纯插件,装了就用)
- 不做云服务 SaaS(数据本地优先)
- 不做协作 / 多用户 / 团队功能
- 不做笔记编辑器(Obsidian 自带)
- 不用 native 模块(零 ABI 兼容风险)

---

# Ratel — Obsidian AI Agent (English)

> Turn your Obsidian vault into a queryable, searchable, curatable second brain.
> Privacy-first, supports local Ollama, zero service, zero terminal.

## What It Does

- **Chat with vault** — Ask questions in natural language, with citations and sources
- **Multi-step closure** — Auto-retrieves multiple notes, generates surveys, writes new notes
- **Hybrid retrieval** — Vector recall + BM25 + Backlinks boost
- **Incremental indexing** — Millisecond response to file changes, background Worker doesn't block main thread

## Demo

![chat-demo](docs/screenshots/chat-demo.gif)

## Installation

1. Obsidian → Settings → Community plugins → Browse → search "Ratel"
2. Install and enable
3. Settings → Ratel → configure model (DeepSeek / Claude / local Ollama, pick one)
4. First launch auto-scans vault and builds index
5. Click 🦡 icon in sidebar to start

> Before store listing, you can install via [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Privacy

- All data stored locally
- Model API is the only outbound channel; Ollama mode has zero outbound
- API keys stored in Obsidian 1.11.4+ SecretStorage, never in config files
- No telemetry, no data collection

## Documentation

- [User Guide](docs/user-guide.md)
- [Architecture](docs/ARCHITECTURE.md) (for developers)
- [Changelog](CHANGELOG.md)

## Feedback

- [GitHub Issues](https://github.com/golddream-y/ratel-vault/issues): submit bugs or feature requests
- Check the [User Guide FAQ](docs/user-guide.md#29-faq) first

## What It Doesn't Do

- No standalone service (pure plugin, install and use)
- No cloud SaaS (local-first data)
- No collaboration / multi-user / team features
- No note editor (Obsidian has one)
- No native modules (zero ABI compatibility risk)

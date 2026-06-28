# Ratel — Obsidian AI Agent

[English](README.md) | [简体中文](README.zh-CN.md)

> 与你的 vault 对话。提问、带引用回答、跨笔记研究自动写综述。

[![GitHub release](https://img.shields.io/github/v/release/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/releases)
[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](LICENSE)

**[查看可交互原型 →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**

## 功能

- **💬 与 vault 对话** — 问"我对 X 记过什么?"得到带引用的回答,点击引用跳转源笔记
- **🔍 混合检索** — 向量 + 关键词联合检索,即使没有命中关键词也能找到相关笔记
- **🤖 多步研究** — 描述任务("研究 X 主题并写综述"),Ratel 自动检索多篇笔记并生成新笔记
- **🔒 隐私优先** — 数据全部本地存储。本地 Ollama 零外发,或自带 LLM API Key
- **⚡ 增量索引** — 文件变更毫秒级响应,后台 Worker 保持 Obsidian 流畅

## 安装

**从 Obsidian 社区插件商店**(推荐):
设置 → 社区插件 → 浏览 → 搜索 "Ratel" → 安装

**通过 BRAT**(测试版):
将 `golddream-y/obsidian-ratel` 添加到 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。

模型配置详见[使用手册](docs/user-guide.md)。

## 隐私

- 数据全部本地存储于你的 vault
- LLM 需 API Key(DeepSeek / Claude),本地 Ollama 无需
- 模型 API 是唯一外发通道,使用 Ollama 则零外发
- API Key 存储于 Obsidian 1.11.4+ SecretStorage,不出现在配置文件中
- 无遥测、无数据收集

## 文档

- [使用手册](docs/user-guide.md) — 配置、用法、故障排查
- [更新日志](CHANGELOG.md)
- [架构设计](docs/ARCHITECTURE.md)(开发者向)

## 反馈

- [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues) — 提交 bug 或 feature request
- [使用手册 FAQ](docs/user-guide.md#29-faq) — 先查常见问题

## License

[Apache-2.0](LICENSE)

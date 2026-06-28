# 更新日志 / Changelog

本项目遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
本文件由 AI 从 Conventional Commits 生成草稿,开发者确认后合入。详见[生成规则](docs/superpowers/specs/2026-06-28-docs-system-v1-design.md)。

## [Unreleased]

### Added
- (待发版时由 AI 填充)

## [0.1.0] - 2026-06-28

### Added
- **问答 vault** — 自然语言提问,流式回答带引用
- **多步闭环** — Agent Loop 自动检索多篇笔记生成综述,MAX_STEPS 默认 50 可配置
- **混合检索** — 向量召回 + BM25 全文匹配 + Backlinks 增强
- **本地 ONNX 嵌入** — Web Worker 子线程推理,主线程零阻塞,批量处理 maxBatchSize=16
- **DeepSeek / Claude / Ollama** 三模型适配器,流式输出支持思考过程(DeepSeek reasoning_content)
- **SecretStorage 密钥管理** — Obsidian 1.11.4+ 钥匙串,API Key 不出现在 data.json
- **状态条** — 模型/索引状态 + 上下文使用率 + token 数据源指示(估算/流式/API)
- **诊断面板** — 模型连接 / 嵌入健康 / 索引状态 / 工具权限自查
- **斜杠命令** — `/new` `/compact` `/model` `/reindex`
- **中文界面 + i18n 框架**
- **工具权限** — read_note / write_note / delete_note 的 allow / ask / deny 配置
- **三产物构建** — main.js + worker.js + embedding-worker.js

### Known Limitations
- 仅桌面端(依赖 Node.js fs)
- 索引大 vault(>5000 笔记)首扫较慢
- Claude adapter 未接 thinking blocks(仅 DeepSeek 接入 reasoning_content)

**English summary:** Initial public release. Chat with vault, multi-step agent loop (MAX_STEPS=50), hybrid retrieval (vector + BM25 + backlinks), local ONNX embedding in Web Worker with batch processing, three model adapters (DeepSeek/Claude/Ollama) with reasoning_content support, SecretStorage key management, status line with token source indicator, diagnostics panel, slash commands, i18n framework, tool permissions, three-artifact build.

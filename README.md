# Ratel — Obsidian AI Agent

[English](README.md) | [简体中文](README.zh-CN.md)

> Chat with your vault. Ask questions, get cited answers, and let Ratel research across notes to write summaries.

[![GitHub release](https://img.shields.io/github/v/release/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/releases)
[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](LICENSE)

**[Try the interactive prototype →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**

## Features

- **💬 Chat with your vault** — Ask "what did I note about X?" and get answers with citations linking back to source notes
- **🔍 Hybrid search** — Vector + keyword retrieval finds relevant notes even when exact words don't match
- **🤖 Multi-step research** — Describe a task ("research topic X and write a summary"), Ratel auto-retrieves notes and writes a new one
- **🔒 Privacy-first** — All data stays local. Use local Ollama for zero outbound traffic, or bring your own LLM API key
- **⚡ Incremental indexing** — File changes reflected in milliseconds, background Worker keeps Obsidian responsive

## Installation

**From Obsidian Community Plugins** (recommended):
Settings → Community plugins → Browse → search "Ratel" → Install

**Via BRAT** (for beta versions):
Add `golddream-y/obsidian-ratel` to [BRAT](https://github.com/TfTHacker/obsidian42-brat).

For model configuration, see the [User Guide](docs/user-guide.md).

## Privacy

- All data stored locally in your vault
- LLM requires API key (DeepSeek / Claude); local Ollama needs none
- Model API is the only outbound channel; Ollama mode has zero outbound
- API keys stored in Obsidian 1.11.4+ SecretStorage, never in config files
- No telemetry, no data collection

## Documentation

- [User Guide](docs/user-guide.md) — configuration, usage, troubleshooting
- [Changelog](CHANGELOG.md)
- [Architecture](docs/ARCHITECTURE.md) (for developers)

## Feedback

- [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues) — bugs and feature requests
- [User Guide FAQ](docs/user-guide.md#29-faq) — check common questions first

## License

[Apache-2.0](LICENSE)

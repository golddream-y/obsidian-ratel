# Ratel — Obsidian AI Agent

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B-7c3aed?style=flat-square)](https://obsidian.md)

> **Chat with your vault and get things done.** Ask what you wrote about a topic, have it research across notes and draft a summary—answers cite sources you can open with one click.

---

## Quick Start

1. **Install** — Download `main.js`, `manifest.json`, `styles.css` from [GitHub Releases](https://github.com/golddream-y/obsidian-ratel/releases), place in `.obsidian/plugins/ratel-vault/`, enable the plugin. Or use [BRAT](https://github.com/TfTHacker/obsidian42-brat) for easier updates.
2. **Configure chat** — Settings → Ratel → pick endpoint and model. Add Keychain secret `ratel-chat-openai-compatible`, or use local Ollama without a key.
3. **Wait for index** — status bar shows progress on first launch; later restarts are usually quick.
4. **Ask** — sidebar 🦡 or command palette → **Ratel: Ask vault**.

Full setup guide: [User Guide](docs/user-guide.md).

> **Requirements:** Obsidian 1.13.0+, desktop only. Default local embedding downloads models on first run (~37 MB), then cached locally.

---

## Features

**Q&A with citations**

Ask what's in your vault — *"What did I write about performance tuning?"* The answer lists key points with numbered `[1][2]` markers. Click one to jump to that note at the right paragraph. Responses stream in as they're generated, no blank waiting screen.

**Multi-step tasks, not just Q&A**

Go beyond single-turn chat. Say *"Pull together everything on product planning into a background doc"* — it searches across notes, reads the relevant ones, synthesizes, and writes a new note with the result. Before editing or deleting anything, it asks for your confirmation.

**Auto-indexed, non-blocking**

Indexes your vault automatically on first install. The indexer runs in a background thread so Obsidian stays responsive while it works. Edits are picked up automatically; restarts are quick after the first scan.

**Pick your own model**

Chat via DeepSeek, Claude, or local Ollama. With Ollama, prompts never leave your machine. Keys are stored in the Obsidian Keychain, not in config files. Context length presets (128k / 200k / 256k / 1M) plus a one-click recommendation from a public model registry.

**Permissions you control, status you can see**

Vault tools for read, search, write, edit, delete, and more — each can be set to ask, allow, or deny. The status bar shows index readiness, context usage, and whether token data comes from the model API. Built-in diagnostics tell you what's wrong when the model or index isn't healthy.

---

## Installation

Download `main.js`, `manifest.json`, `styles.css` from [GitHub Releases](https://github.com/golddream-y/obsidian-ratel/releases), place in your vault's `.obsidian/plugins/ratel-vault/`, restart Obsidian, enable the plugin.

Alternatively, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) (available in the Community Plugin directory) — add `golddream-y/obsidian-ratel` and it will handle installation and updates for you.

---

## Architecture

Ratel builds a **local search index** over your vault and runs a **multi-step agent** that reads and writes only when needed—not by stuffing everything into one prompt:

| Layer | Approach |
|------|------|
| Index | ONNX vectors (Web Worker) + BM25 keywords + backlinks; hash-diff incremental after first full scan |
| Retrieval | Multi-query rewrite → hybrid recall → RRF fusion → optional rerank |
| Agent | Context management + vault tools + permissions + read/write hooks; configurable multi-step loop |
| Distribution | Obsidian 3-file release model; worker inlined, WASM lazy-downloaded |

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CHANGELOG](CHANGELOG.md).

---

## Feedback

- [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues) — Bugs & feature requests
- [User Guide FAQ](docs/user-guide.md#29-faq)

---

## License

[Apache-2.0](LICENSE)

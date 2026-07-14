# Ratel

[English](README.md) | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**Chat with your vault. Get things done.**

Ask what you wrote about a topic. Have Ratel research across notes and draft a summary. Answers cite sources you can open in one click.

---

## Install

Obsidian → **Settings** → **Community plugins** → **Browse** → search **Ratel** → **Install** → **Enable**.

Requires **Obsidian 1.13.0+**, **desktop only**.

Then: configure a chat model (or local Ollama) → wait for the first index → click the 🦡 ribbon (or run **Ratel: Ask vault**).

Full walkthrough: [User Guide](docs/user-guide.md).

---

## What you can do

**Ask with citations**  
“What did I write about performance tuning?” — numbered `[1][2]` sources, click to jump.

**Multi-step work**  
“Pull product-planning notes into a background doc” — search, read, synthesize, write (with confirmation before edits).

**Know the room**  
Every turn injects local time. “Summarize this note” uses the active file. Daily note path, recent edits, and outlines are first-class tools — without inventing separate backlink gadgets (`read_note` already returns them).

**Remember & extend**  
Say “remember I prefer Tailwind…” — stored as Markdown under `.ratel/memory/`. Drop a `SKILL.md` into `.ratel/skills/` to teach new workflows.

**Your model, your keys**  
DeepSeek, Claude, or Ollama. Keys live in Obsidian Keychain — not in `data.json`. Local ONNX embedding by default.

**Stay in control**  
Per-tool allow / ask / deny. Status bar + diagnostics when something’s wrong. No telemetry; network only to endpoints you configure.

---

## Privacy

- Index and default embeddings stay on your machine  
- Optional remote chat / embed / rerank only if you set them up  
- No analytics, no phone-home  

---

## Docs

| | |
|---|---|
| [User Guide](docs/user-guide.md) | Setup, scenarios, slash commands, FAQ |
| [Architecture](docs/ARCHITECTURE.md) | Ports, agent loop, tools, workers |
| [Changelog](CHANGELOG.md) | Release notes |

Issues & ideas: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

---

## License

[Apache-2.0](LICENSE)

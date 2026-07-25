# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**The graph-native AI agent for your vault.**

Chat, research, and act on your linked notes. Ask what you wrote about a topic; have Ratel pull sources into a draft. Answers cite notes you can open in one click.

---

## What's new

**README is the short “what you can do now” snapshot.** Full history: **[Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md)**.

- **Latest stable: [0.1.13](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md#0113---2026-07-25)** — reopen the sidebar and continue the same chat; short-title chip switches recent sessions; auto titles after the first turn; `/new` matches the menu “New chat”

---

## Install

Obsidian → **Settings** → **Community plugins** → **Browse** → search **Ratel** → **Install** → **Enable**.

Requires **Obsidian 1.13.0+**, **desktop only**.

Then: open **Settings → Ratel → Chat model**, pick a scene preset (DeepSeek / Ollama) or custom Base → wait for the first index → click the 🦡 ribbon (or run **Ratel: Ask vault**).

Full walkthrough: [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md).

---

## What you can do

**Ask with citations**  
“What did I write about performance tuning?” — numbered `[1][2]` sources, click to jump.

**Multi-step work**  
“Pull product-planning notes into a background doc” — search, read, synthesize, write (with confirmation before edits).

**Know the room**  
Every turn injects local time. “Summarize this note” uses the active file. Daily note path, recent edits, and outlines are first-class tools.

**Remember & extend**  
Say “remember I prefer Tailwind…” — stored as Markdown under `.ratel/memory/`. Drop a `SKILL.md` into `.ratel/skills/` to teach new workflows.

**Your model, your keys**  
DeepSeek, Claude, or Ollama. Keys live in Obsidian Keychain — not in `data.json`. Local ONNX embedding by default.

**Stay in control**  
Per-tool allow / ask / deny. Status bar + diagnostics when something’s wrong. No telemetry; network only to endpoints you configure.

---

## Why Ratel

- **Graph-native** — built for linked notes, not generic chat over files  
- **Grounded answers** — numbered citations you can open in one click  
- **Private by default** — local embeddings; network only to the model you configure  
- **You approve edits** — per-tool permissions before anything changes your vault  

---

## Features

- Semantic search with clickable citations (`[n]` in the reply and note chips)
- Conversation-first chat: slim tool timeline, status beside the composer
- Graph tools: links, tags, properties, vault overview  
- Agent tools: read / write / grep / glob, memory, skills, active note & daily path  
- Private semantic search — local ONNX embeddings by default; optional API embed / Bailian rerank  
- Scene presets (DeepSeek / Ollama / Custom); keys in Obsidian Keychain  
- Per-tool permissions + trust mode; desktop only; no telemetry  

---

## Privacy

- Index and default embeddings stay on your machine  
- Optional remote chat / embed / rerank only if you set them up  
- No analytics, no phone-home  

---

## Docs

| Doc | Contents |
|---|---|
| [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | Setup, scenarios, slash commands, FAQ |
| [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | Full release history (ranges OK for patch bursts) |
| [Architecture](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/ARCHITECTURE.md) | Ports, agent loop, tools, workers |

Issues & ideas: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

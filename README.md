# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**The graph-native AI agent for your vault.**

Chat, research, and act on your linked notes. Ask what you wrote about a topic; have Ratel pull sources into a draft. Answers cite notes you can open in one click.

---

## Why Ratel

- **Graph-native** — built for linked notes, not generic chat over files
- **Fusion retrieval** — semantic + keyword multi-way recall, automatically pulling in linked related notes; numbered citations open in one click
- **Highly extensible** — built-in skills & subagents, plus MCP servers (HTTP or stdio) to plug in web search and other external tools
- **Deeply customizable** — swap chat / embedding / rerank models, override any prompt section, choose your MCP ecosystem
- **Private & safe by default** — local embeddings; network only to your configured model API and the MCP servers you add; tool calls default to ask, with Safe / Auto / Danger levels in chat

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
“Pull product-planning notes into a background doc” — search, read, synthesize, write (confirmation follows your permission level).

**Know the room**  
Every turn injects local time. “Summarize this note” uses the active file. Daily note path, recent edits, and outlines are first-class tools.

**Remember & extend**  
Say “remember I prefer Tailwind…” — stored as Markdown under `.ratel/memory/`. Drop a `SKILL.md` into `.ratel/skills/` to teach new workflows, or attach an MCP server (Tavily, Brave…) to give the agent web search and other external tools.

---

## Privacy

- Index and default embeddings stay on your machine
- Network access: by default only the model API you set (DeepSeek / Claude / Ollama)
- MCP servers: only the MCP endpoints you explicitly add in settings receive requests; tool approval follows your Safe / Auto / Danger level (default Safe asks)
- No analytics, no phone-home

---

## Docs

| Doc | Contents |
|---|---|
| [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | Setup, scenarios, slash commands, FAQ |
| [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | Full release history (ranges OK for patch bursts) |
| [Architecture](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | Ports, agent loop, tools, workers |

Issues & ideas: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

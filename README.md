# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**Make your Obsidian knowledge work proactively.**

Ratel is a proactive graph knowledge agent. It understands your journals, goals, and linked notes, then brings you sourced reviews, timely suggestions, and knowledge issues worth acting on—inside Obsidian and under your control.

---

## From waiting for prompts to knowing when to help

A typical vault chat starts only after you ask. Ratel is designed to let your knowledge participate at the right time:

1. Heartbeat checks new journals, goals, recent changes, and knowledge relationships.
2. Local rules decide whether there is anything worth interrupting you for.
3. Ratel creates a sourced yesterday review, today suggestion, or knowledge-maintenance insight.
4. Every result enters the insight inbox; high-value items can trigger an Obsidian Notice.
5. You can inspect sources, ask a follow-up, snooze, ignore, or approve a write to your vault.

Proactive does not mean autonomous modification. Notifications may appear automatically; vault changes remain your decision.

---

## How Ratel makes your knowledge work

### Bring you information worth acting on, at the right time (in progress)

Ratel does not require a second task database. Tell it where your journals, monthly goals, and recurring work live through ordinary Markdown memory.

- Start the day with a sourced review of yesterday.
- Add today suggestions when both monthly goals and today's journal are available.
- Ask once when a familiar location is missing; remember “none” instead of asking forever.
- Keep every proactive result in a reviewable insight inbox.
- Use the status bar as a stable entry point and reserve Notices for high-value insights.
- Respect quiet hours, daily limits, snooze, ignore, and follow-up actions.

### Understand relationships, not just files

Ratel combines retrieval, links, citations, maintenance, and knowledge discovery into one workflow.

- **Fusion retrieval:** semantic and keyword recall, enriched by links, backlinks, and properties.
- **Clickable citations:** numbered sources open the original note in one click.
- **Knowledge entropy management (in progress):** surface broken links, orphan notes, duplication, stale knowledge, and lingering tasks.
- **Knowledge mining (in progress):** discover themes, relationships, conflicts, and gaps across notes, then produce sourced syntheses.

### Move from discovery to controlled action

Inspect sources, ask a follow-up, snooze, ignore, or let Ratel organize, link, and write notes. Every vault change continues to follow your permission settings.

---

## What works today

**Recover knowledge when you no longer remember where it lives**

> “What did I write about performance tuning?”

Ratel combines semantic, keyword, and note-relationship signals, then keeps clickable sources in the answer.

**Complete multi-step knowledge work**

> “Turn my product-planning notes into a background document.”

The agent can search, read, synthesize, and write. Changes follow the permission level you choose.

**Understand the current Obsidian context**

> “Summarize this note and relate it to recently edited project notes.”

The active note, daily-note location, recent changes, and outlines are available as first-class context.

**Open the note you are talking about**

> “Open that reading note and jump to its second chapter.”

Ask “open that note” and the agent opens it in Obsidian, jumping straight to the heading (or block) you mean.

**Configure and troubleshoot by chat**

> “Switch my chat model.” / “Why isn’t indexing running?”

The built-in config skill reads current settings, applies whitelisted changes, and walks you through keychain setup — keys are guided into the keychain, never filled in for you.

**Remember preferences and extend workflows**

> “Remember that I prefer conclusions before evidence.”

Memory stays as Markdown under `.ratel/memory/` — pin must-keep preferences with `[pinned]`, and the most related topic memories join each turn automatically. Add a `SKILL.md`, connect an MCP server, or use Subagents for more specialized workflows.

---

## Your agent, your stack

- **Model freedom:** choose chat, embedding, and reranking models independently; use DeepSeek, Claude, Ollama, or compatible custom endpoints.
- **Layered memory:** pinned preferences never get truncated; related topic memories join each turn automatically.
- **Skills:** define reusable working methods in Markdown, with optional sandboxed scripts and reference files the agent can run or read.
- **MCP:** connect web search and external tools with per-server and per-tool permissions.
- **Subagents:** delegate complex research to focused retrieval, review, and synthesis roles.
- **Prompt customization:** override individual prompt sections without forking the plugin.

These capabilities are the foundation. They serve proactive intelligence and graph knowledge management instead of becoming setup work for its own sake.

---

## Privacy and safety

| Data or action | Default behavior |
|---|---|
| Vault index | Stored locally |
| Embeddings | Generated locally by default |
| Retrieved evidence | Sent only to the model endpoint you configure |
| MCP parameters | Sent only when an enabled MCP tool is invoked |
| Proactive insights | Filtered locally before the minimum necessary evidence is assembled |
| Vault changes | Follow Safe / Auto / Danger permissions; notifications cannot bypass them |
| Telemetry | None |

Once blacklist controls land, excluded content will never enter the index, candidate detection, model context, MCP parameters, logs, or notifications.

---

## Install

Obsidian → **Settings** → **Community plugins** → **Browse** → search **Ratel** → **Install** → **Enable**.

Requires **Obsidian 1.13.0+**, **desktop only**.

Then open **Settings → Ratel → Chat model**, choose a DeepSeek / Ollama scene preset or custom Base, wait for the first index, and click the 🦡 ribbon or run **Ratel: Ask vault**.

See the [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) for the full walkthrough.

---

## Docs

| Doc | Contents |
|---|---|
| [Product Vision](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/PRD.md) | Positioning, complete product picture, and direction |
| [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | Setup, scenarios, slash commands, and FAQ |
| [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | Release history |
| [Architecture](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | Ports, agent loop, tools, and workers |

Issues and ideas: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

---

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

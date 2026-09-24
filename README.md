# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**Ratel is an Agent inside Obsidian. It makes Obsidian simpler to use and configure.**

Someone can put a working setup into a skill: which plugins to install, how to configure them, and where folders go. Someone else says what they want, and Ratel installs that same environment and remembers the folders. In that vault, it can also find what you wrote by meaning and links, and edit notes under the permission level you set.

[User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md) · [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md)

## Copy someone else's working setup

A skill records a setup that already works: which plugins to install, which templates to write, which switches to turn on, and where folders go. Running the skill copies that environment into the current vault.

A diary and a monthly task ledger are two built-in examples:

```text
Install the diary plugins
```

This installs Templater and Dataview, writes the daily and monthly templates, and points core daily notes at the same folder. The diary folder and the monthly task folder are saved to memory, so the next chat uses them directly.

Developers can write their own setup as a skill. See the [scene skill guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md). A skill is Markdown and can travel with a vault.

## Find what you wrote

Search by meaning, keywords, and links between notes. `[1]` and `[2]` in an answer open the original note. The active note, recent edits, and heading outlines are available as context. Ask to open a note at a heading or a block.

## Let the Agent work in the vault

- Search, read, and summarize, then write notes under the permission level you set.
- A long-running goal stays with the vault. Chat confirms the done criteria before creating it. The status bar reminds you, and a new chat can take it over.

## Extensions

- **Models:** choose chat, embedding, and reranking models independently. DeepSeek, Claude, Ollama, or a compatible endpoint. The index is generated on this machine by default.
- **Skills:** reusable methods in Markdown, with optional scripts and reference files.
- **MCP:** connect web search and other external tools. Each server and each tool is authorized separately.
- **Subagents:** split retrieval, review, and synthesis into separate roles.
- **Images:** attach images in chat.
- **Prompts:** override individual prompt sections without forking the plugin.

## Not yet

- Check journals and goals on a schedule, and notify only when there is something worth saying. Results go to an inbox. Only high-priority items raise an Obsidian Notice. Quiet hours, a daily limit, snooze, and ignore are planned. A notification cannot bypass write permission.
- List broken links, orphan notes, duplicates, and stale notes.
- Synthesize themes, conflicts, and gaps across notes.
- A blacklist. Once it lands, excluded content will not enter the index, model context, MCP parameters, logs, or notifications.

## Privacy and safety

- The index and memory stay on this machine.
- Only the model endpoint you configure receives retrieved text.
- MCP sends data only when an enabled tool is called. Installing a plugin contacts only the official catalog and that plugin's GitHub release.
- Note edits and plugin installs follow the permission level you set. Keys are not filled in for you. No telemetry.

Details are in the [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md).

## Install

1. Obsidian → **Settings** → **Community plugins** → **Browse**, search **Ratel**, install, and enable.
2. **Settings → Ratel → Chat model.** Choose a DeepSeek or Ollama preset, or enter a custom endpoint.
3. Wait for the first index. Click the 🦡 ribbon, or run **Ratel: Ask vault**.

Requires **Obsidian 1.13.0+**, **desktop only**.

## Docs

| Doc | Contents |
|---|---|
| [Product overview](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/prd/overview.md) | Positioning, capabilities, and direction |
| [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md) | Setup, slash commands, FAQ |
| [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | Release history |
| [Architecture](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | Ports, agent loop, tools, and workers |
| [Scene skill guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md) | How a developer writes a skill that installs and configures a setup |

Issues and ideas: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

## Sponsor

Optional. Sponsorship does not change any feature.

- Afdian: [afdian.com/a/golddream](https://afdian.com/a/golddream)
- Ko-fi: [ko-fi.com/golddream_y](https://ko-fi.com/golddream_y)

See the [sponsor page](https://github.com/golddream-y/obsidian-ratel/blob/main/SPONSOR.md).

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

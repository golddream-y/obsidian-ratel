# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.1%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-0ea5e9?style=flat-square)](https://obsidian.md)

**Ratel is an agent inside Obsidian. Say what you want, and it installs the plugins, templates, and folders into the current vault.**

Obsidian is easy to write in and hard to configure. Templater syntax, Dataview queries, and Day Planner formats are each enough to stop someone. One sentence in chat is enough for Ratel to install the plugins, write the templates, and point the folders.

[User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md) · [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md)

## A working setup, in one sentence

Say “install the diary plugins.” Ratel installs Templater, Dataview, and Day Planner, writes the daily and monthly templates, points core daily notes at that folder, and remembers where those folders are.

> After you change Day Planner’s heading format, quit Obsidian completely and open it again. Otherwise the change does not apply.

That setup is a scene skill: a Markdown folder. Write down a way of working you have already tried, and give the folder to someone else. They put it in their vault and get the same plugins, templates, and paths. How to write one is in the [scene skill guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md).

A short recording belongs here: from the sentence “install the diary plugins” to the templates showing up in the vault.

## Quick start

1. Obsidian → **Settings** → **Community plugins** → **Browse**, search **Ratel**, install, and enable.
2. **Settings → Ratel → Chat model.** Choose DeepSeek or local Ollama, or enter your own endpoint.
3. Wait for the first index to finish. Click the badger in the ribbon, or press `Cmd/Ctrl+P` and run **Ratel: Ask vault**.

Requires **Obsidian 1.13.1 or newer**. Desktop only.

## Why not a plugin you already have

The community already has plugins that talk to a vault. Ratel is different in this:

> Most of them help you ask the vault. Ratel can also set Obsidian up.

Answering questions is one of its abilities. The part that is harder to copy is the environment itself: which plugins to install, which settings to change, where the templates and folders go, and how to hand that tested environment to someone else as a folder.

If you only want to chat with your notes, an existing plugin is enough. If you are stuck on configuration, or you want to give someone a whole way of working, Ratel is built for that.

## What you need

| | |
|---|---|
| Chat model | A cloud model needs your own API key. Ratel does not fill keys into other plugins, and it does not write keys into plugin data or sync them with the vault. |
| No separate fee | Local Ollama can run chat offline. Embeddings are generated on this machine by default. Ratel itself is free and has no paid tier. |
| Model charges | Whatever the provider you chose publishes. |

## Privacy and data boundary

- Embeddings are generated on this machine by default and are not uploaded.
- Retrieved note text is sent only to the model endpoint you configure. An external tool sends data only when that tool is enabled and this call actually uses it. Installing a community plugin contacts only the official plugin directory and that plugin’s GitHub release.
- Keys stay in the system keychain. They are not written into plugin data and are not synced with the vault.
- There is no telemetry.
- Note edits and plugin installs follow the permission level you set: Safe, Auto, or Danger. Each tool can also be set to allow, ask, or deny. Deny overrides the level and any grant for the current session.
- Reading files outside the vault and running commands on this computer are off. Chat cannot turn that switch on for you. If you turn it on, what is read may still be sent to the configured model, and each use asks again.

## Inside the vault

Search uses meaning, keywords, links, backlinks, and properties together. `[1]` and `[2]` in an answer open the heading or block in the original note. The active note, recent edits, and heading outlines are available as context.

If search, reading, or a summary leads to a note edit, that edit still follows the permission rules above.

Goals that last across chats, scripts inside skills, and external tools are in the [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md).

## Documentation

| Document | Contents |
|---|---|
| [User Guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.en.md) | Chat, slash commands, and common questions |
| [Changelog](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | Changes in released versions |
| [Product overview](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/prd/overview.md) | Scope and what comes next |
| [Scene skill guide](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md) | Package a setup for someone else |
| [Architecture](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | Module boundaries and runtime structure |

Questions and suggestions: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

## Sponsor

Optional. Nothing in the plugin changes if you do.

- Afdian: [afdian.com/a/golddream](https://afdian.com/a/golddream)
- Ko-fi: [ko-fi.com/golddream_y](https://ko-fi.com/golddream_y)

See the [sponsor page](https://github.com/golddream-y/obsidian-ratel/blob/main/SPONSOR.md).

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

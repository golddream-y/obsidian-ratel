# Ratel

**English** · [简体中文](README.zh-CN.md)

**Find your notes, finish the work, and set up your Obsidian workflow.**

Ratel is an AI assistant that can read notes and take action inside Obsidian. Ask it to find answers in old notes, turn scattered material into a document, or install and configure a daily-note workflow. It remembers your folders and preferences, answers with sources you can open, and follows your tool permissions.

Your notes remain ordinary Markdown files. Choose DeepSeek, Ollama, or an OpenAI-compatible chat endpoint. The search index is generated locally by default.

[Get started](docs/user-guide.en.md#1-install-and-complete-your-first-query) · [User guide](docs/user-guide.en.md) · [Changelog](CHANGELOG.md)

Requires **Obsidian 1.13.1+**. **Desktop only.**

## Set up a workflow you can actually use

> Set up daily notes and monthly reviews.

A daily-note workflow often needs several plugins to work together: templates create notes, a timeline displays today's plan, and a monthly ledger tracks goals. Installing the plugins still leaves folders and settings to align.

Ratel's built-in diary skill installs Templater, Dataview, and Day Planner, writes daily and monthly templates, configures the core daily-note folder, and remembers those locations. The skill explains the changes and asks about your folder convention before proceeding. Existing templates are not overwritten automatically.

Once configured, you can ask:

- **“Plan today's work.”** Draft time blocks from monthly goals and yesterday's unfinished tasks.
- **“Sync today's ledger.”** Extract work records from your daily note and update monthly progress.
- **“Review this month.”** Draft a review and next month's goals from your notes and ledger.

[Set up and use the diary workflow](docs/user-guide.en.md#3-install-and-maintain-your-plugin-setup)

You can package a working setup as a **skill**: plugins, settings, templates, and instructions for ongoing use. Share the skill folder so others can run it in their own vault. [Write a scene skill](docs/contributing/scene-skill.md)

## Turn accumulated notes into answers and useful documents

> Turn my notes about this project into a background document. Keep the sources, and show me a draft first.

You do not need to remember the title. Ratel searches using meaning, keywords, and link relationships, reads the relevant notes, and organizes the material into an answer or document. Citations open the original notes so you can check the conclusions.

Ask it to summarize the active note, filter by tags or properties, inspect backlinks, or open a note at a specific heading. When writing back, specify the destination and scope. Tool permissions govern the changes.

[Find, understand, and organize notes](docs/user-guide.en.md#2-find-understand-and-organize-notes)

## Keep your working conventions and continue longer tasks

> Remember: project material belongs in Projects. Show a draft before writing a summary.

Preferences and folder conventions can become memory shared across chats. Memory is stored locally as Markdown you can inspect, edit, or delete.

For work that takes several rounds, use `/goal` to agree on completion criteria. Goals stay with the vault and can be taken over in a new chat. Paused or exhausted goals show their status. This supports ongoing work; it does not promise background execution while Obsidian is closed.

[Memory and long-running goals](docs/user-guide.en.md#5-remember-conventions-and-continue-longer-tasks)

## Get started

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **Ratel**, install, and enable it.
2. In **Settings → Ratel → Chat model**, open the current row under Saved setups and select a provider and model. Enter the remote model's API key in that setup's model settings. It is automatically synced to Obsidian Keychain for encrypted storage; local Ollama usually needs no key.
3. Wait for the first index, open chat with the 🦡 ribbon icon, and ask: **“Find notes about a topic in this vault and list the sources.”**

Local embeddings need an initial download of the model and runtime assets. Open the answer's sources to verify the results before trying writing or setup tasks.

**Review tool permissions before first use. Built-in tools default to Allow, including writing, deleting notes, and changing plugins. Safe mode also permits tools set to Allow.** To require confirmation, set the relevant tools to Ask in **Settings → Ratel → Memory & permissions** and use Safe mode. [Permission details](docs/user-guide.en.md#7-control-permissions-and-data-sharing)

## Control your data and changes

- **Local storage:** indexes, chats, and memory stay on this machine. No telemetry. Embeddings are local by default; remote chat still receives the content needed for the task.
- **Model calls:** chat and its context go to your configured chat endpoint. Remote embedding or reranking, if enabled, sends the relevant text to those endpoints.
- **Optional connections:** local models and runtime assets are downloaded initially. Enabled MCP tools connect to their servers. Plugin installation and updates access the official catalog and the selected plugin's GitHub release.
- **Recorded changes:** plugin installation, updates, removal, and configuration changes keep change records and recovery backups. Ask Ratel to inspect the history and restore a specific change.
- **Host access:** reading or importing outside files and running local commands are off by default. Enable access manually; tool permissions still apply. Danger mode skips confirmation. A tool set to Deny stays blocked.

[Full permission and privacy details](docs/user-guide.en.md#7-control-permissions-and-data-sharing)

## Extend your workflow

Configure chat, embedding, and reranking models independently. Skills store reusable instructions in Markdown, with optional references and sandboxed JavaScript. MCP can connect external tools such as web search. Subagents can assist with retrieval, review, and organization. Attached images go to the current chat model, which must support vision.

[Use extensions](docs/user-guide.en.md#6-manage-chats-and-use-extensions) · [Product direction and capabilities not yet delivered](docs/prd/overview.md) · [Architecture](docs/architecture/overview.md)

## Support and contribute

See [Troubleshooting and reference](docs/user-guide.en.md#8-troubleshooting-and-reference), or open a [GitHub issue](https://github.com/golddream-y/obsidian-ratel/issues). Sharing a scene skill you have tested helps others use Obsidian too.

Optional sponsorship: [Afdian](https://afdian.com/a/golddream) · [Ko-fi](https://ko-fi.com/golddream_y). Sponsorship does not change any feature. [Details](SPONSOR.md)

License: [Apache-2.0](LICENSE)

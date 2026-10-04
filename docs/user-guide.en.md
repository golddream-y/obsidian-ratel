# Ratel User Guide

**English** · [简体中文](user-guide.md)

Start with your first search, then use Ratel to organize notes, configure plugins, run a diary workflow, and continue longer tasks. Ratel runs in desktop Obsidian and requires version 1.13.1 or later.

Complete [installation and your first query](#1-install-and-complete-your-first-query) first. If your model is already configured, choose a task:

- [Find notes and write a summary](#2-find-understand-and-organize-notes)
- [Install, configure, and restore plugins](#3-install-and-maintain-your-plugin-setup)
- [Plan today, close out work, and review the month](#4-plan-today-close-out-work-and-review-the-month)
- [Memory and long-running goals](#5-remember-conventions-and-continue-longer-tasks)
- [Chats, images, skills, and MCP](#6-manage-chats-and-use-extensions)
- [Permissions and privacy](#7-control-permissions-and-data-sharing)
- [Troubleshooting, commands, and settings](#8-troubleshooting-and-reference)

## 1. Install and complete your first query

Follow this sequence: install → configure a chat model → review permissions → wait for indexing → ask and verify sources. You do not need to organize tags or links beforehand.

### Install and configure a model

1. In Obsidian, open **Settings → Community plugins → Browse**, search for **Ratel**, install, and enable it.
2. Open **Settings → Ratel → Chat model** and click the row marked Current under Saved setups. Choose a provider, then a model. Ollama is under On this machine; search Common providers for Volcengine or DeepSeek. For a custom endpoint, enter its API Base and model name. Use a model available from your provider or installed locally.
3. For a remote service, enter the API key in that setup's API key field. It is automatically synced to Obsidian Keychain for encrypted storage; no separate manual entry is needed. Local Ollama usually uses `http://localhost:11434/v1` without a key; start Ollama and prepare the model first.
4. Check the key status in Ratel settings. Your chosen provider charges for model usage.

In Saved setups, choose New setup, give it a name, and open it to choose a provider and model and enter its key. Nothing is inherited from the previous setup. To reuse an existing setup, open it and choose Copy setup; its model, endpoint, window, and key are copied to an independent setup. Neither action switches the active setup automatically. After configuring it, choose Set as current or switch from the chat top bar.

Embeddings run locally by default. First use downloads the model and WASM runtime assets, then indexes your notes. You can keep using Obsidian during this process. The strip above the chat input shows progress and explains why sending is blocked until ready.

### Review permissions

**Built-in tools default to Allow, including writing and deleting notes and configuring plugins. Safe mode does not ask for each operation when the tool is set to Allow.**

To review changes first, go to **Settings → Ratel → Memory & permissions → Tool permissions**. Set write, append, edit, delete, and plugin-changing tools to Ask, and keep Safe mode selected. See [permissions](#7-control-permissions-and-data-sharing) for the complete rules.

### Run your first search

Open chat using the 🦡 ribbon icon. Choose a topic you know exists in your vault and ask:

> Find my notes about project retrospectives. Briefly describe each one and list the sources. Do not change any files yet.

Click a citation or expand the source list to open the original notes. Check relevance and accuracy. Finding relevant notes and opening their sources completes your first use. If nothing matches, try words from the notes or select a known note with `@` before asking.

## 2. Find, understand, and organize notes

### Find and read

Ask by topic, or specify an active note, file, tag, or property. Use vault-relative paths. Type `@` to select a note, or right-click a Markdown file and choose **Add to Ratel**. Selecting a path does not preload the whole note into the input; the assistant reads it as needed.

| Task | Example | Check |
|---|---|---|
| Recall a topic | Which notes discuss cache invalidation? | Are the sources relevant? |
| Understand the active note | Summarize this note and list unresolved questions. | Does the original support the conclusions? |
| Inspect relationships | What links here? Which outgoing links are unresolved? | Open related notes to check. |
| Filter notes | Find notes tagged project with status draft. | Do tags and properties match? |
| Open a location | Open the second section of `Projects/Plan.md`. | Did it navigate to the right heading or block? |
| Review recent work | Which notes changed recently? | Do files and dates match? |

A citation gives you a source to inspect; it does not guarantee a correct conclusion. Verify important claims in the original. If no note is open, specify a path or use `@` instead of asking about “this note.”

### Write a document from several notes

Specify scope, output, and whether to write:

> Use notes under Projects/Example to draft the project background, key decisions, and open questions. Keep sources. Show the draft in chat without modifying files.

Check for missing material, unsupported assumptions, and irrelevant citations. Once satisfied, ask:

> Write this draft to Projects/Example/Background.md. If the file already exists, read it first and explain which sections will change.

Tool execution appears in chat; confirmation depends on permissions. Open the destination afterward and check content, links, and scope. Plugin recovery backups are not note version history. Use your own backup or versioning for ordinary note changes.

For local edits, Ratel replaces a uniquely matching passage. To move or copy a note, specify its source and destination paths. Writing tools return Chinese character and Latin word counts for checking length. AGENTS.md files in the note folder and its parent folders provide writing conventions; changing those files still requires confirmation. Patch editing can apply several changes to one note atomically; format errors identify the line and explain how to correct it. Invalid tool arguments receive corrective feedback and are not executed.

## 3. Install and maintain your plugin setup

### Set up the diary workflow

The built-in setup is for recording work time blocks in daily notes and tracking goals in a monthly ledger. Ask:

> Set up daily notes and monthly reviews.

Or type `/install-diary-plugins`. Selecting a skill puts it in the input; press Enter again to send.

Ratel explains the proposed installation and configuration and asks for a diary root folder, suggesting `Work/Diary`. Check whether the folder fits your existing vault. With an English interface, the skill asks whether to translate the Chinese template headings and prompts.

After confirmation, it installs Templater, Dataview, and Day Planner as needed, writes daily and monthly templates, aligns the core daily-note settings and plugin configuration, and remembers the locations. Existing templates are not overwritten automatically. Existing flat daily notes in the chosen root may be moved into month folders; review the proposed changes.

Check the result:

1. Templates exist and the diary directory matches your convention.
2. Create or open today's note using Obsidian's core Daily notes feature. Check the template and monthly ledger. The installation skill does not create today's note itself.
3. Add a task with start and end times under the configured work-task heading and check that Day Planner displays it. The original Chinese heading is “🧸 今天的任务记录：”; use the translated heading if you chose translation.

**After changing Day Planner's heading, fully quit and reopen Obsidian. Reloading the plugin or app alone is insufficient.** This workflow enables Dataview JS; review that setting when approving the setup.

### Manage other plugins

Describe a need or name a plugin:

> Find a community plugin for project kanban boards and explain the recommendation. Do not install it yet.

> Check Dataview's status and change only the settings I name. Preserve everything else.

Ratel can search, install, update, uninstall, and change individual configuration fields. It uses plugins in the official community catalog, not arbitrary download URLs, and does not fill in secrets. If a plugin cannot be enabled immediately, follow the reload instructions and test the actual feature.

### Inspect and restore changes

Plugin changes keep records and recovery backups. To undo a change, first ask:

> List recent plugin changes and explain what each changed.

Select a specific entry and request restoration. Restoring writes the recorded snapshot back; newer changes to that plugin may be overwritten. Expired backups cannot be restored. These snapshots do not replace a long-term backup of your vault.

Reload the app after restoration and check the plugin's version, settings, and enabled state. A diary setup includes templates, memory, and host settings as well as plugins. Restoring one plugin backup does not undo the entire setup.

## 4. Plan today, close out work, and review the month

Set up the diary environment first, or tell Ratel where your existing daily notes and monthly ledger are. Use `/diary-month-ledger` to invoke the built-in workflow explicitly, or ask for a task below.

| When | Ask | Input and output |
|---|---|---|
| Start work | Plan today's work. | Read monthly goals and yesterday's unfinished tasks; draft today's time blocks. |
| Finish work | Sync today's ledger. | Extract today's work records, append them to the monthly ledger, and update goal progress. |
| End of month | Review this month and draft next month's goals. | Summarize daily notes and the ledger; carry unfinished goals forward after confirmation. |

The skill reads relevant records, explains which files it will change, and waits for confirmation before writing. Time blocks belong under the configured work-task heading, for example `- [ ] 08:50 - 10:50 Organize project material`. You maintain the daily narrative. Closeout synchronization leaves the original detailed tasks intact.

Check dates, time blocks, goal associations, and statuses afterward. The monthly ledger tracks broad progress; daily notes retain the detail. Unfinished goals move to the next month only with your agreement.

If notes cannot be found or conventions are unclear, locate the folders and update memory first. Core daily notes may be organized into year and month folders, so checking only the root can miss today's note. Asking where today's note is only locates it; it does not create it.

You initiate these tasks. Scheduled proactive briefings, an insight inbox, and automatic knowledge maintenance have not been delivered.

## 5. Remember conventions and continue longer tasks

### Record and correct memory

> Remember: project material belongs in Projects. Keep sources in summaries and show a draft first.

Ask what conventions it remembers, change one, or ask it to forget. Open **Settings → Ratel → Memory & permissions → View memory**, or use memory management in the chat status drawer to browse, edit, and clean up entries.

Memory and automatic writing are enabled by default. Disable automatic writing in settings if you do not want it. Memory provides context; it neither replaces tool permissions nor guarantees that a model follows every instruction.

Memory is ordinary Markdown under `.ratel/memory/`: `global.md` stores general conventions, `topics/` stores topic memory, and `index.md` indexes topics. You can edit these files directly. Global injection has a size limit; important headings can include `[pinned]`. Adjust how many related topics are injected automatically in settings; 0 disables automatic topic injection.

### Create and continue a goal

Use a goal for work requiring several rounds:

> /goal Check notes under Projects/Example and fill in missing status properties. Leave existing values unchanged and list modified files when finished.

The assistant agrees completion criteria and a round limit with you before creating it. Only one unfinished goal can exist at a time. `/goal` does not support time-limit prefixes such as `30m` or `2h`.

Goals stay with the vault. The status strip shows running, paused, blocked, or round budget exhausted. In a new chat, click **Take over** to bind the goal there; the new chat does not automatically have the old chat's completion criteria.

Stopping generation and pausing a goal are separate actions. Pause, resume, abandon, or archive through the goal list in the status drawer or **Settings → Ratel → Memory & permissions → View goals**. Pausing revokes the goal's directory grant.

When rounds run out, add rounds to that goal or stop for now. The default round limit in settings affects future goals only. Check completion criteria and files before confirming completion in chat. A goal is not a scheduled task and does not keep running with Obsidian closed.

## 6. Manage chats and use extensions

### Chats and images

The title button at the top right opens history to restore, create, or delete chats. The adjacent edit button changes the title manually or requests an AI title. Switching during generation asks for confirmation and stops the current reply. Closing the sidebar or restarting restores the last chat.

`/new` starts a chat. `/compact` compresses context sent to the model while keeping visible chat history. Automatic compression near the context limit is enabled by default and can be disabled in Chat model settings. Save important conventions in memory and use goals to retain completion criteria for longer work.

Attach images in the input alongside text. They go to the current chat model, which must support vision; text-only models may reject them. Images are stored locally and remain visible in history after restart.

### Use and manage skills

A skill is a reusable method. Built-in skills cover diary setup, daily ledger work, and Ratel configuration. Name one in chat or select it from the `/` menu.

To install your own skill, place its folder containing `SKILL.md` under the vault's `.ratel/skills/`, or under `.ratel/skills/` in your user home directory, then reload the plugin. A vault skill takes precedence over a global skill with the same name. The Skills panel in the status drawer shows sources and supports enabling, disabling, editing, and deleting. Built-in skills are updated with the plugin and cannot be edited directly.

Skills can include text in `references/` and JavaScript in `scripts/`. Scripts run in a sandbox without network access or external module loading, and cannot access Obsidian's configuration directory. Enabling host access does not loosen this sandbox. First execution asks for trust: allow and remember, allow once, or reject.

Scripts without progress time out after 30 seconds by default. Long tasks reporting progress can keep running, up to 10 minutes. Three consecutive failures block execution until trust is confirmed again. Adjust the unresponsive timeout in Advanced settings. See the [scene skill guide](contributing/scene-skill.md) for authoring details.

### Connect MCP

Open **MCP** management from the status drawer. Add an HTTP or local-command server, or import Claude / Cursor JSON configuration. Review the source, command, and data destination before enabling. Local-command servers may start processes; remote tools send parameters to their servers.

Enabled tools appear in chat and follow their individual permissions. External tools ask by default. Auto mode retains the rules for high-impact tools; Danger mode skips confirmation. To use web search, configure a server providing it. If a connection fails or no tools appear, wait for enabling to finish, then refresh to reconnect.

## 7. Control permissions and data sharing

### Tool permissions

Select a mode below the chat input or in **Settings → Ratel → Memory & permissions**. Set each tool to Allow, Ask, or Deny.

| Mode | Behavior without additional grants |
|---|---|
| Safe | Follow each tool's setting: Allow executes, Ask requests confirmation, Deny blocks. |
| Auto | Ordinary tools may execute directly. High-impact tools such as deletion, plugin changes, host access, and MCP still follow their individual settings. |
| Danger | Skip confirmation; tools set to Deny stay blocked. |

**Most built-in tools default to Allow, including writing, deletion, and plugin changes.** To review these operations each time, set them to Ask and use Safe mode. Auto mode permits ordinary writing tools even when set to Ask.

“Do not ask again in this chat” grants permission by tool name, not by a single path. Switching chats or `/new` clears it. A goal's directory grant can also reduce confirmations; pause the goal to revoke that grant. Deny always takes precedence. A skill's instruction to ask first is a workflow convention; enforced blocking depends on tool permissions. Changes to `AGENTS.md` have a separate mandatory confirmation that Allow, Danger mode, and existing grants do not bypass.

### Outside files and local commands

Host access is off by default and must be enabled manually in settings. Chat-based configuration cannot enable it. Once enabled, Ratel can list outside directories, read outside text files, import files unchanged, and run local commands. These four tools default to Ask. Safe and Auto modes process them according to individual settings and existing grants; Danger mode skips confirmation.

Absolute paths copied from your file manager can be pasted into the input but are not treated as vault notes. Read content may enter model context. Commands can affect files or access the network; review the command and working directory when confirming. Turning host access off blocks these tools again.

### Storage and connections

| Activity | Storage or destination |
|---|---|
| Indexes, chats, attachments, and diagnostics | Local plugin directory. No telemetry; diagnostics exclude note bodies. |
| Memory | `.ratel/memory/` in the vault; relevant memory is included in chat context. |
| Chat model | Questions, selected note content, memory, tool results, and attachments may go to the configured endpoint. |
| Remote embeddings or reranking | When enabled, relevant note text or candidate passages go to those endpoints. |
| First local embedding setup | Model download from ModelScope; WASM runtime download from jsDelivr. |
| MCP | Connections to enabled servers and tool-call parameters; boundaries depend on the server. |
| Plugin installation and updates | Official community catalog and the selected plugin's GitHub release. |

Chat model keys entered in model settings are automatically synced to Obsidian Keychain for encrypted storage, not written to Ratel's `data.json`. The assistant does not fill them in. Local embeddings do not make remote chat offline. Local Ollama with downloaded embedding assets and no external tools can process work on this machine.

A vault-wide blacklist has not been delivered. For material that must not reach a remote endpoint, do not rely only on the scope stated in a prompt. Choose a suitable local model or use a separate vault.

## 8. Troubleshooting and reference

### Troubleshoot by symptom

| Symptom | What to check |
|---|---|
| Cannot send | Read the reason above the input; check keys, endpoint, and indexing status. |
| First indexing never finishes | Check downloads and network; expand the strip for index and embedding status, then inspect diagnostics. |
| Model request fails | Verify Base, model name, key, and provider quota. For Ollama, check the process and installed model. |
| A known note is missing | Try original wording or an `@` path. Only Markdown is indexed. Rebuild if needed. |
| Embedding or chunking changes have no effect | Restart Obsidian, check the index, and use `/reindex` if needed. |
| Diary template or timeline does not work | Check templates, core daily-note folders, and plugin settings. Fully quit and reopen after changing Day Planner's heading. |
| A plugin behaves incorrectly after a change | Inspect change history, restore the specific backup, reload, and test. |
| No confirmation appeared | Check Allow settings, mode, chat grants, and goal directory grants. |
| A new chat cannot continue the old goal | Take it over and check for pause, blockage, or exhausted rounds. |
| A citation does not open | Hover to check its path, verify the note still exists, and search again. |
| Adding an image breaks the request | Remove the image or switch to a vision-capable model. |
| MCP shows no tools | Wait for enabling to complete, check configuration, and refresh. |

Retries appear at the bottom of chat; Stop interrupts the wait. Expand the status strip to inspect indexing, embeddings, and context usage, and open goals, memory, skills, MCP, or feedback.

For repeated failures, inspect **Settings → Ratel → Advanced → Diagnostics**, including the previous run. Feedback can copy local diagnostics. Review environment information before posting it in an issue, and include reproduction steps and error messages.

### Commands and settings

| Input | Purpose |
|---|---|
| `/new` | Start a new chat. |
| `/goal objective` | Agree and create a long-running goal. |
| `/compact` | Compress model context while keeping chat history. |
| `/model` | View model configuration. |
| `/reindex` | Rebuild the complete index. |
| `/install-diary-plugins` | Built-in diary setup skill. |
| `/diary-month-ledger` | Built-in planning, closeout, and monthly review skill; add a task description. |

The first five are fixed commands; the last two come from enabled skills. Selecting a skill or `/goal` puts it in the input for completion and sending. Commands without arguments execute on selection. The command palette also opens chat, shows index status, pauses or resumes automatic indexing, and clears the index.

| Settings tab | Purpose |
|---|---|
| Chat model | Language, saved setups (provider, model, address, API key, and context length), automatic compression. |
| Note index | Embeddings, chunking, automatic indexing, optional reranking. |
| Memory & permissions | Memory, diary conventions, goals, tool permissions, host access. |
| Appearance | Colors, accent, message navigation, motion, and mascot. |
| Advanced | Context length, model registry, prompt overrides, script timeout, diagnostics. |

Language can be automatic, Chinese, or English. Restart to refresh command-palette names. Dots along the message area's edge navigate to questions; the down button returns to the latest message.

### Secret storage names (troubleshooting reference)

Enter chat keys in the corresponding Saved setups row. They are automatically synced to Keychain for encrypted storage. Each setup has its own key; the storage name shown on the page is for inspection, not an entry to create again.

Embedding, reranking, and MCP keys still need to be added in Obsidian **Settings → Keychain**, using these names:

| Name | Purpose |
|---|---|
| `ratel-embed-openai-compatible` | Remote API embeddings, when enabled. |
| `ratel-rerank-bailian` | Optional Bailian reranking. |
| `ratel-mcp-<serverId>` | Secret environment variables for a local-command MCP server; use its ID from management. |

For further help, open a [GitHub issue](https://github.com/golddream-y/obsidian-ratel/issues). For skill development, see the [contribution guide](contributing/scene-skill.md).

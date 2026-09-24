# Ratel User Guide

[English](user-guide.en.md) | [简体中文](user-guide.md)

> For day-to-day use. After the plugin and the chat model are set up, look up a topic below.

---

## 1. What this is

Ratel is a desktop **vault AI Agent** for Obsidian. It answers questions, reads notes across several steps, writes summaries, and remembers preferences. The index runs locally. Keys stay in the keychain. The only network calls are to the model API you configure.

**For:** vault Q&A, summaries, recent notes, a long-running goal across chats, and custom skills.  
**Not for:** mobile, or workflows that need web search or a shell. This plugin does not do those.

---

## 2. Install and first five minutes

### 2.1 Install

1. Obsidian → **Settings** → **Community plugins** → turn off Restricted mode
2. **Browse** → search **Ratel** → install and enable
3. The 🦡 icon appears in the left ribbon

> Requires Obsidian **1.13.0+**, **desktop only**.

### 2.2 First open

1. **Set the chat model** (Settings → Ratel → **Chat model**)
   - Pick a DeepSeek or Ollama preset, or enter a custom base and model
   - DeepSeek: add keychain secret `ratel-chat-openai-compatible`; default model `deepseek-v4-flash`
   - Ollama: set the base to `http://localhost:11434/v1` (usually no key)
2. **Wait for the index.** The status strip above the input shows progress. You can keep using Obsidian.
3. Click the 🦡 ribbon (or run `Ratel: Ask vault`) and ask.

The default embedding model is local ONNX. The first run downloads it (tens of MB). After that it works offline.

### 2.3 Interface language

Settings → Ratel → **Chat model** → Language: `auto` / 中文 / English. The UI switches immediately. Command names in the command palette refresh after you restart Obsidian.

---

## 3. How to ask

| You want… | You can say… | Ratel will… |
|---|---|---|
| A topic | “What did I write about performance tuning?” | `search_vault` → citations `[1][2]` → open the note |
| One note | “Summarize `notes/xxx.md`” | `read_note` (frontmatter, tags, backlinks) |
| Today’s date | “What day is it?” | Usually no tool. Local time is already in the turn |
| An exact date | “What date is three days from now?” | `get_datetime` |
| The open note | “Summarize this note” | `get_active_note` → `read_note` |
| Open a note | “Open that reading note” / “Jump to chapter two” | `open_note` at a heading or block |
| Recent edits | “Which notes changed recently?” | `list_recent_notes` |
| Today’s daily note | “Where is today’s daily note?” | `get_daily_note` (probe only, **does not create**) |
| An outline | “What headings does this note have?” | `get_note_outline` (heading cache, not the full file) |
| Links | “Who links here?” / “Where does this link?” | `get_links` (includes unresolved links) |
| A tag | “Find notes tagged `#project`” | `search_by_tag` (nested tag prefixes) |
| A property | “Find notes with `status: draft`” | `search_by_property` (omit value to test that the key exists) |
| A vault overview | “What tags and orphan notes are there?” | `get_vault_structure` |
| A write-up | “Turn the product-planning notes into a background doc” | Several search steps, then read and write (writes ask by permission) |
| A long-running goal | “`/goal` fill in properties for a folder” | Restates the done criteria and round budget, then creates after you agree. See [§6](#6-long-running-goals) |
| Config or a fault | “Switch my model” / “Why isn’t indexing running?” | Built-in config skill → `get_app_config` → change a whitelisted setting or open Settings. Keys are guided into the keychain, never filled in |

While the answer streams you can see tool calls. Models that support reasoning (DeepSeek-R1 / V4) show a collapsible thinking block. A dotted orb marks thinking, writing, and tool calls. Search hits sit under the answer as a collapsed “N sources” row. If the answer already has clickable `[1][2]`, that row stays hidden.

Blue `[1]` and `[7]` in the text are indexes from the **latest search in this chat**, not section numbers. Hover for the path, click to open. They stay clickable after later turns.

You can drag-select the answer, the thinking block, and tool details. The header and the input are not selectable.

### 3.1 Ask with an image

Attach an image in the input. A message still needs text.

The image goes to the current chat model. A local Ollama vision model or a remote vision model can read it. A text-only model such as DeepSeek returns an error: remove the image or switch models.

After a restart, images in old bubbles remain. Image files live in the plugin folder, not inside the session JSON.

---

## 4. Sessions

The short title chip (clock icon) at the top right opens recent chats: open an old one, start a new one, or hover a row to delete it. Closing the sidebar or restarting returns you to the last session.

| You want… | Do this |
|---|---|
| Rename | **✎** next to the chip → edit and save, or **AI summary** for a short title and a normal title |
| Switch or start new while generating | Confirm first. The current reply stops and is marked stopped |
| “Don’t ask again this session” | Grants that **tool name** for the whole chat. `/new` or a session switch clears it |

`/new` and “New chat” are the same path. A chat that has content stays in the list. Empty chats are not piled up.

A divider marks a new calendar day (“today / yesterday / a date”). The history list shows the calendar day instead of only `2d`.

### Tool permission level

Under the input: **Safe** (ask before write or delete) / **Auto** (read and write proceed; delete still confirms) / **Danger** (no confirm).  
The same control is under Settings → Memory and permissions. A tool set to Deny always stays denied.

---

## 5. Daily note convention

Settings → Ratel → **Memory and permissions** → daily note:

| Item | Default | Notes |
|---|---|---|
| Folder | (empty = vault root) | Path relative to the vault |
| Filename format | `YYYY-MM-DD` | `YYYY` / `MM` / `DD` |

`get_daily_note` **only checks whether the path exists**. It does not create the note. Ask Ratel to `write_note`, or create the file yourself.

---

## 6. Long-running goals

Use `/goal` for work that spans many rounds or a new chat. Ordinary questions do not need it.

**Create**

- Type `/goal` plus a statement, for example `/goal fill in properties for a folder`. A bare `/goal` only shows usage. `30m` / `2h` prefixes are ignored.
- The assistant restates the done criteria and the round budget. It creates the goal after you agree. The bubble shows the command you typed.
- Only one incomplete goal at a time. A second one asks: drop the current goal, or keep it.
- To change the default round budget for **future** goals, use the config skill. To add rounds to **this** goal, raise this goal’s budget in chat. That does not change the global default.

**Continue**

- The goal stays with the vault across chats and restarts. The done criteria stay on the **bound chat** and survive compaction.
- The status bar and a strip above the input show in progress, paused, blocked, or budget exhausted. A new chat cannot see the criteria until you **take over** and bind the goal to this chat.
- If you granted a folder at creation, batch edits there ask less often. Pausing the goal revokes that grant. Stopping generation is not the same as pausing the goal.

**Finish**

- When the criteria are met, confirm in chat. The goal closes. There is no extra keep-or-drop prompt.
- The list is at the bottom of the status drawer (“Goals”), or Settings → Memory and permissions → **View goals** (pause, resume, drop, archive). Archive is only a manual action there.
- When rounds run out, it stops and asks: add rounds, pause, or drop. Hitting the round count is not “done”. Settings only keep the default round budget, a per-round token soft cap, and days before archive.

---

## 7. Memory

Say “remember that I prefer Tailwind” or “forget X”.

| Path | Contents |
|---|---|
| `.ratel/memory/global.md` | Global preferences, injected at start (about 20KB, then truncated). A heading with `[pinned]` (for example `## Output style [pinned]`) is never truncated |
| `.ratel/memory/topics/` | Topic memories. Each turn injects the most relevant names and summaries. The model fetches the full text when needed |
| `.ratel/memory/index.md` | Topic index |

These are plain Markdown. The storage cap is about 10MB. Memory is sent only to the model endpoint you configure.

Open it from the status drawer → **Memory**, or Settings → Memory and permissions → view memory.

The number of topics injected each turn is under Settings → Memory and permissions → **Related topics to inject** (0–10; 0 turns it off). “Hit N times” on a topic is how often it was injected.

---

## 8. Skills

Put a folder that contains `SKILL.md` in:

- the vault: `.ratel/skills/`
- global: `~/.ratel/skills/`
- or use a skill shipped with the plugin

**Installed means enabled.** The three sources merge at startup (a vault skill wins on the same name). Name the skill in chat.

Manage them from the status drawer → **Skills**:

- See installed skills, with a source badge (built-in / vault / global)
- Toggle one skill. It applies immediately and survives restart
- Read the full text
- Edit: a vault skill opens in Obsidian; a global skill opens in the file manager
- Delete: two confirmations. Built-in skills are read-only and update with the plugin

`SKILL.md` needs frontmatter (`name`, `description`, and so on) plus instructions. Prefer a `kebab-case` folder name.

### Scripts and references

| Folder | Contents | How the agent uses it |
|---|---|---|
| `scripts/` | JavaScript (`.js` / `.mjs` / `.cjs` only) | Runs when needed and returns the result |
| `references/` | Text such as templates and checklists | Read on demand (100KB per file) |

**Sandbox:** no network, no external modules. File access is limited to the current vault and that skill folder. A stuck script is stopped. Only JavaScript runs. For Python or a shell, configure an MCP server. A non-JavaScript file is not executed; the agent says why.

**First run asks.** The dialog names the skill, the script, and the folder. Three choices:

- **Allow and remember** — whitelist; no further prompt
- **Only this time**
- **Deny** (Escape or clicking the mask is the same) — skipped; the agent tries another way

**Two kinds of timeout.** A script that keeps reporting progress is not killed at the limit (default 30 seconds). The agent sees the progress and decides to wait or stop, and tells you. A script with no progress heartbeat past that limit is treated as stuck and stopped. After 10 seconds with no progress you see “still running (you can keep waiting)”. No script runs longer than 10 minutes. Change the stall timeout under Settings → Advanced → script unresponsive timeout (5–120 seconds). The agent can change it too.

**Circuit breaker.** Three failures in a row (stuck, over 10 minutes, or a crash; an agent-chosen stop does not count) disable the script and show a notice. The agent uses another method. Choosing **Allow and remember** again clears the failure count.

---

## 9. Slash commands and the command palette

Type `/` in chat:

| Command | Effect |
|---|---|
| `/new` | New chat |
| `/goal` | Long-running goal. See [§6](#6-long-running-goals) |
| `/compact` | Compress what is sent to the model. The chat transcript stays. Can run automatically (on by default) |
| `/model` | Show the current model |
| `/reindex` | Force a full reindex |

Type `@` to complete a vault note by name or path. The message keeps the `@relative/path` text and does not pre-read the file. You can also right-click a Markdown file → **Add to Ratel**. Do not paste an absolute path such as `/Users/…`.

Command palette (not in the `/` menu):

- `Ratel: Ask vault` / show index status
- Pause / resume automatic indexing
- Clear the index (dangerous; asks first)

---

## 10. Settings

**Settings → Ratel** has five tabs:

| Tab | Common items |
|---|---|
| **Chat model** | Language, preset (DeepSeek / Ollama / custom), model, API base, keychain status, auto-compact (on by default) |
| **Note index** | Embedding, chunking / auto-index, rerank. Markdown only. Images are not chunked as notes |
| **Memory and permissions** | Default goal rounds and “view goals”, memory switch and panel, daily-note convention, tool permission level, every tool including MCP |
| **Appearance** | Color mode (follow Obsidian / light / dark), accent swatches, mascot. Affects the Ratel panel only. Preview is immediate |
| **Advanced** | Context length, model registry, prompt overrides, memory capacity, developer options, diagnostics |

Diagnostics shows “last run”. After a white screen you can see which send stage it stopped on, plus RSS, heap, and external. Copying diagnostics from the drawer includes the last 40 breadcrumb lines and still no note text.

The status drawer opens **MCP**: add an HTTP or local-command server, or paste Claude / Cursor JSON. Turning a server on syncs its tools into chat. **Refresh** reconnects. MCP tools are marked in the timeline.

### API keys (keychain)

| Secret ID | Use |
|---|---|
| `ratel-mcp-<serverId>` | Environment variables for a stdio MCP server (for example an API token). `serverId` is the id on the manage page |
| `ratel-chat-openai-compatible` | Chat (DeepSeek and other OpenAI-compatible endpoints). Ollama usually needs none |
| `ratel-embed-openai-compatible` | Only when the embedding provider is an API |
| `ratel-rerank-bailian` | Optional Bailian rerank |

Add them under Obsidian **Settings → Keychain**, using the names above.

---

## 11. How to read the status

### Position rail

A column of dots on the right of the messages (it can move to the left) marks each question. Hover widens a dot and shows the first words. Click jumps to that turn. When you leave the bottom, ↓ returns to the latest message. The system scrollbar is hidden. You can turn the rail off in settings. It is not the context-usage percent on the status strip.

- **Input:** the send button is **↑**. While generating it becomes a red stop square. The permission level sits underneath. During an automatic retry the typing line says it will retry, how many seconds remain, or that it is retrying. That line disappears when text starts or you stop. It is not on the status strip.
- **Status strip:** a dot, ready or busy text, and context usage `%` on the right (green → yellow → red). While busy it can show together with the thinking orb. An incomplete goal stays visible: in progress (including a goal still bound to an older chat), paused, blocked, or out of rounds. Switching chats does not hide it. This chat does not also show a “keep going” capsule while the goal is idle. A capsule appears when you need to take over another chat, or to clear leftover goals that never started. Only one incomplete goal exists. There is no queue.
- **Open the strip:** index size, embedding type, context used/max and a bar, compact. The bottom opens goals, memory, MCP, and feedback.
- **Header:** title chip, ✎, and the model name. The usage percent is not repeated here.

If the API key is missing or the index is not ready, send is blocked and the strip says why.

Chat motion (can be turned off): the empty-state orb, word particles, a sweep on the header after the first message, the user-bubble outline, send sweep, menu entrance, and the usage-number transition. The busy thinking orb ignores this switch. The system “reduce motion” setting turns the decorations off.

Mascot (can be turned off): a draggable block in the message area. Its face follows busy or idle, and its eyes follow the pointer. With motion off, or with system reduce-motion on, the face stays still. Double-click returns it to the bottom right. Near the left or right edge it snaps gently.

---

## 12. Privacy

- Local index and local embeddings by default
- **The only network:** the model you configure, and optional embedding, rerank, and MCP endpoints
- No telemetry
- Crash breadcrumbs stay in the local plugin folder. On by default. Turn them off under Settings → Advanced → Developer
- Vault text is sent only to the endpoint you set

---

## 13. FAQ

| Question | Answer |
|---|---|
| Does `/compact` delete the chat? | No. It compresses what is sent to the model. Bubbles stay. It can also run automatically near the context limit (turn that off in settings) |
| Why 1.13.0+? | Keychain and the declarative settings API |
| Where is the key? | Obsidian Keychain, not `data.json` |
| Does every launch reindex everything? | No. Smart reindex uses a hash diff and skips unchanged files |
| `/reindex` versus automatic indexing? | `/reindex` clears and rebuilds. Everyday edits are incremental |
| I changed the embedding model and nothing happened | Restart Obsidian after changing embed or chunk settings |
| Mobile? | No. It needs the desktop file system |
| Does Ollama need the network? | Local inference does not |
| “This note” when nothing is open? | It says so. Find a path with search |
| Why doesn’t the daily-note tool create the file? | It only probes, so it does not create a note by accident. Ask it to write, or create the file yourself |
| I can’t select or copy an answer | The message area allows selection. Select the body, not the header controls |
| AI title summary failed | The summary request has thinking off. A truncated opening title is summarized again. If it really fails, edit with ✎ |
| Citation `[n]` is gray | It should follow the latest search in this chat. Hover should show a path. If it stays gray, run a search in this chat and try again |
| “Don’t ask again this session” still asks | A different tool name still asks. The same tool on another path should not. A new chat or `/new` clears the grant |
| `/goal` and the round budget | Confirm in chat, then create. Settings hold the **default** budget. Adding rounds raises this goal only |
| Does the goal survive a new chat? | Yes. The bar and the strip still show it. The new chat cannot see the criteria until you take over. Pausing removes it from this chat |
| MCP just turned on and shows no tools | Wait until enable finishes, then look again. **Refresh** forces a reconnect |
| Why won’t it fill in the API key? | Keys live in the Obsidian keychain. The agent can see whether one is set, not the secret. Add the secret ID under Settings → Keychain |
| What if a tool result is very long? | Text sent to the model is cut to 32,000 characters, keeping the start and the end. The chat bubble still shows the full text. When a long task continues, include the original task sentence |

More questions: [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues).

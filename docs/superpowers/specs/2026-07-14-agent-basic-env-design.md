# Agent 基础环境感知设计

> 日期: 2026-07-14  
> 状态: Active  
> 作者: Erwin（试用中发现 Agent 无当前时间）  
> 关联: 业界对照（Claude Code / Cursor / Obsidian MCP）+ Obsidian 官方 API（Workspace / MetadataCache）

---

## 1. 背景

Ratel Agent 已有 vault CRUD、语义搜索、memory、skill，但缺少**会话环境感知**：

- 不知「现在几点 / 今天几号」→ 写日记、相对时间、日程类问题会瞎猜  
- 不知「当前打开的笔记」→ 「改这篇」「总结当前」无法落地  

调研结论：知识库 Agent 普遍有 active note + daily + recent；时间多用 system 注入。对照 Obsidian 官方 API 后进一步确认：

- **`Workspace.getActiveFile` / 编辑器选区**：宿主有、Ratel **未包装** → 必做  
- **`CachedMetadata.headings`**：宿主有、`VaultMetadata` **未暴露** → outline 应用缓存，勿正则扫全文  
- **frontmatter / tags / links / backlinks**：`read_note` **已返回** → 不必再做独立工具  

## 2. 目标

- 每次对话注入准确本地时间  
- Agent 可查询时间、当前笔记、日记路径、最近修改、笔记大纲  
- 全部只读、默认 allow、不破坏「网络仅模型 API」约束  
- 优先包装「Obsidian 有、模型还摸不到」的能力，避免与 `read_note` 重复  

## 3. 非目标

- web_search / fetch_url / bash / 代码执行  
- 自动创建日记、改 Daily Notes 插件写 API  
- 独立 `get_backlinks` / `get_frontmatter` / `get_tags`（`read_note` 已带）  
- `rename_note` / `processFrontMatter` / `executeCommand`（写操作或 UI，另开）  
- Notice / Modal / Ribbon 等 UI API  

## 4. 设计决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 时间双通道 | system 注入（默认可见）+ `get_datetime`（精确/相对偏移） |
| 2 | WorkspacePort | 活动文件/选区与 Vault 文件 IO 分离；底层 `app.workspace.getActiveFile()` |
| 3 | 日记只探测 | `get_daily_note` 返回 path+exists，不创建文件 |
| 4 | 默认 allow | 新工具只读，写入权限模型不变 |
| 5 | outline 走缓存 | `get_note_outline` 用 `CachedMetadata.headings`，扩展 `VaultMetadata`，不 `cachedRead`+正则 |
| 6 | 不重复 read_note | 反链/出链/fm/tags 已在 `read_note`；需要图信息时先 `read_note` 即可 |

---

## 5. 工具一览

> 给审阅者看：每行先说**人话场景**，再写工具名与技术细节。

### Phase 1 — 必做

| 人话：什么时候用 | 工具 / 机制 | 它干什么 | 典型用户说法 | 主要入参 | 主要返回 |
|---|---|---|---|---|---|
| 每次开口都该知道「现在」 | **环境时间注入**（不是工具，塞进 system） | 把本机当前日期时间写进系统提示，模型不用猜「今天」 | 「今天星期几？」「本周总结」 | — | 一行文本，如 `当前本地时间: 2026-07-14 20:25 (Asia/Shanghai, 星期二)` |
| 要精确时间，或算「三天后」 | **`get_datetime`** | 按需查询当前（或偏移后）的日期时间 | 「现在几点？」「周五是几号？」 | `format?`（iso/local/full）；`offsetDays?`（±天数） | `iso` / `local` / `timezone` / `weekday` / `epochMs` |
| 用户说「这篇」「当前笔记」却没给路径 | **`get_active_note`** | 读 Obsidian 里**正在看的那篇**路径，可选带上选中文字和 frontmatter | 「总结当前这篇」「把选中内容改成列表」 | `includeSelection?`（默认 true）；`includeFrontmatter?`（默认 true） | `path`（无则 null）+ `selection?` + `frontmatter?`；无活动文件时友好说明，不抛错 |

### Phase 2 — 本 plan 含（可审阅后砍）

| 人话：什么时候用 | 工具 / 机制 | 它干什么 | 典型用户说法 | 主要入参 | 主要返回 |
|---|---|---|---|---|---|
| 找「今天的日记」在哪 | **`get_daily_note`** | 按约定文件夹+文件名格式**探测**日记路径是否存在（只读，不创建） | 「打开今天的日记」「把会议记到今日 daily」 | `date?`（`YYYY-MM-DD`，默认今天） | `path` / `exists` / `date` |
| 「最近改过啥」 | **`list_recent_notes`** | 按文件修改时间列出最近动过的 Markdown | 「我昨天下午改了哪些笔记？」 | `limit?`（默认 10，硬顶 50） | `[{ path, mtime, mtimeLocal }]` |
| 先看目录结构再决定读哪一节 | **`get_note_outline`** | 返回笔记**标题大纲**（H1–H6），省得先读全文 | 「这篇有哪些章节？」「大纲是什么？」 | `path`（必填） | `headings: [{ level, text, line }]`（数据来自 Obsidian `metadataCache.headings`） |

### 刻意不做的（避免和现有能力打架）

| 看起来像要做 | 为什么不做 |
|---|---|
| `get_backlinks` / `get_outgoing_links` / `get_frontmatter` | 现有 **`read_note`** 已返回 `backlinks` + `metadata.links` + `metadata.frontmatter` + `metadata.tags` |
| `search_by_tag` / `list_unresolved_links` | 有价值，但属「知识图整理」；标 **Phase 3** 另开 |
| `open_note`（在 UI 里打开某文件） | 改工作区焦点，偏交互；Agent 写路径即可 |
| `rename_note` / 改 frontmatter | 写操作 + 改链风险高，单独 plan |

---

## 6. 数据流

```
ask()
  → formatEnvContextLine(now) → ctx.setEnvContext(...)
  → Agent 默认已知「当前本地时间」
  → 精确/偏移 → get_datetime
  → 「当前这篇」→ get_active_note →（需要正文时）read_note
  → 「今天日记」→ get_daily_note →（exists 时）read_note
  → 「有哪些章」→ get_note_outline（不读全文）
  → 「最近改了啥」→ list_recent_notes
```

## 7. 与 Obsidian API 的对应

| 本设计 | Obsidian 来源 |
|---|---|
| `get_active_note` | `app.workspace.getActiveFile()` + `MarkdownView.editor.getSelection()` |
| `get_note_outline` | `app.metadataCache.getFileCache(file).headings` |
| `list_recent_notes` | `vault.getMarkdownFiles()` + `TFile.stat.mtime`（已有 `VaultPort.stat`） |
| `get_daily_note` | 路径约定 / 可选探测 Daily Notes 设置（只读） |
| 时间 | 运行时 `Date` + `Intl`（非 Obsidian API） |

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 时区与系统不一致 | 用运行时 `Intl` IANA，不硬编码 |
| 无活动文件 | 返回 `{ path: null, message }`，不抛错 |
| 日记路径因人而异 | 设置项 folder/format + 文档约定 |
| headings 缓存未就绪 | outline 返回空数组并提示可先 `read_note` |
| 工具过多稀释注意力 | Phase 1 仅注入 + 2 工具；Phase 2 可砍 |

## 9. 参考

- Obsidian Developer Docs：`Workspace.getActiveFile`、`CachedMetadata.headings`、`MetadataCache`  
- Claude Code / Cursor：时间靠注入或 shell；无 Obsidian 工作区概念  
- Obsidian MCP / note-agent：`get_active_note`、daily、recent、outline  

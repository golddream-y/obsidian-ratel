# Ratel 使用手册

> 面向日常使用。装好插件、配好模型后，按场景查即可。  
> 英文读者见文末 [English summary](#english-summary)。

---

## 1. 这是什么

Ratel 是 Obsidian 桌面端的 **vault AI Agent**：能问答、能多步翻笔记写综述，也能记住你的偏好。索引在本地跑，密钥进钥匙串；只有你配置的模型 API 会联网。

**适合**：知识库问答、写综述、整理最近笔记、扩展自定义 Skill。  
**不适合**：移动端、需要外网搜索 / Shell 的场景（本插件不做）。

---

## 2. 安装与五分钟上手

### 2.1 安装

1. Obsidian → **设置** → **社区插件** → 关闭安全模式  
2. **浏览** → 搜索 **Ratel** → 安装并启用  
3. 左侧出现 🦡 图标即成功

> 需要 Obsidian **1.13.0+**，**仅桌面端**。

### 2.2 第一次打开

1. **配对话模型**（设置 → Ratel → **对话模型**）  
   - 场景预设选 DeepSeek 或 Ollama，或自定义 Base / 模型  
   - DeepSeek：钥匙串添加 `ratel-chat-openai-compatible`；默认模型 `deepseek-v4-flash`  
   - Ollama：Base 指向 `http://localhost:11434/v1`（通常无需 Key）  
2. **等索引** — 输入区顶沿 StatusStrip 显示索引进度；可继续用 Obsidian  
3. 点侧栏 🦡（或命令面板 → `Ratel: Ask vault`）开始提问

默认嵌入是本地 ONNX，首次会下载模型（约几十 MB），之后离线可用。

### 2.3 界面语言

设置 → Ratel → **对话模型** → Language：`auto` / 中文 / English。UI 即时切换；命令面板里的命令名需重启 Obsidian 才刷新。

---

## 3. 日常怎么问

| 你想… | 可以这样说 | Ratel 大致会… |
|---|---|---|
| 查主题 | 「我写过哪些性能优化相关笔记？」 | `search_vault` → 引用 `[1][2]` → 可点开原文 |
| 读某一篇 | 「总结 `notes/xxx.md`」 | `read_note`（含 frontmatter / tags / 反链） |
| 今天几号 / 星期几 | 「今天星期几？」 | **通常不用调工具**（每轮已注入本地时间） |
| 精确时间 / 三天后 | 「三天后是几号？」 | `get_datetime` |
| 当前打开的这篇 | 「概括当前这篇」 | `get_active_note` → `read_note` |
| 打开某一篇 | 「打开那篇读书笔记」「跳到它的第二章」 | `open_note`（可定位标题 / 块，直接在 Obsidian 里翻开） |
| 最近改过什么 | 「最近改了哪些笔记？」 | `list_recent_notes` |
| 今天日记在哪 | 「今天日记在哪？」 | `get_daily_note`（只探测，**不自动创建**） |
| 章节大纲 | 「这篇有哪些标题？」 | `get_note_outline`（走标题缓存，不读全文） |
| 谁链到这篇 / 链到谁 | 「谁链到这篇？」「这篇链向哪里？」 | `get_links`（含未解析链接，可发现知识缺口） |
| 按标签找笔记 | 「找所有 `#project` 笔记」 | `search_by_tag`（支持嵌套标签前缀） |
| 按属性筛选 | 「找 `status: draft` 的笔记」 | `search_by_property`（不传 value 时查键是否存在） |
| 查看库概览 | 「库里有哪些标签和孤儿笔记？」 | `get_vault_structure`（可按目录 / 标签 / 孤儿笔记选择） |
| 写综述 / 整理 | 「把产品规划相关笔记整理成背景文档」 | 多步检索 → 读写（写前会按权限询问） |
| 帮我配置 / 排障 | 「帮我换个模型」「索引怎么不跑了」 | 内置 ratel-config skill → `get_app_config` 诊断 → 代改或 `open_settings` 引导（密钥只会引导去钥匙串，不会代填） |

流式回答时可以看到工具调用过程；支持 reasoning 的模型（如 DeepSeek-R1 / V4）会显示可折叠「思考」块。模型在想、在写、在调工具时，消息流里会用**思考球**（点阵小球）代替原来的小黄点。检索结果在回答下方以「来源 N 篇」折叠条展示，点开可跳转笔记；正文里若已有可点的 `[1][2]`，底部来源条会隐藏以免重复。

正文里的蓝色 `[1]`、`[7]` 是**本场最近一次检索**的结果序号（不是章节号）：悬停可看笔记路径，点击打开原文；多聊几轮之后编号仍可点。

对话正文、思考过程与工具详情可以**拖选复制**（顶栏与输入区仍不可误选）。

---

## 4. 多场会话

右上角 **短标题芯片**（时钟图标）打开最近列表：点进旧场、开「＋ 新对话」、悬停行可删除。关侧栏或重启后，会回到上次那一场。

| 你想… | 怎么做 |
|---|---|
| 改标题 | 芯片旁的 **✎** → 手改后保存，或点「AI 总结」让模型重起短标题 / 正常标题 |
| 生成中换场 / 新建 | 会先确认；确认后才会停止当前回复并切换（未完成内容标为已停止） |
| 工具「本次会话不再询问」 | 按**工具名**整场放行（同一工具读多篇笔记不再反复弹）；`/new` 或换场后清空 |

`/new` 与菜单「新对话」同一套逻辑：有内容的旧场留在列表；空白场不会堆一堆空对话。

### 工具权限档位

聊天输入下方可切换：**安全**（写/删询问） / **自动**（读写放行，删除仍确认） / **危险**（不再确认）。  
设置 → 记忆与权限 中有同一选项。单个工具设为「拒绝」时始终生效。

---

## 5. 日记约定

设置 → Ratel → **记忆与权限** → 日记约定：

| 项 | 默认 | 说明 |
|---|---|---|
| 日记文件夹 | （空 = vault 根） | 相对 vault 的路径 |
| 文件名格式 | `YYYY-MM-DD` | 支持 `YYYY` / `MM` / `DD` |

`get_daily_note` **只探测路径是否存在**，不会替你创建日记。不存在时让 Ratel 用 `write_note` 创建，或先自己建好文件。

---

## 6. 记忆

跟它说「记住我偏好 Tailwind」或「忘掉 X」即可。

| 位置 | 内容 |
|---|---|
| `.ratel/memory/global.md` | 全局偏好，启动时注入（约 20KB 截断）；段落标题加 `[pinned]`（如 `## 输出风格 [pinned]`）则永不截断 |
| `.ratel/memory/topics/` | 主题记忆；每轮自动注入最相关的几条（名称+摘要），完整内容由 AI 按需查询 |
| `.ratel/memory/index.md` | 主题索引 |

都是普通 Markdown，可直接编辑。总存储上限约 10MB。记忆只作对话上下文发往你配置的模型端点，不会单独上传第三方。

在聊天侧栏展开状态条 → 底部「记忆」，或设置 → 记忆与权限 → 查看记忆；在弹窗中浏览 / 编辑 / 清理模型记忆。

每轮自动注入的主题条数在 设置 → 记忆与权限 → **「自动注入相关主题数」** 调整（0–10，0 表示关闭，也可让 AI 代改）。记忆面板中每个主题显示的「命中 N 次」即该主题被自动带入对话的次数。

---

## 7. Skill（扩展能力）

把含 `SKILL.md` 的文件夹放到：

- vault：`.ratel/skills/`  
- 全局：`~/.ratel/skills/`  
- 或使用插件预置

**装了就生效**：启动时三源合并（库内同名优先），无需任何开关；对话里用自然语言点名技能即可。

管理入口：展开聊天侧栏的状态条 → 底部「技能」按钮，打开技能管理弹窗。可以：

- 查看已装技能，带来源徽标（预置 / vault 内 / 全局）
- 每个技能单独开关 — 立即生效、重启后保持
- 查看技能全文
- 编辑：vault 内技能直接打开；全局技能在系统文件管理器打开
- 删除：两击确认；预置技能只读，随插件更新

`SKILL.md` 需含 frontmatter（`name` / `description` 等）+ 正文指令；文件夹名建议 `kebab-case`。

### 技能附带脚本与参考资料

技能文件夹除了 `SKILL.md`，还可以带两个子目录：

| 子目录 | 内容 | AI 怎么用 |
|---|---|---|
| `scripts/` | JavaScript 脚本（仅 `.js` / `.mjs` / `.cjs`） | 需要时自动运行，结果带回对话 |
| `references/` | 参考文档（模板、清单等文本文件） | 按需读取（单文件上限 100KB） |

**沙箱隔离**：脚本在隔离环境中运行——无网络、不能加载外部模块，文件访问限于当前 vault 与该技能目录，卡死自动终止。只支持 JavaScript；需要 Python、Shell 等其他语言的能力时，请配置对应的 MCP server（非 JavaScript 脚本一律不执行，AI 会说明原因并引导）。

**首次运行需授权**：每个脚本第一次被运行时弹出「运行 Skill 脚本」确认框，写明技能名、脚本与来源目录。三个选择：

- **允许并记住** — 加入受信脚本白名单，之后不再询问
- **仅此次** — 只放行这一次
- **拒绝**（ESC 或点遮罩关闭同拒绝）— 本次不运行，AI 会换一种方式

**超时分两种情况**：持续上报进度的长任务脚本不会被一刀切杀掉——到超时时限（默认 30 秒）AI 会收到运行进度，由它判断继续等待还是终止，并告知你；完全无进展（无进度心跳）超过该时限则判定卡死、立即终止。运行超过 10 秒没有上报进度会先提示「仍在运行中（可继续等待）」；任何脚本最长运行 10 分钟（绝对上限）。超时时限可在 设置 → 高级 → 脚本无响应超时 调整（5–120 秒，AI 也可以代改）。

**熔断**：同一脚本连续失败 3 次（卡死终止、超过 10 分钟上限或崩溃；AI 主动终止不算）后不再执行，并弹出提醒，AI 会改用其他方式完成；恢复需重新确认授权——在授权框中选择「允许并记住」会同时清除失败计数。

---

## 8. 斜杠命令与命令面板

聊天输入 `/`：

| 命令 | 作用 |
|---|---|
| `/new` | 新对话 |
| `/compact` | 压缩发给模型的上下文，聊天记录全部保留；可自动（设置默认开） |
| `/model` | 查看当前模型配置 |
| `/reindex` | 强制全量重建索引 |

聊天输入 `@`：按文件名/路径补全库内笔记，发送时只保留 `@相对路径` 字面量（不预读全文）。也可在文件资源管理器右键 Markdown → **添加到 Ratel**。

命令面板（不在 `/` 菜单里）：

- `Ratel: Ask vault` / 显示索引状态  
- 暂停 / 恢复自动索引  
- 清空索引（危险，需确认）

---

## 9. 设置速查

打开 **设置 → Ratel** 即见顶栏五个 Tab：

| Tab | 常用项 |
|---|---|
| **对话模型** | 语言、场景预设（DeepSeek / Ollama / 自定义）、模型、API Base、钥匙串状态、自动压缩上下文（默认开） |
| **笔记索引** | Embedding、分块 / 自动索引、Rerank |
| **记忆与权限** | 记忆开关与面板、日记约定、工具权限档位、全部工具权限（含 MCP 工具） |
| **外观** | 颜色模式（跟随 Obsidian / 浅色 / 深色）、强调色色块（含铜 / Material 色）；仅影响 Ratel 面板，预览即时生效 |
| **高级** | Context Length、模型 registry、提示词覆盖、记忆容量、开发者选项、诊断 |

状态抽屉底部可打开 **MCP** 管理：添加 HTTP / 本地命令服务器，或粘贴 Claude / Cursor 的 JSON 导入。开关开启后会同步工具进对话；「刷新」强制重连。时间线里 MCP 工具带标识。

### API Key（钥匙串）

| secret ID | 用途 |
|---|---|
| `ratel-mcp-<serverId>` | stdio MCP Server 的环境变量(如 API token);serverId 为管理页里的服务器 ID |
| `ratel-chat-openai-compatible` | 对话（DeepSeek / OpenAI 兼容等）；Ollama 通常不需要 |
| `ratel-embed-openai-compatible` | 仅嵌入 provider = API 时 |
| `ratel-rerank-bailian` | 可选百炼重排 |

路径：Obsidian **设置 → 钥匙串**，按上表名称添加。

---

## 10. 状态怎么读

### 对话位置轨

消息区右侧（可改到左侧）有一列细点，对应各轮提问：悬停会加宽并显示前几字摘要，点击跳到该轮；离开底部时点 ↓ 回到最新。消息区系统滚动条已隐藏，用点列导航即可。设置里可关闭。与状态条上的上下文占用 % 不是同一回事。

- **输入区**：右侧发送钮是 **↑**；生成中变成红色停止方块。下方可切工具权限三档。
- **输入区顶沿 StatusStrip**：状态点 + 就绪/忙态文案 + 右侧上下文占用 `%`（绿 → 黄 → 红）；忙时可与消息流里的思考球一起出现
- **点开 Strip**：抽屉里看索引篇数、Embedding 类型、上下文 used/max 与进度条、压缩按钮；底部可进记忆 / MCP / 反馈等
- **Header**：短标题芯片（历史列表）+ ✎（编辑标题）+ 模型名（点击查看模型信息）；不再显示占用百分比

未配置 API Key 或索引未就绪时，发送会被挡住并在 Strip 提示原因。

聊天装饰动效（可关）：空态铜色能量球与轮换提示、词标粒子聚拢、有对话后顶栏残影再扫光、用户气泡描边、发送扫光、菜单入场、上下文占用数字过渡；忙态思考球不受此开关影响。系统「减少动态效果」开启时自动关闭。

---

## 11. 隐私

- 默认本地索引 + 本地嵌入  
- **唯一网络**：你配置的模型 /（可选）嵌入 API /（可选）Rerank  
- 无遥测、无匿名统计  
- 库内容只发往你填的端点  

---

## 12. FAQ

| 问题 | 回答 |
|---|---|
| `/compact` 会删聊天吗？ | 不会。只压缩发给模型的上下文，气泡全部保留；上下文接近上限时也会自动压（设置可关） |
| 为什么要 1.13.0+？ | 钥匙串 + 声明式设置 API |
| Key 存在哪？ | Obsidian Keychain，不进 `data.json` |
| 每次启动都全量索引？ | 否。smart reindex 用 hash diff，未改文件跳过 |
| `/reindex` 和自动索引？ | `/reindex` 清索引后全量；日常改笔记走增量 |
| 改了嵌入模型没生效？ | 改 embed / 分块后重启 Obsidian |
| 支持手机？ | 否（桌面 Node fs） |
| Ollama 要联网吗？ | 本地推理不需要 |
| 「当前笔记」没打开？ | 会友好说明；用 glob / search 找路径即可 |
| 日记工具为什么不创建？ | 只读探测，避免误建；创建请明示或用写工具 |
| 选不中 / 复制不了回答？ | 消息区已允许选择；若仍不行，确认选的是正文而非顶栏控件 |
| AI 总结标题失败？ | 总结请求已关 thinking。若只是开场白截断的临时标题，仍会再跑总结；真正失败时可手改 ✎ |
| 引用 `[n]` 变灰点不开？ | 应沿用本场最近一次检索；悬停应能看到路径。若仍灰，确认本场做过检索后再试 |
| 「本次会话不再询问」还弹？ | 换工具名仍会问；同工具不同路径不应再问。换场或 `/new` 后授权清空 |
| 刚开 MCP 显示无工具？ | 等开启完成后再看列表；可点「刷新」强制重连 |
| 为什么不帮我填 API Key？ | 密钥只存 Obsidian 钥匙串，Agent 只能看到「配没配」，拿不到也填不了明文；照提示去 设置 → 钥匙串 添加对应 secret ID |
| 工具输出特别长会怎样？ | 发给模型的正文截到 3.2 万字符以内（保留头尾要点）；聊天气泡里仍是全文。长任务续跑时最好带上任务原句 |

更多问题可开 [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## English summary

**Install:** Obsidian → Community plugins → Browse → search **Ratel** → Install & Enable (desktop, 1.13.0+).

**First run:** Configure chat model (+ Keychain `ratel-chat-openai-compatible`, or local Ollama). Wait for indexing. Open chat via the 🦡 ribbon.

**Ask naturally:** topics → semantic search with citations; “today” → injected local time; “this note” → active file; “open that note” → opens it in Obsidian at the heading or block; daily note path is probed only (never auto-created). Config questions go through the built-in config skill (whitelisted changes by chat; keys only via the keychain). Memory lives in `.ratel/memory/`. Skills live under `.ratel/skills/` (or `~/.ratel/skills/`) — installed means enabled (vault wins on name conflicts). Manage them via the Skills button in the status drawer: per-skill toggle (persists across restarts), view full text, edit, or delete with double confirmation; built-ins are read-only and update with the plugin. A skill folder may also ship `scripts/` (sandboxed JavaScript — no network, file access limited to the vault and the skill folder) and `references/` docs the agent runs or reads on demand; each script asks approval on first run (“Always allow” remembers); scripts that keep reporting progress are not killed at the timeout — the agent gets their progress and decides to keep waiting or stop them (stalled scripts with no progress heartbeat are terminated after the timeout, default 30s, configurable 5–120s; absolute cap 10 minutes), and a script failing 3 times in a row (stalled, over the cap, or crashed) is circuit-broken until re-approved.

**Sessions:** Header chip opens recent chats; ✎ edits / AI-summarizes the title. Switching while generating asks first. “Allow for this session” grants by tool name for the whole chat.

**Privacy:** No telemetry. Network only to the model (and optional embed/rerank/MCP) endpoints you configure.

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
2. **等索引** — 底部状态条显示索引进度；可继续用 Obsidian  
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
| 最近改过什么 | 「最近改了哪些笔记？」 | `list_recent_notes` |
| 今天日记在哪 | 「今天日记在哪？」 | `get_daily_note`（只探测，**不自动创建**） |
| 章节大纲 | 「这篇有哪些标题？」 | `get_note_outline`（走标题缓存，不读全文） |
| 谁链到这篇 / 链到谁 | 「谁链到这篇？」「这篇链向哪里？」 | `get_links`（含未解析链接，可发现知识缺口） |
| 按标签找笔记 | 「找所有 `#project` 笔记」 | `search_by_tag`（支持嵌套标签前缀） |
| 按属性筛选 | 「找 `status: draft` 的笔记」 | `search_by_property`（不传 value 时查键是否存在） |
| 查看库概览 | 「库里有哪些标签和孤儿笔记？」 | `get_vault_structure`（可按目录 / 标签 / 孤儿笔记选择） |
| 写综述 / 整理 | 「把产品规划相关笔记整理成背景文档」 | 多步检索 → 读写（写前会按权限询问） |

流式回答时可以看到工具调用过程；支持 reasoning 的模型（如 DeepSeek-R1）会显示可折叠「思考」块。

---

## 4. 日记约定

设置 → Ratel → **记忆与权限** → 日记约定：

| 项 | 默认 | 说明 |
|---|---|---|
| 日记文件夹 | （空 = vault 根） | 相对 vault 的路径 |
| 文件名格式 | `YYYY-MM-DD` | 支持 `YYYY` / `MM` / `DD` |

`get_daily_note` **只探测路径是否存在**，不会替你创建日记。不存在时让 Ratel 用 `write_note` 创建，或先自己建好文件。

---

## 5. 记忆

跟它说「记住我偏好 Tailwind」或「忘掉 X」即可。

| 位置 | 内容 |
|---|---|
| `.ratel/memory/global.md` | 全局偏好，启动时注入（约 20KB 截断） |
| `.ratel/memory/topics/` | 主题记忆，相关时再检索 |
| `.ratel/memory/index.md` | 主题索引 |

都是普通 Markdown，可直接编辑。总存储上限约 10MB。记忆只作对话上下文发往你配置的模型端点，不会单独上传第三方。

侧栏可开「记忆」面板查看 / 编辑（设置里也可入口）。

---

## 6. Skill（扩展能力）

把含 `SKILL.md` 的文件夹放到：

- vault：`.ratel/skills/`  
- 全局：`~/.ratel/skills/`  
- 或使用插件预置

启动时三源合并。对话里 `/skill <name>` 激活，`/skills` 列表，`/skill off <name>` 关闭。设置里可总开关 `enableSkills`。

`SKILL.md` 需含 frontmatter（`name` / `description` 等）+ 正文指令；文件夹名建议 `kebab-case`。

---

## 7. 斜杠命令与命令面板

聊天输入 `/`：

| 命令 | 作用 |
|---|---|
| `/new` | 新对话 |
| `/compact` | 压缩上下文 |
| `/model` | 查看当前模型配置 |
| `/reindex` | 强制全量重建索引 |
| `/skill` / `/skills` / `/skill off` | Skill 激活 / 列表 / 关闭 |

聊天输入 `@`：按文件名/路径补全库内笔记，发送时只保留 `@相对路径` 字面量（不预读全文）。也可在文件资源管理器右键 Markdown → **添加到 Ratel**。

命令面板（不在 `/` 菜单里）：

- `Ratel: Ask vault` / 显示索引状态  
- 暂停 / 恢复自动索引  
- 清空索引（危险，需确认）

---

## 8. 设置速查

打开 **设置 → Ratel** 即见顶栏四个 Tab：

| Tab | 常用项 |
|---|---|
| **对话模型** | 语言、场景预设（DeepSeek / Ollama / 自定义）、模型、API Base、钥匙串状态 |
| **笔记索引** | Embedding、分块 / 自动索引、Rerank |
| **记忆与权限** | 记忆开关与面板、Skills、日记约定、信任模式、全部工具权限 |
| **高级** | Context Length、模型 registry、提示词覆盖、记忆容量、开发者选项、诊断 |

### API Key（钥匙串）

| secret ID | 用途 |
|---|---|
| `ratel-chat-openai-compatible` | 对话（DeepSeek / OpenAI 兼容等）；Ollama 通常不需要 |
| `ratel-embed-openai-compatible` | 仅嵌入 provider = API 时 |
| `ratel-rerank-bailian` | 可选百炼重排 |

路径：Obsidian **设置 → 钥匙串**，按上表名称添加。

---

## 9. 状态怎么读

- **底部状态点**：就绪 / 思考 / 索引 / 错误 / 未配置  
- **Chat Header**：上下文占用百分比（绿 → 黄 → 红）  
- **输入框下方 work 条**：索引中 / 下载模型 / 搜索中等  

未配置 API Key 或索引未就绪时，发送会被挡住并提示原因。

---

## 10. 隐私

- 默认本地索引 + 本地嵌入  
- **唯一网络**：你配置的模型 /（可选）嵌入 API /（可选）Rerank  
- 无遥测、无匿名统计  
- 库内容只发往你填的端点  

---

## 11. FAQ

| 问题 | 回答 |
|---|---|
| 为什么要 1.13.0+？ | 钥匙串 + 声明式设置 API |
| Key 存在哪？ | Obsidian Keychain，不进 `data.json` |
| 每次启动都全量索引？ | 否。smart reindex 用 hash diff，未改文件跳过 |
| `/reindex` 和自动索引？ | `/reindex` 清索引后全量；日常改笔记走增量 |
| 改了嵌入模型没生效？ | 改 embed / 分块后重启 Obsidian |
| 支持手机？ | 否（桌面 Node fs） |
| Ollama 要联网吗？ | 本地推理不需要 |
| 「当前笔记」没打开？ | 会友好说明；用 glob / search 找路径即可 |
| 日记工具为什么不创建？ | 只读探测，避免误建；创建请明示或用写工具 |

更多问题可开 [GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

---

## English summary

**Install:** Obsidian → Community plugins → Browse → search **Ratel** → Install & Enable (desktop, 1.13.0+).

**First run:** Configure chat model (+ Keychain `ratel-chat-openai-compatible`, or local Ollama). Wait for indexing. Open chat via the 🦡 ribbon.

**Ask naturally:** topics → semantic search with citations; “today” → injected local time; “this note” → active file; daily note path is probed only (never auto-created). Memory lives in `.ratel/memory/`. Skills live under `.ratel/skills/` (or `~/.ratel/skills/`).

**Privacy:** No telemetry. Network only to the model (and optional embed/rerank) endpoints you configure.

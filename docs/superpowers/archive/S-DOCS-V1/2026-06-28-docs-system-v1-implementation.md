# 文档体系 v1 实施计划 / Docs System v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 S-DOCS-V1 spec 重构 README、新建 CHANGELOG.md 与 docs/user-guide.md、补 screenshots 占位目录、修复 versions.json 历史遗留 bug,并登记 STATUS.md。

**Architecture:** 纯文档工作,不涉及代码改动。每个 Task 产出一份完整文件或修复一处事实错误,独立可验证。验证方式:文件存在 + 内容符合 spec 章节 + markdown 链接路径有效 + git commit 遵循 Conventional Commits。

**Tech Stack:** Markdown、git。无构建/测试依赖。

**关联 Spec:** [docs/superpowers/specs/2026-06-28-docs-system-v1-design.md](../specs/2026-06-28-docs-system-v1-design.md)

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `README.md` | 完全重写 | 商店详情页风格,双语,纯用户向 |
| `CHANGELOG.md` | 新建 | Keep a Changelog 1.1.0,双语(中文正文 + 英文摘要) |
| `docs/user-guide.md` | 新建 | 单文件双语用户手册 |
| `docs/screenshots/.gitkeep` | 新建 | 占位目录,发版前补 GIF |
| `versions.json` | 修复 | `"0.1.0": "1.0.0"` → `"0.1.0": "1.11.4"`(与 minAppVersion 一致) |
| `docs/superpowers/STATUS.md` | 修改 | Plan 执行完成后状态更新 |

---

## Task 1: 创建 docs/screenshots 占位目录

**Files:**
- Create: `docs/screenshots/.gitkeep`

- [ ] **Step 1: 创建 .gitkeep 占位文件**

```bash
mkdir -p docs/screenshots
```

文件内容 `docs/screenshots/.gitkeep`:

```
# 此目录存放 README 嵌入的录屏 GIF 与截图。
# 0.1.0 发版前补:chat-demo.gif / index-status.gif / diagnostics.gif
```

- [ ] **Step 2: 验证目录与文件存在**

Run: `ls -la docs/screenshots/.gitkeep`
Expected: 文件存在

- [ ] **Step 3: Commit**

```bash
git add docs/screenshots/.gitkeep
git commit -m "docs(s-docs-v1): 新增 screenshots 占位目录"
```

---

## Task 2: 修复 versions.json 历史遗留 bug

**Files:**
- Modify: `versions.json`

**背景:** `manifest.json` 的 `minAppVersion` 是 `1.11.4`(因用了 SecretStorage API),但 `versions.json` 当前是 `"0.1.0": "1.0.0"`,不一致。这会导致旧版 Obsidian 用户尝试安装时回退到错误版本。

- [ ] **Step 1: 读取当前 versions.json 确认状态**

Run: `cat versions.json`
Expected:
```json
{
	"0.1.0": "1.0.0"
}
```

- [ ] **Step 2: 修复 minAppVersion 与 manifest.json 一致**

修改 `versions.json` 为:

```json
{
	"0.1.0": "1.11.4"
}
```

- [ ] **Step 3: 验证与 manifest.json minAppVersion 一致**

Run: `grep minAppVersion manifest.json && cat versions.json`
Expected: 两者都是 `1.11.4`

- [ ] **Step 4: Commit**

```bash
git add versions.json
git commit -m "fix(release): versions.json minAppVersion 与 manifest 对齐 1.11.4

修复历史遗留:versions.json 写的是 1.0.0,但 manifest minAppVersion 是 1.11.4
(SecretStorage API 要求)。不一致会导致旧版 Obsidian 用户错误回退。"
```

---

## Task 3: 创建 CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

**内容来源:** spec § 6.1。0.1.0 条目从当前已实现功能梳理(spec § 6.1 已列出)。日期用 `2026-06-28`(首次创建日期,非实际 release 日期;实际 release 时由工作流更新)。

- [ ] **Step 1: 写入 CHANGELOG.md 完整内容**

文件内容 `CHANGELOG.md`:

```markdown
# 更新日志 / Changelog

本项目遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
本文件由 AI 从 Conventional Commits 生成草稿,开发者确认后合入。详见[生成规则](docs/superpowers/specs/2026-06-28-docs-system-v1-design.md)。

## [Unreleased]

### Added
- (待发版时由 AI 填充)

## [0.1.0] - 2026-06-28

### Added
- **问答 vault** — 自然语言提问,流式回答带引用
- **多步闭环** — Agent Loop 自动检索多篇笔记生成综述,MAX_STEPS 默认 50 可配置
- **混合检索** — 向量召回 + BM25 全文匹配 + Backlinks 增强
- **本地 ONNX 嵌入** — Web Worker 子线程推理,主线程零阻塞,批量处理 maxBatchSize=16
- **DeepSeek / Claude / Ollama** 三模型适配器,流式输出支持思考过程(DeepSeek reasoning_content)
- **SecretStorage 密钥管理** — Obsidian 1.11.4+ 钥匙串,API Key 不出现在 data.json
- **状态条** — 模型/索引状态 + 上下文使用率 + token 数据源指示(估算/流式/API)
- **诊断面板** — 模型连接 / 嵌入健康 / 索引状态 / 工具权限自查
- **斜杠命令** — `/new` `/compact` `/model` `/reindex`
- **中文界面 + i18n 框架**
- **工具权限** — read_note / write_note / delete_note 的 allow / ask / deny 配置
- **三产物构建** — main.js + worker.js + embedding-worker.js

### Known Limitations
- 仅桌面端(依赖 Node.js fs)
- 索引大 vault(>5000 笔记)首扫较慢
- Claude adapter 未接 thinking blocks(仅 DeepSeek 接入 reasoning_content)

**English summary:** Initial public release. Chat with vault, multi-step agent loop (MAX_STEPS=50), hybrid retrieval (vector + BM25 + backlinks), local ONNX embedding in Web Worker with batch processing, three model adapters (DeepSeek/Claude/Ollama) with reasoning_content support, SecretStorage key management, status line with token source indicator, diagnostics panel, slash commands, i18n framework, tool permissions, three-artifact build.
```

- [ ] **Step 2: 验证文件存在且内容完整**

Run: `head -5 CHANGELOG.md && echo "---" && wc -l CHANGELOG.md`
Expected: 文件存在,行数 > 20

- [ ] **Step 3: 验证 markdown 链接路径有效**

Run: `grep -oE '\(([^)]+)\)' CHANGELOG.md | grep -v '^http' | xargs -I{} ls {}`
Expected: spec 文件存在(`docs/superpowers/specs/2026-06-28-docs-system-v1-design.md`)

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(s-docs-v1): 新建 CHANGELOG.md(Keep a Changelog 1.1.0)

- 0.1.0 条目覆盖已实现功能(问答/多步/检索/嵌入/三模型/SecretStorage 等)
- Unreleased 空块待发版时填充
- 双语:中文正文 + 每版本块末尾英文摘要"
```

---

## Task 4: 创建 docs/user-guide.md

**Files:**
- Create: `docs/user-guide.md`

**内容来源:** spec § 7.3。双语(中文 + 英文,`<hr>` 分隔)。只写已实现功能,Link Suggestions 不写。

- [ ] **Step 1: 写入 user-guide.md 中文部分**

文件内容 `docs/user-guide.md`(中文部分):

```markdown
# Ratel 使用手册 / User Guide

## 一、配置 — 让 Ratel 跑起来

### 1.1 安装

- **商店安装**(上架后):Obsidian → 设置 → 社区插件 → 浏览 → 搜索 "Ratel" → 安装并启用
- **BRAT 安装**(上架前):安装 BRAT 插件 → BRAT 设置 → Add → 填入仓库地址

### 1.2 首次启动

- 启用插件后自动扫描 vault → 生成索引
- 状态条显示"索引中" + 进度,期间可正常用 Obsidian(索引在后台 Worker 执行)
- 索引完成 → 状态条变"就绪"

### 1.3 配置对话模型(三选一)

- **DeepSeek**:Endpoint `https://api.deepseek.com` + 模型名 + Max Tokens(点"测试连接"自动探测)
- **Claude**:Endpoint `https://api.anthropic.com` + 模型名
- **本地 Ollama**:Endpoint `http://localhost:11434` + 模型名(无需 API Key)
- API Key 配置:Obsidian 设置 → Keychain → 用固定 secret ID 添加(详见 1.6)

### 1.4 配置嵌入模型

- **默认本地 ONNX**(零配置,首次自动下载模型,Web Worker 子线程推理)
- 可选 API 嵌入:设置 → Embedding → 切 provider 为 `api` + 配置端点
- 模型管理:设置面板可查看 / 切换 / 删除已下载的本地模型

### 1.5 (可选)配置 Reranker

- 仅百炼 API 可选,提升搜索精度
- Keychain 添加 `ratel-rerank-bailian` 即自动启用,不配则纯向量 + BM25 检索

### 1.6 API Key 清单

用户在 Obsidian 设置 → Keychain 中按以下固定 secret ID 录入密钥:

| secret ID | 用途 | 必需? |
|---|---|---|
| `ratel-chat-openai-compatible` | 对话模型 API Key(DeepSeek / OpenAI / 硅基流动等) | 远端模型必需,Ollama 不需要 |
| `ratel-embed-openai-compatible` | API 嵌入 Key | 仅 provider=api 时必需 |
| `ratel-rerank-bailian` | 百炼 Reranker Key | 可选 |

## 二、日常使用 — 与 vault 对话

### 2.1 打开聊天

- 侧边栏 🦡 图标
- 或命令面板 `Cmd+P`(macOS)/ `Ctrl+P`(Windows)→ 输入 "Ratel: Ask vault"
- 命令面板还能触发 "Ratel: Show index status" 查看索引状态

### 2.2 基础问答

- 输入问题 → 流式回答
- 引用标记可点击跳转源笔记
- 上下文使用率在状态条实时显示

### 2.3 多步任务

- 描述复杂任务:"帮我研究 X 主题,写一份综述"
- Ratel 自动多步检索 → 工具调用 → 生成 → 写入新笔记
- 工具调用过程可视化(可展开看 args / result)
- MAX_STEPS 默认 50,超出会提示任务过长

### 2.4 思考过程

- 支持 reasoning 能力的模型(如 DeepSeek-R1)会展示思考过程
- 以可折叠"思考"块呈现,流式中默认展开,完成后自动折叠
- 点击可手动展开查看完整推理

### 2.5 斜杠命令

输入 `/` 触发菜单:

| 命令 | 作用 |
|---|---|
| `/new` | 开始新对话,清空当前上下文 |
| `/compact` | 压缩上下文,将历史总结为摘要 |
| `/model` | 切换模型 |
| `/reindex` | 重新索引 vault |

### 2.6 状态条解读

- **状态点**:就绪(绿)/ 思考中(黄脉冲)/ 索引中(黄脉冲)/ 错误(红)/ 未配置(空心)
- **上下文使用率**:0-79% 绿 / 80-94% 黄 / 95-100% 红
- **数据源指示**:估算(灰)/ 流式(黄)/ API(绿)— 反映 token 统计可信度
- 点击状态条展开详情抽屉

### 2.7 工具权限与确认

- Ratel 读写笔记前会询问(默认 ask 模式)
- 可在设置 → Tool permissions 改为 allow / ask / deny
- trustMode 开启后跳过询问(谨慎使用)

### 2.8 诊断与故障排查

- 命令面板 → "Ratel: Show index status" 或设置面板入口
- 三项自查:模型连接 / 嵌入健康 / 索引状态
- 出错时查看诊断面板的具体错误信息

### 2.9 FAQ

| 问题 | 回答 |
|---|---|
| 为什么必须 Obsidian 1.11.4+? | 用了 SecretStorage API 存密钥 |
| API Key 存哪了? | Obsidian Keychain,不出现在 data.json |
| 索引大 vault 很慢? | 首扫在 Worker 后台,可继续用 Obsidian |
| 用 Ollama 需要联网吗? | 不需要,纯本地推理 |
| 支持移动端吗? | 暂不支持(依赖 Node.js fs) |
| 数据上传到哪? | 仅模型 API 端点,Ollama 模式零外发 |
| 思考段只有 DeepSeek 有? | 当前已接入 DeepSeek,其他 reasoning 模型视 adapter 实现支持 |

---

# Ratel User Guide (English)

## 1. Setup — Get Ratel Running

### 1.1 Installation

- **Store install** (once listed): Obsidian → Settings → Community plugins → Browse → search "Ratel" → Install & Enable
- **BRAT install** (pre-listing): Install BRAT plugin → BRAT settings → Add → enter repo URL

### 1.2 First Launch

- On enable, automatically scans vault → builds index
- Status bar shows "Indexing" + progress; you can keep using Obsidian (indexing runs in background Worker)
- Index complete → status bar shows "Ready"

### 1.3 Configure Chat Model (pick one)

- **DeepSeek**: Endpoint `https://api.deepseek.com` + model name + Max Tokens (click "Test connection" to auto-detect)
- **Claude**: Endpoint `https://api.anthropic.com` + model name
- **Local Ollama**: Endpoint `http://localhost:11434` + model name (no API key needed)
- API key setup: Obsidian Settings → Keychain → add with fixed secret ID (see 1.6)

### 1.4 Configure Embedding Model

- **Default local ONNX** (zero config, auto-downloads model on first use, runs in Web Worker thread)
- Optional API embedding: Settings → Embedding → switch provider to `api` + configure endpoint
- Model management: settings panel lets you view / switch / delete downloaded local models

### 1.5 (Optional) Configure Reranker

- Optional Bailian API only, improves search precision
- Add `ratel-rerank-bailian` in Keychain to auto-enable; without it, pure vector + BM25 retrieval

### 1.6 API Key List

Users add keys in Obsidian Settings → Keychain using these fixed secret IDs:

| secret ID | purpose | required? |
|---|---|---|
| `ratel-chat-openai-compatible` | Chat model API key (DeepSeek / OpenAI / SiliconFlow etc.) | Required for remote models, not needed for Ollama |
| `ratel-embed-openai-compatible` | API embedding key | Only when provider=api |
| `ratel-rerank-bailian` | Bailian reranker key | Optional |

## 2. Daily Use — Chat with Your Vault

### 2.1 Open Chat

- Sidebar 🦡 icon
- Or command palette `Cmd+P` (macOS) / `Ctrl+P` (Windows) → type "Ratel: Ask vault"
- Command palette also offers "Ratel: Show index status" to view index state

### 2.2 Basic Q&A

- Type a question → streaming response
- Citation markers are clickable to jump to source note
- Context usage shows in real-time on status bar

### 2.3 Multi-step Tasks

- Describe a complex task: "Research topic X, write a survey"
- Ratel auto multi-step retrieves → tool calls → generates → writes new note
- Tool call process is visualized (expandable to view args / result)
- MAX_STEPS defaults to 50; exceeding prompts task too long

### 2.4 Reasoning Process

- Models with reasoning capability (e.g. DeepSeek-R1) show their thinking
- Collapsible "thinking" block; expanded by default during streaming, auto-collapses when done
- Click to manually expand and view full reasoning

### 2.5 Slash Commands

Type `/` to trigger menu:

| command | effect |
|---|---|
| `/new` | Start new conversation, clear current context |
| `/compact` | Compress context, summarize history |
| `/model` | Switch model |
| `/reindex` | Re-index vault |

### 2.6 Status Bar Reading

- **Status dot**: ready (green) / thinking (yellow pulse) / indexing (yellow pulse) / error (red) / unconfigured (hollow)
- **Context usage**: 0-79% green / 80-94% yellow / 95-100% red
- **Source indicator**: estimate (gray) / streaming (yellow) / API (green) — reflects token stats credibility
- Click status bar to expand detail drawer

### 2.7 Tool Permissions & Confirmation

- Ratel asks before reading/writing notes (default ask mode)
- Change to allow / ask / deny in Settings → Tool permissions
- trustMode skips prompts (use with caution)

### 2.8 Diagnostics & Troubleshooting

- Command palette → "Ratel: Show index status" or settings panel entry
- Three self-checks: model connection / embedding health / index state
- On errors, view detailed error info in diagnostics panel

### 2.9 FAQ

| question | answer |
|---|---|
| Why requires Obsidian 1.11.4+? | Uses SecretStorage API for key storage |
| Where is API key stored? | Obsidian Keychain, not in data.json |
| Indexing large vault is slow? | First scan runs in background Worker; you can keep using Obsidian |
| Does Ollama need internet? | No, fully local inference |
| Mobile support? | Not yet (depends on Node.js fs) |
| Where does data go? | Only to model API endpoint; Ollama mode has zero outbound |
| Is thinking block DeepSeek-only? | Currently DeepSeek is integrated; other reasoning models depend on adapter implementation |
```

- [ ] **Step 2: 验证文件存在且内容完整**

Run: `wc -l docs/user-guide.md && head -3 docs/user-guide.md && echo "---" && grep -c "^## " docs/user-guide.md`
Expected: 行数 > 100,顶部标题正确,二级标题数 ≥ 4(中文 2 + 英文 2)

- [ ] **Step 3: 验证斜杠命令清单与代码一致**

Run: `grep -oE "'/[a-z]+'" src/ui/chat/input/slash-commands.ts | sort -u`
Expected:
```
'/compact'
'/model'
'/new'
'/reindex'
```

对比 `docs/user-guide.md` 中的斜杠命令表,四个命令名必须完全一致。

- [ ] **Step 4: 验证 API Key secret ID 与代码一致**

Run: `grep -oE "ratel-[a-z-]+" src/secrets/ratel-secrets.ts | sort -u`
Expected:
```
ratel-chat-ollama
ratel-chat-openai-compatible
ratel-embed-ollama
ratel-embed-openai-compatible
ratel-rerank-bailian
```

`docs/user-guide.md` 中的 secret ID 表必须包含 `ratel-chat-openai-compatible`、`ratel-embed-openai-compatible`、`ratel-rerank-bailian` 三个(另外两个 ollama 是预留,手册不写)。

- [ ] **Step 5: 验证手册无未实现功能**

Run: `grep -iE "link suggest|auto.?suggest.?link|learner|主动提醒|自动学经验" docs/user-guide.md`
Expected: 无匹配(Link Suggestions 设置项存在但未接线,Learner/主动提醒/自动学经验未实现)

- [ ] **Step 6: Commit**

```bash
git add docs/user-guide.md
git commit -m "docs(s-docs-v1): 新建用户使用手册(单文件双语)

- 中文在前英文在后,hr 分隔
- 配置 6 节(安装/启动/对话模型/嵌入/Reranker/API Key 清单)
- 日常使用 9 节(打开聊天/问答/多步/思考/斜杠/状态条/权限/诊断/FAQ)
- 只写已实现功能,Link Suggestions 不写
- secret ID 与 src/secrets/ratel-secrets.ts 实际定义一致
- 斜杠命令与 src/ui/chat/input/slash-commands.ts 实际定义一致"
```

---

## Task 5: 重构 README.md

**Files:**
- Modify: `README.md`(完全重写)

**内容来源:** spec § 5.2。双语,删除清单见 spec § 5.3。

- [ ] **Step 1: 写入 README.md 完整内容**

文件内容 `README.md`:

```markdown
# Ratel — Obsidian AI Agent

> 让 Obsidian vault 变成可对话、可检索、可治理的第二大脑。
> 隐私优先,支持本地 Ollama,零服务零终端。

## 它能做什么

- **问答 vault** — 自然语言提问,带引用带来源
- **多步闭环** — 自动检索多篇笔记,生成综述写入新笔记
- **混合检索** — 向量召回 + BM25 + Backlinks 增强
- **增量索引** — 文件变更毫秒级响应,后台 Worker 不阻塞主线程

## 演示

![chat-demo](docs/screenshots/chat-demo.gif)

## 安装

1. Obsidian → 设置 → 社区插件 → 浏览 → 搜索 "Ratel"
2. 安装并启用
3. 设置 → Ratel → 配置模型(DeepSeek / Claude / 本地 Ollama,任选其一)
4. 首次启动自动扫描 vault 生成索引
5. 侧边栏 🦡 图标开始使用

> 商店未上架前,可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安装。

## 隐私

- 数据全部本地存储
- 模型 API 是唯一外发通道,使用 Ollama 则零外发
- API Key 存储于 Obsidian 1.11.4+ SecretStorage,不出现在配置文件中
- 无遥测、无数据收集

## 文档

- [使用手册](docs/user-guide.md)
- [架构设计](docs/ARCHITECTURE.md)(开发者向)
- [更新日志](CHANGELOG.md)

## 反馈

- [GitHub Issues](https://github.com/golddream-y/ratel-vault/issues):提交 bug 或 feature request
- 使用前请先查阅[使用手册 FAQ](docs/user-guide.md#29-faq)

## 不做什么

- 不做独立服务(纯插件,装了就用)
- 不做云服务 SaaS(数据本地优先)
- 不做协作 / 多用户 / 团队功能
- 不做笔记编辑器(Obsidian 自带)
- 不用 native 模块(零 ABI 兼容风险)

---

# Ratel — Obsidian AI Agent (English)

> Turn your Obsidian vault into a queryable, searchable, curatable second brain.
> Privacy-first, supports local Ollama, zero service, zero terminal.

## What It Does

- **Chat with vault** — Ask questions in natural language, with citations and sources
- **Multi-step closure** — Auto-retrieves multiple notes, generates surveys, writes new notes
- **Hybrid retrieval** — Vector recall + BM25 + Backlinks boost
- **Incremental indexing** — Millisecond response to file changes, background Worker doesn't block main thread

## Demo

![chat-demo](docs/screenshots/chat-demo.gif)

## Installation

1. Obsidian → Settings → Community plugins → Browse → search "Ratel"
2. Install and enable
3. Settings → Ratel → configure model (DeepSeek / Claude / local Ollama, pick one)
4. First launch auto-scans vault and builds index
5. Click 🦡 icon in sidebar to start

> Before store listing, you can install via [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Privacy

- All data stored locally
- Model API is the only outbound channel; Ollama mode has zero outbound
- API keys stored in Obsidian 1.11.4+ SecretStorage, never in config files
- No telemetry, no data collection

## Documentation

- [User Guide](docs/user-guide.md)
- [Architecture](docs/ARCHITECTURE.md) (for developers)
- [Changelog](CHANGELOG.md)

## Feedback

- [GitHub Issues](https://github.com/golddream-y/ratel-vault/issues): submit bugs or feature requests
- Check the [User Guide FAQ](docs/user-guide.md#29-faq) first

## What It Doesn't Do

- No standalone service (pure plugin, install and use)
- No cloud SaaS (local-first data)
- No collaboration / multi-user / team features
- No note editor (Obsidian has one)
- No native modules (zero ABI compatibility risk)
```

- [ ] **Step 2: 验证文件存在且双语结构完整**

Run: `grep -c "^# Ratel — Obsidian AI Agent" README.md && grep -c "^---$" README.md`
Expected: 顶部标题出现 2 次(中英各一),`---` 分隔符至少 1 次

- [ ] **Step 3: 验证删除清单内容已移除**

Run: `grep -iE "为什么选 Ratel|V1 — 基础能力|W[1-8].*里程碑|自动建链|自动学经验|Learner|🚧" README.md`
Expected: 无匹配

- [ ] **Step 4: 验证文档链接路径有效**

Run: `ls docs/user-guide.md docs/ARCHITECTURE.md CHANGELOG.md docs/screenshots/.gitkeep`
Expected: 四个文件都存在

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(s-docs-v1): README 重构为商店详情页风格

问题:旧 README 含开发导向内容(V1 W1-W8 路线图、竞品对比、🚧 规划功能、
ARCHITECTURE 直接链接、营销语气),不适合 Obsidian 商店详情页,且违反
商店政策(贬低竞品、宣传未实现功能)。

修复:
- 重构为双语商店详情页风格,中文在前英文在后
- 删除路线图/竞品对比/未实现功能宣传
- 保留核心定位/安装/隐私/不做什么
- 文档链接收拢到独立小节
- 补 BRAT 安装路径(商店未上架前)"
```

---

## Task 6: 更新 STATUS.md 标记 plan 完成

**Files:**
- Modify: `docs/superpowers/STATUS.md`

**背景:** spec 已登记(在 brainstorming 阶段),但本 plan 未登记。执行完成后需在 STATUS.md 主表 plan 区新增 P-DOCS-V1 行并标记 Completed。

- [ ] **Step 1: 在 STATUS.md plan 表新增 P-DOCS-V1 行**

在 `## 实施 Plan(任务拆解)` 表格末尾(P-MSG-STREAM 行之后)新增一行:

```markdown
| P-DOCS-V1 | [2026-06-28-docs-system-v1-implementation.md](plans/2026-06-28-docs-system-v1-implementation.md) | ✅ Completed | S-DOCS-V1 | 文档体系 v1 — README 商店化 + 用户手册 + CHANGELOG + versions.json 修复 |
```

- [ ] **Step 2: 验证 STATUS.md 更新**

Run: `grep "P-DOCS-V1" docs/superpowers/STATUS.md`
Expected: 匹配一行,状态为 ✅ Completed

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(s-docs-v1): STATUS.md 登记 P-DOCS-V1 完成"
```

---

## Task 7: 最终验证

**Files:** 无文件操作,纯验证

- [ ] **Step 1: 验证所有新增/修改文件存在**

Run: `ls -la README.md CHANGELOG.md docs/user-guide.md docs/screenshots/.gitkeep versions.json docs/superpowers/STATUS.md`
Expected: 全部存在

- [ ] **Step 2: 验证 versions.json 与 manifest.json minAppVersion 一致**

Run: `grep minAppVersion manifest.json && cat versions.json`
Expected: 两者都是 `1.11.4`

- [ ] **Step 3: 验证 README 双语结构**

Run: `grep -c "^# Ratel — Obsidian AI Agent" README.md`
Expected: `2`

- [ ] **Step 4: 验证 CHANGELOG 含 Unreleased + 0.1.0 两个版本块**

Run: `grep -E "^## \[(Unreleased|0\.1\.0)\]" CHANGELOG.md`
Expected: 匹配两行

- [ ] **Step 5: 验证 user-guide 双语结构**

Run: `grep -c "^# Ratel" docs/user-guide.md`
Expected: `2`(中英文各一个 H1)

- [ ] **Step 6: 验证手册无未实现功能**

Run: `grep -iE "link suggest|auto.?suggest.?link|learner|主动提醒|自动学经验" docs/user-guide.md`
Expected: 无匹配

- [ ] **Step 7: 验证手册斜杠命令与代码一致**

Run: `grep -oE "'/[a-z]+'" src/ui/chat/input/slash-commands.ts | sort -u && echo "---" && grep -oE "\`/[a-z]+\`" docs/user-guide.md | sort -u`
Expected: 代码 4 个命令与手册 4 个命令完全一致(顺序可能不同)

- [ ] **Step 8: 验证手册 secret ID 与代码一致**

Run: `grep -oE "ratel-chat-openai-compatible|ratel-embed-openai-compatible|ratel-rerank-bailian" docs/user-guide.md | sort -u`
Expected: 三个 secret ID 都出现

- [ ] **Step 9: 验证 STATUS.md 登记**

Run: `grep "P-DOCS-V1" docs/superpowers/STATUS.md`
Expected: 匹配,状态 Completed

- [ ] **Step 10: 验证 git 工作区干净**

Run: `git status --short`
Expected: 无未提交改动

---

## 自审 / Self-Review

### 1. Spec 覆盖

| Spec 章节 | 对应 Task |
|---|---|
| § 5 README 重构 | Task 5 |
| § 6.1 CHANGELOG.md 格式 | Task 3 |
| § 6.3 发版工作流 | (不落地代码,工作流是 spec 文档本身,下次发版时执行) |
| § 6.6 首次落地(创建 CHANGELOG 不发 release) | Task 3 |
| § 7 用户使用手册 | Task 4 |
| § 8 Demo GIF 占位 | Task 1 |
| § 9.1 新增文件 | Task 1 / 3 / 4 |
| § 9.2 修改 README | Task 5 |
| § 9.3 不动文件 | (无对应 Task,符合预期) |
| § 9.4 STATUS.md 登记 | Task 6 |
| § 11 验证标准 | Task 7 |

**额外发现:** spec § 11 验证标准未提 versions.json 修复,但实际 `versions.json` 当前 `"0.1.0": "1.0.0"` 与 `manifest.json` `minAppVersion: 1.11.4` 不一致,是历史遗留 bug。本 plan Task 2 顺手修复,不偏离 spec 意图(spec § 9.3 说"首次落地不改版本号"指 0.1.0 这个值不改,但 minAppVersion 兼容性映射必须对齐)。

### 2. Placeholder 扫描

- 无 TBD / TODO / "fill in details"
- 每个代码块都是完整内容,非占位
- 每个 grep 验证都有明确 expected

### 3. 类型一致性

- 文档项目,无类型签名
- secret ID / 斜杠命令在 spec、plan、验证步骤中一致

### 4. 范围检查

- 单一 plan 可覆盖,7 个 Task 独立可验证
- 不需要拆分

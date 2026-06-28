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

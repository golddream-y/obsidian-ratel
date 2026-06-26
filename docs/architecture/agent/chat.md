# 对话体验

> 领域:Agent | 端到端:用户输入 → Agent Loop → 流式渲染

---

## 1. 职责

从用户在侧栏输入问题,到看到流式回答的端到端体验。是 Agent 领域的「门面」— agent-loop / context-manager / tools 都是它的内部实现。

**不做的事**:
- 不负责检索(检索属于 [rag/retriever](../rag/retriever.md))
- 不负责模型管理(模型属于 [llm/model-management](../llm/model-management.md))
- 不负责 Obsidian API 细节(属于 [host/obsidian-integration](../host/obsidian-integration.md))

---

## 2. 设计原则

### 2.1 流式优先

**决策**:从 LLM 到 UI 全链路流式,用户看到的是逐字输出,不是等完再显示。

**原因**:
- LLM 响应延迟 1-5 秒,流式可感知延迟 < 200ms
- Obsidian 侧栏空间有限,流式避免"长时间空白"

### 2.2 工具调用对用户可见

**决策**:工具调用过程(搜索中... / 读取笔记... / 分析中...)在 UI 中显示。

**原因**:
- 用户知道 Agent 在做什么,减少焦虑
- 调试时能看到工具调用链路
- 类似 ChatGPT 的 "Searching the web..." 体验

### 2.3 会话持久化

**决策**:每个对话(session)自动保存,重新打开可恢复。

**原因**:
- 用户关闭侧栏不应丢失对话
- 跨 Obsidian 重启保持上下文

---

## 3. 端到端流程

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CV as ChatView<br/>(Svelte 5)
    participant AL as Agent Loop
    participant CTX as ContextManager
    participant TL as Tools
    participant LLM as LLM API

    Note over U,LLM: 对话体验 — 端到端

    U->>CV: 输入问题
    CV->>AL: agentLoop(req)
    AL->>CTX: load(sessionId)
    AL->>CTX: addUserMessage(message)

    loop 最多 MAX_STEPS 轮
        AL->>LLM: chat(messages, tools)
        LLM-->>AL: 流式 tokens

        alt 纯文本回复
            AL-->>CV: message.delta 事件
            CV-->>U: 逐字渲染
        else 工具调用
            AL-->>CV: tool.call 事件
            CV-->>U: "搜索中..."
            AL->>TL: execute(toolCall)
            TL-->>AL: 工具结果
            AL->>CTX: addToolResult(result)
            AL-->>CV: tool.result 事件
            CV-->>U: "已找到 3 篇相关笔记"
            Note over AL: 继续下一轮 LLM 调用
        end
    end

    AL-->>CV: message.end 事件
    AL->>CTX: save(sessionId)
```

---

## 4. 事件协议

Agent Loop 通过 `AsyncIterable<AgentEvent>` 向 UI 推送事件:

```mermaid
stateDiagram-v2
    [*] --> message.start
    message.start --> message.delta: 流式文本
    message.start --> tool.call: LLM 决定调工具
    message.delta --> message.delta: 持续输出
    message.delta --> message.end: 文本结束
    tool.call --> tool.result: 工具返回
    tool.result --> search.result: search_vault 返回
    tool.result --> message.start: 继续下一轮
    message.end --> [*]
```

| 事件类型 | 含义 | UI 行为 |
|---|---|---|
| `message.start` | 新一轮 LLM 回复开始 | 显示"思考中..." |
| `message.delta` | 流式文本片段 | 逐字渲染到消息气泡 |
| `tool.call` | LLM 请求调用工具 | 显示工具名 + 参数摘要 |
| `tool.result` | 工具执行结果 | 显示结果摘要 |
| `search.result` | search_vault 返回带编号结果 | 渲染搜索结果卡片(编号 + 路径 + 分数) |
| `error` | 错误 | 显示错误提示 |
| `message.end` | 整个对话轮结束 | 保存会话,显示 token 统计 |

---

## 5. Chat UI 布局

```mermaid
graph TB
    subgraph "ChatView.svelte"
        Messages["Messages Area<br/>(消息流 + 工具调用卡片 + 搜索结果 + 附件缩略图)"]
        StatusLine["StatusLine<br/>(30px 常驻底部)"]
        StatusDrawer["StatusDrawer<br/>(展开时显示详情)"]
        AttachmentStrip["AttachmentStrip<br/>(有附件时显示)"]
        SlashMenu["SlashMenu<br/>(输入 / 时弹出)"]
        InputRow["InputRow<br/>(+ 按钮 + textarea + Send/Stop)"]
    end

    Messages --> StatusLine
    StatusLine --> StatusDrawer
    StatusDrawer --> AttachmentStrip
    AttachmentStrip --> SlashMenu
    SlashMenu --> InputRow
```

**组件职责:**

| 组件 | 职责 | 数据源 |
|------|------|--------|
| StatusLine | 单行展示 5 种状态(就绪/思考中/错误/未配置/索引中)+ ctx 进度条 + 百分比 | `userStatus.statusBar$` + `contextUsage$` |
| StatusDrawer | 展开式详情 — 向量化/索引区 + 上下文区(含压缩按钮) | `statusBar$` + `contextUsage$` + `pendingAttachments$` |
| SlashMenu | 输入 / 弹出命令菜单(`/new` `/compact` `/model` `/reindex`) | `filterCommands(input)` 纯函数 |
| AttachmentStrip | 图片附件预览条(56×56 缩略图 + × 删除) | `pendingAttachments$` |

**Notice 迁移策略:**

| 类型 | 迁移后 |
|------|--------|
| 模型下载进度 | `StatusLine` 状态文字 + `toastProgress`(长驻进度条保留) |
| 索引进度 | `StatusLine` 状态文字 + `StatusDrawer` 进度条 |
| 严重错误 | 保留 `toastError` + `StatusLine` 红点 |
| 降级警告 | `StatusDrawer` 降级区(不弹 toast) |

**CSS 变量约束:** 全部颜色复用 Obsidian CSS 变量(`--background-secondary` / `--text-success` / `--text-warning` / `--text-error` 等),禁止硬编码 hex,禁止 box-shadow,圆角 4-8px。

---

## 6. ChatView 生命周期

```mermaid
sequenceDiagram
    autonumber
    participant O as Obsidian
    participant CV as ChatView
    participant Svelte as Svelte 5 组件
    participant Plugin as RatelVaultPlugin

    Note over O,Plugin: 视图打开

    O->>CV: onOpen()
    CV->>CV: containerEl.children[1].empty()
    CV->>Svelte: mount(Component, { target, props })
    Note over Svelte: props = { plugin }<br/>组件通过 plugin 访问 API

    Note over O,Plugin: 用户交互

    Svelte->>Plugin: plugin.ask(message)
    Plugin->>Plugin: agentLoop(req)
    Plugin-->>Svelte: AgentEvent 流
    Svelte->>Svelte: 渲染消息 + 工具调用 + 流式文本

    Note over O,Plugin: 视图关闭

    O->>CV: onClose()
    CV->>Svelte: unmount(component)
    Note over Svelte: 释放 Svelte 内部资源
```

**Svelte 5 mount 注意事项**:
- 必须用 `mount(Component, { target, props })` 双参形式
- 不能用 Svelte 4 的 `new Component({ target, props })` 单参形式
- esbuild 必须加 `conditions: ['browser']`,否则 Svelte 5 解析到 server runtime,`mount` 不可用

---

## 7. 会话管理

```mermaid
graph TB
    subgraph "会话存储"
        S1["session-001.json"]
        S2["session-002.json"]
        SL["sessions.json<br/>会话列表索引"]
    end

    subgraph "单个会话"
        META["meta: { id, title, createdAt }"]
        MSGS["messages: [<br/>  { role: 'user', content },<br/>  { role: 'assistant', content },<br/>  { role: 'tool', name, result }<br/>]"]
    end

    S1 --> META
    S1 --> MSGS
```

| 操作 | 说明 |
|---|---|
| 新建会话 | 用户点击"新对话"或首次打开侧栏 |
| 恢复会话 | 侧栏显示历史会话列表,点击恢复 |
| 自动保存 | 每次 `message.end` 后自动保存 |
| 删除会话 | 用户主动删除,从索引和文件中移除 |

---

## 8. RAG 对话模式

当用户问题涉及 vault 内容时,Chat 的完整流程:

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant AL as Agent Loop
    participant SV as search_vault
    participant RN as read_note
    participant CTX as ContextManager
    participant LLM as LLM API

    U->>AL: "我的项目用了什么技术栈?"
    AL->>LLM: chat(messages, tools)
    LLM-->>AL: tool.call: search_vault({ query: "项目技术栈" })
    AL-->>U: "搜索中..."
    AL->>SV: execute({ query, topK: 5 })
    SV-->>AL: [{ docId, score, metadata }]

    AL->>LLM: chat(messages + tool.result, tools)
    LLM-->>AL: tool.call: read_note({ path: "notes/project.md" })
    AL-->>U: "读取笔记..."
    AL->>RN: execute({ path })
    RN-->>AL: 文档内容

    AL->>CTX: addSearchResults([{ path, content }])
    AL->>LLM: chat(messages + search_results, tools)
    LLM-->>AL: 流式回答
    AL-->>U: "根据你的项目笔记,使用了 TypeScript + esbuild..."
```

**关键**:Agent Loop 自主决定检索 → 读取 → 回答的节奏,用户只看到中间状态提示。

---

## 9. 边界

| 与...的接口 | 方向 | 说明 |
|---|---|---|
| [agent-loop](agent-loop.md) | 包含 | Chat 是门面,agent-loop 是引擎 |
| [context-manager](context-manager.md) | 包含 | 上下文管理是 Chat 的内部机制 |
| [tools](tools.md) | 包含 | 工具是 Chat 的能力扩展 |
| [rag/retriever](../rag/retriever.md) | 依赖 | search_vault 工具调用检索器(混合搜索) |
| [llm/streaming](../llm/streaming.md) | 依赖 | LLM 流式协议 |
| [host/obsidian-integration](../host/obsidian-integration.md) | 依赖 | ItemView + Svelte mount |

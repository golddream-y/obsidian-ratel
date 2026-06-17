# 流式协议

> 领域:LLM | SSE 解析、取消、重试、CORS 策略

---

## 1. 职责

处理 LLM API 的流式响应:解析 SSE 事件、支持取消、错误重试、CORS 跨域。是 LLM 调用的传输层。

**不做的事**:
- 不负责模型选择(属于 [model-management](model-management.md))
- 不负责对话逻辑(属于 [agent-loop](../agent/agent-loop.md))
- 不负责 UI 渲染(属于 [chat](../agent/chat.md))

---

## 2. 设计原则

### 2.1 SSE(Server-Sent Events)标准

**决策**:LLM 流式响应统一用 SSE 协议解析。

**原因**:
- OpenAI / DeepSeek / Ollama 都用 SSE
- Anthropic 也用 SSE(格式略有不同)
- SSE 是单向流,适合 LLM 场景(服务端推送,客户端只读)

### 2.2 取消即中断

**决策**:用户取消对话时,立即中断 SSE 流,不等待当前 chunk 完成。

**原因**:
- 用户取消意味着"不想等了",继续读浪费资源
- 中断后 LLM 端也会停止生成(连接断开)

### 2.3 CORS 用 Obsidian requestUrl 绕过

**决策**:LLM API 调用用 Obsidian 的 `requestUrl` 而非浏览器 `fetch`,绕过 CORS 限制。

**原因**:
- Obsidian 是 Electron 应用,`requestUrl` 走 Node.js HTTP,无 CORS
- 浏览器 `fetch` 受 CORS 限制,大部分 LLM API 不支持浏览器直接调用
- Ollama localhost 例外:可用 `fetch`,但统一用 `requestUrl` 更简单

---

## 3. SSE 解析

### 3.1 流程

```mermaid
sequenceDiagram
    autonumber
    participant AL as Agent Loop
    participant LC as LLMClient
    participant API as LLM API

    AL->>LC: chat(messages, tools)
    LC->>API: POST /v1/chat/completions<br/>stream: true
    API-->>LC: SSE 流

    loop 逐事件
        LC->>LC: 解析 SSE event
        alt content delta
            LC-->>AL: ChatDelta { content }
        else tool_call delta
            LC-->>AL: ChatDelta { toolCall }
        else [DONE]
            LC-->>AL: 流结束
        end
    end
```

### 3.2 SSE 事件格式

**OpenAI / DeepSeek 格式**:

```
data: {"choices":[{"delta":{"content":"你"},"index":0}]}
data: {"choices":[{"delta":{"content":"好"},"index":0}]}
data: [DONE]
```

**Anthropic 格式**(略有不同):

```
event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}

event: message_stop
data: {"type":"message_stop"}
```

### 3.3 工具调用的流式解析

LLM 工具调用的参数是流式分片到达的,需要累积拼接:

```mermaid
sequenceDiagram
    autonumber
    participant API as LLM API
    participant LC as LLMClient

    API-->>LC: delta: { tool_call: { name: "search_vault", arguments: "" } }
    API-->>LC: delta: { tool_call: { arguments: '{"qu' } }
    API-->>LC: delta: { tool_call: { arguments: 'ery":' } }
    API-->>LC: delta: { tool_call: { arguments: '"技术栈"}' } }
    API-->>LC: delta: { tool_call: { arguments: '}' } }

    Note over LC: 累积拼接 arguments<br/>→ '{"query":"技术栈"}'
    Note over LC: JSON.parse → 完整 ToolCall
```

---

## 4. 取消机制

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CV as ChatView
    participant AL as Agent Loop
    participant LC as LLMClient
    participant API as LLM API

    Note over U,API: 用户取消对话

    U->>CV: 点击取消
    CV->>AL: abortController.abort()
    AL->>LC: 中断 SSE 流
    LC->>API: 断开连接
    API-->>LC: 连接关闭
    LC-->>AL: 流中断
    AL-->>CV: message.end(已取消)
```

**实现**:用 `AbortController` + `AbortSignal`,传入 `requestUrl` 的 `signal` 参数。

---

## 5. 错误处理与重试

```mermaid
flowchart TB
    CALL["调用 LLM API"] --> CHECK{"响应状态"}
    CHECK -->|"200"| PARSE["解析 SSE 流"]
    CHECK -->|"429 限流"| WAIT["等待 Retry-After"] --> RETRY["重试"]
    CHECK -->|"5xx 服务端错误"| BACK["指数退避"] --> RETRY
    CHECK -->|"4xx 客户端错误"| ERR["yield error 事件"]
    CHECK -->|"网络超时"| BACK

    RETRY --> CHECK2{"重试次数 < 3?"}
    CHECK2 -->|"是"| CALL
    CHECK2 -->|"否"| ERR

    PARSE --> STREAM{"流式解析"}
    STREAM -->|"正常"| YIELD["yield ChatDelta"]
    STREAM -->|"连接中断"| RETRY2["重试(从断点)"]
    STREAM -->|"JSON 解析错误"| SKIP["跳过该 chunk"]
```

| 错误类型 | 处理策略 |
|---|---|
| 429 限流 | 等待 `Retry-After` 头,最多重试 3 次 |
| 5xx 服务端 | 指数退避(1s / 2s / 4s),最多重试 3 次 |
| 网络超时 | 指数退避重试 |
| 4xx 客户端 | 不重试,yield error 事件 |
| SSE 解析错误 | 跳过该 chunk,继续读 |
| 连接中断 | 重试(如果支持断点续传) |

---

## 6. CORS 策略

```mermaid
graph TB
    subgraph "Obsidian(Electron)"
        REQ["requestUrl()<br/>Node.js HTTP<br/>无 CORS 限制"]
    end

    subgraph "LLM API 端点"
        DS["DeepSeek<br/>api.deepseek.com"]
        CL["Anthropic<br/>api.anthropic.com"]
        OL["Ollama<br/>localhost:11434"]
    end

    REQ --> DS
    REQ --> CL
    REQ --> OL
```

| 端点 | 协议 | CORS | 方式 |
|---|---|---|---|
| DeepSeek | HTTPS | 不允许浏览器 | requestUrl(Node.js) |
| Anthropic | HTTPS | 不允许浏览器 | requestUrl(Node.js) |
| Ollama | HTTP | localhost 无限制 | requestUrl(统一) |

**决策**:所有端点统一用 `requestUrl`,即使 Ollama localhost 可用 `fetch`。减少分支逻辑。

---

## 7. 边界

| 与...的接口 | 方向 | 说明 |
|---|---|---|
| [model-management](model-management.md) | 被依赖 | LLMClient 使用流式协议 |
| [agent-loop](../agent/agent-loop.md) | 被依赖 | Agent Loop 消费 ChatDelta 流 |
| [host/obsidian-integration](../host/obsidian-integration.md) | 依赖 | requestUrl 由 Obsidian 提供 |

---

## 8. 演进路径

| 阶段 | 能力 | 状态 |
|---|---|---|
| 当前 | SSE 解析 + requestUrl + 基础错误处理 | ✅ 已实现 |
| 后续 | 取消(AbortController) + 重试(指数退避) | 待增强 |
| 远期 | 断点续传 + 流式工具结果 | 远期 |

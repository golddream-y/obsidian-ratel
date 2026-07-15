# 工具历史协议修复 — `/compact` 截断与 LLM 400

> 日期: 2026-07-15  
> 状态: Active  
> Spec ID: **S-TOOL-HISTORY-400**  
> 关联: DeepSeek `400`「Messages with role 'tool' must be a response to a preceding message with 'tool_calls'」；截图会话中工具失败后下一轮请求报错

---

## 1. 背景

OpenAI 兼容协议要求：`role:tool` 必须紧跟在带 `tool_calls` 的 `assistant` 之后，且 `tool_call_id` 能对上。

当前 `/compact`（`compact-session.ts`）对非 system 消息做 `slice(-PRESERVED_COUNT)`（N=3）。若窗口落在「半截工具对」上，例如：

```
… assistant(tool_calls:A), tool(A), assistant(tool_calls:B), tool(B)
slice(-3) → tool(A), assistant(B), tool(B)   // tool(A) 孤立
```

下一轮 `buildRequestBody` 仍会发出孤立 `tool` → DeepSeek 400。

次要风险：一轮多工具时 agent-loop 写成多段 `assistant(单 tool_calls)+tool`，部分网关更偏好单条 assistant 含完整 `tool_calls[]`（本 spec v1 以 **sanitize 保留窗口** 为主，合并序列化为可选增强）。

---

## 2. 目标

1. compact 保留窗口 **按工具对对齐**：不出现孤立 `tool`；若保留 assistant(tool_calls) 则带齐其全部 tool 结果  
2. 发出 LLM 请求前可选 **sanitize** 一道（防御已持久化的坏历史）  
3. 单测覆盖「slice 产生孤立 tool」场景  

## 3. 非目标

- 重做整个 session 持久化格式  
- v1 强制改 agent-loop 多工具为单 assistant 多 tool_calls（可列 follow-up）  
- 改路径绝对路径问题（属 S-CHAT-INPUT-MENTIONS Task 6）

---

## 4. 设计

### 4.1 `alignPreservedToolMessages(messages): ChatMessage[]`

从候选 `slice(-N)` 结果（或从尾部选取）出发：

- 若首条是 `tool` → 向前扩展直到找到拥有匹配 `toolCallId` 的 assistant，或丢弃该孤立 tool  
- 若末条是带 `toolCallId` 的 assistant → 向后纳入所有紧邻、id 匹配的 tool 结果  
- 目标：发出序列满足「每个 tool 的前一条相关 assistant 含对应 tool_calls」

### 4.2 接入点

- `compactSession`：`preservedMessages = alignPreservedToolMessages(allMessages.slice(-N))`（必要时允许略多于 N）  
- `DeepSeekLLM.buildRequestBody` 或 `ContextManager.toMessages` 出口：对即将上送的 messages 再跑一遍 drop 孤立 tool（双保险）

### 4.3 验收

- 单元：构造含 2 轮工具的历史，`align` 后无孤立 tool  
- compact 后下一轮 mock chat **不再**因 tool 顺序 400（可用断言 sanitize 输出结构）

---

## 5. 参考

- `src/ui/chat/compact-session.ts`  
- `src/adapters/llm-deepseek.ts` `buildRequestBody`  
- `src/core/agent-loop.ts` 多 tool 写入方式  

# S-MSG-STREAM — Chat 消息流重构 + Think 块 + Token 校准 + 模型长度探测

- **Spec ID:** S-MSG-STREAM
- **状态:** Active
- **创建日期:** 2026-06-28
- **作者:** Ratel Vault 团队
- **关联:** 取代 `archive/S-CHAT-UI/` 中关于消息流的初步实现;为后续 i18n / prompts 提供稳定 UI 编排层

---

## 背景

P-INDEX-BLOCK 完成后,用户在 Obsidian 中实测 Chat 面板,反馈 4 个问题:

1. **工具调用时序错乱** — 一次助手消息内所有 `tool.call` 都堆在消息最上方,而非"文本 → 工具 → 文本 → 工具"交替。根因:ChatView 把 `toolCalls` 作为独立数组渲染,与 `content` 文本分离,丢失了事件到达顺序。
2. **无 think 块 / 工具详情展开** — DeepSeek 的 `reasoning_content` 与 Claude 的 thinking content block 都被适配器丢弃,UI 没有任何思考过程展示;工具调用只显示 `name + args`,无折叠详情。
3. **Token 统计不准** — `context-manager.getUsage()` 用 `text.length / 4` 粗估,中英文混合语料偏差大;`StatusLine` 显示的百分比与 API 返回的真实 token 数对不上。
4. **模型 context length 写死** — `settings.chatModelMaxTokens: 32000` 是硬编码常量,切换模型后不更新,导致进度条阈值失真。

此外,阶段 3 UI 精致度修复暴露出 `ChatView.svelte` 已膨胀到 600+ 行,职责混杂(消息渲染 + 输入 + 附件 + 斜杠 + 状态 + 发送门禁),需借此机会拆分为编排层 + 子组件。

用户追加约束:**Agent loop 保持核心逻辑,单一职责大块逻辑移出去**。即 `agent-loop.ts` 保留循环编排,token usage 更新、segments 追加等大块逻辑提取为独立模块。

## 目标

1. **消息模型重构为 segments 判别联合** — 一次助手消息由有序 `text / think / tool / image / citation` 段组成,保留事件时序,支持"文本 → 工具 → 文本 → 工具"完全交替。
2. **think 块端到端支持** — DeepSeek `reasoning_content` 与 Claude thinking content block 在适配器层解析为 `ChatDelta.reasoning`,agent-loop 透传为 `message.delta.reasoning`,UI 渲染为可折叠 think 段。
3. **工具调用详情可展开** — 工具条点击展开 `args / result`,默认折叠显示 `displayName`(如 `list_files Formatting/`)。
4. **Token 三层校准** — send 前 context-manager 精确估算 → 流式中中英混合权重过渡 → `message.end` 用 API 真值校准。
5. **模型 context length 动态探测** — 设置面板"测试连接"按钮,从 API 响应推断 + 内置模型映射表回退,填充 `chatModelMaxTokens`。
6. **UI 目录整体归拢** — 按 chat / status / tokens / components / diagnostics 五个子系统拆分,`ChatView.svelte` 瘦身到 ~200 行编排层。
7. **Agent-loop 职责拆分** — 保留循环核心,token usage 更新、segments 追加等单一职责逻辑移出为独立模块。

## 非目标

- **不重写 agent-loop 核心循环** — 循环结构、错误处理、取消机制、截断检测保持现状,只迁移旁路逻辑。
- **不引入第三方 tokenizer 库** — `js-tiktoken` 仅支持 OpenAI 系,对 DeepSeek/Claude 不准;`transformers.js` 包体积 ~2MB,得不偿失。本地估算用改进的中英混合权重,真值靠 API 返回。
- **不实现 LLM 总结式上下文压缩** — `/compact` 仍保留"截断到最后 N 条"的简单实现,LLM 总结压缩留给后续 spec。
- **不实现图像生成 / 多模态输出** — `image` segment 类型仅预留接口,本次不实现生成逻辑。
- **不实现 citation 自动抽取** — `citation` segment 类型仅预留,本次不实现从工具结果自动提取引用。
- **不重构 diagnostics 子系统** — 诊断页保持现状,仅随目录迁移。

## 详细设计

### 第 1 节:消息模型重构(segments 判别联合)

#### 1.1 数据模型

在 `src/ui/chat/message-stream/types.ts` 定义:

```typescript
/**
 * 助手消息的有序段 — 保留事件时序,支持"文本 → 工具 → 文本 → 工具"完全交替。
 * 判别联合:type 字段做 discriminator,Svelte 模板用 {#if} 分支渲染。
 */
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'think'; text: string }
  | { type: 'tool'; toolCall: ToolCallEntry }
  | { type: 'image'; mimeType: string; base64: string }
  | { type: 'citation'; docId: string; path: string; snippet: string };

/**
 * 工具调用条目 — UI 渲染单元,displayName 预格式化,startAt 用于时序展示。
 */
export interface ToolCallEntry {
  name: string;
  displayName: string;       // 预格式化展示名,如 "list_files Formatting/"
  args: unknown;
  status: 'calling' | 'done' | 'failed';
  result?: unknown;
  errorMessage?: string;
  startAt: number;           // Date.now(),用于时序排序与耗时展示
}

/**
 * 统一消息 — user / assistant 都用 segments,告别 content + toolCalls 双数组。
 */
export interface Message {
  role: 'user' | 'assistant';
  segments: MessageSegment[];
  chatError?: DiagError;
  cancelled?: boolean;
  searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
  searchReranked?: boolean;
  attachments?: Array<{ fileName: string; mimeType: string; base64: string }>;
  // 关键路径:message.end 收到的 API 真值,用于校准 token 统计
  tokenUsage?: { promptTokens: number; completionTokens: number };
}
```

#### 1.2 段追加策略(segment-appender.ts)

`src/ui/chat/message-stream/segment-appender.ts` 封装 segments 追加 / 合并逻辑,ChatView 不再直接操作数组:

```typescript
/**
 * 向 message.segments 追加文本段 — 相邻 text 段自动合并(流式 delta 场景)。
 */
export function appendText(msg: Message, text: string): void;

/**
 * 向 message.segments 追加 think 段 — 相邻 think 段自动合并。
 */
export function appendThink(msg: Message, text: string): void;

/**
 * 向 message.segments 追加工具调用段 — 不合并,每个 tool.call 一个独立段。
 * displayName 由 formatToolDisplayName 预计算,startAt = Date.now()。
 */
export function appendToolCall(msg: Message, tc: ToolCallEntry): void;

/**
 * 把工具调用结果回填到最近一个 status='calling' 的同名工具段。
 * 若未找到匹配段(异常时序),降级为追加一个已完成的工具段。
 */
export function attachToolResult(msg: Message, name: string, result: unknown): void;

/**
 * 标记工具段失败 — 用于 TOOL_ERROR / TOOL_DENIED / INDEX_NOT_READY 错误。
 */
export function markToolFailed(msg: Message, name: string, errorMessage: string): void;
```

**合并规则:**
- `text` 段:若上一段是 `text`,追加到 `lastSegment.text`;否则 push 新段。
- `think` 段:同 `text`。
- `tool` 段:始终 push 新段(每次 tool.call 是独立调用)。
- `image` / `citation`:本次不实现,接口预留。

#### 1.3 事件流改造

ChatView 的 `for await (const event of events)` 循环改为:

```typescript
case 'message.delta':
  if (event.payload.reasoning) {
    appendThink(am, event.payload.reasoning);
  } else {
    appendText(am, event.payload.text);
  }
  break;
case 'tool.call':
  appendToolCall(am, {
    name: event.payload.name,
    displayName: formatToolDisplayName(event.payload.name, event.payload.args),
    args: event.payload.args,
    status: 'calling',
    startAt: Date.now(),
  });
  break;
case 'tool.result':
  attachToolResult(am, event.payload.name, event.payload.result);
  break;
```

**用户消息段:** user 消息初始化为 `segments: [{ type: 'text', text: input }]`,附件转成 `image` 段(本次仅预留,实际渲染仍走 `attachments` 字段)。

#### 1.4 消息渲染组件

`src/ui/chat/message-stream/MessageList.svelte` 渲染 `Message[]`,`MessageBubble.svelte` 渲染单条消息,内部按 segments 顺序渲染:

```
MessageList.svelte
  └── MessageBubble.svelte (per message)
        ├── 用户消息:TextSegment 渲染 content + 附件预览
        └── 助手消息:按 segments 顺序渲染
              ├── TextSegment.svelte (MarkdownView)
              ├── ThinkSegment.svelte (Collapsible,默认折叠,流式时展开)
              ├── ToolSegment.svelte (Collapsible,默认折叠显示 displayName)
              ├── SearchResults.svelte (search.result 事件触发的引用列表)
              └── chatError / cancelled 状态条
```

**Think 段流式行为:** 流式中(think 段正在追加)默认展开,流式结束后自动折叠(用户可手动展开)。

**Tool 段展示:**
- 折叠态:`✓ list_files Formatting/ — 7 项`(绿色对勾 + displayName + 结果摘要)
- 展开态:折叠态 + args(JSON 折叠代码块)+ result(JSON 折叠代码块)
- 失败态:`✗ read_note ../etc/passwd — 拒绝:路径越界`(红色叉 + 错误消息)

### 第 2 节:Think 块解析(DeepSeek + Claude)

#### 2.1 端口层扩展(ports/llm.ts)

`ChatDelta` 加 `reasoning` 与 `usage` 字段(一次定义,后续小节引用):

```typescript
export interface ChatDelta {
  text: string;
  reasoning?: string;        // 新增:思考过程文本(DeepSeek reasoning_content / Claude thinking)
  toolCall?: ToolCall;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  usage?: { promptTokens: number; completionTokens: number };  // 新增:API 真值 token 统计
}
```

`AgentEvent.message.delta` 加 `reasoning` 字段:

```typescript
| { type: 'message.delta'; payload: { text: string; reasoning?: string } }
```

`AgentEvent.message.end` 加 token 真值:

```typescript
| {
    type: 'message.end';
    payload: {
      tokens: number;                  // 保留:兼容旧调用方
      promptTokens?: number;           // 新增:API 返回的输入 token 数
      completionTokens?: number;       // 新增:API 返回的输出 token 数
    };
  }
```

#### 2.2 DeepSeek 适配器(llm-deepseek.ts)

DeepSeek OpenAI 兼容协议在 `delta` 中返回 `reasoning_content` 字段(仅 deepseek-reasoner 模型)。适配器解析:

```typescript
// processSSEEvent 内部
const parsed = JSON.parse(data) as {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;     // 新增:DeepSeek 思考过程
      tool_calls?: OpenAIToolCallChunk[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {                            // 新增:流末尾的 token 统计
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

if (choice.delta?.content) {
  deltas.push({ text: choice.delta.content });
}
if (choice.delta?.reasoning_content) {
  deltas.push({ text: '', reasoning: choice.delta.reasoning_content });
}
```

`usage` 在流末尾(最后一个 chunk 或独立 chunk)出现,适配器捕获后在末尾 yield 一个特殊 delta:

```typescript
// 流末尾 yield usage(字段定义见 2.1 节 ChatDelta)
if (capturedUsage) {
  yield { text: '', usage: { promptTokens: capturedUsage.prompt_tokens, completionTokens: capturedUsage.completion_tokens } };
}
```

#### 2.3 Claude 适配器(llm-anthropic.ts)

Claude 的 thinking 是独立的 content block,流式中按 `content_block_start` / `content_block_delta` / `content_block_stop` 事件序列到达:

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}
```

适配器解析时按 `content_block.type` 分流:`thinking` 块的 delta yield 为 `{ text: '', reasoning: thinking }`,`text` 块的 delta yield 为 `{ text }`。

Claude `message_delta` 事件携带 `usage`:

```
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":142}}
```

`message_start` 事件携带 `input_tokens`:

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":25}}}
```

适配器在 `message_start` 记录 `inputTokens`,在 `message_delta` 记录 `outputTokens`,流末尾 yield `{ text: '', usage: { promptTokens: inputTokens, completionTokens: outputTokens } }`。

#### 2.4 Agent-loop 透传

agent-loop 的 `for await (const delta of stream)` 循环(L120-136)改为:

```typescript
for await (const delta of stream) {
  if (signal?.aborted) { streamAborted = true; break; }
  if (delta.text) {
    accumulatedText += delta.text;
    yield { type: 'message.delta', payload: { text: delta.text } };
  }
  if (delta.reasoning) {
    yield { type: 'message.delta', payload: { text: '', reasoning: delta.reasoning } };
  }
  if (delta.toolCall) {
    toolCalls.push(delta.toolCall);
  }
  if (delta.finishReason) {
    finishReason = delta.finishReason;
  }
  if (delta.usage) {
    lastUsage = delta.usage;  // 新增:保存到局部变量,finally 阶段 yield
  }
}
```

`finally` 块的 `message.end` 改为:

```typescript
yield {
  type: 'message.end',
  payload: {
    tokens: ctx.tokenCount(),
    promptTokens: lastUsage?.promptTokens,
    completionTokens: lastUsage?.completionTokens,
  },
};
```

### 第 3 节:UI 目录整体归拢

#### 3.1 目标目录结构

```
src/ui/
├── chat/                              # 聊天主子系统
│   ├── ChatView.svelte                # 编排层(~200 行,只做状态编排与事件分发)
│   ├── ChatView.ts                    # mount/unmount 逻辑(从 src/ui/ChatView.ts 迁移)
│   ├── message-stream/                # 消息流渲染
│   │   ├── types.ts                   # MessageSegment, ToolCallEntry, Message
│   │   ├── segment-appender.ts        # segments 追加/合并/工具结果回填
│   │   ├── MessageList.svelte
│   │   ├── MessageBubble.svelte
│   │   ├── TextSegment.svelte
│   │   ├── ThinkSegment.svelte
│   │   ├── ToolSegment.svelte
│   │   └── SearchResults.svelte
│   ├── input/                         # 输入区
│   │   ├── AttachmentStrip.svelte     # 从 src/ui/AttachmentStrip.svelte 迁移
│   │   ├── SlashMenu.svelte           # 从 src/ui/SlashMenu.svelte 迁移
│   │   ├── attachment-utils.ts        # 从 src/ui/attachment-utils.ts 迁移
│   │   └── slash-commands.ts          # 从 src/ui/slash-commands.ts 迁移
│   ├── chat-error.ts                  # 从 src/ui/chat-error.ts 迁移
│   ├── chat-send-gate.ts              # 从 src/ui/chat-send-gate.ts 迁移
│   ├── compact-confirm.ts             # 从 src/ui/compact-confirm.ts 迁移
│   └── format-tool-display.ts         # 从 src/ui/format-tool-display.ts 迁移
├── status/                            # 状态条子系统
│   ├── StatusLine.svelte              # 从 src/ui/StatusLine.svelte 迁移
│   └── StatusDrawer.svelte            # 从 src/ui/StatusDrawer.svelte 迁移
├── tokens/                            # token 估算与模型探测(新增子系统)
│   ├── token-estimator.ts             # 新增:中英混合权重估算
│   └── probe-model.ts                 # 新增:测试连接推断 context length
├── components/                        # 通用 UI 组件
│   ├── Collapsible.svelte             # 新增:可折叠容器(think / tool 段共用)
│   ├── MarkdownView.svelte            # 从 src/ui/MarkdownView.svelte 迁移
│   ├── confirm-modal.ts               # 从 src/ui/confirm-modal.ts 迁移
│   └── secret-hint.ts                 # 从 src/ui/secret-hint.ts 迁移
└── diagnostics/                       # 诊断页(保持现状,仅随目录归拢)
    ├── diag-utils.ts
    ├── embedding-test.ts
    ├── llm-test.ts
    ├── rerank-placeholder.ts
    └── tab-bar.ts
```

#### 3.2 迁移策略

- **先建目录 + 迁移现有文件**(`git mv`),保持 import 路径可追踪。
- **更新所有 import 引用** — `main.ts`、`ChatView.ts`、相互引用的 .svelte 文件。
- **再拆分 ChatView.svelte** — 把消息渲染、输入处理、状态编排分别下沉到子组件,ChatView 只保留:
  - 顶层状态(`messages` / `input` / `isRunning` / `sessionId`)
  - 事件循环(`for await (const event of events)`)分发到 segment-appender
  - 子组件 props 编排
- **diagnostics 不重构**,仅随目录迁移,内部代码不动。

#### 3.3 编排层职责边界

`ChatView.svelte` 重构后只承担:

1. **状态持有:** `messages` / `input` / `isRunning` / `sessionId` / `drawerExpanded` / `keyTick`
2. **派生状态:** `gate` / `slashVisible` / `showThinking` / `modelName` / `hasKey`
3. **事件循环:** `sendMessage()` 内的 `for await (const event of events)` + segment-appender 调用
4. **子组件编排:** `<MessageList messages={messages} />` + `<StatusLine>` + `<StatusDrawer>` + `<SlashMenu>` + `<AttachmentStrip>`
5. **生命周期:** `onMount` / `onDestroy` / abortController 管理

不承担:
- 消息渲染细节(下沉到 MessageBubble / 各 Segment 组件)
- 工具 displayName 格式化(已在 format-tool-display.ts)
- token 估算(下沉到 tokens/token-estimator.ts)
- 斜杠命令执行细节(下沉到 input/slash-commands.ts)

### 第 4 节:Token 三层校准 + 模型长度探测

#### 4.1 Token 估算器(tokens/token-estimator.ts)

```typescript
/**
 * 中英混合 token 估算 — 比纯 length/4 更准,不引入第三方库。
 *
 * 权重依据:
 * - ASCII Latin:平均 ~4 字符/token(英文单词 + 空格 + 标点)
 * - CJK 中文:平均 ~1.5 字符/token(BPE 分词后中文 token 密度高)
 * - 数字与符号:~3 字符/token
 *
 * 仍为估算,真值靠 message.end 的 API usage 校准。
 *
 * @param text - 待估算文本
 * @returns 估算 token 数(向上取整)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) asciiCount++;
    else if (code >= 0x4e00 && code <= 0x9fff) cjkCount++;
    else otherCount++;
  }
  return Math.ceil(asciiCount / 4 + cjkCount / 1.5 + otherCount / 3);
}
```

#### 4.2 三层校准流程

**第 1 层:send 前精确估算**

`context-manager.getUsage()` 替换 `text.length / 4` 为 `estimateTokens(text)`:

```typescript
// src/core/context-manager.ts
import { estimateTokens } from '../ui/tokens/token-estimator';

getUsage(): ContextUsage {
  const used = this.messages.reduce((sum, m) => {
    return sum + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolArgs ?? {}));
  }, 0);
  return {
    usedTokens: used,
    maxTokens: this.maxTokens,
    percentage: Math.min(Math.round((used / this.maxTokens) * 100), 100),
  };
}
```

**第 2 层:流式中过渡估算**

复用现有 `plugin.userStatus.contextUsage$`(ContextUsage 接口),不新建 store。在 `ContextUsage` 加可选 `source` 字段标记数据来源:

```typescript
// src/user-feedback/user-status.ts(修改现有接口)
export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  attachmentTokens: number;
  percentage: number;
  /** 新增:数据来源,用于 StatusLine 样式区分(可选,旧调用方不传等同 'estimate') */
  source?: 'estimate' | 'streaming' | 'api';
}
```

ChatView 在 `message.delta` 事件中累计流式 token,通过 `patchContextUsage` 推送过渡值:

```typescript
// ChatView 内部累计变量
let streamingUsed = 0;

case 'message.delta':
  streamingUsed += estimateTokens(event.payload.text);
  plugin.userStatus.patchContextUsage({
    usedTokens: baselineUsed + streamingUsed,
    source: 'streaming',
  });
  break;
```

**第 3 层:message.end API 真值校准**

ChatView 在 `message.end` 事件中用 API 真值覆盖:

```typescript
case 'message.end':
  if (event.payload.promptTokens && event.payload.completionTokens) {
    plugin.userStatus.patchContextUsage({
      usedTokens: event.payload.promptTokens + event.payload.completionTokens,
      source: 'api',
    });
  }
  break;
```

**source 字段用途:** `StatusLine` 可根据 source 显示不同样式(估算=灰色、流式=黄色、API=绿色),本次仅实现数据流,样式迭代留给后续。

**注意:** 第 2/3 层不再新建 `token-usage-store.ts` 文件,直接复用 `userStatus.contextUsage$`。`estimateTokens` 在 ChatView 内部累计调用,`token-estimator.ts` 仍为独立模块供 context-manager 与 ChatView 共用。

#### 4.3 模型 context length 探测(tokens/probe-model.ts)

```typescript
/**
 * 测试连接并推断模型 context length。
 *
 * 策略:
 * 1. 发送一个极短请求(max_tokens=1),从响应的 usage 或 headers 推断
 * 2. 若响应未携带 context length 信息,查内置模型映射表
 * 3. 映射表未命中,返回 undefined,UI 提示用户手动填写
 *
 * @param config - LLM 配置(apiBase / apiKey / model)
 * @returns 推断的 context length;推断失败返回 undefined
 */
export async function probeModelContextLength(config: {
  apiBase: string;
  apiKey: string;
  model: string;
}): Promise<{ contextLength?: number; error?: string }>;
```

**内置模型映射表(常用模型 context length):**

```typescript
const MODEL_CONTEXT_MAP: Record<string, number> = {
  // DeepSeek
  'deepseek-chat': 64000,
  'deepseek-reasoner': 64000,
  // Claude
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  // Ollama 常见本地模型
  'llama3.1': 128000,
  'qwen2.5': 32768,
  // OpenAI 兼容端点常见模型
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
};
```

匹配规则:模型名小写后做前缀匹配(如 `deepseek-chat-0628` 匹配 `deepseek-chat`)。

#### 4.4 设置面板交互

`settings.ts` 的 `chatModelMaxTokens` 字段保留,但默认值从 `32000` 改为 `0`(0 表示未探测)。

在 `RatelVaultSettingTab`(`src/settings.ts` 第 147 行起的类)的模型配置区域加"测试连接"按钮:
- 点击后调用 `probeModelContextLength`
- 成功:填充 `chatModelMaxTokens`,显示绿色 Notice "已探测:64000 tokens"
- 失败:显示黄色 Notice "无法自动探测,请手动填写"
- 映射表命中:显示蓝色 Notice "基于模型名推断:64000 tokens(建议测试连接确认)"

`StatusLine` 在 `chatModelMaxTokens === 0` 时显示"未配置"而非百分比,引导用户去设置面板探测。

### 第 5 节:Agent-loop 职责拆分

#### 5.1 拆分原则(用户约束)

> "Agent loop 保持核心逻辑 如果单一职责的大块逻辑 移出去"

agent-loop.ts 保留:
- 循环结构(`for (let step = 0; step < maxSteps; step++)`)
- 取消信号检查
- LLM 流式读取与 delta 分发
- 工具调用编排(权限门控 → hooks → execute → hooks)
- 截断检测(`finishReason === 'length'`)
- 步数上限兜底
- `try / finally` 的 message.end 与 save 保证

agent-loop.ts 不保留(移出为独立模块):
- token usage 累计 → 已由 `token-usage-store.ts` + ChatView 处理(message.end 事件触发 calibrateFromApi)
- segments 追加逻辑 → 已由 `segment-appender.ts` + ChatView 处理
- search.result 事件的 results 扁平化 → 移到 `src/core/search-result-mapper.ts`

#### 5.2 search-result-mapper.ts(新增)

```typescript
// src/core/search-result-mapper.ts
/**
 * 把 search_vault 工具的原始结果扁平化为 AgentEvent.search.result 的 payload。
 *
 * 从 metadata.path 提取 path,避免 UI 层再嵌套解析 metadata。
 * 从结果推断是否经过 Rerank;无 reranked 字段时降级 false。
 */
export function mapSearchResults(
  rawResults: unknown,
): { results: SearchResultItem[]; reranked: boolean } | null;
```

agent-loop.ts 的 L230-256 改为:

```typescript
if (tc.name === 'search_vault') {
  const mapped = mapSearchResults(result);
  if (mapped) {
    yield { type: 'search.result', payload: mapped };
  }
}
```

#### 5.3 不拆分的部分(明确边界)

以下逻辑看似"大块",但与循环核心强耦合,不移出:
- 截断检测与 TRUNCATION_NOTICE 追加 — 依赖 accumulatedText 与 toolCalls 局部状态
- 错误事件 yield — 依赖循环上下文(step / signal / accumulatedText)
- 意图分类 — 已是独立参数 `intentClassifier`,无需再拆

#### 5.4 agent-loop 行数预期

当前 295 行。拆分 search-result-mapper 后预计降到 ~270 行。核心循环结构不变,可读性提升。

## 影响面

### 新增文件(12 个)

```
src/ui/chat/message-stream/types.ts
src/ui/chat/message-stream/segment-appender.ts
src/ui/chat/message-stream/MessageList.svelte
src/ui/chat/message-stream/MessageBubble.svelte
src/ui/chat/message-stream/TextSegment.svelte
src/ui/chat/message-stream/ThinkSegment.svelte
src/ui/chat/message-stream/ToolSegment.svelte
src/ui/chat/message-stream/SearchResults.svelte
src/ui/tokens/token-estimator.ts
src/ui/tokens/probe-model.ts
src/ui/components/Collapsible.svelte
src/core/search-result-mapper.ts
```

### 迁移文件(13 个,git mv)

```
src/ui/ChatView.svelte         → src/ui/chat/ChatView.svelte
src/ui/ChatView.ts             → src/ui/chat/ChatView.ts
src/ui/AttachmentStrip.svelte  → src/ui/chat/input/AttachmentStrip.svelte
src/ui/SlashMenu.svelte        → src/ui/chat/input/SlashMenu.svelte
src/ui/attachment-utils.ts     → src/ui/chat/input/attachment-utils.ts
src/ui/slash-commands.ts       → src/ui/chat/input/slash-commands.ts
src/ui/chat-error.ts           → src/ui/chat/chat-error.ts
src/ui/chat-send-gate.ts       → src/ui/chat/chat-send-gate.ts
src/ui/compact-confirm.ts      → src/ui/chat/compact-confirm.ts
src/ui/format-tool-display.ts  → src/ui/chat/format-tool-display.ts
src/ui/StatusLine.svelte       → src/ui/status/StatusLine.svelte
src/ui/StatusDrawer.svelte     → src/ui/status/StatusDrawer.svelte
src/ui/MarkdownView.svelte     → src/ui/components/MarkdownView.svelte
src/ui/confirm-modal.ts        → src/ui/components/confirm-modal.ts
src/ui/secret-hint.ts          → src/ui/components/secret-hint.ts
```

### 修改文件(8 个)

```
src/types.ts                   — AgentEvent.message.delta 加 reasoning,message.end 加 promptTokens/completionTokens
src/ports/llm.ts               — ChatDelta 加 reasoning 与 usage 字段
src/adapters/llm-deepseek.ts   — 解析 reasoning_content 与 usage
src/adapters/llm-anthropic.ts  — 解析 thinking content block 与 usage
src/core/agent-loop.ts         — 透传 reasoning / usage,search.result 改用 mapSearchResults
src/core/context-manager.ts    — getUsage 用 estimateTokens 替代 length/4
src/user-feedback/user-status.ts — ContextUsage 加可选 source 字段(estimate/streaming/api)
src/settings.ts                — chatModelMaxTokens 默认值改 0;RatelVaultSettingTab 加"测试连接"按钮
src/main.ts                    — 更新 ChatView import 路径
```

### 测试覆盖

- **segment-appender:** text/think 合并、tool 不合并、attachToolResult 回填、markToolFailed
- **token-estimator:** 纯英文、纯中文、中英混合、空字符串、纯符号
- **probe-model:** DeepSeek 响应推断、Claude 响应推断、映射表命中、映射表未命中
- **mapSearchResults:** 正常结果、缺 metadata.path、reranked 字段存在/缺失
- **llm-deepseek:** reasoning_content 解析、usage 解析、无 reasoning 字段(普通模型)
- **llm-anthropic:** thinking block 解析、text block 解析、usage(input_tokens + output_tokens)解析
- **agent-loop:** reasoning 透传、usage 透传到 message.end、search.result 改用 mapper

### 破坏性变更

- `Message` 接口从 `content: string + toolCalls?: ToolCallEntry[]` 改为 `segments: MessageSegment[]` — ChatView 内部所有访问 `m.content` / `m.toolCalls` 的地方都要改。
- `AgentEvent.message.delta.payload` 加可选字段 `reasoning` — 向后兼容(不解析 reasoning 的旧调用方仍可读 text)。
- `AgentEvent.message.end.payload` 加可选字段 `promptTokens` / `completionTokens` — 向后兼容。
- `settings.chatModelMaxTokens` 默认值从 32000 改为 0 — 已有用户的 data.json 保留旧值,新用户需手动探测或填写。

## 参考

- [DeepSeek API 文档 — reasoning_content](https://api-docs.deepseek.com/zh-cn/guides/reasoning_model)
- [Anthropic API 文档 — extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [OpenAI API 文档 — streaming](https://platform.openai.com/docs/api-reference/chat/streaming)
- 项目内:`archive/S-CHAT-UI/`(初步 UI 实现)、`archive/S-INDEX-BLOCK/`(Web Worker 迁移,本 spec 前置条件)

# S-VISION — 图片消息真正发给模型

> 日期: 2026-08-20
> 修订: 2026-08-22 **v1.2** — 按 P-VISION-1 实现修正回写:图片走 `ChatMessage.attachments` 独立字段(不扩 content 联合);单适配器现状(无 Anthropic,砍 Ollama 模型名启发式);i18n key 归 `chat.error.*` 族
> 修订: 2026-08-22 **v1.3** — 存储定稿**附件外置**:write-once 落 `pluginDir/attachments/<sessionId>/`,消息只存引用;推翻 v1.2「直存 session JSON」(每回合全量序列化,图片多时主线程卡顿);渲染沿用现有 data URL 形态(objectURL 为后续优化项)
> 状态: Active
> Spec ID: **S-VISION**
> 关联: [PRD §7](../../PRD.md)(支柱 A 对话能力)、ADR-014(网络出站不变 — 无新增端点)

## 1. 背景

图片上传是半截功能:UI 层完整(上传/粘贴/预览/token 预估/气泡展示,[attachment-utils.ts](../../../src/ui/chat/input/attachment-utils.ts) 有 5MB/4 张限制),但 **LLM 协议层没有图片通道**:

- [llm.ts](../../../src/ports/llm.ts) `ChatMessage.content` 是纯 `string`,无图片通道
- context-manager `addUserMessage(content: string)` 只保存纯文本
- 唯一适配器 [llm-openai-compat.ts](../../../src/adapters/llm-openai-compat.ts)(承载 DeepSeek 官方与本地 Ollama 两类 OpenAI 兼容端点)无 vision 格式构造
- `src/core`、`src/adapters`、`src/ports` 里零 attachment 引用

结果:用户上传图片提问,token 预算被扣(attachmentTokens 计入上下文),模型却只收到文字——占着额度不干活,答非所问。用户感知是「模型识别能力差」,实际是图根本没发出去。

## 2. 目标

1. 上传的图片随用户消息**真正发给模型**(EC 对话能力补全)
2. 视觉路径 v1 落地:localhost Ollama 透传 `images` 数组(取决于本地模型是否为 vl 模型);Anthropic 待其适配器立项时一并做(v1.2 按仓库现状修正)
3. **模态不支持时直接报错**:发送前按 provider 探测能力,DeepSeek 等不支持图片的模型,在发送时明确报「当前模型不支持图片输入,请移除图片或更换模型」类错误——不静默丢图,那是用户自己的选择(用户已确认此产品决策)
4. 会话持久化包含图片附件(重开 Ratel 后图片仍可见)
5. 上下文 token 预算逻辑保持(图片按视觉 token 估算,现状公式已存在)

## 3. 非目标

- 不做图片压缩/裁剪/服务端处理(v1 原图 base64,Anthropic 建议长边 ≤1568px,超出由用户自己控制)
- 不做 OCR / 本地图片预提取文本(模型直接看图)
- 不做图片编辑、生成、多模态输出(模型回复图片)
- 不做自动切换视觉模型(报错后由用户决定换模型还是删图)
- 不做粘贴文件类非图片附件(v1 仍限图片)

## 4. 详细设计

### 4.1 数据模型:引用外置(v1.3 存储定稿)

**不扩 `MessageSegment` 联合、不把 base64 存进 session。** 两个理由:① `content` 在 compact / microcompact / tokenCount 全链路按 string 处理,改联合会波及 6+ 文件;② `ctx.save()` 每回合全量读盘+序列化(agent-loop 收尾必经)——base64 直存意味着图片多的会话每发一条消息主线程卡几百毫秒。定稿形态:

- **磁盘**:图片 write-once 写 `pluginDir/attachments/<sessionId>/<hash>.json`(`{mimeType, base64}`;hash 为内容摘要,同图去重限会话内)。**会话删除整目录清走**,GC 零逻辑
- **消息里只存引用(KB 级,session JSON 体积与图片数无关)**:

```typescript
/** 图片附件引用 — session 里只有这一层 */
interface AttachmentRef {
  id: string;      // 内容 hash,即文件名
  mimeType: string;
}

// ChatMessage 追加:user 消息专属,缺省即无图
attachments?: AttachmentRef[];
```

- **base64 只活在两处瞬态**:上传时的 `pendingAttachments$`(待发送队列)、解析后的请求体 / objectURL——**永不进 session JSON**
- **解析收敛在一个新模块 `AttachmentStore`**(约百行):`save()` write-once;`load(id)` 带 Map 缓存(每次应用运行每图只读盘一次)。两个消费点:UI hydrate(refs → 可渲染 URL;v1 回填现有 data URL 形态,objectURL 省内存为后续优化)、agent-loop 发送前(refs → base64 进请求体)
- **兼容**:老会话无该字段天然兼容(缺省=无图)
- **已知限制(v1)**:`attachmentTokens` 只在发送时刻由 UI 层计入用量条;重开/hydrate 后历史含图消息不计入 `getContextUsage`,用量条低估——记录不修,v2 再议

### 4.2 端口层:`attachments` 引用字段与能力声明(v1.2/v1.3)

[llm.ts](../../../src/ports/llm.ts) **不改** `content` 类型(保持纯 string),追加两个成员:

- `ChatMessage.attachments?: AttachmentRef[]`(引用形态见 4.1;适配器收到的是 agent-loop 已解析 base64 的出站消息,见 4.5)
- `LLMClient.supportsImages: boolean` — 能力声明,agent-loop 发送前探测用

attachments 仅出现在 user 消息上;system / assistant / tool 消息不带。

### 4.3 适配器实现(v1.2 按单适配器现状修正)

仓库只有 `llm-openai-compat.ts` 一个适配器(原名 llm-deepseek.ts,P-VISION-1 Task 0 正名——它实为通用 OpenAI 兼容家族适配器),同时承载 DeepSeek 官方与本地 Ollama 两类 OpenAI 兼容端点(无 Anthropic 适配器):

| 端点 | 图片支持 | 实现 |
|---|---|---|
| localhost(Ollama) | ✅(模型相关) | `buildRequestBody` 透传 `messages[].images = [base64]`(Ollama 原生字段) |
| DeepSeek 官方远端 | ❌ | agent-loop 探测拦截本轮新图(见 4.4);请求体层剥掉历史图 |
| Anthropic | — | 适配器不存在;待立项时一并实现 base64 image block |

**跨模型会话防护(v1.2 补)**:透传必须带 `supportsImages &&` 前置判断——Ollama 会话中途切回 DeepSeek 续聊时,本轮无新图、探测放行,但**历史含图消息仍会进 buildRequestBody**,远端必须剥掉 images(否则未知字段报 400)。语义与 compact 摘要后模型看不到旧图一致。

### 4.4 能力探测与报错(核心交互)

**探测位置:发送时刻,agent-loop 调 LLM 前**(不是上传时刻——上传时不知道用户会用哪个模型,且用户可能中途换模型):

- `LlmPort` 能力声明:`supportsImages: boolean`。v1.2 **按端点判断**(localhost 即 true),不做模型名启发式——本地非视觉模型的错误由 Ollama 报错原样透传给用户(「报错就行,那是用户配置的事」)
- 发送链路含图片 && `!supportsImages` → yield error 事件(code `VISION_UNSUPPORTED`)后终止本轮,**不调 LLM、不静默丢图**;消息已入 session,用户换模型后重发可见
- Chat UI 走 `handleAgentError` 现有管道显示**自愈型提示**(非红色错误条,与「取消」同语义),文案含「移除图片」或「更换模型」引导

### 4.5 链路接线(改动面)

```
ChatView.svelte(发送:pendingAttachments$ → AttachmentStore.save 落盘 → 得到 refs)
  → plugin.ask(sessionId, text, signal, refs)
  → agent-loop:addUserMessage(refs)入库(轻量)→ 探测(含图 && !supportsImages → VISION_UNSUPPORTED 终止)
  → 发送前经 AttachmentStore 解析 refs → base64(仅内存,不落盘)随 ChatMessage 出站
  → 适配器:localhost 透传 images / 远端剥除
```

- context-manager `addUserMessage` 扩为 `(content, refs?)` 可选二参(纯文本路径兼容;有图才写字段,入库的只有 KB 级引用)
- 渲染:hydrate 经 AttachmentStore 把 refs 异步解析回 base64(Map 缓存,每图每次运行只读一次盘),回填现有 data URL 渲染形态;token 预算仍由 UI 层 `attachmentTokens` 在发送时刻计入(重开后低估见 4.1 已知限制)

### 4.6 i18n

新增词条(zh/en):`chat.error.visionUnsupported`(v1.2 归入现有 `chat.error.*` 族,与 stopped / compactFailed / attachmentInvalid 同结构)、自愈提示文案。遵循现有 i18n 强制规则。

## 5. 影响面

| 层 | 文件 | 变更 |
|---|---|---|
| 协议 | src/ports/llm.ts | `AttachmentRef` + `ChatMessage.attachments` + `LLMClient.supportsImages` |
| 存储 | src/core/attachment-store.ts(新) | write-once 落盘 / Map 缓存读取 / 会话删除清目录(v1.3) |
| 数据 | src/types.ts | `UserChatRequest.attachments`(直接 import ports 类型,单一事实源) |
| 核心 | src/core/context-manager.ts / agent-loop.ts | addUserMessage 二参;VISION_UNSUPPORTED 探测与终止 |
| 适配 | src/adapters/llm-openai-compat.ts | `supportsImages` getter(端点级)+ buildRequestBody 透传 images(带 supportsImages 守卫) |
| UI | ChatView.svelte / hydrate-session-messages.ts / chat-error.ts | ask 第 4 参透传;hydrate 还原 attachments;VISION_UNSUPPORTED 自愈分支 |
| 入口 | main.ts | ask 签名扩展,agentLoop 透传 attachments |
| 持久 | session JSON + attachments/ 目录 | 引用直存 session(轻);图片外置 write-once;会话删除整目录清走 |
| i18n | zh/en/types | `chat.error.visionUnsupported` |

**架构文档触发确认**:涉及 `ChatMessage`(ports 数据契约)扩展与 `LlmPort` 接口新增成员,按 AGENTS.md 文档同步规则需在落地时确认 architecture 文档与 ADR(预计小 ADR:图片附件挂独立字段而非扩 content 联合的端口决策)。

## 6. 参考

- [Anthropic vision API](https://docs.anthropic.com/en/docs/build-with-claude/vision)(base64 image block,适配器立项时参照)
- [Ollama multimodal](https://github.com/ollama/ollama/blob/main/docs/api.md#request-with-images)(v1 透传格式:`messages[].images` base64 数组)

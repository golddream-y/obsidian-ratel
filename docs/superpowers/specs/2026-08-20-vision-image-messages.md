# S-VISION — 图片消息真正发给模型

> 日期: 2026-08-20
> 状态: Active
> Spec ID: **S-VISION**
> 关联: [PRD §7](../../PRD.md)(支柱 A 对话能力)、ADR-014(网络出站不变 — 无新增端点)

## 1. 背景

图片上传是半截功能:UI 层完整(上传/粘贴/预览/token 预估/气泡展示,[attachment-utils.ts](../../../src/ui/chat/input/attachment-utils.ts) 有 5MB/4 张限制),但 **LLM 协议层没有图片通道**:

- [llm.ts](../../../src/ports/llm.ts) `ChatMessage.content` 是纯 `string`,无 multi-part content
- context-manager `addUserMessage(content: string)` 只保存纯文本
- 三家适配器(deepseek/anthropic/ollama)均无 vision 格式构造
- `src/core`、`src/adapters`、`src/ports` 里零 attachment 引用

结果:用户上传图片提问,token 预算被扣(attachmentTokens 计入上下文),模型却只收到文字——占着额度不干活,答非所问。用户感知是「模型识别能力差」,实际是图根本没发出去。

## 2. 目标

1. 上传的图片随用户消息**真正发给模型**(EC 对话能力补全)
2. Anthropic 适配器构造 base64 image block;Ollama 透传 images 数组(取决于本地模型是否为 vl 模型)
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

### 4.1 数据模型:MessageSegment 扩展(架构变更点)

现有 `MessageSegment` 判别联合(纯 text)。新增 image segment:

```typescript
/** 图片段 — 与文本段平级,持久化到会话存储 */
interface ImageSegment {
  type: 'image';
  /** 原始 mimeType(image/png | image/jpeg | image/webp | image/gif) */
  mimeType: string;
  /** base64,不含 data: 前缀 */
  base64: string;
}
```

- **持久化**:segments 存进会话消息,重开插件图片仍在(现状 attachments 挂在 UI Message 上不进持久层,一并迁移)
- **兼容**:老会话无 image segment,读取不受影响
- 会话体积注意:base64 入 data.json(LLM 会话存储)可能膨胀,单会话 4 张×5MB 上限即 ~27MB base64 — 持久层若扛不住,降级方案为图片存独立目录 `pluginDir/attachments/`,消息里只存引用(实现期 spike 后定)

### 4.2 端口层:ChatMessage multi-part content

[llm.ts](../../../src/ports/llm.ts) `ChatMessage.content` 扩展:

```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 文本,或 文本+图片 混合内容 */
  content: string | Array<TextPart | ImagePart>;
}

interface TextPart { type: 'text'; text: string }
interface ImagePart { type: 'image_url'; image_url: { url: string /* data:...;base64, */ } }
```

- OpenAI 风格 multi-part 作为端口中立格式(Anthropic/Ollama 适配器各自转换)
- system 消息保持纯 string(架构不变)

### 4.3 适配器实现

| 适配器 | 图片支持 | 实现 |
|---|---|---|
| llm-anthropic | ✅ | content parts → `{type:'image', source:{type:'base64', media_type, data}}` + text block |
| llm-ollama | ✅(模型相关) | messages[].images = [base64](Ollama 原生支持,直接透传) |
| llm-deepseek | ❌ | 发送前校验:含图片 → 直接抛错,文案「当前模型不支持图片输入」 |

### 4.4 能力探测与报错(核心交互)

**探测位置:发送时刻,agent-loop 调 LLM 前**(不是上传时刻——上传时不知道用户会用哪个模型,且用户可能中途换模型):

- `LlmPort` 新增能力声明(接口属性或静态能力表):`supportsImages: boolean`
- 发送链路含图片 && `!supportsImages` → 抛 `VisionNotSupportedError`,Chat UI 显示**模态错误**(非红色错误条,与「取消」同语义的自愈型提示),文案含「移除图片」或「更换模型」引导
- Ollama 特例:`supportsImages` 按**当前选择的模型名**启发式判断(名称含 vl/llava/minicpm-v/qwen-vl 等视觉模型关键词),判断不了时按支持处理并允许模型侧报错回传 — 错误信息原样透传给用户,那是用户自己的本地模型配置

### 4.5 链路接线(改动面)

```
ChatView.svelte(发送)
  → userStatus.addAttachment(已有)
  → agent-loop: 用户消息 segments 含 image
  → context-manager: addUserMessage 支持 segments(含 image)
  → toMessages(intent) → ChatMessage multi-part
  → 适配器 vision 格式 / 或 VisionNotSupportedError
```

- context-manager `addUserMessage` 签名扩为可含 segments(保持纯文本路径兼容)
- token 预算:图片段计入(现 attachmentTokens 逻辑保留,合并进 segment 估算)

### 4.6 i18n

新增词条(zh/en):`chat.vision.notSupported`、`chat.vision.removeOrSwitchModel`、错误 Notice 文案。遵循现有 i18n 强制规则。

## 5. 影响面

| 层 | 文件 | 变更 |
|---|---|---|
| 协议 | src/ports/llm.ts | ChatMessage content multi-part + LlmPort 能力声明 |
| 数据 | src/types.ts / context-manager.ts | MessageSegment 增 image、addUserMessage 扩签名 |
| 适配 | src/adapters/llm-*.ts(3 家) | vision 格式构造/校验 |
| 核心 | src/core/agent-loop.ts | 图片链路接线 + VisionNotSupportedError 抛出点 |
| UI | src/ui/chat/ChatView.svelte、MessageBubble.svelte | 附件→segment 迁移、模态错误展示 |
| 持久 | 会话存储 | image segment 持久化(含 spike:base64 直存 vs 独立附件目录) |
| i18n | zh/en/types | 新词条 |

**架构文档触发确认**:涉及 `MessageSegment` 数据模型变更与 ports 接口扩展,按 AGENTS.md 文档同步规则需在落地时确认 architecture 文档与 ADR(预计小 ADR:vision 消息格式端口中立决策)。

## 6. 参考

- [Anthropic vision API](https://docs.anthropic.com/en/docs/build-with-claude/vision)(base64 image block)
- [Ollama multimodal](https://github.com/ollama/ollama/blob/main/docs/api.md#request-with-images)
- OpenAI Chat Completions multi-part content(端口中立格式参照)

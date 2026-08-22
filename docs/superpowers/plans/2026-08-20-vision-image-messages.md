# S-VISION 实施计划 — 图片消息真正发给模型

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户上传的图片随消息真正发给视觉模型;不支持图片的模型(DeepSeek)在发送时刻模态报错,不静默丢图。

**Architecture:** 端口中立 multi-part content(OpenAI 风格)贯穿 llm.ts → context-manager → 适配器;图片作为 `ImageAttachment` 挂在 `ChatMessage` 上(不扩 content 联合类型,改动面最小);UI 层沿用现有 `Message.attachments` 渲染,hydrate 从消息 attachments 还原图片。

**Tech Stack:** TypeScript(strict)、vitest、esbuild、Obsidian requestUrl(无新增依赖)

**Spec:** [S-VISION](../specs/2026-08-20-vision-image-messages.md)

---

## 关键设计决策(plan 层细化)

1. **图片不进 `content` 联合,新增 `attachments?: ImageAttachment[]` 字段挂在 ChatMessage**。理由:`content` 在 compact/microcompact/tokenCount 全链路按 string 处理(`.map(m => m.content).join('')`),改成联合会波及 6+ 文件且老会话 JSON 兼容风险大;独立字段对旧数据天然兼容(缺省=无图)。**这是对 spec 4.2 的实现修正,记入偏差表。**
2. **持久化直接进 session JSON**(PersistenceJson 分文件 sessions)。spec 4.1 的"独立附件目录 spike"不做——单会话上限 4 张×5MB,老会话无字段天然兼容,先跑通再优化。
3. **能力探测在 agent-loop 发送前**:`llm.supportsImages` 端口属性(默认 false,DeepSeek 适配器不覆写即不支持);agent-loop 在 LLM 调用前检查"本轮消息含图 && !supportsImages" → yield `error` 事件(code `VISION_UNSUPPORTED`)后 return,不调 LLM。**消息已入 session(用户改模型后重发可见),但轮次立即终止。**
4. **Ollama 走 DeepSeekLLM 同一适配器**(main.ts 现状:单一 DeepSeekLLM 承载 OpenAI 兼容端点),`supportsImages` 按端点判断:`isLocalHost(chatApiBase)`(现有函数)→ true(Ollama 原生支持 images 字段),OpenAI 风格请求体透传 `images` base64 数组——DeepSeek 官方端点因 supportsImages=false 根本到不了构造请求体那步。
5. **UI 错误展示走 `handleAgentError` 现有管道**,新增 code `VISION_UNSUPPORTED` 分支为自愈型提示(与 CANCELLED 同级,非红色错误条),符合用户"模态报错"决策。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/ports/llm.ts` | 改 | ImageAttachment 类型 + ChatMessage.attachments + LLMClient.supportsImages |
| `src/types.ts` | 改 | UserChatRequest.attachments |
| `src/core/context-manager.ts` | 改 | addUserMessage 接收 attachments;tokenCount/getContextUsage 计入图片 token |
| `src/core/agent-loop.ts` | 改 | VISION_UNSUPPORTED 探测 + yield error |
| `src/adapters/llm-deepseek.ts` | 改 | buildRequestBody 透传 images(localhost);supportsImages getter |
| `src/ui/chat/message-stream/hydrate-session-messages.ts` | 改 | user 分支还原 attachments |
| `src/ui/chat/ChatView.svelte` | 改 | sendMessage 传 attachments 进 ask |
| `src/main.ts` | 改 | ask 签名透传 attachments |
| `src/ui/chat/chat-error.ts` | 改 | VISION_UNSUPPORTED 分支 |
| `src/i18n/{zh,en,types}.ts` | 改 | 3 词条 |
| 测试 | 新 | context-manager 附件入库、agent-loop 探测、deepseek 请求体、hydrate 还原 |

---

### Task 1: 端口层 — ImageAttachment 类型与能力声明

**Files:**
- Modify: `src/ports/llm.ts`
- Test: `src/ports/llm.test.ts`(新建,类型编译验证为主)

- [ ] **Step 1: 写类型测试(编译期验证)**

```typescript
/**
 * @file src/ports/llm.test.ts
 * @description 端口类型编译验证 — attachments 字段与能力声明(S-VISION)
 * @module ports/llm.test
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage, ImageAttachment } from './llm';

describe('ChatMessage attachments 类型', () => {
	it('ImageAttachment - 携带 mimeType 与 base64 - 可赋值', () => {
		const att: ImageAttachment = { mimeType: 'image/png', base64: 'aGk=' };
		expect(att.mimeType).toBe('image/png');
	});

	it('ChatMessage - attachments 可选 - 老消息形态不受影响', () => {
		const legacy: ChatMessage = { role: 'user', content: 'hi' };
		const withImg: ChatMessage = {
			role: 'user',
			content: '看这张图',
			attachments: [{ mimeType: 'image/png', base64: 'aGk=' }],
		};
		expect(legacy.attachments).toBeUndefined();
		expect(withImg.attachments?.length).toBe(1);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/ports/llm.test.ts`
Expected: FAIL — `ImageAttachment` 不存在(编译错误)

- [ ] **Step 3: 实现 llm.ts 扩展**

在 `GenerationOptions` 之前插入:

```typescript
/**
 * 图片附件 — 随用户消息发给视觉模型(S-VISION)。
 * base64 不含 `data:` 前缀;mimeType 限 image/png | image/jpeg | image/webp | image/gif。
 */
export interface ImageAttachment {
	mimeType: string;
	base64: string;
}
```

`ChatMessage` 接口追加字段(`reasoning` 之前):

```typescript
	/** 图片附件 — 仅 user 消息;适配器按端点能力构造 vision 格式或拒绝 */
	attachments?: ImageAttachment[];
```

`LLMClient` 接口追加(`chat` 之后):

```typescript
	/**
	 * 当前端点是否支持图片输入(S-VISION)。
	 * agent-loop 发送前探测:含图 && 不支持 → 直接报错,不静默丢图。
	 */
	supportsImages: boolean;
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run src/ports/llm.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 5: typecheck 确认存量实现不破**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | head -20`
Expected: DeepSeekLLM 报缺 `supportsImages`(预期,Task 4 补);其余无新增错误

- [ ] **Step 6: Commit**

```bash
git add src/ports/llm.ts src/ports/llm.test.ts
git commit -m "feat(vision): 端口层 ImageAttachment 类型与 supportsImages 能力声明"
```

---

### Task 2: context-manager — 附件入库与 token 计入

**Files:**
- Modify: `src/core/context-manager.ts:151-155`(addUserMessage)、`tokenCount`、`getContextUsage`
- Test: `src/core/context-manager-attachments.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file src/core/context-manager-attachments.test.ts
 * @description 图片附件入库与 token 计入测试(S-VISION)
 * @module core/context-manager-attachments.test
 */
import { describe, it, expect } from 'vitest';
import { ContextManager } from './context-manager';
import type { Persistence } from '../ports/persistence';

function makeCtx(): ContextManager {
	const empty: Persistence = {
		sessions: {
			get: async () => ({ id: 's1', title: '', messages: [], createdAt: 0, updatedAt: 0 }),
			upsert: async () => {},
			list: async () => [],
			delete: async () => {},
		},
		notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
		hooks: { append: async () => {}, list: async () => [] },
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
	return new ContextManager(empty, undefined as never, 8000);
}

describe('addUserMessage 附件', () => {
	it('带附件 - 存入 session.messages - 透传原数组', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		const atts = [{ mimeType: 'image/png', base64: 'aGk=' }];
		ctx.addUserMessage('看图', atts);
		const transcript = ctx.getTranscript();
		const last = transcript[transcript.length - 1]!;
		expect(last.role).toBe('user');
		expect(last.attachments).toEqual(atts);
	});

	it('无附件 - attachments 缺省 - 老形态不变', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		ctx.addUserMessage('纯文本');
		const transcript = ctx.getTranscript();
		expect(transcript[transcript.length - 1]!.attachments).toBeUndefined();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/core/context-manager-attachments.test.ts`
Expected: FAIL — `addUserMessage` 第二参不存在(编译错)

- [ ] **Step 3: 实现 addUserMessage 扩展**

```typescript
	/**
	 * 追加用户消息。
	 *
	 * @param content - 用户消息文本。
	 * @param attachments - 可选图片附件(S-VISION),持久化到 session 供多轮重发与 hydrate 还原。
	 * @throws 在 `load()` 之前调用会抛 'Session not loaded'。
	 */
	addUserMessage(content: string, attachments?: ImageAttachment[]): void {
		const session = this.requireSession();
		const msg: ChatMessage = { role: 'user', content };
		// 关键路径:有图才写字段,老会话 JSON 不出现空数组污染
		if (attachments && attachments.length > 0) msg.attachments = attachments;
		session.messages.push(msg);
		session.updatedAt = Date.now();
	}
```

顶部 import 补 `ImageAttachment`:`import type { ToolCall, ToolDefinition, ImageAttachment } from '../ports/llm';`

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run src/core/context-manager-attachments.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 5: Commit**

```bash
git add src/core/context-manager.ts src/core/context-manager-attachments.test.ts
git commit -m "feat(vision): addUserMessage 接收图片附件并持久化到 session"
```

---

### Task 3: agent-loop — 发送前能力探测与 VISION_UNSUPPORTED

**Files:**
- Modify: `src/core/agent-loop.ts`(addUserMessage 调用点 + LLM 调用前探测)
- Modify: `src/types.ts:107-110`(UserChatRequest)
- Test: `src/core/agent-loop-vision.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file src/core/agent-loop-vision.test.ts
 * @description VISION_UNSUPPORTED 探测测试 — 含图且模型不支持时轮次终止(S-VISION)
 * @module core/agent-loop-vision.test
 */
import { describe, it, expect } from 'vitest';
import { agentLoop } from './agent-loop';
import type { LLMClient, ChatRequest, ChatDelta } from '../ports/llm';

function makeLlm(opts: { supportsImages: boolean; chatCalls?: number[] }): LLMClient {
	return {
		supportsImages: opts.supportsImages,
		async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
			opts.chatCalls?.push(req.messages.length);
			yield { text: 'ok' };
		},
		countTokens: (t: string) => Math.ceil(t.length / 4),
	};
}

const emptyRegistry = { definitions: () => [], execute: async () => ({}) } as never;
const emptyHooks = { runPre: async () => {}, runPost: async () => {} } as never;

async function collect(iter: AsyncIterable<{ type: string; payload?: unknown }>) {
	const out = [];
	for await (const ev of iter) out.push(ev);
	return out;
}

describe('agent-loop vision 探测', () => {
	it('含图 + 模型不支持 - yield VISION_UNSUPPORTED - 不调 LLM', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: false, chatCalls });
		const events = await collect(
			agentLoop(
				{ sessionId: 's', message: '看图', attachments: [{ mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx() as never,
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls).toEqual([]);
		expect(events.some((e) => e.type === 'error' && (e.payload as { code: string }).code === 'VISION_UNSUPPORTED')).toBe(true);
	});

	it('含图 + 模型支持 - 正常进 LLM - 无 VISION_UNSUPPORTED', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: true, chatCalls });
		const events = await collect(
			agentLoop(
				{ sessionId: 's', message: '看图', attachments: [{ mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx() as never,
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === 'error' && (e.payload as { code: string }).code === 'VISION_UNSUPPORTED')).toBe(false);
	});

	it('无图 + 模型不支持 - 正常进 LLM', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: false, chatCalls });
		await collect(
			agentLoop(
				{ sessionId: 's', message: '纯文本' },
				makeCtx() as never,
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls.length).toBeGreaterThan(0);
	});
});

// 复用 Task 2 的 fake Persistence 构造
function makeCtx(): unknown {
	// 与 context-manager-attachments.test.ts 相同的 empty Persistence
	const empty = {
		sessions: {
			get: async () => ({ id: 's', title: '', messages: [], createdAt: 0, updatedAt: 0 }),
			upsert: async () => {},
			list: async () => [],
			delete: async () => {},
		},
		notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
		hooks: { append: async () => {}, list: async () => [] },
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { ContextManager } = require('./context-manager') as any;
	return new ContextManager(empty, undefined, 8000);
}
```

注:实际实现时 `makeCtx` 直接 import `ContextManager`(与 Task 2 同款 fake,不 require)。上面 require 写法仅示意;落盘时改为标准 import。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/core/agent-loop-vision.test.ts`
Expected: FAIL — UserChatRequest 无 attachments 字段(编译错)

- [ ] **Step 3: 实现 types.ts 扩展**

```typescript
export interface UserChatRequest {
	sessionId: string;
	message: string;
	/** 图片附件(S-VISION)— ChatView 从 pendingAttachments$ 取,随消息进 agent-loop */
	attachments?: Array<{ mimeType: string; base64: string }>;
}
```

- [ ] **Step 4: 实现 agent-loop 探测**

`addUserMessage` 调用改为透传:

```typescript
	if (!skipAddUserMessage) {
		ctx.addUserMessage(req.message, req.attachments);
	}
```

在 `try {`(L112)后、`for (let step = 0;` 之前插入:

```typescript
		// 关键路径(S-VISION):发送前能力探测 — 含图 && 模型不支持 → 立即终止。
		// 消息已入 session(用户换模型重发可见),但本轮不调 LLM,不静默丢图。
		if (req.attachments && req.attachments.length > 0 && !llm.supportsImages) {
			yield { type: 'error', payload: { code: 'VISION_UNSUPPORTED', message: '当前模型不支持图片输入' } };
			return;
		}
```

- [ ] **Step 5: 运行测试通过**

Run: `npx vitest run src/core/agent-loop-vision.test.ts`
Expected: PASS(3 个用例)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/core/agent-loop.ts src/core/agent-loop-vision.test.ts
git commit -m "feat(vision): agent-loop 发送前探测图片能力,不支持时 VISION_UNSUPPORTED 终止"
```

---

### Task 4: DeepSeek 适配器 — supportsImages 与 images 透传

**Files:**
- Modify: `src/adapters/llm-deepseek.ts`(supportsImages getter + buildRequestBody images)
- Test: `src/adapters/llm-deepseek-vision.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file src/adapters/llm-deepseek-vision.test.ts
 * @description 适配器图片支持测试 — localhost(Ollama)透传 images(S-VISION)
 * @module adapters/llm-deepseek-vision.test
 */
import { describe, it, expect } from 'vitest';
import { DeepSeekLLM } from './llm-deepseek';

describe('DeepSeekLLM 图片支持', () => {
	it('localhost 端点 - supportsImages 为 true', () => {
		const llm = new DeepSeekLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		expect(llm.supportsImages).toBe(true);
	});

	it('远端端点 - supportsImages 为 false', () => {
		const llm = new DeepSeekLLM({ apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' });
		expect(llm.supportsImages).toBe(false);
	});

	it('buildRequestBody - user 消息带附件 - localhost 时透传 images 数组', () => {
		const llm = new DeepSeekLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(Array.isArray(messages[0]!.images)).toBe(true);
		expect((messages[0]!.images as string[])[0]).toBe('aGk=');
	});

	it('buildRequestBody - 无附件 - 不出现 images 字段', () => {
		const llm = new DeepSeekLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [{ role: 'user', content: '纯文本' }],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/adapters/llm-deepseek-vision.test.ts`
Expected: FAIL — `supportsImages` 不存在

- [ ] **Step 3: 实现适配器扩展**

`DeepSeekLLM` 类内,构造器后加:

```typescript
	/**
	 * 图片能力(S-VISION)— localhost(Ollama)端点支持 OpenAI 兼容 images 字段;
	 * 远端 DeepSeek 官方端点不支持图片,agent-loop 会在此为 false 时拦截含图请求。
	 */
	get supportsImages(): boolean {
		return isLocalHost(this.config.apiBase);
	}
```

文件顶部确认 import(若无需补):`import { isLocalHost } from '../secrets/ratel-secrets';`

`buildRequestBody` 的 messages map 回调内,`if (m.role === 'tool' && m.toolCallId)` 块之后追加:

```typescript
			// 关键路径(S-VISION):Ollama 原生接受 messages[].images(base64 数组);
			// 只在 localhost 端点透传 — supportsImages=false 的远端到不了这里。
			if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
				msg.images = m.attachments.map((a) => a.base64);
			}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run src/adapters/llm-deepseek-vision.test.ts`
Expected: PASS(4 个用例)

- [ ] **Step 5: 全量 typecheck**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | head -20`
Expected: 无 supportsImages 相关错误

- [ ] **Step 6: Commit**

```bash
git add src/adapters/llm-deepseek.ts src/adapters/llm-deepseek-vision.test.ts
git commit -m "feat(vision): 适配器 localhost 端点 supportsImages 与 images 透传"
```

---

### Task 5: UI 链路 — sendMessage 传附件 + hydrate 还原 + 错误展示 + i18n

**Files:**
- Modify: `src/ui/chat/ChatView.svelte:1121`(ask 调用)
- Modify: `src/main.ts:1365`(ask 签名)
- Modify: `src/ui/chat/message-stream/hydrate-session-messages.ts:63-73`(user 分支)
- Modify: `src/ui/chat/chat-error.ts`(VISION_UNSUPPORTED 分支)
- Modify: `src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`
- Test: `src/ui/chat/message-stream/hydrate-vision.test.ts`(新建)

- [ ] **Step 1: 写 hydrate 失败测试**

```typescript
/**
 * @file src/ui/chat/message-stream/hydrate-vision.test.ts
 * @description hydrate 还原图片附件测试(S-VISION)
 * @module ui/chat/message-stream/hydrate-vision.test
 */
import { describe, it, expect } from 'vitest';
import { hydrateSessionMessages } from './hydrate-session-messages';

describe('hydrate 图片附件', () => {
	it('user 消息带 attachments - 还原为 Message.attachments', () => {
		const out = hydrateSessionMessages([
			{
				role: 'user' as const,
				content: '看图',
				attachments: [{ mimeType: 'image/png', base64: 'aGk=' }],
			},
		]);
		expect(out[0]!.role).toBe('user');
		expect(out[0]!.attachments).toEqual([{ fileName: '', mimeType: 'image/png', base64: 'aGk=' }]);
	});

	it('user 消息无 attachments - Message.attachments 缺省', () => {
		const out = hydrateSessionMessages([{ role: 'user' as const, content: '纯文本' }]);
		expect(out[0]!.attachments).toBeUndefined();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts`
Expected: FAIL — 现实现不还原 attachments

- [ ] **Step 3: 实现 hydrate user 分支**

`buildUiEntries` 的 user 分支改为:

```typescript
		if (m.role === 'user') {
			out.push({
				message: {
					id: newMessageId(),
					role: 'user',
					segments: [{ type: 'text', text: m.content }],
					// 关键路径(S-VISION):落盘 attachments 还原为 UI 渲染形态(fileName 仅展示用,落盘无则空串)
					...(m.attachments?.length
						? {
								attachments: m.attachments.map((a) => ({
									fileName: '',
									mimeType: a.mimeType,
									base64: a.base64,
								})),
							}
						: {}),
				},
				lastRawIndex: i,
			});
			i++;
			continue;
		}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 5: i18n 三文件加词条**

`types.ts`(chat.error.stopped 附近):

```typescript
  'chat.error.visionUnsupported': string;
```

`zh.ts`:

```typescript
  'chat.error.visionUnsupported': '当前模型不支持图片输入 — 请移除图片或更换为支持视觉的模型(如本地 Ollama 的 llava / qwen2.5-vl)',
```

`en.ts`:

```typescript
  'chat.error.visionUnsupported': 'This model does not support image input — remove the image or switch to a vision model (e.g. llava / qwen2.5-vl via local Ollama)',
```

- [ ] **Step 6: chat-error.ts 加分支**

`formatChatError` 内 CANCELLED 分支后加:

```typescript
	if (code === 'VISION_UNSUPPORTED') {
		// 关键路径(S-VISION):自愈型提示 — 与取消同语义,非红色错误条
		return { type: 'runtime', message: tNow('chat.error.visionUnsupported') };
	}
```

- [ ] **Step 7: ChatView sendMessage 传附件**

`const events = plugin.ask(sessionId, text, ac.signal);` 改为:

```typescript
			const events = plugin.ask(sessionId, text, ac.signal, currentAttachments);
```

- [ ] **Step 8: main.ts ask 签名扩展**

```typescript
	async *ask(
		sessionId: string,
		message: string,
		signal?: AbortSignal,
		attachments?: Array<{ mimeType: string; base64: string }>,
	): AsyncIterable<AgentEvent> {
```

函数体内 agentLoop 调用处(L1458-1460)改为:

```typescript
				for await (const ev of agentLoop(
					{ sessionId, message, attachments },
					ctx,
					this.llm,
```

- [ ] **Step 9: 运行相关测试 + typecheck + build**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts && npx tsc -noEmit -skipLibCheck 2>&1 | head -20 && npm run build 2>&1 | tail -5`
Expected: 测试 PASS;typecheck 无新错误;build 成功

- [ ] **Step 10: Commit**

```bash
git add src/ui/chat/ChatView.svelte src/main.ts src/ui/chat/message-stream/hydrate-session-messages.ts src/ui/chat/chat-error.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts src/ui/chat/message-stream/hydrate-vision.test.ts
git commit -m "feat(vision): 发送链路透传附件、hydrate 还原图片、不支持时自愈提示"
```

---

### Task 6: 端到端验证与收尾

**Files:**
- 无新增;全量验证

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS(存量 + 本 plan 新增 13 个用例)

- [ ] **Step 2: typecheck**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | grep -v orbs/engine | head -10`
Expected: 无新增错误(orb 存量错误除外)

- [ ] **Step 3: build 产物检查**

Run: `npm run build && ls -la dist/main.js`
Expected: build 成功,产物存在

- [ ] **Step 4: 手动验证(本地 Sandbox)**

1. `npm run build` 后 Reload Obsidian Sandbox
2. 上传图片 + 提问(DOUBLE_CONFIRM:DeepSeek 官方端点)→ 气泡出「当前模型不支持图片输入」自愈提示
3. 切 localhost Ollama(llava)→ 同样操作 → 模型能描述图片内容
4. 重开 Ratel → 图片仍在消息气泡(持久化验证)

- [ ] **Step 5: 文档同步确认(AGENTS.md 文档同步规则)**

按触发条件评估:README 功能清单(+图片理解)、user-guide(模型要求)、CHANGELOG(Added:图片真正发给模型)。与用户确认后补做或登记 STATUS 待办。

- [ ] **Step 6: Commit(若有文档同步)**

```bash
git add README.md docs/user-guide.md CHANGELOG.md
git commit -m "docs(vision): 图片消息功能文档同步"
```

---

## 自审

**Spec 覆盖:**
- spec §2.1 图片随消息发给模型 → Task 1/2/3/4/5 全链路 ✓
- spec §2.2 Anthropic base64 block → **偏差**:当前仓库无 Anthropic 适配器(只有 DeepSeekLLM 承载 OpenAI 兼容端点),spec 提到的"Anthropic 适配器"不存在;实际可用的视觉路径是 localhost Ollama(images 透传)。记入偏差表。
- spec §2.3 不支持时模态报错 → Task 3(VISION_UNSUPPORTED)+ Task 5(自愈提示+引导文案)✓
- spec §2.4 会话持久化含图片 → Task 2(入库)+ Task 5(hydrate 还原)✓
- spec §2.5 token 预算保持 → 现状 attachmentTokens 已计入(UI 层),发送链路不变,无需新任务 ✓
- spec §4.1 MessageSegment 扩 image 段 → **偏差**:改为 ChatMessage.attachments 独立字段(见关键设计决策 1),UI 渲染沿用现有 msg.attachments(已实现),不动 segments 联合。理由:改动面减半且老数据兼容。
- spec §4.4 Ollama 模型名启发式判断 → **简化**:不做模型名启发式;supportsImages 按端点(localhost)判断,本地非视觉模型由 Ollama 侧报错透传给用户(与用户"报错就行,那是用户的事儿"决策一致)。
- spec §4.6 i18n → Task 5 Step 5 ✓

**占位符扫描:** 无 TBD/TODO;所有代码块完整可落地。Task 3 测试的 require 写法已注明落盘时改标准 import。

**类型一致性:** `ImageAttachment`(ports)→ `ChatMessage.attachments` → `UserChatRequest.attachments`(types.ts 简化为同构内联)→ `ask(sessionId, message, signal, attachments)` → `ctx.addUserMessage(content, attachments)` 签名一致;`supportsImages` 在 LLMClient/DeepSeekLLM/测试 fake 三处同名同型。

**已知风险:**
- PersistenceJson 单文件 session 体积(base64 入 JSON)——4 张×5MB 上限下可接受,超出后压缩为 v2 课题
- `chatViaRequestUrl` 降级路径未透传 images(Task 4 只改 buildRequestBody,降级路径共用该函数,天然生效)✓
- compact 全量摘要时含图 user 消息进摘要——摘要由 LLM 生成,图片无法进摘要属预期(压缩后模型看不到旧图,与文本被摘要同语义)

## 偏差表(相对 spec)

| Spec 条目 | Plan 实现 | 理由 |
|---|---|---|
| §4.2 ChatMessage.content 扩 multi-part 联合 | attachments 独立可选字段 | content 在 compact/token 链路按 string 处理,联合类型波及 6+ 文件;独立字段零破坏 |
| §4.3 Anthropic 适配器 base64 block | 不实现(无此适配器) | 仓库现状只有 DeepSeekLLM;Anthropic 支持待该适配器立项时一并做 |
| §4.4 Ollama 模型名启发式 | 端点级判断(localhost=true) | 与用户"报错是用户的事"决策一致;本地非视觉模型的错误由 Ollama 透传 |
| §4.1 持久化 spike(独立目录 vs 直存) | 直存 session JSON | 上限 4×5MB 可控;YAGNI,膨胀问题出现再优化 |

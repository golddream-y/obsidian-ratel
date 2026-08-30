# S-VISION 实施计划 — 图片消息真正发给模型

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **修订:** 2026-08-22 外审补强 — 跨模型会话防护(`supportsImages &&` 前置守卫)、测试 makeCtx 正规化、types 直接 import ports 类型、i18n key 归 `chat.error.*` 族。
> **修订 2:** 2026-08-22 **存储定稿 v1.3** — base64 **不**直存 session(`ctx.save()` 每回合全量读盘+序列化,agent-loop:357 必经,图片多时主线程卡顿);改 `AttachmentStore` write-once 外置 + 消息只存 `{id, mimeType}` 引用;hydrate 异步解析;Task 2 扩为 store+入库,Task 5 hydrate 改造。

**Goal:** 用户上传的图片随消息真正发给视觉模型;不支持图片的模型(DeepSeek)在发送时刻模态报错,不静默丢图。

**Architecture:** 端口中立引用贯穿 llm.ts → context-manager → 适配器:session 消息只存 `AttachmentRef {id, mimeType}`(KB 级),base64 由 `AttachmentStore` write-once 外置、出站时经 `toMessagesResolved` 解析成瞬态副本(v1.3);UI 层沿用现有 `Message.attachments` 渲染形态,hydrate 从引用异步还原。

**Tech Stack:** TypeScript(strict)、vitest、esbuild、Obsidian requestUrl(无新增依赖)

**Spec:** [S-VISION](./2026-08-20-vision-image-messages.md)

---

## 关键设计决策(plan 层细化)

1. **图片不进 `content` 联合,新增 `attachments?: AttachmentRef[]` 字段挂在 ChatMessage**。理由:`content` 在 compact/microcompact/tokenCount 全链路按 string 处理(`.map(m => m.content).join('')`),改成联合会波及 6+ 文件且老会话 JSON 兼容风险大;独立字段对旧数据天然兼容(缺省=无图)。**这是对 spec 4.2 的实现修正,记入偏差表。**
2. **持久化外置(v1.3 定稿,推翻初版「直存 session JSON」)**:`ctx.save()` 每回合全量读盘+序列化(agent-loop 收尾必经),base64 直存会让图片多的会话每发一条消息卡主线程几百毫秒。改为 `AttachmentStore` write-once 写 `pluginDir/attachments/<sessionId>/<hash>.json`,session 消息只存 `{id, mimeType}` 引用(KB 级);base64 仅存在于 pendingAttachments$ 与解析后的出站消息/渲染 URL,**永不进 session JSON**。GC = 会话删除整目录清走。spec v1.3 §4.1 已同步,不再是偏差。
3. **能力探测在 agent-loop 发送前**:`llm.supportsImages` 端口属性(默认 false,DeepSeek 适配器不覆写即不支持);agent-loop 在 LLM 调用前检查"本轮消息含图 && !supportsImages" → yield `error` 事件(code `VISION_UNSUPPORTED`)后 return,不调 LLM。**消息已入 session(用户改模型后重发可见),但轮次立即终止。**
4. **Ollama 走 OpenAICompatLLM 同一适配器**(main.ts 现状:单一 OpenAICompatLLM 承载 OpenAI 兼容端点),`supportsImages` 按端点判断:`isLocalHost(chatApiBase)`(现有函数)→ true(Ollama 原生支持 images 字段),OpenAI 风格请求体透传 `images` base64 数组。**透传必须带 `this.supportsImages &&` 前置判断**:本轮新图由 agent-loop 探测拦截,但历史含图消息(Ollama 会话中途切回 DeepSeek 续聊)仍会进 buildRequestBody——远端剥掉 images,会话可继续(与 compact 摘要后模型看不到旧图同语义),不静默污染远端请求。
5. **UI 错误展示走 `handleAgentError` 现有管道**,新增 code `VISION_UNSUPPORTED` 分支为自愈型提示(与 CANCELLED 同级,非红色错误条),符合用户"模态报错"决策。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/ports/llm.ts` | 改 | AttachmentRef 类型(id/mimeType/base64?)+ ChatMessage.attachments + LLMClient.supportsImages |
| `src/types.ts` | 改 | UserChatRequest.attachments(引用数组) |
| `src/core/attachment-store.ts` | 新 | write-once 落盘(内容 hash 寻址)/ Map 缓存读取 / removeSession 清目录(v1.3) |
| `src/core/context-manager.ts` | 改 | addUserMessage 接收引用;toMessagesResolved 出站解析(图片 token 已由 UI 层 attachmentTokens 计入,tokenCount 链路无需改) |
| `src/core/agent-loop.ts` | 改 | VISION_UNSUPPORTED 探测 + yield error;出站消息改走 toMessagesResolved |
| `src/adapters/llm-openai-compat.ts` | 改 | buildRequestBody 透传 images(localhost);supportsImages getter |
| `src/ui/chat/message-stream/hydrate-session-messages.ts` | 改 | user 分支还原附件:refs 经 AttachmentStore 异步解析(base64 回填现有 UI 渲染形态) |
| `src/ui/chat/ChatView.svelte` | 改 | sendMessage 先经 store 落盘得 refs 再传 ask |
| `src/main.ts` | 改 | ask 签名透传 attachments |
| `src/ui/chat/chat-error.ts` | 改 | VISION_UNSUPPORTED 分支 |
| `src/i18n/{zh,en,types}.ts` | 改 | 3 词条 |
| 测试 | 新 | context-manager 附件入库、agent-loop 探测、deepseek 请求体、hydrate 还原 |

---

### Task 0: 适配器正名 — DeepSeekLLM → OpenAICompatLLM(机械改名,零行为变化)

> 它本来就是通用 OpenAI 兼容家族适配器(任何 OpenAI 兼容端点都能挂),改名是把事实摆正,为将来第二只协议适配器(如 Anthropic 原生)腾出命名空间。本 plan 与 spec 文档中的路径/类名引用已统一为正名后形态。

**Files:**
- Rename(git mv 保历史): `src/adapters/llm-deepseek.ts` → `src/adapters/llm-openai-compat.ts`
- Rename: `tests/adapters/llm-deepseek.test.ts` → `tests/adapters/llm-openai-compat.test.ts`
- Modify: 类名与全部标识符 `DeepSeekLLM` → `OpenAICompatLLM`(含类注释自引用)
- Modify 引用点(已知共 3 处): `src/main.ts`(import 与构造)、`src/ui/diagnostics/llm-test.ts`、`tests/integration/settings-propagation.test.ts`

**红线:** 只改标识符与文件名。模型默认值 `deepseek-chat`、端点 `https://api.deepseek.com/v1`、`isLocalHost` 判断等行为语义一个字符都不动。

- [x] **Step 1: git mv 两个文件;全局替换类名标识符**

Run: `grep -rn "DeepSeekLLM\|llm-deepseek" src/ tests/`
Expected: 除模型名/端点字符串外零命中

- [x] **Step 2: 定向验证**

Run: `npx vitest run tests/adapters/llm-openai-compat.test.ts tests/integration/settings-propagation.test.ts && npx tsc -noEmit -skipLibCheck 2>&1 | grep -v "orbs/engine\|tests/" | head -10 && npm run build 2>&1 | tail -3`
Expected: 测试 PASS;typecheck 无**新增**错误(存量 orbs/tests 债除外);build 成功

- [x] **Step 3: Commit**

```bash
git add -A src/ tests/
git commit -m "refactor(adapters): DeepSeekLLM 正名 OpenAICompatLLM — 通用 OpenAI 兼容适配器,零行为变化"
```

---

### Task 1: 端口层 — AttachmentRef 类型与能力声明

**Files:**
- Modify: `src/ports/llm.ts`
- Test: `src/ports/llm.test.ts`(新建,类型编译验证为主)

- [x] **Step 1: 写类型测试(编译期验证)**

```typescript
/**
 * @file src/ports/llm.test.ts
 * @description 端口类型编译验证 — attachments 字段与能力声明(S-VISION)
 * @module ports/llm.test
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage, AttachmentRef } from './llm';

describe('ChatMessage attachments 类型', () => {
	it('AttachmentRef - 引用形态(id/mimeType)- 可赋值', () => {
		const ref: AttachmentRef = { id: 'h1', mimeType: 'image/png' };
		expect(ref.id).toBe('h1');
	});

	it('ChatMessage - attachments 可选 - 老消息形态不受影响', () => {
		const legacy: ChatMessage = { role: 'user', content: 'hi' };
		const withImg: ChatMessage = {
			role: 'user',
			content: '看这张图',
			attachments: [{ id: 'h1', mimeType: 'image/png' }],
		};
		expect(legacy.attachments).toBeUndefined();
		expect(withImg.attachments?.length).toBe(1);
	});
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/ports/llm.test.ts`
Expected: FAIL — `AttachmentRef` 不存在(编译错误)

- [x] **Step 3: 实现 llm.ts 扩展**

在 `GenerationOptions` 之前插入:

```typescript
/**
 * 图片附件引用(S-VISION v1.3)— session 里只存 {id, mimeType};
 * base64 仅在出站解析副本上出现(见 context-manager.toMessagesResolved),持久层永不含。
 * id = 内容 hash(AttachmentStore 文件名);base64 不含 `data:` 前缀。
 */
export interface AttachmentRef {
	id: string;
	mimeType: string;
	base64?: string;
}
```

`ChatMessage` 接口追加字段(`reasoning` 之前):

```typescript
	/** 图片附件引用 — 仅 user 消息;适配器按端点能力构造 vision 格式或拒绝 */
	attachments?: AttachmentRef[];
```

`LLMClient` 接口追加(`chat` 之后):

```typescript
	/**
	 * 当前端点是否支持图片输入(S-VISION)。
	 * agent-loop 发送前探测:含图 && 不支持 → 直接报错,不静默丢图。
	 */
	supportsImages: boolean;
```

- [x] **Step 4: 运行测试通过**

Run: `npx vitest run src/ports/llm.test.ts`
Expected: PASS(2 个用例)

- [x] **Step 5: typecheck 确认存量实现不破**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | head -20`
Expected: OpenAICompatLLM 报缺 `supportsImages`(预期,Task 4 补);其余无新增错误

- [x] **Step 6: Commit**

```bash
git add src/ports/llm.ts src/ports/llm.test.ts
git commit -m "feat(vision): 端口层 AttachmentRef 引用类型与 supportsImages 能力声明"
```

---

### Task 2: attachment-store 与 context-manager 入库(v1.3)

**Files:**
- Create: `src/core/attachment-store.ts`
- Modify: `src/core/context-manager.ts`(addUserMessage 二参 refs;新增 toMessagesResolved 出站解析)
- Test: `src/core/attachment-store.test.ts`(新建)、`src/core/context-manager-attachments.test.ts`(新建)

- [x] **Step 1: 写失败测试(store + 入库)**

```typescript
/**
 * @file src/core/attachment-store.test.ts
 * @description 附件外置存储 — write-once / 缓存读取 / 会话清理(S-VISION v1.3)
 * @module core/attachment-store.test
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from './attachment-store';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'att-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('AttachmentStore', () => {
	it('save - 同内容两次 - 同 id 只写一份(内容 hash 寻址)', async () => {
		const store = new AttachmentStore(dir);
		const a = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		const b = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		expect(a.id).toBe(b.id);
	});

	it('load - Map 缓存命中 - 磁盘删除后仍可读(每运行每图只读一次盘)', async () => {
		const store = new AttachmentStore(dir);
		const { id } = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		await store.load('s1', id);
		await rm(join(dir, 's1'), { recursive: true, force: true });
		expect((await store.load('s1', id))!.base64).toBe('aGk=');
	});

	it('load - 文件缺失 - 返回 null(渲染/出站双侧降级)', async () => {
		const store = new AttachmentStore(dir);
		expect(await store.load('s1', 'nope')).toBeNull();
	});

	it('removeSession - 整目录清走且缓存键失效 - 其他会话不受影响', async () => {
		const store = new AttachmentStore(dir);
		await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		await store.save('s2', { mimeType: 'image/png', base64: 'aGg=' });
		await store.removeSession('s1');
		await expect(stat(join(dir, 's1'))).rejects.toThrow();
		await expect(stat(join(dir, 's2'))).resolves.toBeTruthy();
	});
});
```

```typescript
/**
 * @file src/core/context-manager-attachments.test.ts
 * @description 引用入库与出站解析测试(S-VISION v1.3)— session 里只有 KB 级引用
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

describe('addUserMessage 引用', () => {
	it('带引用 - 存入 session.messages - 只存 {id,mimeType},不含 base64', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		const refs = [{ id: 'h1', mimeType: 'image/png' }];
		ctx.addUserMessage('看图', refs);
		const transcript = ctx.getTranscript();
		const last = transcript[transcript.length - 1]!;
		expect(last.attachments).toEqual(refs);
		expect(JSON.stringify(last)).not.toContain('aGk=');
	});

	it('无引用 - attachments 缺省 - 老形态不变', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		ctx.addUserMessage('纯文本');
		const t2 = ctx.getTranscript();
		expect(t2[t2.length - 1]!.attachments).toBeUndefined();
	});
});

describe('toMessagesResolved 出站解析', () => {
	it('refs + store - 解析为带 base64 的出站副本 - 原会话不被污染', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		ctx.addUserMessage('看图', [{ id: 'h1', mimeType: 'image/png' }]);
		const out = await ctx.toMessagesResolved({ load: async () => ({ mimeType: 'image/png', base64: 'aGk=' }) });
		const lastOut = out[out.length - 1]!;
		expect(lastOut.attachments![0]).toEqual({ id: 'h1', mimeType: 'image/png', base64: 'aGk=' });
		expect(ctx.getTranscript()[ctx.getTranscript().length - 1]!.attachments![0]).not.toHaveProperty('base64');
	});

	it('单图解析失败 - 剥掉该图不阻塞本轮', async () => {
		const ctx = makeCtx();
		await ctx.load('s1');
		ctx.addUserMessage('看图', [{ id: 'gone', mimeType: 'image/png' }]);
		const out = await ctx.toMessagesResolved({ load: async () => null });
		expect(out[out.length - 1]!.attachments).toEqual([]);
	});
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/core/attachment-store.test.ts src/core/context-manager-attachments.test.ts`
Expected: FAIL — `AttachmentStore` 不存在 / `addUserMessage` 第二参不存在(编译错)

- [x] **Step 3: 实现 AttachmentStore + context-manager 扩展**

`src/core/attachment-store.ts`(新):

```typescript
/**
 * @file src/core/attachment-store.ts
 * @description 图片附件外置存储 — write-once 落盘、缓存读取、会话级清理(S-VISION v1.3)
 * @module core/attachment-store
 * @depends node:fs/promises, node:crypto
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 落盘的附件内容(write-once 文件体) */
export interface StoredAttachment {
	mimeType: string;
	base64: string;
}

/**
 * 图片附件外置存储。
 *
 * 设计要点:
 * - session JSON 只存 {id, mimeType} 引用(KB 级)——ctx.save() 每回合全量序列化,
 *   base64 直存会让图片多的会话每回合卡顿(spec v1.3 §4.1)
 * - 内容 hash 寻址,write-once 天然去重(限会话内)
 * - Map 缓存:每次应用运行每图只读盘一次(hydrate 渲染与每回合出站共用)
 */
export class AttachmentStore {
	private readonly cache = new Map<string, StoredAttachment>();

	constructor(private readonly rootDir: string) {}

	/** 会话附件目录:<rootDir>/<sessionId>(会话删除整目录清走,GC 零逻辑) */
	private dir(sessionId: string): string {
		return join(this.rootDir, sessionId);
	}

	/** 内容寻址短 hash 作文件名 */
	private idFor(att: StoredAttachment): string {
		return createHash('sha256').update(att.base64).digest('hex').slice(0, 16);
	}

	/**
	 * write-once 保存:同内容重复发送直接复用,不重写文件。
	 *
	 * @returns 存入 session 消息的引用 {id, mimeType}
	 */
	async save(sessionId: string, att: StoredAttachment): Promise<{ id: string; mimeType: string }> {
		const id = this.idFor(att);
		this.cache.set(`${sessionId}/${id}`, att);
		await mkdir(this.dir(sessionId), { recursive: true });
		// 关键路径:write-once —— 文件已存在即跳过写入,避免同图重复 IO
		try {
			await readFile(join(this.dir(sessionId), `${id}.json`));
		} catch {
			await writeFile(join(this.dir(sessionId), `${id}.json`), JSON.stringify(att));
		}
		return { id, mimeType: att.mimeType };
	}

	/**
	 * 读取附件内容;缓存命中不读盘;文件缺失返回 null(渲染占位 / 出站剥除)。
	 */
	async load(sessionId: string, id: string): Promise<StoredAttachment | null> {
		const key = `${sessionId}/${id}`;
		const hit = this.cache.get(key);
		if (hit) return hit;
		try {
			const raw = JSON.parse(await readFile(join(this.dir(sessionId), `${id}.json`), 'utf8')) as StoredAttachment;
			this.cache.set(key, raw);
			return raw;
		} catch {
			return null;
		}
	}

	/**
	 * 会话删除时整目录清走;对应缓存键一并失效。
	 *
	 * @throws rm 失败时抛原错误(目录不存在视为已清,不抛)。
	 */
	async removeSession(sessionId: string): Promise<void> {
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(`${sessionId}/`)) this.cache.delete(key);
		}
		await rm(this.dir(sessionId), { recursive: true, force: true });
	}
}
```

`src/core/context-manager.ts` 两处扩展:

```typescript
	/**
	 * 追加用户消息。
	 *
	 * @param content - 用户消息文本。
	 * @param refs - 可选图片附件引用(S-VISION v1.3);只存 KB 级 {id, mimeType},
	 *               base64 永不入 session(见 AttachmentStore)。
	 * @throws 在 `load()` 之前调用会抛 'Session not loaded'。
	 */
	addUserMessage(content: string, refs?: AttachmentRef[]): void {
		const session = this.requireSession();
		const msg: ChatMessage = { role: 'user', content };
		// 关键路径:有图才写字段,老会话 JSON 不出现空数组污染;引用不含 base64
		if (refs && refs.length > 0) {
			msg.attachments = refs.map((r) => ({ id: r.id, mimeType: r.mimeType }));
		}
		session.messages.push(msg);
		session.updatedAt = Date.now();
	}

	/**
	 * 出站消息解析:把 user 消息里的附件引用解析回 base64(仅内存瞬态)。
	 *
	 * 设计要点:
	 * - 返回新数组,绝不改写 session 内消息(出站副本,原引用保持干净)
	 * - store 缺失(纯文本端点)原样返回;单图解析失败剥掉该图不阻塞本轮
	 *
	 * @param store - AttachmentStore(或同形测试替身);undefined 时不解析。
	 * @returns 可直接进 ChatRequest 的消息数组;含 base64 的引用仅存在于该副本。
	 */
	async toMessagesResolved(
		store: { load(sessionId: string, id: string): Promise<StoredAttachment | null> } | undefined,
		intent: Intent = 'direct',
	): Promise<ChatMessage[]> {
		const msgs = this.toMessages(intent);
		if (!store) return msgs;
		return Promise.all(
			msgs.map(async (m) => {
				if (m.role !== 'user' || !m.attachments?.length) return m;
				const resolved: AttachmentRef[] = [];
				for (const ref of m.attachments) {
					const hit = await store.load(this.sessionId, ref.id);
					// 关键路径:解析成功才带 base64 出站;失败剥除(历史图容错)
					if (hit) resolved.push({ ...ref, base64: hit.base64 });
				}
				return { ...m, attachments: resolved };
			}),
		);
	}
```

顶部 import 调整:`import type { ToolCall, ToolDefinition, AttachmentRef } from '../ports/llm';` 与 `import type { StoredAttachment } from './attachment-store';`

- [x] **Step 4: 运行测试通过**

Run: `npx vitest run src/core/attachment-store.test.ts src/core/context-manager-attachments.test.ts`
Expected: PASS(8 个用例:store 4 + ctx 4)

- [x] **Step 5: Commit**

```bash
git add src/core/attachment-store.ts src/core/attachment-store.test.ts src/core/context-manager.ts src/core/context-manager-attachments.test.ts
git commit -m "feat(vision): 附件外置存储 write-once 落盘,session 只存引用(v1.3)"
```

---

### Task 3: agent-loop — 发送前能力探测与 VISION_UNSUPPORTED

**Files:**
- Modify: `src/core/agent-loop.ts`(addUserMessage 调用点 + LLM 调用前探测)
- Modify: `src/types.ts:107-110`(UserChatRequest)
- Test: `src/core/agent-loop-vision.test.ts`(新建)

- [x] **Step 1: 写失败测试**

```typescript
/**
 * @file src/core/agent-loop-vision.test.ts
 * @description VISION_UNSUPPORTED 探测测试 — 含图且模型不支持时轮次终止(S-VISION)
 * @module core/agent-loop-vision.test
 */
import { describe, it, expect } from 'vitest';
import { agentLoop } from './agent-loop';
import { ContextManager } from './context-manager';
import type { Persistence } from '../ports/persistence';
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
				{ sessionId: 's', message: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx(),
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
				{ sessionId: 's', message: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx(),
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
				makeCtx(),
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls.length).toBeGreaterThan(0);
	});
});

// 与 Task 2 同款 fake Persistence + ContextManager 构造
function makeCtx(): ContextManager {
	const empty: Persistence = {
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
	return new ContextManager(empty, undefined, 8000);
}
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/core/agent-loop-vision.test.ts`
Expected: FAIL — UserChatRequest 无 attachments 字段(编译错)

- [x] **Step 3: 实现 types.ts 扩展**

```typescript
import type { AttachmentRef } from './ports/llm';

export interface UserChatRequest {
	sessionId: string;
	message: string;
	/** 图片附件(S-VISION)— ChatView 从 pendingAttachments$ 取,随消息进 agent-loop */
	attachments?: AttachmentRef[];
}
```

注:`types.ts` 直接 import ports 的 `AttachmentRef`,不内联同构类型,防两份定义漂移。

- [x] **Step 4: 实现 agent-loop 探测**

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

- [x] **Step 4.5: 出站解析接线(v1.3)**

agentLoop 签名追加可选末参(插在 `skipAddUserMessage` 之后):

```typescript
	attachmentStore?: {
		load(sessionId: string, id: string): Promise<{ mimeType: string; base64: string } | null>;
	},
```

函数内构造 LLM 请求的 `ctx.toMessages(...)` 调用点改为:

```typescript
		// 关键路径(S-VISION v1.3):出站前把引用解析回 base64 —— 仅内存瞬态副本,
		// session 内消息保持 KB 级引用不被污染;store 未注入时原样直通。
		const messages = await ctx.toMessagesResolved(attachmentStore, intent);
```

(main.ts 在 Task 5 注入实例;本步先让签名与调用点就位,fake store 测试已在 Task 2 覆盖解析语义。)

- [x] **Step 5: 运行测试通过**

Run: `npx vitest run src/core/agent-loop-vision.test.ts`
Expected: PASS(3 个用例)

- [x] **Step 6: Commit**

```bash
git add src/types.ts src/core/agent-loop.ts src/core/agent-loop-vision.test.ts
git commit -m "feat(vision): agent-loop 发送前探测图片能力,不支持时 VISION_UNSUPPORTED 终止"
```

---

### Task 4: DeepSeek 适配器 — supportsImages 与 images 透传

**Files:**
- Modify: `src/adapters/llm-openai-compat.ts`(supportsImages getter + buildRequestBody images)
- Test: `src/adapters/llm-openai-compat-vision.test.ts`(新建)

- [x] **Step 1: 写失败测试**

```typescript
/**
 * @file src/adapters/llm-openai-compat-vision.test.ts
 * @description 适配器图片支持测试 — localhost(Ollama)透传 images(S-VISION)
 * @module adapters/llm-openai-compat-vision.test
 */
import { describe, it, expect } from 'vitest';
import { OpenAICompatLLM } from './llm-openai-compat';

describe('OpenAICompatLLM 图片支持', () => {
	it('localhost 端点 - supportsImages 为 true', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		expect(llm.supportsImages).toBe(true);
	});

	it('远端端点 - supportsImages 为 false', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' });
		expect(llm.supportsImages).toBe(false);
	});

	it('buildRequestBody - user 消息带附件 - localhost 时透传 images 数组', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(Array.isArray(messages[0]!.images)).toBe(true);
		expect((messages[0]!.images as string[])[0]).toBe('aGk=');
	});

	it('buildRequestBody - 无附件 - 不出现 images 字段', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [{ role: 'user', content: '纯文本' }],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
	});

	it('buildRequestBody - 远端端点 + 历史含图消息 - 不透传 images(防跨模型会话污染)', () => {
		// 场景:用户先在 Ollama(llava)下发了带图消息,之后切回 DeepSeek 续聊同一会话。
		// 本轮无新图,agent-loop 探测放行,但历史含图消息仍会进 buildRequestBody —
		// 远端必须剥掉 images,否则 DeepSeek API 收到未知字段报 400。
		const llm = new OpenAICompatLLM({ apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
	});
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/adapters/llm-openai-compat-vision.test.ts`
Expected: FAIL — `supportsImages` 不存在

- [x] **Step 3: 实现适配器扩展**

`OpenAICompatLLM` 类内,构造器后加:

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
			// 关键路径(S-VISION):Ollama 原生接受 messages[].images(base64 数组)。
			// 必须带 this.supportsImages 前置判断:本轮新图由 agent-loop 探测拦截,
			// 但历史含图消息(Ollama 会话中途切回 DeepSeek 续聊)仍会走到这里 —
			// 远端剥掉 images(与 compact 摘要后模型看不到旧图同语义),会话可继续。
			if (this.supportsImages && m.role === 'user' && m.attachments && m.attachments.length > 0) {
				msg.images = m.attachments.map((a) => a.base64);
			}
```

- [x] **Step 4: 运行测试通过**

Run: `npx vitest run src/adapters/llm-openai-compat-vision.test.ts`
Expected: PASS(5 个用例)

- [x] **Step 5: 全量 typecheck**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | head -20`
Expected: 无 supportsImages 相关错误

- [x] **Step 6: Commit**

```bash
git add src/adapters/llm-openai-compat.ts src/adapters/llm-openai-compat-vision.test.ts
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

- [x] **Step 1: 写 hydrate 失败测试**

```typescript
/**
 * @file src/ui/chat/message-stream/hydrate-vision.test.ts
 * @description hydrate 还原图片附件测试(S-VISION)
 * @module ui/chat/message-stream/hydrate-vision.test
 */
import { describe, it, expect } from 'vitest';
import { hydrateSessionMessages } from './hydrate-session-messages';

describe('hydrate 图片引用', () => {
	it('user 消息带 refs - 经 store 解析 - 还原为 Message.attachments(base64 回填)', async () => {
		const out = await hydrateSessionMessages(
			[
				{
					role: 'user' as const,
					content: '看图',
					attachments: [{ id: 'h1', mimeType: 'image/png' }],
				},
			],
			{ load: async () => ({ mimeType: 'image/png', base64: 'aGk=' }) },
			's1',
		);
		expect(out[0]!.role).toBe('user');
		expect(out[0]!.attachments).toEqual([{ fileName: '', mimeType: 'image/png', base64: 'aGk=' }]);
	});

	it('解析失败的单图 - 剥除不阻塞(与出站同语义)', async () => {
		const out = await hydrateSessionMessages(
			[{ role: 'user' as const, content: '看图', attachments: [{ id: 'gone', mimeType: 'image/png' }] }],
			{ load: async () => null },
			's1',
		);
		expect(out[0]!.attachments).toBeUndefined();
	});

	it('user 消息无 attachments - Message.attachments 缺省', async () => {
		const out = await hydrateSessionMessages([{ role: 'user' as const, content: '纯文本' }], undefined, 's1');
		expect(out[0]!.attachments).toBeUndefined();
	});
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts`
Expected: FAIL — 现实现不同步还原 attachments(且签名尚无 store 参)

- [x] **Step 3: 实现 hydrate 异步解析(v1.3)**

`hydrateSessionMessages` 改为 async 并前置解析(store 的 Map 缓存保证每图每次运行只读一次盘):

```typescript
/**
 * 会话原始消息 → UI 消息条目。
 *
 * @param store - AttachmentStore(或同形替身);缺省时含图消息按无图处理(纯文本降级)。
 * @param sessionId - 附件寻址用(目录按会话分域)。
 */
export async function hydrateSessionMessages(
	raw: ChatMessage[],
	store?: { load(sessionId: string, id: string): Promise<StoredAttachment | null> },
	sessionId = '',
): Promise<UiEntry[]> {
	// 关键路径(S-VISION v1.3):refs → base64 异步预解析;
	// 解析失败剥除该附件(与出站 toMessagesResolved 同语义),其余走原同步构建。
	const resolvedByMsg = new Map<number, Array<{ fileName: string; mimeType: string; base64: string }>>();
	if (store) {
		await Promise.all(
			raw.map(async (m, i) => {
				if (m.role !== 'user' || !m.attachments?.length) return;
				const atts: Array<{ fileName: string; mimeType: string; base64: string }> = [];
				for (const ref of m.attachments) {
					const hit = await store.load(sessionId, ref.id);
					if (hit) atts.push({ fileName: '', mimeType: hit.mimeType, base64: hit.base64 });
				}
				if (atts.length > 0) resolvedByMsg.set(i, atts);
			}),
		);
	}
	return buildUiEntries(raw, resolvedByMsg);
}
```

`buildUiEntries` 增加 `resolvedByMsg` 参数,user 分支改为查表:

```typescript
		if (m.role === 'user') {
			const atts = resolvedByMsg.get(i);
			out.push({
				message: {
					id: newMessageId(),
					role: 'user',
					segments: [{ type: 'text', text: m.content }],
					// fileName 仅展示用,落盘引用无文件名,还原置空串
					...(atts ? { attachments: atts } : {}),
				},
				lastRawIndex: i,
			});
			i++;
			continue;
		}
```

- [x] **Step 4: 运行测试通过**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts`
Expected: PASS(3 个用例)

- [x] **Step 5: i18n 三文件加词条**

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

- [x] **Step 6: chat-error.ts 加分支**

`formatChatError` 内 CANCELLED 分支后加:

```typescript
	if (code === 'VISION_UNSUPPORTED') {
		// 关键路径(S-VISION):自愈型提示 — 与取消同语义,非红色错误条
		return { type: 'runtime', message: tNow('chat.error.visionUnsupported') };
	}
```

- [x] **Step 7: ChatView sendMessage 先落盘得 refs 再传 ask(v1.3)**

`const events = plugin.ask(sessionId, text, ac.signal);`(L1121)改为:

```typescript
			// 关键路径(S-VISION v1.3):发送前 write-once 落盘,ask 只传 KB 级引用;
			// base64 从 pendingAttachments$ 直接进 AttachmentStore,不落 session JSON
			const refs: AttachmentRef[] = [];
			for (const att of currentAttachments) {
				refs.push(await plugin.attachments.save(sessionId, att));
			}
			const events = plugin.ask(sessionId, text, ac.signal, refs.length > 0 ? refs : undefined);
```

(ChatView 顶部补 `import type { AttachmentRef } from '../../ports/llm';`;气泡 UI 展示沿用现有 `currentAttachments`,不依赖 refs。)

- [x] **Step 8: main.ts 装配 store 与 ask 签名扩展**

onload 装配(与 GoalStore 同层):

```typescript
		this.attachments = new AttachmentStore(join(this.manifest.dir, 'attachments'));
```

(main.ts 顶部补 `import { AttachmentStore } from './core/attachment-store';` 与 `import { join } from 'node:path';`;Plugin 类加 `attachments: AttachmentStore;` 字段声明。)

ask 签名:

```typescript
	async *ask(
		sessionId: string,
		message: string,
		signal?: AbortSignal,
		attachments?: AttachmentRef[],
	): AsyncIterable<AgentEvent> {
```

函数体内 agentLoop 调用处(L1458 起,现有 11 个实参全保留)末尾追加第 12 参:

```typescript
				for await (const ev of agentLoop(
					{ sessionId, message, attachments },
					ctx,
					this.llm,
					this.tools,
					this.hooks,
					signal,
					intentClassifier,
					toolPermissionCheck,
					this.settings.agentMaxSteps,
					this.skillActivator,
					skipAdd,
					this.attachments, // ← v1.3 新增:出站解析用(Task 3 Step 4.5)
				)) {
```

会话删除入口同步清理附件目录:

```typescript
		await this.attachments.removeSession(sessionId); // 与 ctx.deleteSession 同点调用
```

hydrate 调用点(message-stream 会话加载处)传入 `plugin.attachments` 与 sessionId。

- [x] **Step 9: 运行相关测试 + typecheck + build**

Run: `npx vitest run src/ui/chat/message-stream/hydrate-vision.test.ts && npx tsc -noEmit -skipLibCheck 2>&1 | head -20 && npm run build 2>&1 | tail -5`
Expected: 测试 PASS;typecheck 无新错误;build 成功

- [x] **Step 10: Commit**

```bash
git add src/ui/chat/ChatView.svelte src/main.ts src/ui/chat/message-stream/hydrate-session-messages.ts src/ui/chat/chat-error.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts src/ui/chat/message-stream/hydrate-vision.test.ts
git commit -m "feat(vision): 发送链路透传附件、hydrate 还原图片、不支持时自愈提示"
```

---

### Task 6: 端到端验证与收尾

**Files:**
- 无新增;全量验证

- [x] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS(存量 + 本 plan 新增 21 个用例:T1 端口 2 / T2 store+ctx 8 / T3 探测 3 / T4 适配器 5 / T5 hydrate 3)

- [x] **Step 2: typecheck**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | grep -v orbs/engine | head -10`
Expected: 无新增错误(orb 存量错误除外)

- [x] **Step 3: build 产物检查**

Run: `npm run build && ls -la dist/main.js`
Expected: build 成功,产物存在

- [x] **Step 4: 手动验证(本地 Sandbox)**

1. `npm run build` 后 Reload Obsidian Sandbox
2. 上传图片 + 提问(DOUBLE_CONFIRM:DeepSeek 官方端点)→ 气泡出「当前模型不支持图片输入」自愈提示(单测覆盖;手测主路径为 OpenRouter 视觉模型)
3. 切视觉模型(OpenRouter / localhost Ollama)→ 模型能描述图片内容 — **用户已确认「可以了」**
4. 发送后预览栏立即清空 — 已修;持久化走 AttachmentStore 引用 + hydrate

- [x] **Step 5: 文档同步确认(AGENTS.md 文档同步规则)**

CHANGELOG `[Unreleased]` + user-guide §3.1 已写。README 英/中功能清单是否加「带图提问」待用户确认(不阻塞合入)。

- [x] **Step 6: Commit(若有文档同步)**

随 feat/p-vision-1 squash 一次提交合入 develop,不单拆 docs commit。

```bash
git add README.md docs/user-guide.md CHANGELOG.md
git commit -m "docs(vision): 图片消息功能文档同步"
```

---

## 自审

**Spec 覆盖:**
- spec §2.1 图片随消息发给模型 → Task 1/2/3/4/5 全链路 ✓
- spec §2.2 Anthropic base64 block → **偏差**:当前仓库无 Anthropic 适配器(只有 OpenAICompatLLM 承载 OpenAI 兼容端点),spec 提到的"Anthropic 适配器"不存在;实际可用的视觉路径是 localhost Ollama(images 透传)。记入偏差表。
- spec §2.3 不支持时模态报错 → Task 3(VISION_UNSUPPORTED)+ Task 5(自愈提示+引导文案)✓
- spec §2.4 会话持久化含图片 → Task 2(AttachmentStore 外置 + 引用入库)+ Task 5(hydrate 经 store 还原)✓(v1.3 定稿)
- spec §2.5 token 预算保持 → 现状 attachmentTokens 已计入(UI 层),发送链路不变,无需新任务 ✓
- spec §4.1 MessageSegment 扩 image 段 → **偏差**:改为 ChatMessage.attachments 引用字段 + AttachmentStore 外置(见关键设计决策 1/2),UI 渲染沿用现有 msg.attachments 形态,不动 segments 联合。理由:改动面减半、老数据兼容、落盘体积与图片数解耦。spec v1.3 已同步回写。
- spec §4.4 Ollama 模型名启发式判断 → **简化**:不做模型名启发式;supportsImages 按端点(localhost)判断,本地非视觉模型由 Ollama 侧报错透传给用户(与用户"报错就行,那是用户的事儿"决策一致)。
- spec §4.6 i18n → Task 5 Step 5 ✓

**占位符扫描:** 无 TBD/TODO;所有代码块完整可落地。

**类型一致性:** `AttachmentRef`(ports)→ `ChatMessage.attachments` → `UserChatRequest.attachments`(types.ts 直接 import,单一事实源)→ `ask(sessionId, message, signal, refs)` → `ctx.addUserMessage(content, refs)` 签名一致;`supportsImages` 在 LLMClient/OpenAICompatLLM/测试 fake 三处同名同型。

**跨模型会话防护(审查补强):** 历史含图消息(Ollama 会话中途切回 DeepSeek 续聊)在 buildRequestBody 层被 `this.supportsImages &&` 守卫剥掉 images——本轮新图由 agent-loop 报错(用户决策),历史图静默剥除(与 compact 摘要同语义,会话可继续),两层防护互补。已补测试用例覆盖。

**已知风险:**
- 附件目录孤儿文件(用户不经删除流程手删 session JSON)——v1 接受;「清理未引用附件」设置页入口为候选后续
- hydrate 变异步:首次打开含图会话多一轮附件读盘(store Map 缓存后零成本);调用方需 await(Task 5 Step 8 已列)
- `chatViaRequestUrl` 降级路径未透传 images(Task 4 只改 buildRequestBody,降级路径共用该函数,天然生效)✓
- compact 全量摘要时含图 user 消息进摘要——摘要由 LLM 生成,图片无法进摘要属预期(压缩后模型看不到旧图,与文本被摘要同语义)
- 重开/hydrate 后历史含图消息不计入用量条(`attachmentTokens` 仅发送时刻计算)——低估可接受,v2 再议(spec v1.3 §4.1 已知限制已记录)

## 偏差表(相对 spec)

| Spec 条目 | Plan 实现 | 理由 |
|---|---|---|
| §4.2 ChatMessage.content 扩 multi-part 联合 | attachments 独立可选字段 | content 在 compact/token 链路按 string 处理,联合类型波及 6+ 文件;独立字段零破坏 |
| §4.3 Anthropic 适配器 base64 block | 不实现(无此适配器) | 仓库现状只有 OpenAICompatLLM;Anthropic 支持待该适配器立项时一并做 |
| §4.4 Ollama 模型名启发式 | 端点级判断(localhost=true) | 与用户"报错是用户的事"决策一致;本地非视觉模型的错误由 Ollama 透传 |
| §4.6 词条名 `chat.vision.notSupported` | `chat.error.visionUnsupported` | 贴合现有 `chat.error.*` 命名结构(stopped/compactFailed/attachmentInvalid 同族) |

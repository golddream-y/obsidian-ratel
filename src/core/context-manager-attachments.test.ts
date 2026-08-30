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

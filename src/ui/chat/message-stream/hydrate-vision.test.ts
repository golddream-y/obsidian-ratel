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

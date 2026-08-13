/**
 * @file tests/ui/chat/message-stream/hydrate-compact-markers.test.ts
 * @description hydrateSessionMessages 压缩标记分隔测试
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../../../src/ports/llm';
import { hydrateSessionMessages } from '../../../../src/ui/chat/message-stream/hydrate-session-messages';

describe('hydrateSessionMessages compact markers', () => {
	it('hydrateSessionMessages - 有 marker afterIndex=1 - 在第三条 UI 前插入 compact 分隔', () => {
		const raw: ChatMessage[] = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: 'c' },
		];
		const ui = hydrateSessionMessages(raw, {
			markers: [{ afterIndex: 1, summary: 's', restoredNotePaths: [], at: 1 }],
		});
		expect(ui.map((m) => m.role)).toEqual(['user', 'assistant', 'compact', 'user']);
		expect(ui[2]!.compactPhase).toBe('done');
	});
});

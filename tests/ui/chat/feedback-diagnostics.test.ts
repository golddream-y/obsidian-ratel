/**
 * @file tests/ui/chat/feedback-diagnostics.test.ts
 * @description 反馈诊断摘要 — 可附最近面包屑且不含笔记正文
 * @module tests/ui/chat/feedback-diagnostics
 */

import { describe, it, expect } from 'vitest';
import { buildFeedbackDiagnostics } from '../../../src/ui/chat/feedback-modal';

const plugin = {
	app: { appVersion: '1.13.0' },
	manifest: { version: '0.0.0-test', id: 'ratel-vault' },
	settings: { chatModel: 'm', embedProvider: 'local' as const, language: 'zh' },
};

describe('buildFeedbackDiagnostics', () => {
	it('buildFeedbackDiagnostics - 传入面包屑 - 附在末尾且不含用户消息', () => {
		const text = buildFeedbackDiagnostics(plugin as never, [
			'2026-09-15T03:06:00.000Z|ask.begin|537425|-|10|4|2',
		]);
		expect(text).toContain('Breadcrumbs (last 40, no message text):');
		expect(text).toContain('ask.begin|537425');
		expect(text).not.toContain('请帮我总结');
	});

	it('buildFeedbackDiagnostics - 无面包屑 - 行为与原来一致不含 Breadcrumbs 段', () => {
		const text = buildFeedbackDiagnostics(plugin as never);
		expect(text).not.toContain('Breadcrumbs');
		expect(text).toContain('Embed: local');
	});
});

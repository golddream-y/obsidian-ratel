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

	it('buildFeedbackDiagnostics - 宿主提供索引诊断 - 如实列出阶段/计数与缺少 epoch 保护', () => {
		const withIndex = {
			...plugin,
			indexDiagnostics: () => ({
				phase: 'stalled',
				committed: 3,
				total: 10,
				pending: 7,
				failed: 0,
				epochSourceMissing: true,
				recordsKind: 'unjudgeable' as const,
				recordsConfig: 'mismatch' as const,
				activeGenerationId: 'gen-0123456789abcdef',
			}),
		};
		const text = buildFeedbackDiagnostics(withIndex as never);

		expect(text).toContain('stalled');
		expect(text).toContain('3/10');
		expect(text).toContain('epoch');
		expect(text).toContain('unjudgeable');
		expect(text).toContain('gen-0123456789abcdef');
		// 关键路径:诊断只放计数与状态,不放笔记正文或密钥。
		expect(text).not.toContain('请帮我总结');
	});

	it('buildFeedbackDiagnostics - 宿主未提供索引诊断 - 不新增段(向后兼容)', () => {
		const text = buildFeedbackDiagnostics(plugin as never);
		expect(text).not.toContain('Index phase');
		expect(text).not.toContain('epoch');
	});
});

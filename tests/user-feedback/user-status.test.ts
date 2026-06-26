import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { UserStatus, DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('UserStatus', () => {
	let status: UserStatus;

	beforeEach(() => {
		status = new UserStatus();
	});

	it('初始 - 默认值', () => {
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});

	it('patch - 浅合并字段', () => {
		status.patch({ model: 'ready', indexDocCount: 42 });
		expect(get(status.statusBar$).model).toBe('ready');
		expect(get(status.statusBar$).indexDocCount).toBe(42);
		expect(get(status.statusBar$).embedding).toBe('loading');
	});

	it('reset - 恢复默认', () => {
		status.patch({ model: 'failed' });
		status.reset();
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});

	// ==================== contextUsage$ ====================

	it('contextUsage$ - 初始为 0/0', () => {
		expect(get(status.contextUsage$)).toEqual({
			usedTokens: 0,
			maxTokens: 0,
			attachmentTokens: 0,
			percentage: 0,
		});
	});

	it('patchContextUsage - 更新 usedTokens 并自动算 percentage', () => {
		status.patchContextUsage({ usedTokens: 1000, maxTokens: 10000 });
		const snap = get(status.contextUsage$);
		expect(snap.usedTokens).toBe(1000);
		expect(snap.maxTokens).toBe(10000);
		expect(snap.percentage).toBe(10);
	});

	it('patchContextUsage - maxTokens 为 0 时 percentage 防除零', () => {
		status.patchContextUsage({ usedTokens: 500, maxTokens: 0 });
		expect(get(status.contextUsage$).percentage).toBe(0);
	});

	// ==================== pendingAttachments$ ====================

	it('pendingAttachments$ - 初始为空数组', () => {
		expect(get(status.pendingAttachments$)).toEqual([]);
	});

	it('addAttachment - 追加并返回 id', () => {
		const id = status.addAttachment({
			fileName: 'a.png',
			mimeType: 'image/png',
			base64: 'iVBORw0KGgo=',
			estimatedTokens: 100,
		});
		expect(id).toBeTruthy();
		expect(get(status.pendingAttachments$)).toHaveLength(1);
		expect(get(status.pendingAttachments$)[0]!.fileName).toBe('a.png');
	});

	it('removeAttachment - 按 id 移除', () => {
		const id1 = status.addAttachment({ fileName: 'a.png', mimeType: 'image/png', base64: 'x', estimatedTokens: 100 });
		status.addAttachment({ fileName: 'b.jpg', mimeType: 'image/jpeg', base64: 'y', estimatedTokens: 200 });
		status.removeAttachment(id1);
		const list = get(status.pendingAttachments$);
		expect(list).toHaveLength(1);
		expect(list[0]!.fileName).toBe('b.jpg');
	});

	it('clearAttachments - 清空', () => {
		status.addAttachment({ fileName: 'a.png', mimeType: 'image/png', base64: 'x', estimatedTokens: 100 });
		status.clearAttachments();
		expect(get(status.pendingAttachments$)).toEqual([]);
	});

	it('reset - 同时恢复 contextUsage$ 与 pendingAttachments$', () => {
		status.patchContextUsage({ usedTokens: 500, maxTokens: 10000 });
		status.addAttachment({ fileName: 'a.png', mimeType: 'image/png', base64: 'x', estimatedTokens: 100 });
		status.reset();
		expect(get(status.contextUsage$).usedTokens).toBe(0);
		expect(get(status.pendingAttachments$)).toEqual([]);
	});
});

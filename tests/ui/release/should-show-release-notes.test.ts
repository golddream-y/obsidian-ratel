import { describe, expect, it } from 'vitest';
import { buildReleaseNotesMarkdown } from '../../../src/ui/release/release-notes-view';
import { shouldShowReleaseNotes } from '../../../src/ui/release/should-show-release-notes';

describe('shouldShowReleaseNotes', () => {
	it('shouldShowReleaseNotes - 从未看过 - 打开', () => {
		expect(shouldShowReleaseNotes('', '1.0.0')).toBe(true);
	});

	it('shouldShowReleaseNotes - 版本变了 - 打开', () => {
		expect(shouldShowReleaseNotes('0.10.0', '1.0.0')).toBe(true);
	});

	it('shouldShowReleaseNotes - 同一版本 - 不再打开', () => {
		expect(shouldShowReleaseNotes('1.0.0', '1.0.0')).toBe(false);
	});

	it('buildReleaseNotesMarkdown - 当前版本 - 含任务与配置两节', () => {
		const md = buildReleaseNotesMarkdown('1.0.1', '1.14.0');
		expect(md.startsWith('# Ratel 1.0.1')).toBe(true);
		expect(md).toContain('Obsidian 1.14.0');
		expect(md).not.toContain('1.13.1');
		expect(md).toContain('## 从一个具体任务开始');
		expect(md).toContain('## 配好模型，完成第一次提问');
	});
});

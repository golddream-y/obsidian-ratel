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

	it('buildReleaseNotesMarkdown - 当前版本 - 含更新与配置两节', () => {
		const md = buildReleaseNotesMarkdown('1.0.0');
		expect(md.startsWith('# Ratel 1.0.0')).toBe(true);
		expect(md).toContain('## 更新了什么');
		expect(md).toContain('## 模型怎么配');
	});
});

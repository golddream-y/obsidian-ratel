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

	it('buildReleaseNotesMarkdown - 当前版本 - 含更新与升级提醒两节', () => {
		const md = buildReleaseNotesMarkdown('1.2.1', '1.14.0');
		expect(md.startsWith('# Ratel 1.2.1')).toBe(true);
		expect(md).toContain('Obsidian 1.14.0');
		expect(md).not.toContain('1.13.1');
		expect(md).toContain('## 本次更新');
		expect(md).toContain('## 升级后');
		expect(md).toContain('重启复用已保存索引');
		expect(md).toContain('失败不再显示完成');
		expect(md).toContain('旧索引若缺少完成记录');
		expect(md).not.toContain('首次启动会重建索引，期间搜索暂不可用');
	});
});

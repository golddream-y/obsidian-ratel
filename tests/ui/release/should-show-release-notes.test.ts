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

	// 关键路径:只断言结构,不钉死某一版的文案 —— 更新说明每版都会重写,
	// 把营销句子写进用例会让每次发版都红一次,而结构（标题 / 两节 / 条目数 / 最低版本）
	// 才是这个函数真正的契约。
	it('buildReleaseNotesMarkdown - 结构完整 - 标题带版本且含更新与升级两节', () => {
		const md = buildReleaseNotesMarkdown('1.2.1', '1.14.0');
		expect(md.startsWith('# Ratel 1.2.1')).toBe(true);
		expect(md).toContain('Obsidian 1.14.0');
		expect(md).not.toContain('1.13.1');
		expect(md).toContain('## 本次更新');
		expect(md).toContain('## 升级后');
		// 「本次更新」4 条、「升级后」3 条：条目数量变了说明渲染逻辑漏项。
		const bulletCount = md.split('\n').filter((line) => line.startsWith('- ')).length;
		const numberedCount = md.split('\n').filter((line) => /^\d+\. /.test(line)).length;
		expect(bulletCount).toBe(4);
		expect(numberedCount).toBe(3);
		// 正文非空：每条都应有实际内容，不能渲染成空列表项。
		expect(md).not.toMatch(/^-\s*$/m);
		expect(md).not.toMatch(/^\d+\.\s*$/m);
	});
});

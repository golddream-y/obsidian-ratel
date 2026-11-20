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
		// 关键路径:断言"两节都有正文、条目不重复",不钉死条目数 —— 每版条目数本来就会变。
		const lines = md.split('\n');
		const bullets = lines.filter((line) => line.startsWith('- '));
		const numbered = lines.filter((line) => /^\d+\. /.test(line));
		expect(bullets.length).toBeGreaterThan(0);
		expect(numbered.length).toBeGreaterThan(0);
		// 正文非空：不能渲染成空列表项。
		expect(bullets.every((line) => line.length > 2)).toBe(true);
		expect(numbered.every((line) => line.length > 3)).toBe(true);
		// 防残留:此前用固定槽位逐条覆盖,漏改一条就会重复上版内容。
		expect(new Set(bullets).size).toBe(bullets.length);
		expect(new Set(numbered).size).toBe(numbered.length);
		expect(new Set([...bullets, ...numbered]).size).toBe(bullets.length + numbered.length);
	});

	// 防复发:升级弹窗是整段正文,发版时整段重写;测试只守"不留旧槽位/旧版本"这类低级残留。
	it('buildReleaseNotesMarkdown - 不含旧槽位与上一版版本号 - 文案已按本版重写', () => {
		const md = buildReleaseNotesMarkdown('1.5.7', '1.13.1');
		expect(md).not.toMatch(/modal\.release\./);
		expect(md).not.toContain('1.5.6');
		expect(md).toContain('1.5.7');
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
	validateVaultPath,
	validateEcosystemPath,
	setConfigDir,
	isIndexableMarkdownPath,
	RATEL_PLUGIN_ID,
} from '../../src/utils/path-safety';

describe('validateVaultPath', () => {
	// 关键路径:模拟生产环境,configDirName 必须设置,否则 configDir 检查失效
	beforeEach(() => setConfigDir('.obsidian'));
	it('正常相对路径 - 返回归一化结果', () => {
		expect(validateVaultPath('notes/foo.md')).toBe('notes/foo.md');
		expect(validateVaultPath('notes//bar.md')).toBe('notes/bar.md');
	});

	it('空路径 - 抛错', () => {
		expect(() => validateVaultPath('')).toThrow('路径不能为空');
	});

	it('前导斜杠的 vault 相对路径 - 归一化后返回', () => {
		// 关键路径:模型常用 `/` 表示 vault 根,视为相对路径,不抛错
		expect(validateVaultPath('/etc/passwd')).toBe('etc/passwd');
		expect(validateVaultPath('/')).toBe('');
		expect(validateVaultPath('/notes/foo.md')).toBe('notes/foo.md');
	});

	it('Windows 盘符绝对路径 - 抛错', () => {
		expect(() => validateVaultPath('C:\\secret')).toThrow('不允许绝对路径');
		expect(() => validateVaultPath('D:/path')).toThrow('不允许绝对路径');
	});

	it('.. 穿越 - 抛错', () => {
		expect(() => validateVaultPath('../secret.md')).toThrow('禁止使用 ".." 穿越');
	});

	it('.obsidian 目录 - 抛错', () => {
		expect(() => validateVaultPath('.obsidian/config')).toThrow('不允许访问配置目录');
	});

	it('.trash 目录 - 抛错', () => {
		expect(() => validateVaultPath('.trash/old.md')).toThrow('不允许访问 .trash');
	});
});

describe('validateEcosystemPath', () => {
	beforeEach(() => setConfigDir('.obsidian'));

	const ctx = {
		catalogIds: new Set(['calendar']),
		installedIds: new Set(['dataview']),
	};

	it('通道 A 回归 - 笔记工具仍拒整个 configDir', () => {
		expect(() => validateVaultPath('.obsidian/plugins/calendar/main.js')).toThrow('不允许访问配置目录');
		expect(() => validateVaultPath('.obsidian/community-plugins.json')).toThrow('不允许访问配置目录');
	});

	it('启用清单 - community-plugins.json 放行', () => {
		expect(validateEcosystemPath('.obsidian/community-plugins.json', ctx)).toBe(
			'.obsidian/community-plugins.json',
		);
	});

	it('商店清单内 id - 插件三件套路径放行', () => {
		expect(validateEcosystemPath('.obsidian/plugins/calendar/main.js', ctx)).toBe(
			'.obsidian/plugins/calendar/main.js',
		);
	});

	it('本地已装 id - 即使不在清单也放行(下架仍可卸)', () => {
		expect(validateEcosystemPath('.obsidian/plugins/dataview/manifest.json', ctx)).toBe(
			'.obsidian/plugins/dataview/manifest.json',
		);
	});

	it('未知 id - 拒绝(防拼路径)', () => {
		expect(() => validateEcosystemPath('.obsidian/plugins/evil-id/main.js', ctx)).toThrow();
	});

	it('ratel-vault 自己 - 拒绝', () => {
		expect(() =>
			validateEcosystemPath(`.obsidian/plugins/${RATEL_PLUGIN_ID}/data.json`, ctx),
		).toThrow();
	});

	it('app.json / 其它配置 - 拒绝', () => {
		expect(() => validateEcosystemPath('.obsidian/app.json', ctx)).toThrow();
		expect(() => validateEcosystemPath('.obsidian/hotkeys.json', ctx)).toThrow();
		expect(() => validateEcosystemPath('.obsidian/themes/x/theme.css', ctx)).toThrow();
	});

	it('自定义 configDir 名 - 不写死 .obsidian', () => {
		setConfigDir('my-config');
		expect(validateEcosystemPath('my-config/community-plugins.json', ctx)).toBe(
			'my-config/community-plugins.json',
		);
		expect(() => validateEcosystemPath('.obsidian/community-plugins.json', ctx)).toThrow();
	});
});

describe('isIndexableMarkdownPath', () => {
	it('isIndexableMarkdownPath - md 大小写 - 可索引', () => {
		expect(isIndexableMarkdownPath('notes/a.md')).toBe(true);
		expect(isIndexableMarkdownPath('Notes/A.MD')).toBe(true);
	});

	it('isIndexableMarkdownPath - 图片与无扩展名 - 不索引', () => {
		expect(isIndexableMarkdownPath('shot.png')).toBe(false);
		expect(isIndexableMarkdownPath('folder/photo.jpg')).toBe(false);
		expect(isIndexableMarkdownPath('readme')).toBe(false);
	});
});

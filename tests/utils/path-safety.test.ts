import { describe, it, expect } from 'vitest';
import { validateVaultPath } from '../../src/utils/path-safety';

describe('validateVaultPath', () => {
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
		expect(() => validateVaultPath('.obsidian/config')).toThrow('不允许访问 .obsidian');
	});

	it('.trash 目录 - 抛错', () => {
		expect(() => validateVaultPath('.trash/old.md')).toThrow('不允许访问 .trash');
	});
});

/**
 * @file tests/adapters/skill-vault.test.ts
 * @description SkillVaultAdapter — 目录缺失静默空列表
 * @module tests/adapters/skill-vault
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillVaultAdapter } from '../../src/adapters/skill-vault';
import type { VaultPort } from '../../src/ports/vault';

function mockVault(overrides: Partial<VaultPort> = {}): VaultPort {
	return {
		listFiles: vi.fn(),
		fileExists: vi.fn(),
		readFile: vi.fn(),
		...overrides,
	} as unknown as VaultPort;
}

describe('SkillVaultAdapter.listSkillFolders', () => {
	it('列出 - 根目录不存在 - 返回空数组且不调用 listFiles', async () => {
		const vault = mockVault({
			fileExists: vi.fn().mockResolvedValue(false),
			listFiles: vi.fn(),
		});
		const adapter = new SkillVaultAdapter(vault, '.ratel/skills');
		await expect(adapter.listSkillFolders()).resolves.toEqual([]);
		expect(vault.listFiles).not.toHaveBeenCalled();
	});

	it('列出 - 含子文件夹且有 SKILL.md - 返回 skill 名', async () => {
		const vault = mockVault({
			fileExists: vi.fn(async (p: string) => {
				if (p === '.ratel/skills') return true;
				if (p === '.ratel/skills/demo/SKILL.md') return true;
				return false;
			}),
			listFiles: vi.fn().mockResolvedValue({
				files: [],
				folders: ['.ratel/skills/demo'],
			}),
		});
		const adapter = new SkillVaultAdapter(vault, '.ratel/skills');
		await expect(adapter.listSkillFolders()).resolves.toEqual(['demo']);
	});
});

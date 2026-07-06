/**
 * @file src/adapters/skill-vault.ts
 * @description SkillVaultAdapter — 走 VaultPort 外观读 vault 内 skills 的 SkillPort 实现
 * @module adapters/skill-vault
 * @depends ports/vault, ports/skill-port, skills/types
 */

import type { VaultPort } from '../ports/vault';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from '../skills/types';

/**
 * VaultPort 适配的 SkillPort — 读 `<vaultRoot>/.ratel/skills/` 内的 skills。
 *
 * 设计要点:
 * - 所有 Obsidian API 访问走 VaultPort 外观(AGENTS.md 架构约束),
 *   构造时注入 VaultPort 实例(通常为 ObsidianVault),测试时可传 mock。
 * - `listSkillFolders` 委托 `vault.listFiles` 读目录,过滤含 SKILL.md 的子文件夹。
 * - `readSkillManifest` 委托 `vault.readFile`,路径校验由 VaultPort 实现内部处理
 *   (ObsidianVault.readFile 已调 validateVaultPath,此处不重复校验)。
 * - vault 内源会监听文件变更(spec §4.4),但监听由 main.ts 注册,
 *   适配器本身不订阅事件(保持无状态)。
 *
 * 关键路径:vault 内源是用户主要管理 skill 的位置(随 vault git/syncthing 同步),
 * 优先级最高,同名覆盖 builtin 与 global。
 */
export class SkillVaultAdapter implements SkillPort {
	readonly source: SkillSource = 'vault';

	constructor(
		private vault: VaultPort,
		readonly rootDir: string,
	) {}

	async listSkillFolders(): Promise<string[]> {
		// 关键路径:vault.listFiles 在目录不存在时返回空数组(Obsidian API 行为)。
		const { folders } = await this.vault.listFiles(this.rootDir);
		const skillFolders: string[] = [];
		for (const folder of folders) {
			// 关键路径:Obsidian adapter.list 返回的 folder 路径有两种可能形态:
			// (a) 相对 vault 根的完整路径(如 ".ratel/skills/my-skill")— Obsidian 实际行为
			// (b) 相对 rootDir 的子目录名(如 "my-skill")— 防御性处理
			// 此处统一处理:若 folder 已以 rootDir 开头,视为完整路径直接用;否则拼前缀。
			const isFullPath = folder === this.rootDir || folder.startsWith(`${this.rootDir}/`);
			const fullFolderPath = isFullPath ? folder : `${this.rootDir}/${folder}`;
			const skillMdPath = `${fullFolderPath}/SKILL.md`;
			if (await this.vault.fileExists(skillMdPath)) {
				// 关键路径:取路径末尾段作为 skill 名(kebab-case,Loader 层会再做正则校验)。
				// 嵌套子目录(非直接子文件夹)在此也会被取末尾段,但 Obsidian adapter.list
				// 是非递归的,只返回直接子项,故无需额外过滤。
				const name = fullFolderPath.split('/').pop()!;
				skillFolders.push(name);
			}
		}
		return skillFolders;
	}

	async readSkillManifest(skillName: string): Promise<string> {
		// 关键路径:VaultPort.readFile 实现内部已调 validateVaultPath(ObsidianVault 会校验
		// path traversal),此处只需拼路径。skillName 应为 kebab-case(Loader 已校验),
		// 不含路径分隔符,但即使含恶意输入,validateVaultPath 也会拦截 .. 穿越。
		const relativePath = `${this.rootDir}/${skillName}/SKILL.md`;
		return this.vault.readFile(relativePath);
	}
}

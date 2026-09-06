/**
 * @file src/ui/goal/estimate-grant-files.ts
 * @description 估算 grant glob 覆盖的 markdown 文件数 — GoalCreateModal 底部提示
 * @module ui/goal/estimate-grant-files
 * @depends ports/vault, utils/glob-to-regex
 */

import type { VaultPort } from '../../ports/vault';
import { globToRegex } from '../../utils/glob-to-regex';

/**
 * 统计 grant globs 将授权写入的约略文件数(去重)。
 *
 * @param vault - Vault 外观
 * @param globs - grant glob 列表
 */
export function estimateGrantFileCount(vault: VaultPort, globs: string[]): number {
	if (!globs.length) return 0;
	const regexes = globs.map((g) => globToRegex(g));
	const paths = vault.listMarkdownFiles();
	const matched = new Set<string>();
	for (const p of paths) {
		if (regexes.some((re) => re.test(p))) {
			matched.add(p);
		}
	}
	return matched.size;
}

/**
 * @file src/tools/write-skill-draft.ts
 * @description `write_skill_draft` 工具 — 写库内 Skill 草稿到 `.ratel/skills/`(S-SCENE-ECO 分期 A)
 * @module tools/write-skill-draft
 * @depends core/tool-registry, skills/skill-name, skills/parse-skill-ecosystem, gray-matter, i18n
 */

import matter from 'gray-matter';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import type { EcosystemErrorCode, EcosystemIssue } from '../skills/ecosystem-types';
import { parseSkillEcosystem } from '../skills/parse-skill-ecosystem';
import { isSkillName } from '../skills/skill-name';
import { isWhitelistedKey } from '../settings/config-whitelist';
import { tNow } from '../i18n';
import type { StringKey } from '../i18n/types';
import { optionalBoolean } from './validate-args';

const SKILL_DRAFT_DIR = '.ratel/skills';

function ecosystemIssueMessage(code: EcosystemErrorCode, params?: Record<string, string>): string {
	const key = `ecosystem.invalid.${code}` as StringKey;
	return params ? tNow(key, params) : tNow(key);
}

function formatEcosystemIssues(issues: EcosystemIssue[]): string {
	return issues
		.map((issue) =>
			issue.params
				? ecosystemIssueMessage(issue.code, issue.params)
				: ecosystemIssueMessage(issue.code),
		)
		.join('; ');
}

/**
 * 构造 `write_skill_draft` 工具实例。
 *
 * 设计要点:
 * - 路径固定 `.ratel/skills/<name>/SKILL.md`,不接受自定义目录参数。
 * - frontmatter 强制 `enabled: false`、`activation: auto`。
 * - 可选 `ecosystem` 对象经 `parseSkillEcosystem` 校验;invalid 时拒绝写入。
 * - 成功后可选调用 `reloadSkills`,让管理面板立刻看到草稿。
 *
 * @param vault - VaultPort 外观
 * @param definition - LLM 侧 schema
 * @param reloadSkills - 可选,写盘后刷新 SkillRegistry
 * @param listBuiltinNames - 可选,返回内置 skill 名列表,用于拒绝覆盖内置技能
 */
export function createWriteSkillDraftTool(
	vault: VaultPort,
	definition: ToolDefinition,
	reloadSkills?: () => void | Promise<void>,
	listBuiltinNames?: () => string[],
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			if (!isSkillName(name)) {
				throw new Error(tNow('error.skill.invalidName', { name }));
			}

			if (listBuiltinNames?.().includes(name)) {
				throw new Error(tNow('error.skill.draftNameReserved', { name }));
			}

			if (typeof args.description !== 'string' || args.description.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'description', type: typeof args.description }));
			}
			const description = args.description.trim();

			if (typeof args.instructions !== 'string') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'instructions', type: typeof args.instructions }));
			}
			const instructions = args.instructions;

			const overwrite = optionalBoolean(args, 'overwrite', false);

			let ecosystemValidity: 'absent' | 'valid' | 'invalid' = 'absent';
			let ecosystemRaw: Record<string, unknown> | undefined;

			if (args.ecosystem !== undefined) {
				if (typeof args.ecosystem !== 'object' || args.ecosystem === null || Array.isArray(args.ecosystem)) {
					throw new Error(formatEcosystemIssues([{ code: 'notObject', detail: 'ecosystem 必须是对象' }]));
				}
				ecosystemRaw = args.ecosystem as Record<string, unknown>;
				const parsed = parseSkillEcosystem(ecosystemRaw, {
					skillName: name,
					isWhitelistedKey,
					lookupProfile: { lookup: () => undefined },
				});
				ecosystemValidity = parsed.validity;
				if (parsed.validity === 'invalid') {
					throw new Error(formatEcosystemIssues(parsed.issues));
				}
			}

			const path = `${SKILL_DRAFT_DIR}/${name}/SKILL.md`;
			const existed = await vault.fileExists(path);
			if (existed && !overwrite) {
				throw new Error(tNow('ecosystem.draft.exists', { name }));
			}

			const frontmatter: Record<string, unknown> = {
				name,
				description,
				enabled: false,
				activation: 'auto',
			};
			if (ecosystemRaw !== undefined) {
				frontmatter.ecosystem = ecosystemRaw;
			}

			const content = matter.stringify(instructions, frontmatter);
			await vault.writeFile(path, content);

			if (reloadSkills) {
				await reloadSkills();
			}

			return { path, created: !existed, ecosystemValidity };
		},
	};
}

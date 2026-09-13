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

/**
 * 从 parse 阶段 issue.detail 提取 i18n 占位符(与 preview-skill-ecosystem 对齐)。
 */
function issueParamsForI18n(issue: EcosystemIssue): Record<string, string> | undefined {
	const { code, detail } = issue;
	switch (code) {
		case 'unknownTopLevel': {
			const m = /^未知顶层键: (.+)$/.exec(detail);
			return m ? { key: m[1] } : undefined;
		}
		case 'profileMissing': {
			const m = /^档案不存在: (.+)\/(.+)$/.exec(detail);
			return m ? { profileId: m[1], presetId: m[2] } : undefined;
		}
		case 'profileDraft': {
			const m = /^档案为草稿: (.+)$/.exec(detail);
			return m ? { profileId: m[1] } : undefined;
		}
		case 'profileDisabled': {
			const m = /^档案已禁用: (.+)$/.exec(detail);
			return m ? { profileId: m[1] } : undefined;
		}
		case 'presetMissing': {
			const m = /^预设不存在: (.+)$/.exec(detail);
			return m ? { presetId: m[1] } : undefined;
		}
		case 'ratelKeyUnknown': {
			const m = /^ratel\.key 不在白名单: (.+)$/.exec(detail);
			return m ? { key: m[1] } : undefined;
		}
		case 'vaultDestUnsafe': {
			const m = /^vaultFiles\.dest 越界: (.+)$/.exec(detail);
			return m ? { dest: m[1] } : undefined;
		}
		default:
			return undefined;
	}
}

function ecosystemIssueMessage(code: EcosystemErrorCode, params?: Record<string, string>): string {
	const key = `ecosystem.invalid.${code}` as StringKey;
	return params ? tNow(key, params) : tNow(key);
}

function formatEcosystemIssues(issues: EcosystemIssue[]): string {
	return issues
		.map((issue) => {
			const params = issueParamsForI18n(issue);
			return params
				? ecosystemIssueMessage(issue.code, params)
				: ecosystemIssueMessage(issue.code);
		})
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
 */
export function createWriteSkillDraftTool(
	vault: VaultPort,
	definition: ToolDefinition,
	reloadSkills?: () => void | Promise<void>,
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

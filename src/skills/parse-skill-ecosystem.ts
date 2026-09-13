/**
 * @file src/skills/parse-skill-ecosystem.ts
 * @description 解析并校验 Skill frontmatter 的 ecosystem 依赖块(S-SCENE-ECO 分期 A)
 * @module skills/parse-skill-ecosystem
 * @depends skills/ecosystem-types, utils/path-safety
 */

import type {
	EcosystemIssue,
	ParsedSkillEcosystem,
	ProfileLookup,
	SkillEcosystem,
	SkillEcosystemPluginDep,
	SkillEcosystemRatelDep,
	SkillEcosystemVaultFile,
} from './ecosystem-types';
import { validateVaultPath } from '../utils/path-safety';

/** skill:// URL 解析正则:skill://<name>/<vault-relative-path> */
const SKILL_URL_REGEX = /^skill:\/\/([^/]+)\/(.+)$/;

const ALLOWED_TOP_LEVEL_KEYS = new Set(['plugins', 'ratel', 'vaultFiles']);

const BARE_PLUGIN_PATCH_KEYS = ['keys', 'patch', 'dataJson'] as const;

/** parseSkillEcosystem 运行时上下文 */
export interface ParseSkillEcosystemContext {
	skillName: string;
	isWhitelistedKey: (key: string) => boolean;
	lookupProfile: ProfileLookup;
}

/**
 * 解析并校验 Skill frontmatter 的 ecosystem 依赖块。
 *
 * 设计要点:
 * - 纯函数,不抛错;dest/source 越界等问题转为 issue code
 * - 有 issue 时仍附带已解析的 partial value,供 preview 列出未完成项
 * - profile 查找依赖 ctx.lookupProfile(分期 A 默认空 lookup → profileMissing)
 *
 * @param raw - frontmatter 中的 ecosystem 字段(可能为 undefined)
 * @param ctx - 解析上下文(skill 名、白名单校验、档案查找)
 * @returns 含 validity / value / issues 的解析结果
 */
export function parseSkillEcosystem(
	raw: unknown,
	ctx: ParseSkillEcosystemContext,
): ParsedSkillEcosystem {
	if (raw == null) {
		return { validity: 'absent', issues: [] };
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			validity: 'invalid',
			issues: [{ code: 'notObject', detail: 'ecosystem 必须是对象' }],
		};
	}

	const obj = raw as Record<string, unknown>;
	const issues: EcosystemIssue[] = [];

	// 未知顶层键
	for (const key of Object.keys(obj)) {
		if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
			issues.push({
				code: 'unknownTopLevel',
				detail: `未知顶层键: ${key}`,
			});
		}
	}

	const plugins = parsePlugins(obj.plugins, ctx, issues);
	const ratel = parseRatel(obj.ratel, ctx, issues);
	const vaultFiles = parseVaultFiles(obj.vaultFiles, ctx, issues);

	const value: SkillEcosystem = { plugins, ratel, vaultFiles };

	if (issues.length > 0) {
		return { validity: 'invalid', value, issues };
	}

	return { validity: 'valid', value, issues };
}

// ==================== plugins ====================

function parsePlugins(
	raw: unknown,
	ctx: ParseSkillEcosystemContext,
	issues: EcosystemIssue[],
): SkillEcosystemPluginDep[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		issues.push({ code: 'notObject', detail: 'plugins 必须是数组' });
		return [];
	}

	const result: SkillEcosystemPluginDep[] = [];

	for (const item of raw) {
		if (typeof item !== 'object' || item == null || Array.isArray(item)) {
			issues.push({ code: 'notObject', detail: 'plugins 每项必须是对象' });
			continue;
		}

		const entry = item as Record<string, unknown>;

		// 裸补丁键
		for (const patchKey of BARE_PLUGIN_PATCH_KEYS) {
			if (patchKey in entry) {
				issues.push({
					code: 'barePluginKeys',
					detail: `plugin 项不允许包含 ${patchKey}`,
				});
			}
		}

		const pluginId = entry.pluginId;
		if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
			issues.push({ code: 'pluginIdEmpty', detail: 'pluginId 必须为非空字符串' });
			continue;
		}

		if (pluginId === 'ratel-vault') {
			issues.push({
				code: 'forbiddenPluginId',
				detail: '禁止依赖 ratel-vault 自身',
			});
		}

		let required = true;
		if ('required' in entry) {
			if (typeof entry.required !== 'boolean') {
				issues.push({ code: 'notObject', detail: 'required 必须为布尔值' });
			} else {
				required = entry.required;
			}
		}

		const hasProfileId = 'profileId' in entry;
		const hasPresetId = 'presetId' in entry;
		const profileId = hasProfileId ? entry.profileId : undefined;
		const presetId = hasPresetId ? entry.presetId : undefined;

		if (hasProfileId !== hasPresetId) {
			issues.push({
				code: 'profileIncomplete',
				detail: 'profileId 与 presetId 必须成对出现',
			});
		} else if (
			hasProfileId &&
			(typeof profileId !== 'string' || typeof presetId !== 'string')
		) {
			issues.push({
				code: 'profileIncomplete',
				detail: 'profileId 与 presetId 必须为非空字符串',
			});
		}

		const dep: SkillEcosystemPluginDep = { pluginId, required };

		if (
			hasProfileId &&
			hasPresetId &&
			typeof profileId === 'string' &&
			typeof presetId === 'string'
		) {
			dep.profileId = profileId;
			dep.presetId = presetId;
			validateProfile(pluginId, profileId, presetId, ctx, issues);
		}

		result.push(dep);
	}

	return result;
}

function validateProfile(
	pluginId: string,
	profileId: string,
	presetId: string,
	ctx: ParseSkillEcosystemContext,
	issues: EcosystemIssue[],
): void {
	const profile = ctx.lookupProfile.lookup(profileId, presetId);

	if (profile == null) {
		issues.push({
			code: 'profileMissing',
			detail: `档案不存在: ${profileId}/${presetId}`,
		});
		return;
	}

	if (profile.draft) {
		issues.push({
			code: 'profileDraft',
			detail: `档案为草稿: ${profileId}`,
		});
	}

	if (profile.enabled === false) {
		issues.push({
			code: 'profileDisabled',
			detail: `档案已禁用: ${profileId}`,
		});
	}

	if (profile.pluginId !== pluginId) {
		issues.push({
			code: 'profilePluginMismatch',
			detail: `档案 pluginId(${profile.pluginId}) 与声明(${pluginId})不一致`,
		});
	}

	if (profile.presetExists === false) {
		issues.push({
			code: 'presetMissing',
			detail: `预设不存在: ${presetId}`,
		});
	}
}

// ==================== ratel ====================

function parseRatel(
	raw: unknown,
	ctx: ParseSkillEcosystemContext,
	issues: EcosystemIssue[],
): SkillEcosystemRatelDep[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		issues.push({ code: 'notObject', detail: 'ratel 必须是数组' });
		return [];
	}

	const result: SkillEcosystemRatelDep[] = [];

	for (const item of raw) {
		if (typeof item !== 'object' || item == null || Array.isArray(item)) {
			issues.push({ code: 'notObject', detail: 'ratel 每项必须是对象' });
			continue;
		}

		const entry = item as Record<string, unknown>;
		const key = entry.key;

		if (typeof key !== 'string' || key.length === 0) {
			issues.push({ code: 'ratelKeyUnknown', detail: 'ratel.key 必须为非空字符串' });
			continue;
		}

		if (!ctx.isWhitelistedKey(key)) {
			issues.push({
				code: 'ratelKeyUnknown',
				detail: `ratel.key 不在白名单: ${key}`,
			});
		}

		result.push({ key });
	}

	return result;
}

// ==================== vaultFiles ====================

function parseVaultFiles(
	raw: unknown,
	ctx: ParseSkillEcosystemContext,
	issues: EcosystemIssue[],
): SkillEcosystemVaultFile[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		issues.push({ code: 'notObject', detail: 'vaultFiles 必须是数组' });
		return [];
	}

	const result: SkillEcosystemVaultFile[] = [];

	for (const item of raw) {
		if (typeof item !== 'object' || item == null || Array.isArray(item)) {
			issues.push({ code: 'notObject', detail: 'vaultFiles 每项必须是对象' });
			continue;
		}

		const entry = item as Record<string, unknown>;
		const dest = typeof entry.dest === 'string' ? entry.dest : '';
		const source = typeof entry.source === 'string' ? entry.source : '';

		let sourceRel = '';

		// source 校验
		const match = SKILL_URL_REGEX.exec(source);
		if (!match) {
			issues.push({
				code: 'skillUrlInvalid',
				detail: `vaultFiles.source 格式无效: ${source}`,
			});
		} else {
			const [, urlSkillName, relPath] = match;
			sourceRel = relPath;

			if (urlSkillName !== ctx.skillName) {
				issues.push({
					code: 'skillUrlWrongSkill',
					detail: `skill:// URL 指向其他 skill: ${urlSkillName}`,
				});
			}

			try {
				validateVaultPath(sourceRel);
			} catch {
				issues.push({
					code: 'skillUrlTraversal',
					detail: `skill:// 路径含越界片段: ${sourceRel}`,
				});
			}
		}

		// dest 校验 — 关键路径:catch 后 emit issue,不得 throw 出 loader
		try {
			validateVaultPath(dest);
		} catch {
			issues.push({
				code: 'vaultDestUnsafe',
				detail: `vaultFiles.dest 越界: ${dest}`,
			});
		}

		result.push({ dest, source, sourceRel });
	}

	return result;
}

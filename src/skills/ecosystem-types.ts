/**
 * @file src/skills/ecosystem-types.ts
 * @description 场景 Skill 的 ecosystem 依赖类型与查找端口(S-SCENE-ECO 分期 A)
 * @module skills/ecosystem-types
 */

export const ECOSYSTEM_ERROR_CODES = [
	'notObject',
	'notArray',
	'itemNotObject',
	'requiredNotBoolean',
	'unknownTopLevel',
	'pluginIdEmpty',
	'barePluginKeys',
	'profileIncomplete',
	'profileMissing',
	'profileDraft',
	'profileDisabled',
	'profilePluginMismatch',
	'presetMissing',
	'forbiddenPluginId',
	'ratelKeyUnknown',
	'vaultDestUnsafe',
	'skillUrlInvalid',
	'skillUrlWrongSkill',
	'skillUrlTraversal',
] as const;

export type EcosystemErrorCode = (typeof ECOSYSTEM_ERROR_CODES)[number];

export type EcosystemValidity = 'absent' | 'valid' | 'invalid';

export interface SkillEcosystemPluginDep {
	pluginId: string;
	profileId?: string;
	presetId?: string;
	required: boolean;
}

export interface SkillEcosystemRatelDep {
	key: string;
}

export interface SkillEcosystemVaultFile {
	dest: string;
	source: string;
	sourceRel: string;
}

export interface SkillEcosystem {
	plugins: SkillEcosystemPluginDep[];
	ratel: SkillEcosystemRatelDep[];
	vaultFiles: SkillEcosystemVaultFile[];
}

export interface EcosystemIssue {
	code: EcosystemErrorCode;
	/** 给开发者日志的中文细节,不含本机绝对路径 */
	detail: string;
	/** i18n 占位符(如 profileId、presetId、key) */
	params?: Record<string, string>;
}

export interface ParsedSkillEcosystem {
	validity: EcosystemValidity;
	value?: SkillEcosystem;
	issues: EcosystemIssue[];
}

/** 分期 A:档案 Registry 未落地时一律返回 undefined → profile 引用标 invalid */
export interface ProfileLookup {
	lookup(profileId: string, presetId: string): {
		pluginId: string;
		enabled: boolean;
		draft: boolean;
		presetExists: boolean;
	} | undefined;
}

export interface PluginPresence {
	listEnabled(): Promise<string[]>;
	isInstalled(pluginId: string): Promise<boolean>;
}

export type PluginPresenceStatus = 'enabled' | 'installed' | 'missing' | 'unknown';

/**
 * @file src/profiles/types.ts
 * @description 插件档案对象（S-PLUGIN-PROFILE §6）
 * @module profiles/types
 */
export type ProfileKind = 'obsidian-plugin-profile';

export interface PluginProfile {
	kind: ProfileKind;
	id: string;
	pluginId: string;
	pluginName: string;
	pluginVersionRange: string;
	enabled?: boolean;
	tags?: string[];
	sopSkill?: string;
	install: { source: 'community-store' };
	forbid: string[];
	presets: ProfilePreset[];
}

export interface ProfilePreset {
	id: string;
	when: string;
	patch: Record<string, unknown>;
}

export interface ProfileMatchQuery {
	utterance?: string;
	pluginId?: string;
	tags?: string[];
}

export interface ProfileMatchHit {
	profileId: string;
	pluginId: string;
	presetId: string;
	score: number;
	reasons: string[];
}

export interface ProfileDiagnostic {
	profileId?: string;
	path: string;
	code:
		| 'schemaInvalid'
		| 'semanticInvalid'
		| 'unknownPluginId'
		| 'unverifiedStoreId'
		| 'versionMismatch'
		| 'draftSkipped'
		| 'idCollision'
		| 'forbidOverlap'
		| 'parseError';
	message: string;
}

export interface LoadReport {
	loaded: number;
	skipped: number;
	diagnostics: ProfileDiagnostic[];
}

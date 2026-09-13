/**
 * @file src/skills/preview-skill-ecosystem.ts
 * @description 只读展开 Skill ecosystem 依赖预览计划(S-SCENE-ECO 分期 A)
 * @module skills/preview-skill-ecosystem
 * @depends skills/ecosystem-types, skills/types
 */

import type {
	EcosystemErrorCode,
	EcosystemIssue,
	EcosystemValidity,
	PluginPresence,
	PluginPresenceStatus,
} from './ecosystem-types';
import type { Skill } from './types';

export interface EcosystemPreviewPlugin {
	pluginId: string;
	required: boolean;
	presence: PluginPresenceStatus;
	profileId?: string;
	presetId?: string;
}

export interface EcosystemPreview {
	skillName: string;
	validity: EcosystemValidity;
	issues: Array<{ code: EcosystemErrorCode; message: string }>;
	plugins: EcosystemPreviewPlugin[];
	ratel: Array<{ key: string }>;
	vaultFiles: Array<{ dest: string; source: string }>;
	applyReady: boolean;
}

/**
 * 从 parse 阶段 issue.detail 提取 i18n 占位符(与 parse-skill-ecosystem 中文 detail 对齐)。
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

/**
 * 解析单个插件的在场状态 — 无 presence 注入时一律 unknown。
 */
async function resolvePluginPresence(
	pluginId: string,
	presence: PluginPresence | undefined,
	enabledSet: Set<string> | undefined,
): Promise<PluginPresenceStatus> {
	if (!presence) return 'unknown';
	if (enabledSet?.has(pluginId)) return 'enabled';
	if (await presence.isInstalled(pluginId)) return 'installed';
	return 'missing';
}

/**
 * 把已解析 Skill manifest.ecosystem 展开为只读预览计划。
 *
 * 设计要点:
 * - 不二次校验 ecosystem,只展示 ParsedSkillEcosystem 结果
 * - validity=absent 时返回空依赖列表,applyReady=false
 * - validity=valid 时 applyReady=true(分期 A 仍无 apply 工具,仅供模型判断契约)
 * - issues.message 由 opts.t 映射 ecosystem.invalid.*,禁止写「已配好」类文案
 *
 * @param skill - 含 manifest.ecosystem 的 Skill
 * @param opts.presence - 可选插件在场探测;缺省则全部 unknown
 * @param opts.t - 错误码 → 用户可见文案(生产注入 i18n,单测可 stub)
 * @returns 可序列化的预览计划
 */
export async function buildEcosystemPreview(
	skill: Skill,
	opts: {
		presence?: PluginPresence;
		t: (code: EcosystemErrorCode, params?: Record<string, string>) => string;
	},
): Promise<EcosystemPreview> {
	const parsed = skill.manifest.ecosystem;
	const { validity, issues } = parsed;

	const previewIssues = issues.map((issue) => {
		const params = issueParamsForI18n(issue);
		return {
			code: issue.code,
			message: params ? opts.t(issue.code, params) : opts.t(issue.code),
		};
	});

	if (validity === 'absent') {
		return {
			skillName: skill.manifest.name,
			validity,
			issues: previewIssues,
			plugins: [],
			ratel: [],
			vaultFiles: [],
			applyReady: false,
		};
	}

	const value = parsed.value ?? { plugins: [], ratel: [], vaultFiles: [] };

	let enabledSet: Set<string> | undefined;
	if (opts.presence) {
		enabledSet = new Set(await opts.presence.listEnabled());
	}

	const plugins: EcosystemPreviewPlugin[] = await Promise.all(
		value.plugins.map(async (dep) => {
			const item: EcosystemPreviewPlugin = {
				pluginId: dep.pluginId,
				required: dep.required,
				presence: await resolvePluginPresence(dep.pluginId, opts.presence, enabledSet),
			};
			if (dep.profileId !== undefined) item.profileId = dep.profileId;
			if (dep.presetId !== undefined) item.presetId = dep.presetId;
			return item;
		}),
	);

	return {
		skillName: skill.manifest.name,
		validity,
		issues: previewIssues,
		plugins,
		ratel: value.ratel.map(({ key }) => ({ key })),
		vaultFiles: value.vaultFiles.map(({ dest, source }) => ({ dest, source })),
		applyReady: validity === 'valid',
	};
}

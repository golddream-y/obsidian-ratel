/**
 * @file src/profiles/validate.ts
 * @description 档案手写校验，不引入 ajv
 * @module profiles/validate
 */
import type { PluginProfile } from './types';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const RANGE = /^(\*|\d+\.\d+\.\d+|>=\d+\.\d+\.\d+)$/;

/**
 * 校验原始档案对象是否符合 schema 与语义约束。
 *
 * @param raw - 待校验的未知对象（通常来自 YAML/JSON 解析）
 * @returns 成功时返回规范化后的 profile；失败时返回错误码列表
 */
export function validateProfile(raw: unknown): { ok: true; profile: PluginProfile } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not-object'] };
	const o = raw as Record<string, unknown>;
	if (o.kind !== 'obsidian-plugin-profile') errors.push('kind');
	if (typeof o.id !== 'string' || !ID.test(o.id)) errors.push('id');
	if (typeof o.pluginId !== 'string' || o.pluginId === 'ratel-vault') errors.push('pluginId');
	if (typeof o.pluginName !== 'string') errors.push('pluginName');
	if (typeof o.pluginVersionRange !== 'string' || !RANGE.test(o.pluginVersionRange)) errors.push('pluginVersionRange');
	const inst = o.install as { source?: string } | undefined;
	if (inst?.source !== 'community-store') errors.push('install.source');
	const forbid = Array.isArray(o.forbid) ? o.forbid.map(String) : [];
	const presets = o.presets;
	if (!Array.isArray(presets) || presets.length === 0 || presets.length > 8) errors.push('presets');
	const ids = new Set<string>();
	if (Array.isArray(presets)) {
		for (const pr of presets) {
			const p = pr as { id?: string; when?: string; patch?: Record<string, unknown> };
			if (!p.id || ids.has(p.id) || !p.when || !p.patch) errors.push('preset');
			ids.add(p.id ?? '');
			const keys = Object.keys(p.patch ?? {});
			if (keys.length > 20) errors.push('patch-size');
			for (const k of keys) {
				if (forbid.includes(k)) errors.push('forbidOverlap');
				if (k.includes('..') || k.startsWith('.') || k.includes('/')) errors.push('key');
			}
		}
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, profile: o as unknown as PluginProfile };
}

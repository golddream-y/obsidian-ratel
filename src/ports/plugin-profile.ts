/**
 * @file src/ports/plugin-profile.ts
 * @description 插件档案加载与匹配的端口契约（实现留给后续任务）
 * @module ports/plugin-profile
 */
export interface PluginProfilePort {
	loadAll(): Promise<{ loaded: number; skipped: number; diagnostics: unknown[] }>;
	get(id: string): import('../profiles/types').PluginProfile | undefined;
	match(query: import('../profiles/types').ProfileMatchQuery): import('../profiles/types').ProfileMatchHit[];
	validate(raw: unknown): { ok: true; profile: import('../profiles/types').PluginProfile } | { ok: false; errors: string[] };
}

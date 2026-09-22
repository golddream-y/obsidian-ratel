/**
 * @file src/ports/ecosystem.ts
 * @description 社区插件执行层端口 — 零实现
 * @module ports/ecosystem
 */

/**
 * 生态工具对外能力契约;由后续 Task 注入实现。
 */
export interface EcosystemPort {
	search(query: string): Promise<unknown>;
	listInstalled(): Promise<Array<{ id: string; name: string; version: string; enabled: boolean }>>;
	status(pluginId: string, opts?: { includeKeys?: boolean; checkUpdate?: boolean }): Promise<unknown>;
	install(pluginId: string): Promise<unknown>;
	update(pluginId: string): Promise<unknown>;
	uninstall(pluginId: string): Promise<unknown>;
	inspectData(pluginId: string): Promise<{ keys: string[]; values: Record<string, unknown> }>;
	applyData(pluginId: string, patch: Record<string, unknown>): Promise<unknown>;
	listChanges(opts?: { pluginId?: string; limit?: number }): Promise<unknown[]>;
	restore(changeId: string): Promise<unknown>;
}

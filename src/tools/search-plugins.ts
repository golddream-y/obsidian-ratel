/**
 * @file src/tools/search-plugins.ts
 * @description search_plugins — 官方清单内检索,只把 top N 回给模型(ADR-018)
 * @module tools/search-plugins
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';
import { EcosystemRegistry, rankCommunityPlugins, SEARCH_TOP_N } from '../adapters/ecosystem-registry';

export interface SearchPluginsDeps {
	registry: EcosystemRegistry;
	installedIds: () => Set<string> | Promise<Set<string>>;
}

/**
 * 构造只读检索工具。出站仅在缓存缺失/过期时发生(用户调用本工具即发起)。
 */
export function createSearchPluginsTool(definition: ToolDefinition, deps: SearchPluginsDeps): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.query !== 'string' || args.query.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'query', type: typeof args.query }));
			}
			const catalog = await deps.registry.ensureCatalog();
			const stats = await deps.registry.ensureStats();
			const installed = await deps.installedIds();
			const hits = rankCommunityPlugins(args.query, catalog.plugins, stats, installed, SEARCH_TOP_N);
			return {
				stale: catalog.stale,
				fetchedAt: catalog.fetchedAt,
				note: catalog.stale
					? tNow('ecosystem.search.stale', { fetchedAt: new Date(catalog.fetchedAt).toISOString() })
					: undefined,
				results: hits,
			};
		},
	};
}

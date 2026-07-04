/**
 * @file src/ui/tokens/probe-model.ts
 * @description Chat 配置校验 + 映射表推荐 context — 见 ADR-007
 * @module ui/tokens/probe-model
 */

import { requestUrl } from 'obsidian';
import type { ModelContextRegistry } from './model-context-registry';

export type ProbeModelResult =
	| { ok: true; recommendedTokens?: number; registryHit: boolean }
	| { ok: false; error: string };

export async function probeChatConnection(deps: {
	apiBase: string;
	apiKey: string;
	model: string;
	registry: ModelContextRegistry;
	registryUrl: string;
}): Promise<ProbeModelResult> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (deps.apiKey) {
		headers.Authorization = `Bearer ${deps.apiKey}`;
	}

	try {
		const response = await requestUrl({
			url: `${deps.apiBase}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: deps.model,
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1,
				stream: false,
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			return { ok: false, error: `API 返回 ${response.status}:连接失败或模型名无效` };
		}

		const map = await deps.registry.ensureRegistry(deps.registryUrl);
		const recommended =
			map != null ? deps.registry.lookupContextLength(deps.model, map) : undefined;

		return {
			ok: true,
			recommendedTokens: recommended,
			registryHit: recommended != null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `请求失败:${message}` };
	}
}

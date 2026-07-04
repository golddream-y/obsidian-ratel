/**
 * @file src/ui/tokens/model-context-registry.ts
 * @description LiteLLM 模型映射表拉取、缓存与 context length 查找 — 见 ADR-007
 * @module ui/tokens/model-context-registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { devLogger } from '../../logging/dev-logger';

export const MODEL_REGISTRY_DOC_URL =
	'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';

export const DEFAULT_MODEL_REGISTRY_URL =
	'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';

export const FALLBACK_MODEL_REGISTRY_URL =
	'https://cdn.jsdelivr.net/gh/BerriAI/litellm@v1.65.4-stable/model_prices_and_context_window.json';

export const REGISTRY_CACHE_FILENAME = 'model-context-registry.json';
export const REGISTRY_META_FILENAME = 'model-context-registry.meta.json';

const REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_MAX_BYTES = 3 * 1024 * 1024;

export type LiteLLMModelEntry = {
	max_input_tokens?: number;
	max_tokens?: number;
};

export type LiteLLMModelMap = Record<string, LiteLLMModelEntry>;

export type RegistryMeta = {
	fetchedAt: number;
	sourceUrl: string;
	modelCount: number;
};

type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

function readEntryTokens(entry: LiteLLMModelEntry | undefined): number | undefined {
	if (!entry) return undefined;
	const n = entry.max_input_tokens ?? entry.max_tokens;
	return typeof n === 'number' && n > 0 ? n : undefined;
}

/** 纯函数 lookup — 便于单测 */
export function lookupContextLengthInRegistry(
	model: string,
	registry: LiteLLMModelMap,
): number | undefined {
	const trimmed = model.trim();
	if (!trimmed || trimmed === 'sample_spec') return undefined;
	const lower = trimmed.toLowerCase();

	const direct = registry[trimmed] ?? registry[lower];
	const directTokens = readEntryTokens(direct);
	if (directTokens != null) return directTokens;

	let suffixBest: number | undefined;
	let prefixBestKey = '';
	let prefixBestTokens: number | undefined;

	for (const [key, entry] of Object.entries(registry)) {
		if (key === 'sample_spec') continue;
		const keyLower = key.toLowerCase();
		if (keyLower === lower || keyLower.endsWith(`/${lower}`)) {
			const t = readEntryTokens(entry);
			if (t != null) suffixBest = t;
		}
		if (keyLower.includes('/') && lower.startsWith(keyLower)) {
			if (keyLower.length > prefixBestKey.length) {
				const t = readEntryTokens(entry);
				if (t != null) {
					prefixBestKey = keyLower;
					prefixBestTokens = t;
				}
			}
		}
	}

	return suffixBest ?? prefixBestTokens;
}

export class ModelContextRegistry {
	constructor(
		private pluginDir: string,
		private fetchFn: RequestUrlFn = requestUrl,
	) {}

	private cachePath(): string {
		return path.join(this.pluginDir, REGISTRY_CACHE_FILENAME);
	}

	private metaPath(): string {
		return path.join(this.pluginDir, REGISTRY_META_FILENAME);
	}

	async ensureRegistry(sourceUrl: string): Promise<LiteLLMModelMap | null> {
		const cached = await this.readCacheIfFresh(sourceUrl);
		if (cached) return cached;

		const isDefaultSource =
			sourceUrl === DEFAULT_MODEL_REGISTRY_URL || sourceUrl === FALLBACK_MODEL_REGISTRY_URL;

		let map = await this.fetchAndParse(sourceUrl);
		if (!map && isDefaultSource && sourceUrl !== FALLBACK_MODEL_REGISTRY_URL) {
			map = await this.fetchAndParse(FALLBACK_MODEL_REGISTRY_URL);
			if (map) {
				await this.writeCache(map, FALLBACK_MODEL_REGISTRY_URL);
				return map;
			}
		}
		if (map) {
			await this.writeCache(map, sourceUrl);
			return map;
		}

		const stale = await this.readCacheIgnoringTtl();
		if (stale) {
			devLogger.warn('main', '映射表拉取失败,使用过期缓存');
			return stale;
		}
		return null;
	}

	lookupContextLength(model: string, registry: LiteLLMModelMap): number | undefined {
		return lookupContextLengthInRegistry(model, registry);
	}

	private async readCacheIfFresh(sourceUrl: string): Promise<LiteLLMModelMap | null> {
		try {
			const [raw, metaRaw] = await Promise.all([
				readFile(this.cachePath(), 'utf-8'),
				readFile(this.metaPath(), 'utf-8'),
			]);
			const meta = JSON.parse(metaRaw) as RegistryMeta;
			if (meta.sourceUrl !== sourceUrl) return null;
			if (Date.now() - meta.fetchedAt > REGISTRY_TTL_MS) return null;
			return JSON.parse(raw) as LiteLLMModelMap;
		} catch {
			return null;
		}
	}

	private async readCacheIgnoringTtl(): Promise<LiteLLMModelMap | null> {
		try {
			const raw = await readFile(this.cachePath(), 'utf-8');
			return JSON.parse(raw) as LiteLLMModelMap;
		} catch {
			return null;
		}
	}

	private async fetchAndParse(url: string): Promise<LiteLLMModelMap | null> {
		try {
			const response = await this.fetchFn({ url, method: 'GET', throw: false });
			if (response.status < 200 || response.status >= 300) {
				devLogger.warn('main', `映射表 HTTP ${response.status}: ${url}`);
				return null;
			}
			const text = response.text;
			if (text.length > REGISTRY_MAX_BYTES) {
				devLogger.warn('main', `映射表过大(${text.length} bytes),丢弃: ${url}`);
				return null;
			}
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return null;
			}
			return parsed as LiteLLMModelMap;
		} catch (err) {
			devLogger.warn('main', '映射表拉取/解析失败', err);
			return null;
		}
	}

	private async writeCache(map: LiteLLMModelMap, sourceUrl: string): Promise<void> {
		await mkdir(this.pluginDir, { recursive: true });
		const body = JSON.stringify(map);
		const tmp = `${this.cachePath()}.tmp`;
		const metaTmp = `${this.metaPath()}.tmp`;
		const meta: RegistryMeta = {
			fetchedAt: Date.now(),
			sourceUrl,
			modelCount: Object.keys(map).filter((k) => k !== 'sample_spec').length,
		};
		await writeFile(tmp, body, 'utf-8');
		await writeFile(metaTmp, JSON.stringify(meta), 'utf-8');
		await rename(tmp, this.cachePath());
		await rename(metaTmp, this.metaPath());
	}
}

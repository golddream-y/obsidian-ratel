/**
 * @file src/settings/model-catalog-cache.ts
 * @description models.dev 名单的拉取与 7 天文件缓存
 * @module settings/model-catalog-cache
 * @depends settings/model-catalog, obsidian, logging/dev-logger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { devLogger } from '../logging/dev-logger';
import { MODELS_DEV_URL, type ModelsDevCatalog } from './model-catalog';

export const CATALOG_CACHE_FILENAME = 'models-dev.json';
export const CATALOG_META_FILENAME = 'models-dev.meta.json';

const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 名单约 4.7MB，沿用映射表 3MB 上限会把合法响应丢掉 */
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;

type CatalogMeta = {
	fetchedAt: number;
	sourceUrl: string;
};

type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * 打开对话模型页时拉取 models.dev，并缓存在插件目录。
 *
 * 设计要点:
 * - 不在插件 onload 调用
 * - 7 天内用缓存；拉取失败时用过期缓存；都没有则返回 null
 */
export class ModelsDevCatalogCache {
	constructor(
		private pluginDir: string,
		private fetchFn: RequestUrlFn = requestUrl,
	) {}

	private cachePath(): string {
		return path.join(this.pluginDir, CATALOG_CACHE_FILENAME);
	}

	private metaPath(): string {
		return path.join(this.pluginDir, CATALOG_META_FILENAME);
	}

	/**
	 * 取可用名单。新鲜缓存优先，否则拉取，再否则过期缓存。
	 *
	 * @returns 解析后的名单；无缓存且拉取失败时 null
	 */
	async ensureCatalog(): Promise<ModelsDevCatalog | null> {
		const cached = await this.readCacheIfFresh();
		if (cached) return cached;

		const fetched = await this.fetchAndParse(MODELS_DEV_URL);
		if (fetched) {
			await this.writeCache(fetched);
			return fetched;
		}

		const stale = await this.readCacheIgnoringTtl();
		if (stale) {
			devLogger.warn('main', '模型名单拉取失败,使用过期缓存');
			return stale;
		}
		return null;
	}

	private async readCacheIfFresh(): Promise<ModelsDevCatalog | null> {
		try {
			const [raw, metaRaw] = await Promise.all([
				readFile(this.cachePath(), 'utf-8'),
				readFile(this.metaPath(), 'utf-8'),
			]);
			const meta = JSON.parse(metaRaw) as CatalogMeta;
			if (meta.sourceUrl !== MODELS_DEV_URL) return null;
			if (Date.now() - meta.fetchedAt > CATALOG_TTL_MS) return null;
			return JSON.parse(raw) as ModelsDevCatalog;
		} catch {
			return null;
		}
	}

	private async readCacheIgnoringTtl(): Promise<ModelsDevCatalog | null> {
		try {
			const raw = await readFile(this.cachePath(), 'utf-8');
			return JSON.parse(raw) as ModelsDevCatalog;
		} catch {
			return null;
		}
	}

	private async fetchAndParse(url: string): Promise<ModelsDevCatalog | null> {
		try {
			const response = await this.fetchFn({ url, method: 'GET', throw: false });
			if (response.status < 200 || response.status >= 300) {
				devLogger.warn('main', `模型名单 HTTP ${response.status}`);
				return null;
			}
			const text = response.text;
			if (text.length > CATALOG_MAX_BYTES) {
				devLogger.warn('main', `模型名单过大(${text.length} bytes),丢弃`);
				return null;
			}
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return null;
			}
			return parsed as ModelsDevCatalog;
		} catch (err) {
			devLogger.warn('main', '模型名单拉取/解析失败', err);
			return null;
		}
	}

	private async writeCache(catalog: ModelsDevCatalog): Promise<void> {
		await mkdir(this.pluginDir, { recursive: true });
		const tmp = `${this.cachePath()}.tmp`;
		const metaTmp = `${this.metaPath()}.tmp`;
		const meta: CatalogMeta = {
			fetchedAt: Date.now(),
			sourceUrl: MODELS_DEV_URL,
		};
		await writeFile(tmp, JSON.stringify(catalog), 'utf-8');
		await writeFile(metaTmp, JSON.stringify(meta), 'utf-8');
		await rename(tmp, this.cachePath());
		await rename(metaTmp, this.metaPath());
	}
}

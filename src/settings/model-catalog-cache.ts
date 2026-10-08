/**
 * @file src/settings/model-catalog-cache.ts
 * @description models.dev 名单的拉取与 24 小时文件缓存
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

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
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
 * - 24 小时内用缓存；拉取失败时用过期缓存；都没有则返回 null
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
			const fetchedAt = await this.readFetchedAt();
			const when = fetchedAt ? `，上次拉取 ${new Date(fetchedAt).toISOString()}` : '';
			devLogger.warn(
				'main',
				`models.dev 这次没拿到。改用插件目录里的旧名单${when}。供应商和模型下拉仍可用，窗口数字可能不是最新的。`,
			);
			return stale;
		}
		devLogger.warn(
			'main',
			'models.dev 这次没拿到，插件目录里也没有旧名单。对话模型页只保留本地 Ollama 和自定义，窗口需要手填。已保存的地址、模型和密钥不变。',
		);
		return null;
	}

	private async readFetchedAt(): Promise<number | null> {
		try {
			const meta = JSON.parse(await readFile(this.metaPath(), 'utf-8')) as CatalogMeta;
			return typeof meta.fetchedAt === 'number' ? meta.fetchedAt : null;
		} catch {
			return null;
		}
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
				devLogger.warn('main', `models.dev 返回 HTTP ${response.status}，不用这次响应`);
				return null;
			}
			const text = response.text;
			if (text.length > CATALOG_MAX_BYTES) {
				devLogger.warn('main', `models.dev 响应有 ${text.length} 字节，超过 8MB，丢弃`);
				return null;
			}
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				devLogger.warn('main', 'models.dev 响应不是供应商名单，丢弃');
				return null;
			}
			return parsed as ModelsDevCatalog;
		} catch (err) {
			devLogger.warn('main', 'models.dev 请求或解析失败', err);
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

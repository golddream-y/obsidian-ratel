/**
 * @file src/adapters/ecosystem-registry.ts
 * @description 官方社区清单/统计缓存与 GitHub 三件套版本定位(ADR-018)
 * @module adapters/ecosystem-registry
 * @depends node:fs/promises, utils/path-safety(仅类型无关)
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tNow } from '../i18n';

/** 官方商店目录(对象数组)。勿与本库启用清单 community-plugins.json 混淆 */
export const COMMUNITY_PLUGINS_CATALOG_URL =
	'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json';

export const COMMUNITY_PLUGIN_STATS_URL =
	'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugin-stats.json';

export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_TOP_N = 8;

export interface CommunityPluginEntry {
	id: string;
	name: string;
	author: string;
	description: string;
	repo: string;
}

export interface CatalogSnapshot {
	fetchedAt: number;
	sourceUrl: string;
	plugins: CommunityPluginEntry[];
	stale: boolean;
}

export interface PluginStatsMap {
	[id: string]: { downloads?: number };
}

export interface SearchHit {
	id: string;
	name: string;
	author: string;
	description: string;
	downloads: number | null;
	installed: boolean;
	repo: string;
}

export interface HttpGet {
	(url: string): Promise<{ status: number; text: string }>;
}

export interface ResolvedRelease {
	version: string;
	minAppVersion: string;
	manifestId: string;
}

/**
 * 比较 Obsidian 风格 x.y.z;current >= min 返回 true。
 */
export function isAppVersionAtLeast(current: string, min: string): boolean {
	const pa = current.split('.').map((n) => parseInt(n, 10) || 0);
	const pb = min.split('.').map((n) => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const a = pa[i] ?? 0;
		const b = pb[i] ?? 0;
		if (a > b) return true;
		if (a < b) return false;
	}
	return true;
}

/**
 * 比较点分段版本。任一侧含非数字段（如 beta）则返回 null。
 */
function parseDottedSegments(v: string): number[] | null {
	const parts = v.split('.');
	const nums: number[] = [];
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return null;
		nums.push(parseInt(p, 10));
	}
	return nums;
}

export function compareDottedVersion(a: string, b: string): number | null {
	const pa = parseDottedSegments(a);
	const pb = parseDottedSegments(b);
	if (pa === null || pb === null) return null;
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}

/**
 * 本地过滤商店条目,只把 top N 交给模型(ADR-018:整份清单不进上下文)。
 */
export function rankCommunityPlugins(
	query: string,
	plugins: CommunityPluginEntry[],
	stats: PluginStatsMap,
	installedIds: ReadonlySet<string>,
	topN: number = SEARCH_TOP_N,
): SearchHit[] {
	const q = query.trim().toLowerCase();
	const tokens = q.split(/\s+/).filter(Boolean);
	const scored = plugins.map((p) => {
		const hay = `${p.id} ${p.name} ${p.author} ${p.description}`.toLowerCase();
		let score = 0;
		for (const t of tokens) {
			if (p.id.toLowerCase() === t) score += 50;
			if (p.name.toLowerCase() === t) score += 40;
			if (p.id.toLowerCase().includes(t)) score += 20;
			if (p.name.toLowerCase().includes(t)) score += 18;
			if (hay.includes(t)) score += 8;
		}
		const dl = stats[p.id]?.downloads;
		return {
			score,
			hit: {
				id: p.id,
				name: p.name,
				author: p.author,
				description: p.description,
				downloads: typeof dl === 'number' ? dl : null,
				installed: installedIds.has(p.id),
				repo: p.repo,
			} satisfies SearchHit,
		};
	});
	scored.sort((a, b) => b.score - a.score || (b.hit.downloads ?? -1) - (a.hit.downloads ?? -1));
	return scored
		.filter((s) => s.score > 0)
		.slice(0, topN)
		.map((s) => s.hit);
}

interface OnDiskCatalog {
	fetchedAt: number;
	sourceUrl: string;
	plugins: CommunityPluginEntry[];
}

/**
 * 清单与 stats 缓存在 Ratel pluginDir;HTTP 可注入(测试 mock,生产 requestUrl)。
 */
export class EcosystemRegistry {
	constructor(
		private pluginDir: string,
		private httpGet: HttpGet,
		private opts: { ttlMs?: number } = {},
	) {}

	private get ttlMs(): number {
		return this.opts.ttlMs ?? CATALOG_TTL_MS;
	}

	private catalogPath(): string {
		return path.join(this.pluginDir, 'ecosystem-catalog.json');
	}

	private statsPath(): string {
		return path.join(this.pluginDir, 'ecosystem-stats.json');
	}

	/**
	 * 读取或刷新商店目录。TTL 内不出站;过期则尝试刷新,失败则返回 stale 缓存。
	 */
	async ensureCatalog(): Promise<CatalogSnapshot> {
		const disk = await this.readDisk<OnDiskCatalog>(this.catalogPath());
		const now = Date.now();
		if (disk && now - disk.fetchedAt < this.ttlMs) {
			return { ...disk, stale: false };
		}
		try {
			const fresh = await this.fetchCatalog();
			await this.atomicWriteJson(this.catalogPath(), fresh);
			return { ...fresh, stale: false };
		} catch (err) {
			if (disk) {
				return { ...disk, stale: true };
			}
			throw err;
		}
	}

	async ensureStats(): Promise<PluginStatsMap> {
		const disk = await this.readDisk<{ fetchedAt: number; stats: PluginStatsMap }>(this.statsPath());
		const now = Date.now();
		if (disk && now - disk.fetchedAt < this.ttlMs) {
			return disk.stats;
		}
		try {
			const res = await this.httpGet(COMMUNITY_PLUGIN_STATS_URL);
			if (res.status !== 200) throw new Error(tNow('error.ecosystem.catalogFetch', { status: res.status }));
			const stats = JSON.parse(res.text) as PluginStatsMap;
			await this.atomicWriteJson(this.statsPath(), { fetchedAt: Date.now(), sourceUrl: COMMUNITY_PLUGIN_STATS_URL, stats });
			return stats;
		} catch {
			return disk?.stats ?? {};
		}
	}

	/**
	 * 对齐官方:用仓库 HEAD/manifest.json 的 version,禁止 /releases/latest。
	 */
	async resolveReleaseVersion(repo: string, apiVersion: string): Promise<ResolvedRelease> {
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
			throw new Error(tNow('error.ecosystem.badRepo', { repo }));
		}
		const url = `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`;
		const res = await this.httpGet(url);
		if (res.status !== 200) {
			throw new Error(tNow('error.ecosystem.manifestFetch', { status: res.status }));
		}
		const man = JSON.parse(res.text) as { id?: string; version?: string; minAppVersion?: string };
		const version = man.version ?? '';
		const minAppVersion = man.minAppVersion ?? '0.0.0';
		const manifestId = man.id ?? '';
		if (!version || !manifestId) {
			throw new Error(tNow('error.ecosystem.badManifest'));
		}
		if (!isAppVersionAtLeast(apiVersion, minAppVersion)) {
			throw new Error(tNow('error.ecosystem.minApp', { minAppVersion, apiVersion }));
		}
		return { version, minAppVersion, manifestId };
	}

	/**
	 * 下载三件套。tag 失败再试 v 前缀。不跟 latest。
	 */
	async downloadTriple(
		repo: string,
		version: string,
	): Promise<{ manifestText: string; mainJs: ArrayBuffer; stylesCss: string | null }> {
		const tryTag = async (tag: string) => {
			const base = `https://github.com/${repo}/releases/download/${tag}`;
			const manifest = await this.httpGet(`${base}/manifest.json`);
			const main = await this.httpGet(`${base}/main.js`);
			const styles = await this.httpGet(`${base}/styles.css`);
			return { manifest, main, styles };
		};
		let pack = await tryTag(version);
		if (pack.manifest.status !== 200 || pack.main.status !== 200) {
			pack = await tryTag(`v${version}`);
		}
		if (pack.manifest.status !== 200 || pack.main.status !== 200 || !pack.main.text) {
			throw new Error(tNow('error.ecosystem.incompleteRelease'));
		}
		// 关键路径:main.js 可能被 http 层当 utf-8 文本;调用方再转 ArrayBuffer
		const encoder = new TextEncoder();
		return {
			manifestText: pack.manifest.text,
			mainJs: encoder.encode(pack.main.text).buffer,
			stylesCss: pack.styles.status === 200 ? pack.styles.text : null,
		};
	}

	private async fetchCatalog(): Promise<OnDiskCatalog> {
		const res = await this.httpGet(COMMUNITY_PLUGINS_CATALOG_URL);
		if (res.status === 429) {
			throw new Error(tNow('error.ecosystem.rateLimited'));
		}
		if (res.status !== 200) {
			throw new Error(tNow('error.ecosystem.catalogFetch', { status: res.status }));
		}
		const parsed = JSON.parse(res.text) as CommunityPluginEntry[];
		if (!Array.isArray(parsed)) {
			throw new Error(tNow('error.ecosystem.badCatalog'));
		}
		const plugins = parsed.filter(
			(p) => p && typeof p.id === 'string' && typeof p.repo === 'string' && typeof p.name === 'string',
		);
		return { fetchedAt: Date.now(), sourceUrl: COMMUNITY_PLUGINS_CATALOG_URL, plugins };
	}

	private async readDisk<T>(file: string): Promise<T | null> {
		try {
			const raw = await readFile(file, 'utf-8');
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	private async atomicWriteJson(file: string, data: unknown): Promise<void> {
		await mkdir(this.pluginDir, { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(data), 'utf-8');
		await rename(tmp, file);
	}
}

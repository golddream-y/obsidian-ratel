/**
 * @file tests/settings/model-catalog-cache.test.ts
 * @description models.dev 名单缓存：新鲜缓存、过期回退、失败与体积上限
 * @module tests/settings/model-catalog-cache
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODELS_DEV_URL } from '../../src/settings/model-catalog';
import { ModelsDevCatalogCache } from '../../src/settings/model-catalog-cache';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'models-dev-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const body = JSON.stringify({
	deepseek: {
		id: 'deepseek',
		name: 'DeepSeek',
		api: 'https://api.deepseek.com',
		models: {},
	},
});

describe('ModelsDevCatalogCache', () => {
	it('ensureCatalog - 无缓存 - 拉取并写入插件目录', async () => {
		const dir = await tempDir();
		let calls = 0;
		const cache = new ModelsDevCatalogCache(dir, async () => {
			calls += 1;
			return { status: 200, text: body } as never;
		});
		const catalog = await cache.ensureCatalog();
		expect(catalog?.deepseek?.id).toBe('deepseek');
		expect(calls).toBe(1);
		const saved = await readFile(path.join(dir, 'models-dev.json'), 'utf-8');
		expect(saved).toContain('deepseek');
		await cache.ensureCatalog();
		expect(calls).toBe(1);
	});

	it('ensureCatalog - 拉取失败且有过期缓存 - 返回旧名单', async () => {
		const dir = await tempDir();
		await writeFile(path.join(dir, 'models-dev.json'), body, 'utf-8');
		await writeFile(
			path.join(dir, 'models-dev.meta.json'),
			JSON.stringify({ fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, sourceUrl: MODELS_DEV_URL }),
			'utf-8',
		);
		const cache = new ModelsDevCatalogCache(dir, async () => {
			throw new Error('offline');
		});
		const catalog = await cache.ensureCatalog();
		expect(catalog?.deepseek?.name).toBe('DeepSeek');
	});

	it('ensureCatalog - 无缓存且拉取失败 - 返回 null', async () => {
		const dir = await tempDir();
		const cache = new ModelsDevCatalogCache(dir, async () => ({ status: 500, text: '' }) as never);
		expect(await cache.ensureCatalog()).toBeNull();
	});

	it('ensureCatalog - 正文超过 8MB - 丢弃且不写缓存', async () => {
		const dir = await tempDir();
		const cache = new ModelsDevCatalogCache(dir, async () => ({ status: 200, text: 'x'.repeat(8 * 1024 * 1024 + 1) }) as never);
		expect(await cache.ensureCatalog()).toBeNull();
	});
});

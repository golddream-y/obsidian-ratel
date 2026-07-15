/**
 * @file tests/core/index-manifest-migrate.test.ts
 * @description 旧版 index-manifest.json 迁入 .index/ratel-manifest.json
 * @module tests/core/index-manifest-migrate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
	migrateLegacyIndexManifest,
	resolveIndexManifestPath,
	INDEX_MANIFEST_FILENAME,
	LEGACY_INDEX_MANIFEST_FILENAME,
} from '../../src/core/index-manifest';

const TEST_DIR = path.join(__dirname, '../tmp/test-manifest-migrate');

describe('migrateLegacyIndexManifest', () => {
	beforeEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('migrateLegacyIndexManifest - 仅有旧文件 - 迁入 .index 并删除旧文件', async () => {
		const pluginDir = TEST_DIR;
		const indexDir = path.join(pluginDir, '.index');
		const legacy = path.join(pluginDir, LEGACY_INDEX_MANIFEST_FILENAME);
		fs.writeFileSync(legacy, '{"version":1,"entries":{}}');
		const moved = await migrateLegacyIndexManifest(pluginDir, indexDir);
		expect(moved).toBe(true);
		expect(fs.existsSync(resolveIndexManifestPath(indexDir))).toBe(true);
		expect(fs.existsSync(legacy)).toBe(false);
		expect(INDEX_MANIFEST_FILENAME).toBe('ratel-manifest.json');
	});

	it('migrateLegacyIndexManifest - 新路径已存在 - 不覆盖并清理旧文件', async () => {
		const pluginDir = TEST_DIR;
		const indexDir = path.join(pluginDir, '.index');
		fs.mkdirSync(indexDir, { recursive: true });
		const next = resolveIndexManifestPath(indexDir);
		const legacy = path.join(pluginDir, LEGACY_INDEX_MANIFEST_FILENAME);
		fs.writeFileSync(next, '{"version":1,"entries":{"a.md":{}}}');
		fs.writeFileSync(legacy, '{"version":1,"entries":{}}');
		const moved = await migrateLegacyIndexManifest(pluginDir, indexDir);
		expect(moved).toBe(false);
		expect(JSON.parse(fs.readFileSync(next, 'utf8')).entries['a.md']).toBeDefined();
		expect(fs.existsSync(legacy)).toBe(false);
	});
});

/**
 * @file tests/core/incremental-manifest-update.test.ts
 * @description updateManifestAfterIncremental 单测 — 验证 incremental 后 manifest 更新
 * @module tests/core/incremental-manifest-update
 * @depends core/incremental-manifest-update, core/index-manifest
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { IndexManifest } from '../../src/core/index-manifest';
import type { IndexManifestData } from '../../src/core/index-manifest';
import { updateManifestAfterIncremental } from '../../src/core/incremental-manifest-update';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-manifest-test-'));
});

afterEach(() => {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

describe('updateManifestAfterIncremental', () => {
    it('updateManifestAfterIncremental - 正常 - 更新 hash + mtime', async () => {
        const manifestPath = path.join(tmpDir, 'manifest.json');
        const manifest = new IndexManifest(manifestPath);
        // 初始化:旧 entry 带 chunkCount=5
        const oldData: IndexManifestData = {
            version: 1, embedModelId: 'm', chunkSize: 500, chunkOverlap: 100, lastIndexTime: 0,
            entries: { 'foo.md': { path: 'foo.md', hash: 'old-hash', mtime: 1000, chunkCount: 5 } },
        };
        await manifest.save(oldData);

        await updateManifestAfterIncremental(manifest, 'foo.md', 'new content');

        const updated = await manifest.load();
        expect(updated).not.toBeNull();
        expect(updated!.entries['foo.md'].hash).not.toBe('old-hash');
        expect(updated!.entries['foo.md'].mtime).toBeGreaterThan(1000);
    });

    it('updateManifestAfterIncremental - 已有 chunkCount - 保留旧值', async () => {
        const manifestPath = path.join(tmpDir, 'manifest.json');
        const manifest = new IndexManifest(manifestPath);
        const oldData: IndexManifestData = {
            version: 1, embedModelId: 'm', chunkSize: 500, chunkOverlap: 100, lastIndexTime: 0,
            entries: { 'foo.md': { path: 'foo.md', hash: 'old', mtime: 1000, chunkCount: 7 } },
        };
        await manifest.save(oldData);

        await updateManifestAfterIncremental(manifest, 'foo.md', 'new content');

        const updated = await manifest.load();
        expect(updated!.entries['foo.md'].chunkCount).toBe(7);
    });

    it('updateManifestAfterIncremental - 新文件 - chunkCount 默认 0', async () => {
        const manifestPath = path.join(tmpDir, 'manifest.json');
        const manifest = new IndexManifest(manifestPath);
        const data: IndexManifestData = {
            version: 1, embedModelId: 'm', chunkSize: 500, chunkOverlap: 100, lastIndexTime: 0,
            entries: {},
        };
        await manifest.save(data);

        await updateManifestAfterIncremental(manifest, 'new.md', 'content');

        const updated = await manifest.load();
        expect(updated!.entries['new.md']).toBeDefined();
        expect(updated!.entries['new.md'].chunkCount).toBe(0);
    });

    it('updateManifestAfterIncremental - manifest 不存在 - 跳过不抛错', async () => {
        const manifest = new IndexManifest(path.join(tmpDir, 'nonexistent.json'));
        await expect(updateManifestAfterIncremental(manifest, 'foo.md', 'content')).resolves.not.toThrow();
    });
});

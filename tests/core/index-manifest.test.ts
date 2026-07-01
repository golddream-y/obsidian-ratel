/**
 * @file tests/core/index-manifest.test.ts
 * @description IndexManifest 行为 — load/save/diff/recordEntry/removeEntry/invalidate/shouldFullRebuild
 * @module tests/core/index-manifest
 * @depends core/index-manifest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexManifest } from '../../src/core/index-manifest';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(__dirname, '../tmp/test-manifest');
const MANIFEST_PATH = path.join(TEST_DIR, 'index-manifest.json');

describe('IndexManifest', () => {
    let manifest: IndexManifest;

    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DIR, { recursive: true });
        manifest = new IndexManifest(MANIFEST_PATH);
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
    });

    it('load - 文件不存在 - 返回 null', async () => {
        expect(await manifest.load()).toBeNull();
    });

    it('load - JSON 损坏 - 返回 null', async () => {
        fs.writeFileSync(MANIFEST_PATH, '{not valid json');
        expect(await manifest.load()).toBeNull();
    });

    it('load - 正常文件 - 返回 manifest', async () => {
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'bge-small-zh',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 1000,
            entries: {},
        };
        await manifest.save(data);
        const loaded = await manifest.load();
        expect(loaded).toEqual(data);
    });

    it('shouldFullRebuild - embedModelId 变 - 返回 true', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'bge-small-zh',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'different-model', 500, 100)).toBe(true);
    });

    it('shouldFullRebuild - chunkSize 变 - 返回 true', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'm', 800, 100)).toBe(true);
    });

    it('shouldFullRebuild - chunkOverlap 变 - 返回 true', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'm', 500, 200)).toBe(true);
    });

    it('shouldFullRebuild - 全部不变 - 返回 false', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'm', 500, 100)).toBe(false);
    });

    it('diff - 全新文件 - 进 toAdd', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'h1', mtime: 100 },
        ]);
        expect(diff.toAdd).toHaveLength(1);
        expect(diff.toAdd[0]!.path).toBe('a.md');
        expect(diff.toUpdate).toHaveLength(0);
        expect(diff.toDelete).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(0);
    });

    it('diff - hash 未变 - 进 unchanged', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 },
            },
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'h1', mtime: 200 },
        ]);
        expect(diff.unchanged).toEqual(['a.md']);
        expect(diff.toUpdate).toHaveLength(0);
    });

    it('diff - hash 变 - 进 toUpdate', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'old', mtime: 100, chunkCount: 3 },
            },
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'new', mtime: 200 },
        ]);
        expect(diff.toUpdate).toHaveLength(1);
        expect(diff.toUpdate[0]!.path).toBe('a.md');
        expect(diff.unchanged).toHaveLength(0);
    });

    it('diff - manifest 有 vault 无 - 进 toDelete', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'gone.md': { path: 'gone.md', hash: 'h', mtime: 100, chunkCount: 2 },
            },
        };
        const diff = manifest2.diff(data, []);
        expect(diff.toDelete).toEqual(['gone.md']);
    });

    it('recordEntry - 写入后 entries 包含该条目', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        manifest2.recordEntry(data, 'a.md', 'h1', 100, 3);
        expect(data.entries['a.md']).toEqual({ path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 });
    });

    it('removeEntry - 移除后 entries 不含该条目', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 },
            },
        };
        manifest2.removeEntry(data, 'a.md');
        expect(data.entries['a.md']).toBeUndefined();
    });

    it('invalidate - 清空 entries 保留全局参数', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 1000,
            entries: {
                'a.md': { path: 'a.md', hash: 'h', mtime: 1, chunkCount: 1 },
            },
        };
        manifest2.invalidate(data);
        expect(data.entries).toEqual({});
        // 关键路径:全局参数保留,模型切换后全量重建时复用 embedModelId 等字段。
        expect(data.embedModelId).toBe('m');
        expect(data.chunkSize).toBe(500);
    });
});

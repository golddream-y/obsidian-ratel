/**
 * @file tests/core/model-downloader.test.ts
 * @description ModelDownloader 行为 — 磁盘不足时抛错
 * @module tests/core/model-downloader
 * @depends core/model-downloader
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:src/core/model-downloader.ts 现在通过 requestUrl 下载文件,需 mock 'obsidian'。
// 本测试只覆盖磁盘不足路径,不会真正触发下载,因此 requestUrl 用空实现即可。
vi.mock('obsidian', () => ({
    requestUrl: vi.fn(),
}));

import { ModelDownloader, InsufficientDiskError } from '../../src/core/model-downloader';

vi.mock('../../src/utils/disk-checker', () => ({
    hasEnoughDiskSpace: vi.fn().mockResolvedValue(true),
}));

describe('ModelDownloader', () => {
    it('磁盘不足 - 抛 InsufficientDiskError', async () => {
        const { hasEnoughDiskSpace } = await import('../../src/utils/disk-checker');
        (hasEnoughDiskSpace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
        const dl = new ModelDownloader('/tmp/models');
        await expect(dl.ensureModel()).rejects.toBeInstanceOf(InsufficientDiskError);
    });
});

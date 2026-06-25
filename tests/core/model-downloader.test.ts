/**
 * @file tests/core/model-downloader.test.ts
 * @description ModelDownloader 行为 — 磁盘不足时抛错
 * @module tests/core/model-downloader
 * @depends core/model-downloader
 */

import { describe, it, expect, vi } from 'vitest';
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

/**
 * @file tests/integration/model-download-integration.test.ts
 * @description 模型下载集成 — vi.mock transformers 模拟进度回调
 * @module tests/integration/model-download-integration
 * @depends core/model-downloader
 */

import { describe, it, expect, vi } from 'vitest';
import { ModelDownloader } from '../../src/core/model-downloader';

vi.mock('@huggingface/transformers', () => ({
    pipeline: vi.fn().mockImplementation(async (
        _task: string,
        _modelId: string,
        opts: { progress_callback?: (p: { status: string; progress?: number; file?: string }) => void },
    ) => {
        opts.progress_callback?.({ status: 'progress', progress: 50, file: 'model.onnx' });
        opts.progress_callback?.({ status: 'progress', progress: 100, file: 'model.onnx' });
        return {};
    }),
}));

describe('ModelDownloader 集成 - 进度回调', () => {
    it('ensureModel - 进度回调被触发', async () => {
        const dl = new ModelDownloader();
        const onProgress = vi.fn();
        await dl.ensureModel('Xenova/bge-small-zh-v1.5', onProgress);
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ file: 'model.onnx' }));
    });
});

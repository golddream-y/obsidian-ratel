/**
 * @file src/core/model-downloader.ts
 * @description 模型下载器 — 包装 transformers pipeline 加载
 * @module core/model-downloader
 * @depends utils/disk-checker
 *
 * 设计要点:
 * - 磁盘检测在下载前(1.2 倍缓冲)
 * - transformers pipeline 内部按需下载 + 缓存
 * - 进度回调由 transformers `progress_callback` 透传
 */

import { hasEnoughDiskSpace } from '../utils/disk-checker';
import path from 'path';
import os from 'os';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface');

/** 磁盘不足错误。 */
export class InsufficientDiskError extends Error {
    constructor(public neededBytes: number, public availableBytes: number) {
        super(`InsufficientDisk: need ${neededBytes} bytes, have ${availableBytes} bytes`);
    }
}

export interface ProgressInfo {
    file: string;
    progress: number;
    speed?: number;
}

export class ModelDownloader {
    private cacheDir: string;
    private modelSizes: Map<string, number> = new Map([
        ['Xenova/bge-small-zh-v1.5', 90 * 1024 * 1024],
        ['Xenova/bge-base-zh-v1.5', 210 * 1024 * 1024],
        ['Xenova/bge-large-zh-v1.5', 650 * 1024 * 1024],
        ['BAAI/bge-m3', 600 * 1024 * 1024],
    ]);

    constructor(cacheDir: string = DEFAULT_CACHE_DIR) {
        this.cacheDir = cacheDir;
    }

    /**
     * 启动 pipeline 加载(transformers 内部按需下载 + 缓存)。
     *
     * @param modelId - HuggingFace model id。
     * @param onProgress - 进度回调。
     * @returns transformers FeatureExtractor。
     * @throws InsufficientDiskError 磁盘不足。
     */
    async ensureModel(
        modelId: string,
        onProgress?: (p: ProgressInfo) => void,
    ): Promise<unknown> {
        const size = this.modelSizes.get(modelId) ?? 100 * 1024 * 1024;
        const enough = await hasEnoughDiskSpace(this.cacheDir, size);
        if (!enough) {
            throw new InsufficientDiskError(size, 0);
        }

        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline('feature-extraction', modelId, {
            dtype: 'q8',
            cache_dir: this.cacheDir,
            progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
                if (progress.status === 'progress' && progress.progress !== undefined) {
                    onProgress?.({
                        file: progress.file ?? modelId,
                        progress: progress.progress / 100,
                    });
                }
            },
        });
        return extractor;
    }

    /**
     * 删除本地缓存的指定模型。
     *
     * 关键路径:Hugging Face cache 目录形如 `models--<org>--<model>`,同时尝试
     * `cacheDir/hub/` 与 `cacheDir/` 两种布局,不存在时静默忽略。
     *
     * @param modelId - 要删除的模型 ID。
     */
    async remove(modelId: string): Promise<void> {
        const fs = await import('fs/promises');
        const safeId = modelId.replace(/\//g, '--');
        const candidates = [
            path.join(this.cacheDir, 'hub', `models--${safeId}`),
            path.join(this.cacheDir, `models--${safeId}`),
        ];
        for (const dir of candidates) {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
}

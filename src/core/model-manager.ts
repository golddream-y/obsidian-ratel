/**
 * @file src/core/model-manager.ts
 * @description 本地 Embedding 模型生命周期管理
 * @module core/model-manager
 * @depends core/model-downloader, svelte/store
 */

import { writable } from 'svelte/store';
import { InsufficientDiskError, type ProgressInfo } from './model-downloader';

export type ModelStatus =
    | { state: 'NotStarted' }
    | { state: 'Checking' }
    | { state: 'Downloading'; progress: number; speed: number; eta: number }
    | { state: 'Ready'; modelId: string; size: number; loadedAt: number }
    | { state: 'Failed'; reason: string }
    | { state: 'Switching'; from: string; to: string };

export interface ModelBackend {
    ensureModel(modelId: string, onProgress?: (p: ProgressInfo) => void): Promise<unknown>;
    remove(modelId: string): Promise<void>;
}

export class ModelManager {
    readonly status$ = writable<ModelStatus>({ state: 'NotStarted' });
    private backend: ModelBackend;
    private currentModelId: string | null = null;
    private extractor: unknown | null = null;

    constructor(backend: ModelBackend) {
        this.backend = backend;
    }

    /**
     * 下载指定模型(后台,带进度)。
     *
     * 关键路径:状态推进顺序 Checking → Downloading → Ready/Failed,UI 可订阅 status$。
     */
    async download(modelId: string, onProgress?: (p: ProgressInfo) => void): Promise<void> {
        this.status$.set({ state: 'Checking' });
        try {
            this.status$.set({ state: 'Downloading', progress: 0, speed: 0, eta: 0 });
            const startTime = Date.now();
            this.extractor = await this.backend.ensureModel(modelId, (p) => {
                onProgress?.(p);
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = p.progress > 0 ? p.progress / elapsed : 0;
                this.status$.set({
                    state: 'Downloading',
                    progress: p.progress,
                    speed,
                    eta: speed > 0 ? (1 - p.progress) / speed : 0,
                });
            });
            this.currentModelId = modelId;
            this.status$.set({ state: 'Ready', modelId, size: 0, loadedAt: Date.now() });
        } catch (err) {
            this.status$.set({
                state: 'Failed',
                reason: err instanceof InsufficientDiskError ? '磁盘空间不足' : String(err),
            });
        }
    }

    /**
     * 获取当前已加载的 transformers extractor。
     *
     * @returns 已下载模型对应的 pipeline;未下载时为 null。
     */
    getExtractor(): unknown | null {
        return this.extractor;
    }

    /** 切换当前激活模型(简化版:直接调 download)。 */
    async switchTo(modelId: string): Promise<void> {
        const prev = this.currentModelId ?? 'unknown';
        this.status$.set({ state: 'Switching', from: prev, to: modelId });
        await this.download(modelId);
    }

    /** 删除指定模型。 */
    async remove(modelId: string): Promise<void> {
        await this.backend.remove(modelId);
        this.currentModelId = null;
        this.extractor = null;
        this.status$.set({ state: 'NotStarted' });
    }

    /**
     * 一键清理所有已下载模型。
     *
     * @param modelIds - 要清理的模型 ID 列表。
     */
    async cleanup(modelIds: string[]): Promise<void> {
        for (const id of modelIds) {
            await this.backend.remove(id);
        }
        this.currentModelId = null;
        this.extractor = null;
        this.status$.set({ state: 'NotStarted' });
    }
}

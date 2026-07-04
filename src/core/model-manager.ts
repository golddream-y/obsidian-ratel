/**
 * @file src/core/model-manager.ts
 * @description 本地 Embedding 模型生命周期管理
 * @module core/model-manager
 * @depends core/model-downloader, adapters/embedding-onnx, svelte/store
 */

import { writable } from 'svelte/store';
import { InsufficientDiskError, type ProgressInfo, ModelDownloader } from './model-downloader';
import { EmbeddingOnnx, type EmbeddingOnnxDeps } from '../adapters/embedding-onnx';
import type { EmbeddingPort } from '../ports/embedding';
import { OrtRuntimeAssets } from './ort-runtime-assets';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * 创建默认的模型加载函数:从缓存目录读取 ONNX + vocab,从 OrtRuntimeAssets 读取 ORT WASM,
 * 然后初始化 EmbeddingOnnx。
 *
 * 关键路径:用工厂模式接收 ortAssets,返回符合 (modelDir: string) => Promise<EmbeddingPort> 签名,
 * 避免在 ModelManager 构造时就读取 wasm 文件(延迟到 download() 调用时)。
 *
 * @param ortAssets - ONNX Runtime WASM 懒下载与缓存。
 */
export function createDefaultEmbeddingFactory(ortAssets: OrtRuntimeAssets) {
    return async (modelDir: string): Promise<EmbeddingPort> => {
        const [onnxBuffer, wasmBinary, vocabContent] = await Promise.all([
            readFile(path.join(modelDir, 'model_quantized.onnx')),
            ortAssets.readWasmBinary(),
            // 关键路径:vocab 用内容传递,与 Web Worker 路径一致(Worker 无 node:fs)。
            readFile(path.join(modelDir, 'vocab.txt'), 'utf-8'),
        ]);
        // 关键路径:readFile 返回的 Buffer 底层 ArrayBuffer 可能大于实际数据,复制为独立 Uint8Array 后再取 buffer。
        const modelBuffer = new Uint8Array(onnxBuffer).buffer;
        const embedding = new EmbeddingOnnx({
            vocabContent,
            modelBuffer,
            wasmBinary,
        });
        await embedding.init();
        return embedding;
    };
}

export type ModelStatus =
    | { state: 'NotStarted' }
    | { state: 'Checking' }
    | { state: 'Downloading'; progress: number; speed: number; eta: number }
    | { state: 'Initializing' }
    | { state: 'Ready'; modelId: string; size: number; loadedAt: number }
    | { state: 'Failed'; reason: string }
    | { state: 'Switching'; from: string; to: string };

export class ModelManager {
    readonly status$ = writable<ModelStatus>({ state: 'NotStarted' });
    private downloader: ModelDownloader;
    private embedding: EmbeddingPort | null = null;
    private cacheDir: string;
    // 关键路径:ortAssets 供 getDeps() 重新读盘,Web Worker 需要全新的 ArrayBuffer 副本 transfer。
    private ortAssets: OrtRuntimeAssets;
    // 关键路径:modelDir 在 download() 成功后记录,getDeps() 据此重新读取模型文件。
    private modelDir: string | null = null;
    private createEmbedding: (modelDir: string) => Promise<EmbeddingPort>;

    constructor(
        cacheDir: string,
        ortAssets: OrtRuntimeAssets,
        downloader?: ModelDownloader,
        createEmbedding?: (modelDir: string) => Promise<EmbeddingPort>,
    ) {
        this.cacheDir = cacheDir;
        this.ortAssets = ortAssets;
        this.downloader = downloader ?? new ModelDownloader(cacheDir);
        // 关键路径:createEmbedding 未传入时,用 ortAssets 构造默认工厂;
        // 测试场景下传入 mock 函数则跳过默认逻辑。
        this.createEmbedding = createEmbedding ?? createDefaultEmbeddingFactory(ortAssets);
    }

    /**
     * 下载并加载本地 Embedding 模型。
     *
     * 关键路径:
     * - 状态推进顺序 Checking → Downloading → Ready/Failed,UI 可订阅 status$。
     * - 失败时同时设置 status$ 与 throw,让调用方既能看到状态也能 catch。
     *
     * @throws Error 任何 backend 失败都抛出,便于 main.ts / onLayoutReady catch。
     */
    async download(onProgress?: (p: ProgressInfo) => void): Promise<void> {
        this.status$.set({ state: 'Checking' });
        try {
            this.status$.set({ state: 'Downloading', progress: 0, speed: 0, eta: 0 });
            const startTime = Date.now();
            // 关键路径:WASM(~13MB) 与 ONNX 模型(~24MB) 并行下载,各自 0-1 进度需加权合并,避免竞态把 progress 顶到 >100%。
            let wasmProgress = 0;
            let modelProgress = 0;
            const WASM_DOWNLOAD_WEIGHT = 0.35;
            const MODEL_DOWNLOAD_WEIGHT = 0.65;
            const emitCombinedProgress = () => {
                const combined = Math.min(
                    1,
                    wasmProgress * WASM_DOWNLOAD_WEIGHT + modelProgress * MODEL_DOWNLOAD_WEIGHT,
                );
                onProgress?.({ file: 'download', progress: combined });
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = combined > 0 ? combined / elapsed : 0;
                this.status$.set({
                    state: 'Downloading',
                    progress: combined,
                    speed,
                    eta: speed > 0 ? (1 - combined) / speed : 0,
                });
            };
            const reportWasmProgress = (p: ProgressInfo) => {
                wasmProgress = Math.min(1, p.progress);
                emitCombinedProgress();
            };
            const reportModelProgress = (p: ProgressInfo) => {
                modelProgress = Math.min(1, p.progress);
                emitCombinedProgress();
            };
            // 关键路径:ORT WASM 与 ONNX 模型并行下载,首次初始化更快(ADR-006)。
            const [modelDir] = await Promise.all([
                this.downloader.ensureModel(reportModelProgress),
                this.ortAssets.ensureWasm(reportWasmProgress),
            ]);
            // 关键路径:记录 modelDir 供 getDeps() 重新读盘,Web Worker 需要全新 ArrayBuffer 副本。
            this.modelDir = modelDir;

            // 关键路径:文件下载完后,ORT 还要编译 WASM + 加载模型权重,这在主线程可能需要几秒到十几秒,
            // 必须给用户状态反馈,否则会以为卡住了。
            this.status$.set({ state: 'Initializing' });
            const embedding = await this.createEmbedding(modelDir);
            this.embedding = embedding;

            this.status$.set({ state: 'Ready', modelId: embedding.modelId, size: 0, loadedAt: Date.now() });
        } catch (err) {
            const reason = err instanceof InsufficientDiskError
                ? '磁盘空间不足'
                : err instanceof Error
                    ? err.message
                    : String(err);
            this.status$.set({ state: 'Failed', reason });
            throw err instanceof Error ? err : new Error(reason);
        }
    }

    /**
     * 获取已加载的本地 Embedding 适配器。
     *
     * @returns 已就绪的 EmbeddingOnnx;未下载时为 null。
     */
    getEmbedding(): EmbeddingPort | null {
        return this.embedding;
    }

    /**
     * 重新从磁盘读取模型依赖,返回可安全 transfer 给 Web Worker 的 EmbeddingOnnxDeps。
     *
     * 关键路径:
     * - EmbeddingWorkerProxy 在 init 时把 modelBuffer / wasmBinary 作为 transferable postMessage 给 Worker,
     *   transfer 后主线程的 ArrayBuffer 会被 neuter(长度归零)。
     * - 因此不能复用主线程 EmbeddingOnnx 实例持有的 buffer,必须重新读盘得到全新副本。
     * - 模型未下载(modelDir 为 null)时返回 null,调用方据此报错。
     *
     * @returns 全新的模型依赖;模型未下载时返回 null。
     * @throws Error 文件读取失败(模型文件被删除等)。
     */
    async getDeps(): Promise<EmbeddingOnnxDeps | null> {
        if (!this.modelDir) return null;
        // 关键路径:并行读盘,与 createDefaultEmbeddingFactory 一致的路径结构。
        const [onnxBuffer, wasmBinary, vocabContent] = await Promise.all([
            readFile(path.join(this.modelDir, 'model_quantized.onnx')),
            this.ortAssets.readWasmBinary(),
            readFile(path.join(this.modelDir, 'vocab.txt'), 'utf-8'),
        ]);
        // 关键路径:readFile 返回的 Buffer 底层 ArrayBuffer 可能大于实际数据,
        // 复制为独立 Uint8Array 后再取 buffer,确保 transfer 的是精确大小的 ArrayBuffer。
        return {
            vocabContent,
            modelBuffer: new Uint8Array(onnxBuffer).buffer,
            wasmBinary,
        };
    }

    /** 删除本地模型缓存。 */
    async remove(): Promise<void> {
        await this.downloader.remove();
        this.embedding = null;
        this.modelDir = null;
        this.status$.set({ state: 'NotStarted' });
    }
}

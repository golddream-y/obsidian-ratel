/**
 * @file src/core/model-downloader.ts
 * @description 本地 Embedding 模型下载器 — 从 ModelScope 下载 ONNX 模型 + vocab.txt
 * @module core/model-downloader
 * @depends node:fs/promises, node:path, utils/disk-checker
 *
 * 设计要点:
 * - 固定模型:bge-small-zh-v1.5(Xenova 导出的 ONNX 版本)。
 * - 下载源:ModelScope(国内可访问),不走 HuggingFace Hub。
 * - 只下载两个文件:onnx/model_quantized.onnx(24MB) + vocab.txt(109KB)。
 * - 磁盘检测在下载前(1.2 倍缓冲)。
 */

import { hasEnoughDiskSpace } from '../utils/disk-checker';
import path from 'node:path';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';

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

/** 默认模型信息。 */
export const DEFAULT_LOCAL_MODEL = {
    modelId: 'Xenova/bge-small-zh-v1.5',
    onnxPath: 'onnx/model_quantized.onnx',
    vocabPath: 'vocab.txt',
    // 24MB ONNX + 109KB vocab,留 1.2 倍缓冲。
    neededBytes: 30 * 1024 * 1024,
} as const;

/** ModelScope 下载基地址。 */
const MODELSCOPE_BASE = 'https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master';

export class ModelDownloader {
    private cacheDir: string;

    constructor(cacheDir: string) {
        this.cacheDir = cacheDir;
    }

    /**
     * 确保本地缓存目录存在并返回模型缓存根目录。
     *
     * 关键路径:cacheDir 由调用方(ModelManager/main.ts)传入,已经是模型缓存根目录(如 <pluginDir>/models),
     * 这里只追加 modelId 命名空间(Xenova/bge-small-zh-v1.5),不再额外拼接 models/ 层。
     */
    private async ensureCacheDir(): Promise<string> {
        const dir = path.join(this.cacheDir, DEFAULT_LOCAL_MODEL.modelId);
        await mkdir(dir, { recursive: true });
        return dir;
    }

    /**
     * 下载指定文件到本地缓存目录。
     *
     * @param remoteName - ModelScope 上的相对路径。
     * @param localPath - 本地保存路径。
     * @param onProgress - 进度回调,progress 为 0-1。
     * @throws InsufficientDiskError 磁盘不足。
     * @throws Error 下载失败。
     */
    private async downloadFile(
        remoteName: string,
        localPath: string,
        onProgress?: (p: ProgressInfo) => void,
    ): Promise<void> {
        const url = `${MODELSCOPE_BASE}/${remoteName}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`下载 ${remoteName} 失败: ${response.status} ${response.statusText}`);
        }

        const total = Number(response.headers.get('content-length')) || 0;
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error(`下载 ${remoteName} 失败: response.body 为空`);
        }

        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total > 0) {
                onProgress?.({
                    file: remoteName,
                    progress: received / total,
                });
            }
        }

        // 关键路径:浏览器/Node fetch 返回的 chunks 合并成完整 ArrayBuffer 后写入磁盘。
        const all = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }

        await writeFile(localPath, all);
    }

    /**
     * 确保本地 Embedding 模型文件已下载。
     *
     * @param onProgress - 进度回调。
     * @returns 本地缓存的模型目录路径。
     * @throws InsufficientDiskError 磁盘不足。
     * @throws Error 网络或文件系统错误。
     */
    async ensureModel(onProgress?: (p: ProgressInfo) => void): Promise<string> {
        const enough = await hasEnoughDiskSpace(this.cacheDir, DEFAULT_LOCAL_MODEL.neededBytes);
        if (!enough) {
            throw new InsufficientDiskError(DEFAULT_LOCAL_MODEL.neededBytes, 0);
        }

        const dir = await this.ensureCacheDir();
        const onnxLocal = path.join(dir, 'model_quantized.onnx');
        const vocabLocal = path.join(dir, 'vocab.txt');

        let onnxExists = false;
        let vocabExists = false;
        try {
            await access(onnxLocal);
            onnxExists = true;
        } catch { /* 文件不存在 */ }
        try {
            await access(vocabLocal);
            vocabExists = true;
        } catch { /* 文件不存在 */ }

        if (!onnxExists) {
            await this.downloadFile(DEFAULT_LOCAL_MODEL.onnxPath, onnxLocal, (p) => {
                onProgress?.({ file: p.file, progress: p.progress * 0.99 });
            });
        }
        if (!vocabExists) {
            await this.downloadFile(DEFAULT_LOCAL_MODEL.vocabPath, vocabLocal, (p) => {
                onProgress?.({ file: p.file, progress: 0.99 + p.progress * 0.01 });
            });
        }

        return dir;
    }

    /**
     * 删除本地缓存的默认模型。
     */
    async remove(): Promise<void> {
        const dir = path.join(this.cacheDir, DEFAULT_LOCAL_MODEL.modelId);
        await rm(dir, { recursive: true, force: true });
    }
}

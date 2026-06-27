/**
 * @file tests/integration/local-embedding-e2e.test.ts
 * @description 本地 Embedding 端到端验证:从 ModelScope 下载真实模型并跑通推理。
 * @module tests/integration/local-embedding-e2e
 * @depends core/model-downloader, adapters/embedding-onnx
 *
 * 关键路径:
 * - 该测试会真实下载 24MB ONNX 模型,默认不随 `npm test` 运行,需单独执行本文件。
 * - 验证下载 → 加载 → 推理整条链路无报错,确保 Obsidian 外独立可跑通。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { rm, readFile, mkdir } from 'node:fs/promises';
import { ModelDownloader } from '../../src/core/model-downloader';
import { EmbeddingOnnx } from '../../src/adapters/embedding-onnx';

const CACHE_DIR = path.join(os.tmpdir(), `ratel-e2e-${Date.now()}`);

describe('本地 Embedding 端到端', () => {
	let modelDir: string;

	beforeAll(async () => {
		// 关键路径:disk-checker 需要目录已存在才能 statfs,先建临时缓存目录。
		await mkdir(CACHE_DIR, { recursive: true });
		const downloader = new ModelDownloader(CACHE_DIR);
		modelDir = await downloader.ensureModel((p) => {
			// 关键路径:进度回调仅打印,不阻塞下载。
			console.log(`[e2e] ${p.file}: ${(p.progress * 100).toFixed(1)}%`);
		});
	}, 120_000);

	afterAll(async () => {
		// 关键路径:清理临时缓存,避免污染系统临时目录。
		await rm(CACHE_DIR, { recursive: true, force: true });
	});

	it('下载后可用 EmbeddingOnnx 推理出 512 维向量', async () => {
		const onnxBuffer = await readFile(path.join(modelDir, 'model_quantized.onnx'));
		const vocabContent = await readFile(path.join(modelDir, 'vocab.txt'), 'utf-8');
		const modelBuffer = new Uint8Array(onnxBuffer).buffer;

		const embedding = new EmbeddingOnnx({
			vocabContent,
			modelBuffer,
		});
		await embedding.init();

		const [a, b, c] = await embedding.embed([
			'机器学习是人工智能的一个分支',
			'深度学习属于人工智能领域',
			'今天天气很好适合去公园散步',
		]);

		expect(a).toHaveLength(512);
		expect(b).toHaveLength(512);
		expect(c).toHaveLength(512);

		const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i], 0);
		const simAB = dot(a, b);
		const simAC = dot(a, c);
		// 关键路径:语义相近文本的相似度应明显高于无关文本。
		expect(simAB).toBeGreaterThan(simAC);
	}, 120_000);
});

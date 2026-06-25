/**
 * @file tests/adapters/embedding-onnx.test.ts
 * @description EmbeddingOnnx 单元测试
 * @module tests/adapters/embedding-onnx
 * @depends src/adapters/embedding-onnx
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { EmbeddingOnnx } from '../../src/adapters/embedding-onnx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(__dirname, '../fixtures/bge-small-zh-v1.5');
const VOCAB_PATH = path.join(FIXTURE_DIR, 'vocab.txt');
const MODEL_PATH = path.join(FIXTURE_DIR, 'model_quantized.onnx');
const WASM_PATH = path.join(PROJECT_ROOT, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm');

async function createEmbedding(): Promise<EmbeddingOnnx> {
	const [modelBuffer, wasmBuffer] = await Promise.all([
		readFile(MODEL_PATH),
		readFile(WASM_PATH),
	]);
	const emb = new EmbeddingOnnx({
		vocabPath: VOCAB_PATH,
		modelBuffer: new Uint8Array(modelBuffer).buffer,
		wasmBinary: new Uint8Array(wasmBuffer).buffer,
	});
	await emb.init();
	return emb;
}

describe('EmbeddingOnnx', () => {
	it('构造 - 默认 modelId - 为 local:bge-small-zh-v1.5', () => {
		const emb = new EmbeddingOnnx({ vocabPath: VOCAB_PATH, modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) });
		expect(emb.modelId).toBe('local:bge-small-zh-v1.5');
		expect(emb.dimensions).toBe(512);
	});

	it('embed - 未 init - 抛错', async () => {
		const emb = new EmbeddingOnnx({ vocabPath: VOCAB_PATH, modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) });
		await expect(emb.embed(['hello'])).rejects.toThrow('未初始化');
	});

	it('embed - 空数组 - 返回空数组', async () => {
		const emb = await createEmbedding();
		const out = await emb.embed([]);
		expect(out).toEqual([]);
	});

	it('embed - 单条文本 - 返回 512 维单位向量', async () => {
		const emb = await createEmbedding();
		const out = await emb.embed(['你好世界']);
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(512);

		// L2 norm ≈ 1
		const norm = Math.sqrt(out[0].reduce((sum, v) => sum + v * v, 0));
		expect(norm).toBeCloseTo(1, 5);
	});

	it('embed - 两条语义相近文本 - 点积高于两条语义无关文本', async () => {
		const emb = await createEmbedding();
		const [a, b, c] = await emb.embed([
			'机器学习是人工智能的一个分支',
			'深度学习属于人工智能领域',
			'今天天气很好适合去公园散步',
		]);

		const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i], 0);
		const simAB = dot(a, b);
		const simAC = dot(a, c);
		expect(simAB).toBeGreaterThan(simAC);
	});
});

/**
 * @file tests/adapters/embedding-onnx.test.ts
 * @description EmbeddingOnnx 单元测试
 * @module tests/adapters/embedding-onnx
 * @depends src/adapters/embedding-onnx
 */

import { describe, it, expect, vi } from 'vitest';
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

async function createEmbedding(maxBatchSize = 16): Promise<EmbeddingOnnx> {
	const [modelBuffer, wasmBuffer, vocabContent] = await Promise.all([
		readFile(MODEL_PATH),
		readFile(WASM_PATH),
		readFile(VOCAB_PATH, 'utf-8'),
	]);
	const emb = new EmbeddingOnnx(
		{
			vocabContent,
			modelBuffer: new Uint8Array(modelBuffer).buffer,
			wasmBinary: new Uint8Array(wasmBuffer).buffer,
		},
		512,
		maxBatchSize,
	);
	await emb.init();
	return emb;
}

// 关键路径:ONNX 会话初始化的成本可观,同一批次上限的实例在用例间复用;
// 复用的是只读推理会话,用例不改变实例配置。
let sharedDefault: Promise<EmbeddingOnnx> | null = null;
function defaultEmbedding(): Promise<EmbeddingOnnx> {
	sharedDefault ??= createEmbedding(16);
	return sharedDefault;
}

describe('EmbeddingOnnx', () => {
	it('构造 - 默认 modelId - 为 local:bge-small-zh-v1.5', () => {
		// 关键路径:仅验证构造,不调 init(),vocabContent 用占位串即可。
		const emb = new EmbeddingOnnx({ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) });
		expect(emb.modelId).toBe('local:bge-small-zh-v1.5');
		expect(emb.dimensions).toBe(512);
	});

	it('embed - 未 init - 抛错', async () => {
		const emb = new EmbeddingOnnx({ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) });
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

/**
 * T5 新增行为:批次活动回报与批次边界取消。
 *
 * 关键路径:这两条行为都在 EmbeddingOnnx 的 embed 主路径上,必须用**真实推理**取证 ——
 * 用 mock 掉 EmbeddingOnnx 的消费者测试无法证明「每个真实完成批次回报一次」。
 */
describe('EmbeddingOnnx — T5 批次回报与批次边界取消', () => {
	it('embed - 5 条文本 maxBatchSize=2 - 每个真实完成批次各回报一次,次数等于批次数', async () => {
		const emb = await createEmbedding(2);
		const batches: Array<[number, number]> = [];
		const out = await emb.embed(['一', '二', '三', '四', '五'], {
			onBatchComplete: (done, total) => batches.push([done, total]),
		});

		expect(out).toHaveLength(5);
		// 关键路径:ceil(5 / 2) = 3 个批次,回报必须精确对应每个批次的累计完成数,
		// 不是「总次数附近」的近似值。
		expect(batches).toEqual([[2, 5], [4, 5], [5, 5]]);
	});

	it('embed - 文本数整除批次上限 - 回报次数等于批次数且累计数单调递增到总数', async () => {
		const emb = await createEmbedding(2);
		const batches: Array<[number, number]> = [];
		await emb.embed(['a', 'b', 'c', 'd'], {
			onBatchComplete: (done, total) => batches.push([done, total]),
		});

		expect(batches).toEqual([[2, 4], [4, 4]]);
	});

	it('embed - 单批(文本数不超过批次上限) - 只回报一次 (n, n)', async () => {
		const emb = await defaultEmbedding();
		const batches: Array<[number, number]> = [];
		await emb.embed(['一', '二', '三'], {
			onBatchComplete: (done, total) => batches.push([done, total]),
		});

		expect(batches).toEqual([[3, 3]]);
	});

	it('embed - 发批次前 signal 已中止 - 不跑任何批次、零回报、按 AbortError 结束', async () => {
		const emb = await defaultEmbedding();
		const controller = new AbortController();
		controller.abort();
		const batches: Array<[number, number]> = [];

		await expect(
			emb.embed(['一', '二'], { signal: controller.signal, onBatchComplete: (done, total) => batches.push([done, total]) }),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(batches).toEqual([]);
	});

	it('embed - 首批完成回报内中止 signal - 按 AbortError 结束、不再跑后续批次、无额外回报', async () => {
		const emb = await createEmbedding(2);
		// 关键路径:给真实会话的 run 打计数探针,证明「不再继续后续批次」是真没跑,而不是只少报了一次活动。
		const session = (emb as unknown as { session: { run: (...args: unknown[]) => Promise<unknown> } }).session;
		const runSpy = vi.spyOn(session, 'run');
		const controller = new AbortController();
		const batches: Array<[number, number]> = [];

		await expect(
			emb.embed(['一', '二', '三', '四', '五'], {
				signal: controller.signal,
				onBatchComplete: (done, total) => {
					batches.push([done, total]);
					// 第一批真实完成后立刻取消:下一个批次边界必须中止。
					controller.abort();
				},
			}),
		).rejects.toMatchObject({ name: 'AbortError' });

		// 5 条文本按 2 条一批共 3 批;中止后只应有第 1 批的回报与 1 次真实推理。
		expect(batches).toEqual([[2, 5]]);
		expect(runSpy).toHaveBeenCalledTimes(1);
		runSpy.mockRestore();
	});

	it('embed - 未传 options 与传空 options / 仅批次回调 - 结果逐元素一致(向后兼容)', async () => {
		const emb = await defaultEmbedding();
		const texts = ['你好世界', '机器学习是人工智能的一个分支'];

		// 关键路径:旧调用 embed(texts) 的路径不变。ONNX 推理是确定性的,
		// 两次调用的向量必须逐元素相等,才能说明新增分支没有改变旧行为。
		const legacy = await emb.embed(texts);
		const emptyOptions = await emb.embed(texts, {});
		const withCallback = await emb.embed(texts, { onBatchComplete: () => undefined });

		expect(legacy).toHaveLength(2);
		expect(legacy[0]).toHaveLength(512);
		expect(emptyOptions).toEqual(legacy);
		expect(withCallback).toEqual(legacy);
	});
});

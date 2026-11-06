/**
 * @file tests/adapters/embedding-onnx.test.ts
 * @description EmbeddingOnnx 单元测试 — 真实 ONNX 推理用例由环境变量门控
 * @module tests/adapters/embedding-onnx
 * @depends src/adapters/embedding-onnx
 *
 * 关键路径(T7 门禁收口):
 * - 本文件**不在默认套件内**。夹具 `tests/fixtures/bge-small-zh-v1.5/model_quantized.onnx`(23M)
 *   已被 git 跟踪,默认套件会真跑 ORT 会话初始化与推理:默认 5s 超时对真实 ONNX 从来不够
 *   (实测串行单文件在大面积 `Test timed out in 5000ms` 下才会绿)。
 * - 运行方式(默认 `npx vitest run` 不会收集本文件):
 *   `RATEL_ONNX=1 npx vitest run --no-file-parallelism tests/adapters/embedding-onnx.test.ts`
 *   `vitest.config.ts` 的排除项由 `RATEL_ONNX` 门控,而不是无条件排除 —— vitest 的 `exclude`
 *   优先于命令行路径过滤,无条件排除会让上面这条命令变成 `No test files found` 并静默 exit 0。
 * - 真实会话按批次上限在用例间**复用**(`defaultEmbedding()` / `batchOfTwoEmbedding()`):
 *   此前每例各自 `createEmbedding`,等于各自 init 一个 ORT 会话;会话是只读推理实例,
 *   用例不改变其配置。
 * - 批次边界取消的两条用例**不受门控**(见下方 describe 说明):它们是取消语义的唯一真实取证。
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

/**
 * 真实 ONNX 用例的显式超时 — 默认 5s 对 ORT 会话初始化与推理从来不够。
 *
 * 关键路径:超时口径必须是**显式**的,否则一次高负载就会把推理用例判成失败,
 * 掩盖真正的行为回归;这里统一在 describe 级声明,避免逐例漂移。
 */
const ONNX_CASE_TIMEOUT_MS = 120_000;

/** 是否运行真实 ONNX 推理用例 — 默认套件(未设置该变量)不跑。 */
const RUN_REAL_ONNX = process.env.RATEL_ONNX === '1';

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

// 关键路径(T7):批次回报与批次边界取消用例需要 `maxBatchSize=2` 的会话。
// 此前三例各自 `createEmbedding(2)`,等于各自 init 一个 ORT 会话(实测拖垮整个文件);
// 这里按批次上限共用同一个只读会话。
let sharedBatch2: Promise<EmbeddingOnnx> | null = null;
function batchOfTwoEmbedding(): Promise<EmbeddingOnnx> {
	sharedBatch2 ??= createEmbedding(2);
	return sharedBatch2;
}

/** 构造与未初始化路径 — 不触发任何真实推理,可安全留在默认可收集范围。 */
describe('EmbeddingOnnx — 构造与未初始化路径', () => {
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
});

/**
 * T5 新增行为:批次边界取消 — **不受 `RATEL_ONNX` 门控**。
 *
 * 关键路径(T7 门禁收口):这两条是「批次边界取消」的唯一**真实取证** ——
 * 用 mock 掉 EmbeddingOnnx 的消费者测试无法证明「中止后真的没再跑后续批次」。
 * 它们复用共享会话、不额外 init,因此明确不加 `skipIf`:门控只能跳过同文件里需要
 * 新会话/长推理的用例,不能连这两条取证一起丢掉。
 */
describe('EmbeddingOnnx — 取消语义(不受 RATEL_ONNX 门控)', { timeout: ONNX_CASE_TIMEOUT_MS }, () => {
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
		const emb = await batchOfTwoEmbedding();
		// 关键路径:给真实会话的 run 打计数探针,证明「不再继续后续批次」是真没跑,而不是只少报了一次活动。
		const session = (emb as unknown as { session: { run: (...args: unknown[]) => Promise<unknown> } }).session;
		const runSpy = vi.spyOn(session, 'run');
		const controller = new AbortController();
		const batches: Array<[number, number]> = [];
		try {
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
		} finally {
			// 关键路径:会话是**共享**的,探针必须无条件还原,否则后续用例的 run 计数会被污染。
			runSpy.mockRestore();
		}
	});
});

/**
 * 真实 ONNX 推理 — 只有在 `RATEL_ONNX=1` 时运行。
 *
 * 关键路径:这里每条都会真的初始化/使用 ORT 会话;默认套件已通过 `vitest.config.ts` 的
 * 环境变量门控排除本文件,`skipIf` 是第二道防线(专用 config 或直接指定路径时仍会生效)。
 */
describe.skipIf(!RUN_REAL_ONNX)('EmbeddingOnnx — 真实 ONNX 推理(需 RATEL_ONNX=1)', { timeout: ONNX_CASE_TIMEOUT_MS }, () => {
	it('embed - 空数组 - 返回空数组', async () => {
		const emb = await defaultEmbedding();
		const out = await emb.embed([]);
		expect(out).toEqual([]);
	});

	it('embed - 单条文本 - 返回 512 维单位向量', async () => {
		const emb = await defaultEmbedding();
		const out = await emb.embed(['你好世界']);
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(512);

		// L2 norm ≈ 1
		const norm = Math.sqrt(out[0]!.reduce((sum, v) => sum + v * v, 0));
		expect(norm).toBeCloseTo(1, 5);
	});

	it('embed - 两条语义相近文本 - 点积高于两条语义无关文本', async () => {
		const emb = await defaultEmbedding();
		const [a, b, c] = await emb.embed([
			'机器学习是人工智能的一个分支',
			'深度学习属于人工智能领域',
			'今天天气很好适合去公园散步',
		]);

		const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i]!, 0);
		const simAB = dot(a!, b!);
		const simAC = dot(a!, c!);
		expect(simAB).toBeGreaterThan(simAC);
	});

	it('embed - 5 条文本 maxBatchSize=2 - 每个真实完成批次各回报一次,次数等于批次数', async () => {
		const emb = await batchOfTwoEmbedding();
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
		const emb = await batchOfTwoEmbedding();
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
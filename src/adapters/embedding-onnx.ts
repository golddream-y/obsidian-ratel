/**
 * @file src/adapters/embedding-onnx.ts
 * @description 基于 onnxruntime-web 的本地 Embedding 适配器,专用于 bge-small-zh-v1.5
 * @module adapters/embedding-onnx
 * @depends onnxruntime-web, src/adapters/bert-tokenizer, src/ports/embedding
 *
 * 设计要点:
 * - 完全绕开 @huggingface/transformers,在 Obsidian 渲染进程可用。
 * - 用自写 BertTokenizer 生成 input_ids / attention_mask / token_type_ids。
 * - ONNX 模型输出 last_hidden_state,再经 mean pooling + L2 normalize 得到最终向量。
 * - 批量推理时一次性构造 [batch, seqLen] 张量,减少 WASM 调用次数。
 */

import * as ort from 'onnxruntime-web';
import { throwIfEmbeddingAborted, type EmbeddingPort } from '../ports/embedding';
import type { EmbedOptions } from '../core/index-persistence-types';
import { createTokenizer, parseVocab, type BertTokenizer } from './bert-tokenizer';
import { tNow } from '../i18n';
import { devLogger } from '../logging/dev-logger';

// 关键路径:Tensor 构造函数在 embed 中复用,避免每次重复动态 import。
type TensorConstructor = typeof ort.Tensor;

/**
 * 构造 EmbeddingOnnx 实例所需的依赖。
 *
 * 关键路径:vocab 用内容(string)而非路径传递,让 Web Worker(无 node:fs)
 * 也能直接构造 tokenizer;主线程负责读文件后传入。
 */
export interface EmbeddingOnnxDeps {
	/**
	 * vocab.txt 的文本内容。
	 *
	 * 关键路径:用内容而非路径,避免 Web Worker 依赖 node:fs 读文件。
	 * 主线程读取 vocab.txt 后传入,Worker 内用 parseVocab 解析。
	 */
	vocabContent: string;

	/**
	 * ONNX 模型文件内容(ArrayBuffer)。
	 */
	modelBuffer: ArrayBuffer;

	/**
	 * onnxruntime-web 的 WASM 二进制内容(ArrayBuffer)。
	 *
	 * 关键路径:WASM 二进制由外部(Node.js fs 读取)传入,避免在本模块内硬编码路径,
	 * 也让测试环境可显式传入 node_modules 中的 wasm 文件。
	 */
	wasmBinary: ArrayBuffer;

	/**
	 * 模型标识,默认 local:bge-small-zh-v1.5。
	 */
	modelId?: string;

	/**
	 * 是否尝试 WebGPU 执行器。
	 *
	 * 关键路径(S-WEBGPU-EMBEDDING):只有 GPU 版 Worker 置 true;WASM 版缺省 false。
	 * 该字段**不参与配置指纹**,因此切换后端不会重建索引。
	 */
	enableWebgpu?: boolean;

	/** 构建期内联的 jsep 胶水模块源码;GPU 版非空。 */
	glueSource?: string;
}

/**
 * 可选序列长度档位 — 填充只对齐到这些值。
 *
 * 关键路径(S-WEBGPU-EMBEDDING):GPU 执行器会按输入形状建立流水线/缓冲区缓存,
 * 形状种类越多,重复编译与分配越多。若按 8 的倍数对齐,一次索引里能出现 60 多种形状,
 * 实测端到端从 0.26 秒/块退化到 0.43 秒/块;档位化把形状压到十几种,
 * 同时仍保留「短块少算」的收益。
 */
const PAD_LENGTH_BUCKETS = [16, 32, 64, 96, 128, 160, 192, 224, 256, 320, 384, 448, 512] as const;

/**
 * 计算批内填充长度:取最长真实长度,向上取最近的档位,最大 512。
 *
 * 关键路径:attention 算力随长度平方增长,按真实长度档位填充比固定 512 省算力;
 * 而档位而非逐 8 对齐,是为了避免 GPU 上出现过多不同的输入形状。
 *
 * @param lengths - 批内每条的 token 数(含 [CLS]/[SEP])
 * @returns 实际使用的序列长度
 */
function padLengthFor(lengths: number[]): number {
	const longest = lengths.reduce((max, value) => (value > max ? value : max), 0);
	if (longest <= 0) return PAD_LENGTH_BUCKETS[0];
	const bucket = PAD_LENGTH_BUCKETS.find((candidate) => candidate >= longest);
	return bucket ?? 512;
}

/**
 * 基于 onnxruntime-web 的本地 Embedding 适配器。
 *
 * 关键路径:
 * - 构造时异步加载词表与 ONNX 模型,构造失败会抛错,避免运行时静默失败。
 * - embed() 支持批量输入,内部一次性 run,避免多次 WASM 调用;单批次过大时自动切片,
 *   防止主线程/InlineWorker 被长时间阻塞。
 */
export class EmbeddingOnnx implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;
	private tokenizer!: BertTokenizer;
	private session!: ort.InferenceSession;
	private TensorCtor!: TensorConstructor;
	private ready = false;
	/** 内联胶水模块的 Blob URL。 */
	private glueUrl: string | undefined;
	// 关键路径:单批最大文本数,过大时会分多批推理;取值依据是 bge-small 512 维 + WASM 单线程
	// 场景下,16 条文本推理时间约数百毫秒,不会明显阻塞 UI。
	private readonly maxBatchSize: number;

	constructor(
		private readonly deps: EmbeddingOnnxDeps,
		dimensions = 512,
		maxBatchSize = 16,
	) {
		this.dimensions = dimensions;
		this.maxBatchSize = maxBatchSize;
		this.modelId = deps.modelId ?? 'local:bge-small-zh-v1.5';
	}

	/**
	 * 加载词表与 ONNX 模型。
	 *
	 * 关键路径:onnxruntime-web 的 InferenceSession.create 是异步的,
	 * 且需要在设置 wasmBinary 后调用。本方法由 ModelManager 在模型下载完成后调用。
	 *
	 * 关键路径:
	 * - wasmBinary 由外部通过 deps 传入,ORT 不再去 fetch/import 外部 .wasm/.mjs 文件,
	 *   避免在 Obsidian 的 app://obsidian.md origin 下出现 CORS 或文件找不到错误。
	 * - numThreads=1 禁用多线程,既避免 SharedArrayBuffer/crossOriginIsolated 要求,
	 *   也让 wasmBinary 模式走 embeddedModule 路径,不动态 import 外部 .mjs 文件。
	 * - executionProviders 显式指定 ['wasm'],禁止尝试加载 WebGPU/JSEP 后端。
	 */
	async init(): Promise<void> {
		// 关键路径:用 parseVocab(纯函数)替代 loadVocab(依赖 node:fs),
		// 让 Web Worker 也能直接从主线程传入的 vocabContent 构造 tokenizer。
		const vocab = parseVocab(this.deps.vocabContent);
		this.tokenizer = createTokenizer(vocab);

		this.TensorCtor = ort.Tensor;

		// 关键路径:直接传入 wasm 二进制,ORT 不再去 fetch/import 外部 .wasm/.mjs 文件。
		// 关键路径:ORT 的 C++ 层默认会为每个会话打印算子分配统计
		// (`VerifyEachNodeIsAssignedToAnEp`),GPU 版每次侦测+正式装配各建一次会话,
		// 控制台会被这种性能提示刷屏。这里压到 error,只保留真正的错误。
		ort.env.logLevel = 'error';
		ort.env.wasm.wasmBinary = this.deps.wasmBinary;
		ort.env.wasm.numThreads = 1;

		this.session = await this.createSession();
		this.ready = true;
	}

	/**
	 * 优先尝试 WebGPU，不可用时回退 WASM。
	 *
	 * 关键路径(2026-11-07 线上实测 5 秒/块):单线程 WASM 跑 448 token 的 bge-small 约
	 * 3–5 秒，这是算力上限而非缺省配置问题。WebGPU 可用时可降到几十毫秒；
	 * 桌面端未必支持，失败必须无声回退，不能让索引整体不可用。
	 *
	 * @returns 已创建的 ONNX 会话
	 */
	private async createSession(): Promise<ort.InferenceSession> {
		if (this.deps.enableWebgpu !== true) {
			devLogger.info('index', '嵌入后端:WASM(CPU 推理)');
			return ort.InferenceSession.create(this.deps.modelBuffer, {
				executionProviders: ['wasm'],
				logSeverityLevel: 3,
			});
		}

		// 关键路径(S-WEBGPU-EMBEDDING):GPU 版 Worker 专用。
		// 构建期内联的 jsep 胶水还原成 Blob URL 交给 ORT —— webgpu EP 注册依赖它;
		// 缺了它 ORT 会去 fetch 相对路径(Blob Worker 下必然失败)并报 backend not found。
		const glueUrl = this.createGlueUrl();
		if (glueUrl !== undefined) {
			(ort.env.wasm as { wasmPaths?: unknown }).wasmPaths = { mjs: glueUrl };
		}
		// 关键路径:此处**不做 WASM 回退**。同一 ORT 实例里 webgpu 尝试失败会污染
		// initWasm(),导致回退也失败(1.4.0 实测)。失败直接抛,由装配层换一个全新的
		// WASM Worker —— 两个独立实例,零污染。
		const session = await ort.InferenceSession.create(this.deps.modelBuffer, {
			executionProviders: ['webgpu'],
			// 关键路径:ORT 的 C++ 层会为每个会话打印算子分配统计(W 级),
			// GPU 路径每次装载都刷一屏;3 = error,只保留真正的错误。
			logSeverityLevel: 3,
		});
		devLogger.info('index', '嵌入后端:WebGPU(本机 GPU 加速已启用)');
		return session;
	}

	/** 把内联胶水源码还原成 Blob URL;源码缺失或环境不支持时返回 undefined。 */
	private createGlueUrl(): string | undefined {
		const source = this.deps.glueSource;
		if (source === undefined || source.length === 0) return undefined;
		if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return undefined;
		try {
			this.glueUrl ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
			return this.glueUrl;
		} catch {
			return undefined;
		}
	}

	/**
	 * 批量生成文本向量。
	 *
	 * 关键路径(T5):
	 * - 每个**真实完成**的批次结束后回报一次 `onBatchComplete`,序号单调;
	 *   计时器空转与存活心跳不会产生这里的回调。
	 * - 取消在批次边界生效:已中止则按 `AbortError` 结束,不返回半批结果。
	 *
	 * @param texts - 待编码文本数组。
	 * @param options - 可选取消信号与批次活动回调。
	 * @returns 与 texts 等长的向量数组,每个向量长度等于 dimensions。
	 * @throws Error 模型未初始化、ONNX 推理失败或调用已取消。
	 */
	async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
		if (!this.ready || !this.session) {
			throw new Error(tNow('error.embedding.notInit'));
		}
		if (texts.length === 0) {
			return [];
		}

		const total = texts.length;
		const embeddings: number[][] = [];
		// 关键路径:超过 maxBatchSize 时分批推理,避免单次 WASM 调用阻塞主线程过久。
		for (let i = 0; i < total; i += this.maxBatchSize) {
			// 关键路径:批次边界检查取消;批次内部不承诺中断。
			throwIfEmbeddingAborted(options?.signal);
			const batch = texts.slice(i, i + this.maxBatchSize);
			const batchEmbeddings = await this.embedBatch(batch);
			embeddings.push(...batchEmbeddings);
			// 关键路径:只有推理真的返回了向量才算完成一个批次。
			options?.onBatchComplete?.(embeddings.length, total);
		}
		return embeddings;
	}

	/**
	 * 单批次推理,输入 texts 数量不超过 maxBatchSize。
	 *
	 * @param texts - 当前批次文本数组。
	 * @returns 当前批次的向量数组。
	 */
	private async embedBatch(texts: string[]): Promise<number[][]> {
		const maxLength = 512;
		const batchSize = texts.length;
		// 关键路径(S-WEBGPU-EMBEDDING 性能):此前一律按 512 填充,而实际块长度常常只有
		// 几十到一两百 token —— attention 的算力按长度平方增长,固定 512 意味着数倍浪费。
		// 先按真实长度编码,再取批内最大值并向上对齐,把填充压到最小。
		const encodedBatch = texts.map((text) => this.tokenizer.encode(text, maxLength));
		const batchMaxLength = padLengthFor(encodedBatch.map((item) => item.attentionMask.reduce((sum, flag) => sum + flag, 0)));
		const inputIds = new BigInt64Array(batchSize * batchMaxLength);
		const attentionMask = new BigInt64Array(batchSize * batchMaxLength);
		const tokenTypeIds = new BigInt64Array(batchSize * batchMaxLength);
		const padId = 0;

		for (let b = 0; b < batchSize; b++) {
			const encoded = encodedBatch[b];
			if (encoded === undefined) continue;
			for (let i = 0; i < batchMaxLength; i++) {
				const offset = b * batchMaxLength + i;
				const inRange = i < encoded.inputIds.length;
				// 超出批内长度的位置填 pad,attention mask 置 0,不参与池化。
				inputIds[offset] = BigInt(inRange ? (encoded.inputIds[i] ?? padId) : padId);
				attentionMask[offset] = BigInt(inRange ? (encoded.attentionMask[i] ?? 0) : 0);
				tokenTypeIds[offset] = BigInt(inRange ? (encoded.tokenTypeIds[i] ?? 0) : 0);
			}
		}

		const dims = [batchSize, batchMaxLength];
		const feeds = {
			input_ids: new this.TensorCtor('int64', inputIds, dims),
			attention_mask: new this.TensorCtor('int64', attentionMask, dims),
			token_type_ids: new this.TensorCtor('int64', tokenTypeIds, dims),
		};

		const results = await this.session.run(feeds);
		const lastHiddenState = results.last_hidden_state as ort.Tensor;
		const dimsArr = lastHiddenState.dims;
		if (dimsArr.length !== 3) {
			throw new Error(tNow('error.embedding.dimMismatch', { expected: 3, actual: dimsArr.length }));
		}
		const seqLen = dimsArr[1]!;
		const hiddenSize = dimsArr[2]!;
		// 类型:ONNX BERT 输出为 Float32Array,复制到普通 number[] 消除 TS 索引访问推断问题。
		const data = Array.from(lastHiddenState.data as Float32Array);

		// 性能:mean pooling 与 L2 normalize 一次性在 JS 中完成,避免多次遍历。
		const embeddings: number[][] = [];
		for (let b = 0; b < batchSize; b++) {
			// 关键路径:复用本轮已编码结果,别再对同一段文本分词一次 ——
			// 分词是纯 JS,重复做等于把省下的算力又还回去。
			const encoded = encodedBatch[b];
			if (encoded === undefined) continue;
			const sums = new Float64Array(hiddenSize);
			let maskSum = 0;

			for (let i = 0; i < seqLen; i++) {
				const mask = encoded.attentionMask[i];
				if (mask === undefined || mask === 0) continue;
				maskSum += mask;
				const offset = (b * seqLen + i) * hiddenSize;
				for (let h = 0; h < hiddenSize; h++) {
					// 关键路径:TypeScript strict 模式下数组索引返回 number | undefined,
					// 用临时变量展开避免 TS 误判(运行时值一定存在)。
					const current = sums[h] ?? 0;
					const add = data[offset + h] ?? 0;
					sums[h] = current + add;
				}
			}

			const pooled = new Array(hiddenSize);
			for (let h = 0; h < hiddenSize; h++) {
				pooled[h] = maskSum > 0 ? sums[h]! / maskSum : 0;
			}

			// L2 normalize
			let norm = 0;
			for (let h = 0; h < hiddenSize; h++) {
				norm += pooled[h]! * pooled[h]!;
			}
			norm = Math.sqrt(norm);

			// 关键路径:显式标注 number[] 避免 any[] 推断触发 no-unsafe-argument。
			const normalized: number[] = new Array<number>(hiddenSize);
			for (let h = 0; h < hiddenSize; h++) {
				normalized[h] = norm > 0 ? pooled[h]! / norm : 0;
			}

			embeddings.push(normalized);
		}

		return embeddings;
	}
}

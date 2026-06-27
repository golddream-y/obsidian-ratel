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
import type { EmbeddingPort } from '../ports/embedding';
import { createTokenizer, parseVocab, type BertTokenizer } from './bert-tokenizer';

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
		ort.env.wasm.wasmBinary = this.deps.wasmBinary;
		ort.env.wasm.numThreads = 1;

		this.session = await ort.InferenceSession.create(this.deps.modelBuffer, {
			executionProviders: ['wasm'],
		});
		this.ready = true;
	}

	/**
	 * 批量生成文本向量。
	 *
	 * @param texts - 待编码文本数组。
	 * @returns 与 texts 等长的向量数组,每个向量长度等于 dimensions。
	 * @throws Error 模型未初始化或 ONNX 推理失败。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (!this.ready || !this.session) {
			throw new Error('EmbeddingOnnx 未初始化,请先调用 init()');
		}
		if (texts.length === 0) {
			return [];
		}

		const embeddings: number[][] = [];
		// 关键路径:超过 maxBatchSize 时分批推理,避免单次 WASM 调用阻塞主线程过久。
		for (let i = 0; i < texts.length; i += this.maxBatchSize) {
			const batch = texts.slice(i, i + this.maxBatchSize);
			const batchEmbeddings = await this.embedBatch(batch);
			embeddings.push(...batchEmbeddings);
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
		const inputIds = new BigInt64Array(batchSize * maxLength);
		const attentionMask = new BigInt64Array(batchSize * maxLength);
		const tokenTypeIds = new BigInt64Array(batchSize * maxLength);

		for (let b = 0; b < batchSize; b++) {
			const text = texts[b];
			if (text === undefined) continue;
			const encoded = this.tokenizer.encode(text, maxLength);
			for (let i = 0; i < maxLength; i++) {
				const offset = b * maxLength + i;
				inputIds[offset] = BigInt(encoded.inputIds[i] ?? 0);
				attentionMask[offset] = BigInt(encoded.attentionMask[i] ?? 0);
				tokenTypeIds[offset] = BigInt(encoded.tokenTypeIds[i] ?? 0);
			}
		}

		const dims = [batchSize, maxLength];
		const feeds = {
			input_ids: new this.TensorCtor('int64', inputIds, dims),
			attention_mask: new this.TensorCtor('int64', attentionMask, dims),
			token_type_ids: new this.TensorCtor('int64', tokenTypeIds, dims),
		};

		const results = await this.session.run(feeds);
		const lastHiddenState = results.last_hidden_state as ort.Tensor;
		const dimsArr = lastHiddenState.dims;
		if (dimsArr.length !== 3) {
			throw new Error(`ONNX 输出维度异常: 期望 3 维,得到 ${dimsArr.length} 维`);
		}
		const seqLen = dimsArr[1]!;
		const hiddenSize = dimsArr[2]!;
		// 类型:ONNX BERT 输出为 Float32Array,复制到普通 number[] 消除 TS 索引访问推断问题。
		const data = Array.from(lastHiddenState.data as Float32Array);

		// 性能:mean pooling 与 L2 normalize 一次性在 JS 中完成,避免多次遍历。
		const embeddings: number[][] = [];
		for (let b = 0; b < batchSize; b++) {
			const text = texts[b];
			if (text === undefined) continue;
			const encoded = this.tokenizer.encode(text, maxLength);
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

			const normalized = new Array(hiddenSize);
			for (let h = 0; h < hiddenSize; h++) {
				normalized[h] = norm > 0 ? pooled[h]! / norm : 0;
			}

			embeddings.push(normalized);
		}

		return embeddings;
	}
}

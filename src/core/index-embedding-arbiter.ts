/**
 * @file src/core/index-embedding-arbiter.ts
 * @description 共享模型通道的批次仲裁 — 让交互查询插到索引批次之间,而不是排完整批之后
 * @module src/core/index-embedding-arbiter
 *
 * 关键路径:
 * - 模型是共享资源:索引一次要算很多块,查询只算一条。若严格先来先服务,用户检索会排在
 *   整个索引批次后面,表现为「搜索转圈」。
 * - 仲裁只在**批次边界**切换:已发出的一批必须跑完(取消语义由嵌入端口自己负责),
 *   不会把一次推理拆成两半。
 * - 高优先级不是无限插队:同一优先级的请求保持先进先出,避免查询风暴饿死索引。
 * - 队列长度有上界;超出即明确拒绝,不默默堆积内存。
 */

import { devLogger } from '../logging/dev-logger';

/** 工作类型;`query` 高于 `index`。 */
export type EmbedWorkload = 'query' | 'index';

/** 单批文本上限。 */
export interface EmbeddingArbiterOptions {
	/** 每批最多文本条数;缺省 8。 */
	maxBatchSize?: number;
	/** 队列上限(按请求计);缺省 256。 */
	maxQueued?: number;
}

/** 一个待处理的批次。 */
interface QueuedBatch {
	texts: string[];
	workload: EmbedWorkload;
	resolve: (vectors: number[][]) => void;
	reject: (error: Error) => void;
	/** 同批内部的顺序,用于同优先级先进先出。 */
	sequence: number;
}

/** 嵌入批次仲裁器。 */
export class EmbeddingArbiter {
	private readonly queue: QueuedBatch[] = [];
	private readonly maxBatchSize: number;
	private readonly maxQueued: number;
	private sequence = 0;
	private pumping = false;

	constructor(
		private readonly embed: (texts: string[], workload: EmbedWorkload) => Promise<number[][]>,
		options: EmbeddingArbiterOptions = {},
	) {
		this.maxBatchSize = options.maxBatchSize ?? 8;
		this.maxQueued = options.maxQueued ?? 256;
	}

	/** 当前排队请求数(含正在执行的一批)。 */
	get queued(): number {
		return this.queue.length;
	}

	/**
	 * 请求一批向量。
	 * @param texts 待嵌入文本
	 * @param workload 工作类型;查询优先于索引
	 */
	async request(texts: readonly string[], workload: EmbedWorkload = 'index'): Promise<number[][]> {
		if (texts.length === 0) return [];
		const slices: string[][] = [];
		for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
			slices.push([...texts.slice(offset, offset + this.maxBatchSize)]);
		}
		if (this.queue.length + slices.length > this.maxQueued) throw new Error('嵌入队列已满');
		const parts = slices.map((slice) => new Promise<number[][]>((resolve, reject) => {
			this.queue.push({ texts: slice, workload, resolve: (vectors) => resolve(vectors), reject, sequence: ++this.sequence });
		}));
		void this.pump();
		const results = await Promise.all(parts);
		return results.flat();
	}

	/** 取下一个批次:查询优先,同级先进先出。 */
	private takeNext(): QueuedBatch | undefined {
		let index = -1;
		for (let i = 0; i < this.queue.length; i += 1) {
			const candidate = this.queue[i]!;
			if (index === -1) {
				index = i;
				continue;
			}
			const best = this.queue[index]!;
			if (candidate.workload === 'query' && best.workload !== 'query') index = i;
		}
		if (index === -1) return undefined;
		return this.queue.splice(index, 1)[0];
	}

	/** 吞吐统计用的累计量与下次打点阈值。 */
	private throughputBlocks = 0;
	private throughputMs = 0;
	private nextThroughputLogAt = 50;

	/**
	 * 记录一批索引嵌入的耗时，累计到 50 块时输出一条实际速度。
	 *
	 * @param elapsedMs - 这批推理耗时
	 * @param blocks - 这批的文本块数
	 */
	private recordThroughput(elapsedMs: number, blocks: number): void {
		this.throughputBlocks += blocks;
		this.throughputMs += elapsedMs;
		if (this.throughputBlocks < this.nextThroughputLogAt) return;
		const secondsPerBlock = this.throughputMs / 1000 / this.throughputBlocks;
		devLogger.info(
			'index',
			`嵌入速度 ${secondsPerBlock.toFixed(2)} 秒/块(累计 ${this.throughputBlocks} 块 / ${Math.round(this.throughputMs / 1000)} 秒)`,
		);
		this.nextThroughputLogAt = this.throughputBlocks * 2;
	}

	/** 逐批执行,直到队列空。 */
	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (;;) {
				const batch = this.takeNext();
				if (batch === undefined) return;
				try {
					const startedAt = performance.now();
					const vectors = await this.embed(batch.texts, batch.workload);
					// 关键路径:给出「每块实际推理耗时」——按篇看会被文件大小淹没,
					// 只有按块才能判断是模型慢还是文档太大(生产库平均 14 块,最大 215 块)。
					if (batch.workload === 'index') this.recordThroughput(performance.now() - startedAt, batch.texts.length);
					batch.resolve(vectors);
				} catch (error) {
					batch.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		} finally {
			this.pumping = false;
		}
	}
}

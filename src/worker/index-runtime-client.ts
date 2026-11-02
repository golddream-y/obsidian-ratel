/**
 * @file src/worker/index-runtime-client.ts
 * @description 宿主侧索引用例 — 启动常驻索引线程、转发嵌入请求并封装会话调用
 * @module src/worker/index-runtime-client
 *
 * 关键路径:
 * - 宿主只做三件事:拉起线程、把嵌入请求转给模型通道、把调用转发成协议请求。
 * - 嵌入请求按工作类型进仲裁器:查询插到索引批次之间,不被整批索引堵住。
 * - 线程未启动时调用直接失败,不隐式重启 —— 重启意味着新 epoch,必须由上层显式决定。
 * - 关闭先撤销再终止,并等待 drained 语义之外的本地收敛(请求全部结算)。
 */

import { EmbeddingArbiter, type EmbedWorkload } from '../core/index-embedding-arbiter';
import { IndexRuntimeHost, type RuntimeWorkerFactory } from './index-runtime-host';
import { createInlineRuntimeWorker } from './index-runtime-browser';

/** 启动参数。 */
export interface IndexRuntimeStartOptions {
	/** 索引根(代际目录)。 */
	root: string;
	/** 代际 ID。 */
	generationId: string;
	/** 配置指纹。 */
	configFingerprint: string;
	/** 期望向量维度。 */
	expectedDimension?: number;
	/** 工作模式;只读时不装配索引入口。 */
	access?: 'read-only' | 'read-write';
	/** 分块预算。 */
	chunkOptions?: { maxTokens?: number; overlapTokens?: number };
}

/** 客户端依赖。 */
export interface IndexRuntimeClientOptions {
	/** 自定义线程工厂;缺省用内联 Blob Worker。 */
	createWorker?: RuntimeWorkerFactory;
	/** 嵌入通道:由宿主接上真实模型。 */
	embed: (texts: readonly string[], workload: EmbedWorkload) => Promise<number[][]>;
	/** 单次请求超时。 */
	requestTimeoutMs?: number;
	/** 每批最多文本条数(仲裁用)。 */
	maxBatchSize?: number;
}

/** 查询命中。 */
export interface IndexRuntimeHit {
	/** 文档标识;线程侧用路径作为文档级标识。 */
	docId?: string;
	path: string;
	score: number;
	chunkIndex: number | null;
}

/** 宿主侧索引客户端。 */
export class IndexRuntimeClient {
	private readonly host: IndexRuntimeHost;
	private readonly arbiter: EmbeddingArbiter;
	private opened = false;

	constructor(options: IndexRuntimeClientOptions) {
		this.arbiter = new EmbeddingArbiter(
			(texts, workload) => options.embed(texts, workload),
			{ maxBatchSize: options.maxBatchSize ?? 8 },
		);
		this.host = new IndexRuntimeHost({
			createWorker: options.createWorker ?? defaultWorkerFactory(),
			requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
			// 关键路径:Worker 反向请求的嵌入统一走仲裁器,查询优先。
			onCall: async (method, payload) => {
				if (method !== 'embed') throw new Error(`未知宿主方法: ${method}`);
				const record = payload as { texts?: unknown; workload?: unknown } | null;
				const texts = Array.isArray(record?.texts) ? record.texts.filter((text): text is string => typeof text === 'string') : null;
				if (texts === null || texts.length === 0) throw new Error('嵌入请求缺少文本');
				const workload: EmbedWorkload = record?.workload === 'query' ? 'query' : 'index';
				return this.arbiter.request(texts, workload);
			},
		});
	}

	/** 运行时标识;测试与诊断用,协议帧必须与线程端一致。 */
	get runtimeId(): string {
		return this.host.runtimeIdValue;
	}

	/** 运行时是否已启动。 */
	get running(): boolean {
		return this.host.running;
	}

	/**
	 * 启动线程并完成 init 授权。
	 * @param options 代际与访问模式
	 */
	async start(options: IndexRuntimeStartOptions): Promise<void> {
		this.host.start();
		this.host.send({
			kind: 'init',
			runtimeId: this.host.runtimeIdValue,
			epoch: this.host.epoch,
			root: options.root,
			access: options.access ?? 'read-write',
			chunkOptions: options.chunkOptions,
		});
		await this.host.request('ping');
		await this.host.request('session.open', {
			generationId: options.generationId,
			configFingerprint: options.configFingerprint,
			expectedDimension: options.expectedDimension,
		});
		this.opened = true;
	}

	/** 写入单个文件(切块 + 提交都在线程内)。 */
	async indexFile(filePath: string, content: string): Promise<{ chunkCount: number }> {
		this.assertOpen();
		return this.host.request<{ chunkCount: number }>('session.upsertFile', { path: filePath, content });
	}

	/** 删除单个文件。 */
	async deleteFile(filePath: string): Promise<{ removed: number }> {
		this.assertOpen();
		return this.host.request<{ removed: number }>('session.deleteFile', { path: filePath });
	}

	/** 查询。 */
	async search(query: string, topK = 10): Promise<IndexRuntimeHit[]> {
		this.assertOpen();
		const result = await this.host.request<{ hits: IndexRuntimeHit[] }>('session.search', { query, topK });
		return result.hits;
	}

	/**
	 * 按向量查询 — 供检索编排层使用,避免宿主再算一次向量。
	 * @param vector 查询向量
	 * @param topK 返回条数
	 */
	async searchByVector(vector: readonly number[], topK = 10): Promise<IndexRuntimeHit[]> {
		this.assertOpen();
		const result = await this.host.request<{ hits: IndexRuntimeHit[] }>('session.searchVector', {
			vector: [...vector],
			topK,
		});
		return result.hits;
	}

	/** 恢复遗留未决事务。 */
	async recover(inputs: ReadonlyArray<{ path: string; hash: string | null }>): Promise<{ pending: number; decisions: number; failures: number }> {
		this.assertOpen();
		return this.host.request('session.recover', { inputs });
	}

	/**
	 * 读取可信完成记录 — 供宿主侧可见性门判定候选是否可检索。
	 * @returns 完成记录列表
	 */
	async listCommitted(): Promise<Array<{ path: string; state: 'present' | 'deleted'; revision: number; inputHash: string | null; chunkCount: number }>> {
		this.assertOpen();
		const result = await this.host.request<{ records: Array<{ path: string; state: 'present' | 'deleted'; revision: number; inputHash: string | null; chunkCount: number }> }>('session.listCommitted');
		return result.records;
	}

	/** 读会话状态。 */
	async status(): Promise<{ totalDocs: number; written: number }> {
		this.assertOpen();
		return this.host.request('session.status', {});
	}

	/** 关闭:先撤销再终止。 */
	async close(reason = 'client close'): Promise<void> {
		this.opened = false;
		await this.host.stop(reason);
	}

	/** 断言已打开。 */
	private assertOpen(): void {
		if (!this.opened) throw new Error('索引线程尚未打开');
	}
}

/** 默认线程工厂:内联 Worker 代码。 */
function defaultWorkerFactory(): RuntimeWorkerFactory {
	return () => createInlineRuntimeWorker();
}

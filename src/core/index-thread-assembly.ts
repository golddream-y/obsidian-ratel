/**
 * @file src/core/index-thread-assembly.ts
 * @description 线程版索引装配 — 把索引运行时、嵌入通道与协调器接成一组
 * @module src/core/index-thread-assembly
 *
 * 关键路径:
 * - 装配只负责接线,**不**在主线程构造存储/日志:那些都在索引线程内完成。
 * - 嵌入通道复用既有 `EmbeddingPort`,经桥接与仲裁进入线程,查询优先。
 * - 未传入自定义线程工厂时用内联 Blob Worker;测试可注入替身,不需要真实宿主。
 * - 与主线程装配共用同一 `IndexTaskCoordinatorPort`,上层无须分支。
 */

import type { EmbeddingPort } from '../ports/embedding';
import { createEmbeddingBridge } from '../worker/index-runtime-embedding-bridge';
import { IndexRuntimeClient } from '../worker/index-runtime-client';
import type { RuntimeWorkerFactory } from '../worker/index-runtime-host';
import { type IndexVectorStore, createShardedStore } from '../adapters/vector-vectra-sharded';
import { ensureShardLayout, migrateSingleFileIndex, readShardLayout } from './index-shard-migration';
import { shardCountForBlocks } from './index-shard-routing';
import { IndexThreadCoordinator, type ThreadIndexClient } from './index-thread-coordinator';
import { resolveIndexGeneration, type ResolvedIndexGeneration } from './index-processor-port';
import type { IndexGenerations } from './index-generations';
import type { IndexConfigDescriptor } from './index-persistence-types';
import type { JournalWriteOwner } from './index-file-journal';

/** 装配依赖。 */
export interface AssembleIndexThreadDeps {
	/** 索引根(代际目录)。 */
	indexRoot: string;
	/** 代际 ID。 */
	generationId: string;
	/** 配置指纹。 */
	configFingerprint: string;
	/** 期望向量维度。 */
	expectedDimension?: number;
	/** 嵌入端口。 */
	embedding: EmbeddingPort;
	/** Vault 端口 — 只用于枚举与读正文。 */
	vault: {
		listMarkdownFiles(): string[];
		readFile(filePath: string): Promise<string>;
	};
	/** 分块预算。 */
	chunkOptions?: { maxTokens?: number; overlapTokens?: number };
	/** 自定义线程工厂(测试注入)。 */
	createWorker?: RuntimeWorkerFactory;
	/** 自定义客户端(测试注入)。 */
	createClient?: (client: IndexRuntimeClient) => ThreadIndexClient;
	/** 已装配好的分片存储(由 `assembleIndexThreadRuntime` 注入;直接调用管线时为 undefined)。 */
	store?: IndexVectorStore;
}

/** 装配结果。 */
export interface AssembledIndexThreadPipeline {
	/** 与主线程协调器同端口的协调器。 */
	coordinator: IndexThreadCoordinator;
	/** 底层客户端 — 关闭/诊断用。 */
	client: IndexRuntimeClient;
	/**
	 * 本代际的分片存储句柄 — 与主线程装配同一组方法语义。
	 *
	 * 关键路径:线程模式下**写入真相**在索引线程的会话内,这里只是装配层持有的
	 * 同布局句柄(不 init、不参与提交),供状态读取与诊断按布局访问;不能拿它写盘,
	 * 否则主线程与线程会各持一套存储视图。直接调用本函数(未解析代际)时为 undefined。
	 */
	store?: IndexVectorStore;
}

/**
 * 装配线程版索引管线。
 * @param deps 索引根、配置与端口
 */
export function assembleIndexThreadPipeline(deps: AssembleIndexThreadDeps): AssembledIndexThreadPipeline {
	const client = new IndexRuntimeClient({
		embed: createEmbeddingBridge(deps.embedding),
		createWorker: deps.createWorker,
	});
	const threadClient: ThreadIndexClient = deps.createClient
		? deps.createClient(client)
		: {
			start: (options) => client.start(options),
			indexFile: (filePath, content) => client.indexFile(filePath, content),
			indexFiles: (files) => client.indexFiles(files),
			deleteFile: (filePath) => client.deleteFile(filePath),
			recover: (inputs) => client.recover(inputs),
			close: (reason) => client.close(reason),
		};
	const coordinator = new IndexThreadCoordinator({
		client: threadClient,
		vault: deps.vault,
		start: {
			root: deps.indexRoot,
			generationId: deps.generationId,
			configFingerprint: deps.configFingerprint,
			expectedDimension: deps.expectedDimension,
			chunkOptions: deps.chunkOptions,
		},
	});
	return { coordinator, client, ...(deps.store === undefined ? {} : { store: deps.store }) };
}

/** 需要先解析代际的装配依赖。 */
export interface AssembleIndexThreadRuntimeDeps extends Omit<AssembleIndexThreadDeps, 'indexRoot' | 'generationId' | 'configFingerprint' | 'expectedDimension'> {
	/** `.index/` 根绝对路径。 */
	indexRoot: string;
	/** 代际管理实例(已绑定 owner)。 */
	generations: IndexGenerations;
	/** 当前配置。 */
	config: IndexConfigDescriptor;
	/** 写所有权 — 迁移与新建都在锁内。 */
	owner: JournalWriteOwner;
	/** 期望向量维度。 */
	expectedDimension?: number;
	/** legacy 只读来源;无旧索引传 null。 */
	legacy?: Parameters<typeof resolveIndexGeneration>[0]['legacy'];
	/** 分块边界(与旧清单交叉核对)。 */
	chunkLimits?: { chunkSize: number; chunkOverlap: number };
}

/**
 * 先解析代际,再装配线程版管线。
 *
 * 关键路径:代际解析不放进线程 —— 它要读写控制指针、跑迁移与回收,属于装配决策;
 * 线程只拿「已经解析好的代际目录与指纹」。
 *
 * @param deps 代际、配置与端口
 * @returns 解析结论与管线;无可用代际时 `resolved` 为 null,调用方走只读或降级
 */
export async function assembleIndexThreadRuntime(deps: AssembleIndexThreadRuntimeDeps): Promise<{
	resolved: ResolvedIndexGeneration | null;
	pipeline: AssembledIndexThreadPipeline | null;
}> {
	const resolution = await resolveIndexGeneration({
		generations: deps.generations,
		indexRoot: deps.indexRoot,
		config: deps.config,
		owner: deps.owner,
		allowCreate: true,
		legacy: deps.legacy ?? null,
		chunkLimits: deps.chunkLimits,
		expectedDimension: deps.expectedDimension,
	});
	const resolved = resolution.resolved;
	if (resolved === null) return { resolved: null, pipeline: null };
	// 关键路径:线程装配在起动线程之前就把布局定下来 —— 先迁移旧单份索引,再读 layout
	// 决定片数,全新库取下限 8。这样线程会话(以及任何重启)打开时读到的都是分片布局,
	// 不会出现「本次单份、下次分片」的撕裂。
	// 迁移失败 fail-closed:不吞错,由调用方整体回落到主线程路径。
	await migrateSingleFileIndex({ generationRoot: resolved.generationRoot });
	const layout = await readShardLayout(resolved.generationRoot);
	const store = createShardedStore({
		root: resolved.generationRoot,
		shardCount: layout?.shardCount ?? shardCountForBlocks(0),
	});
	const pipeline = assembleIndexThreadPipeline({
		...deps,
		indexRoot: resolved.generationRoot,
		generationId: resolved.generationId,
		configFingerprint: resolved.configFingerprint,
		expectedDimension: deps.expectedDimension,
		store,
	});
	// 关键路径:layout 在管线装配成功之后才落盘且幂等;装配失败不留假迁移标记。
	if (layout === null) await ensureShardLayout(resolved.generationRoot, store.shardCount);
	return { resolved, pipeline };
}

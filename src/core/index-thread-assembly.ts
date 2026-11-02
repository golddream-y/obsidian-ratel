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
}

/** 装配结果。 */
export interface AssembledIndexThreadPipeline {
	/** 与主线程协调器同端口的协调器。 */
	coordinator: IndexThreadCoordinator;
	/** 底层客户端 — 关闭/诊断用。 */
	client: IndexRuntimeClient;
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
	return { coordinator, client };
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
	const pipeline = assembleIndexThreadPipeline({
		...deps,
		indexRoot: resolved.generationRoot,
		generationId: resolved.generationId,
		configFingerprint: resolved.configFingerprint,
		expectedDimension: deps.expectedDimension,
	});
	return { resolved, pipeline };
}

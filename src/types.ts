/**
 * @file src/types.ts
 * @description Ratel 跨切面类型定义 — Agent 事件、Worker 协议、用户请求
 * @module types
 * @depends ports/llm, ports/vector, ports/persistence
 *
 * 端口专属类型在各自的 port 文件中维护(本文件仅做 re-export 与跨模块聚合):
 *   - ports/persistence.ts  → Session, ChatMessage, NoteMeta, HookLogEntry
 *   - ports/vector.ts       → VectorSearchResult, SearchFilter, IndexStatus
 *   - ports/llm.ts          → ChatRequest, ChatDelta, ToolCall, ToolDefinition, ChatMessage
 */

// ==================== 端口类型 re-export ====================
import type { AttachmentRef, LlmRetryWait, ToolArgsIssue } from './ports/llm';
import type { BreadcrumbPhase } from './logging/breadcrumbs';
// 关键路径:活动包的唯一类型声明在 core/index-persistence-types(T1 建立的集中类型文件),
// 本文件只做协议侧引用,不另建一份活动类型。
import type { IndexActivity } from './core/index-persistence-types';
export type { ChatMessage, ChatDelta, ToolCall, ToolDefinition } from './ports/llm';
export type { VectorSearchResult, SearchFilter } from './ports/vector';
export type { Session, NoteMeta, HookLogEntry } from './ports/persistence';
export type { IndexActivity } from './core/index-persistence-types';

// ==================== Agent 事件(主线程 → UI) ====================

/**
 * Agent 实时事件流 — 喂给 Svelte 聊天面板,驱动流式渲染、工具调用展示、错误提示。
 *
 * 关键路径:
 * - `message.start` / `message.delta` / `message.end` 三件套标记一次助手消息生命周期。
 * - `tool.call` / `tool.result` 让 UI 能展示"正在调用 read_note"等中间状态。
 * - `error` 是结构化错误(带 code),UI 决定是否可恢复。
 */
export type AgentEvent =
	| { type: 'message.start'; payload: { role: 'user' | 'assistant' } }
	// 关键路径(S-RUN-STATUS-PHASES):主 LLM 请求出站标记 — UI 据此把「在途等待」与「本地准备」分成两段
	| { type: 'message.request'; payload: { step: number } }
	| { type: 'message.delta'; payload: { text: string; reasoning?: string } }
	| {
			type: 'message.end';
			payload: {
				tokens: number;
				promptTokens?: number;
				completionTokens?: number;
				/** F1:跨步累计 prompt tokens(向后兼容,优先于 promptTokens) */
				stepPromptTokens?: number;
				/** F1:跨步累计 completion tokens(向后兼容,优先于 completionTokens) */
				stepCompletionTokens?: number;
			};
	  }
	| { type: 'tool.call'; payload: { name: string; args: unknown; argsIssue?: ToolArgsIssue | null } }
	| { type: 'tool.result'; payload: { name: string; result: unknown; argsIssue?: ToolArgsIssue | null } }
	| {
			type: 'search.result';
			payload: {
				results: Array<{
					docId: string;
					score: number;
					path: string;
					index: number;
				}>;
				// 关键路径:W4 新增 — 标识是否经过 Rerank 精排,供 ChatView 显示标记。
				reranked: boolean;
			};
		}
	| { type: 'subagent.spawn'; payload: { role: string; task: string } }
	| { type: 'subagent.done'; payload: { role: string; result: unknown } }
	| { type: 'hook.fired'; payload: { phase: string; tool: string } }
	| { type: 'compact.applied'; payload: { sessionId: string } }
	| { type: 'error'; payload: { code: string; message: string } };

// ==================== Worker 请求(主线程 → Worker) ====================

/**
 * 分块参数(主线程 → Worker)— 单位是 token。
 *
 * 关键路径:只传数值,`count` 计数函数不能过 postMessage ——
 * Worker 内部用词表自行构造计数器(见 worker/handler.ts)。
 */
export interface ChunkOptionsPayload {
	/** 单块 token 预算(含结构前缀) */
	maxTokens: number;
	/** 块间重叠 token 数 */
	overlapTokens: number;
}

/**
 * 索引请求的任务身份 — 主线程把任务标识与写所有权 epoch 随索引请求下发。
 *
 * 关键路径:Worker 侧用它们给活动包盖章,主线程据此把活动归属到正确的任务与 epoch;
 * 跨 Worker 不传函数或 `AbortSignal`,取消经 `index.cancel` 消息表达。
 */
export interface IndexRequestIdentityPayload {
	/** 任务标识;省略时由发送端生成。 */
	taskId?: string;
	/** 写所有权 epoch;省略时按 0 处理。 */
	epoch?: number;
}

/**
 * 主线程发给 Worker 的请求集合 — 含索引 / 向量 CRUD / 状态查询。
 *
 * 关键路径:类型用判别联合,Worker 端 switch 时 TypeScript 能自动收窄。
 *
 * 改造点(M-1):
 * - `index.full` 协议改为传 `{ files: Array<{ path, content }> }`,主线程已读取 + 分块,Worker 只做 IO
 * - `index.incremental` payload 嵌套成 `{ file: { path, content } }`,对齐 index.full
 * - 保留 `vector.search` 的 `filter` 可选项(用于按 metadata 过滤)
 *
 * 改造点(S-RETRIEVAL-QUALITY §4.2):
 * - `index.full / index.incremental / index.batch` 载荷新增 `chunkOptions`,
 *   让设置项里的分块大小与重叠真正传到 Worker(此前 Worker 硬编码 500/100)。
 *
 * 改造点(T5 §4):
 * - 三个索引入口新增 `taskId` / `epoch`,Worker 侧用 `index.activity` 回报真实完成步骤;
 * - 新增 `index.cancel`:取消单项任务,不得终止共享 Worker 的其他使用者。
 */
export type WorkerRequest =
	| { type: 'index.full'; payload: { files: Array<{ path: string; content: string }>; chunkOptions?: ChunkOptionsPayload } & IndexRequestIdentityPayload }
	| { type: 'index.incremental'; payload: { file: { path: string; content: string }; chunkOptions?: ChunkOptionsPayload } & IndexRequestIdentityPayload }
	| { type: 'index.batch'; payload: { files: Array<{ path: string; content: string }>; chunkOptions?: ChunkOptionsPayload } & IndexRequestIdentityPayload }
	| { type: 'index.cancel'; payload: { requestId?: string; taskId?: string; epoch?: number } }
	| { type: 'index.delete'; payload: { filePath: string } }
	| { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: import('./ports/vector').SearchFilter } }
	| { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
	| { type: 'vector.delete'; payload: { docIds: string[] } }
	| { type: 'index.status'; payload: Record<string, never> };

/**
 * 索引请求清单 — 这些请求携带任务身份,并按活动续期。
 *
 * 关键路径:集中声明,主线程管理器与 Worker 侧运行登记共用同一份清单。
 */
export const WORKER_INDEX_REQUEST_TYPES = ['index.full', 'index.batch', 'index.incremental'] as const;

/** 索引请求类型。 */
export type WorkerIndexRequestType = (typeof WORKER_INDEX_REQUEST_TYPES)[number];

/**
 * 判断是否为索引请求。
 *
 * @param type - 请求类型。
 * @returns 是否为索引请求。
 */
export function isWorkerIndexRequest(type: WorkerRequest['type']): type is WorkerIndexRequestType {
	return (WORKER_INDEX_REQUEST_TYPES as readonly string[]).includes(type);
}

/**
 * 只读请求清单 — 这些请求与索引写通道**分离**:不排在长推理后面,但不得穿过提交窗口。
 *
 * 关键路径:集中声明,主线程车道分流与 Worker 侧消息分道共用同一份清单。
 */
export const WORKER_READ_REQUEST_TYPES = ['vector.search', 'index.status'] as const;

/** 只读请求类型。 */
export type WorkerReadRequestType = (typeof WORKER_READ_REQUEST_TYPES)[number];

/**
 * 判断是否为只读请求 — 只读请求可在长推理期间派发,写请求必须串行。
 *
 * @param type - 请求类型。
 * @returns 是否为只读请求。
 */
export function isWorkerReadRequest(type: WorkerRequest['type']): type is WorkerReadRequestType {
	return (WORKER_READ_REQUEST_TYPES as readonly string[]).includes(type);
}

/**
 * 直接存储写事务请求清单 — 这些请求的**整个生命周期**就是一次真实存储事务
 * (`deleteByPath` / `upsert` / `delete`),没有与查询并行的长推理阶段。
 *
 * 关键路径(T5 §4 / B1):它们不经过 `index.*` 的 `persist` 活动通道,因此提交窗口
 * 必须由请求本身开启与关闭,否则只读车道会穿过这些写事务。
 */
export const WORKER_STORE_WRITE_REQUEST_TYPES = ['index.delete', 'vector.upsert', 'vector.delete'] as const;

/** 直接存储写事务请求类型。 */
export type WorkerStoreWriteRequestType = (typeof WORKER_STORE_WRITE_REQUEST_TYPES)[number];

/**
 * 判断请求是否为「整个请求即一次存储事务」的写请求。
 *
 * @param type - 请求类型。
 * @returns 是否为直接存储写请求。
 */
export function isWorkerStoreWriteRequest(type: WorkerRequest['type']): type is WorkerStoreWriteRequestType {
	return (WORKER_STORE_WRITE_REQUEST_TYPES as readonly string[]).includes(type);
}

/**
 * Worker 回给主线程的响应集合 — 索引进度、查询结果、错误。
 *
 * 关键路径:`error` 是通用兜底,各业务响应类型在协议层独立,方便扩展。
 *
 * T5 扩展:
 * - `index.activity`:真实完成步骤触发的活动包(自带 taskId/requestId,不叠加信封 `_requestId`);
 * - `index.cancel.done`:取消消息的回执(发送端不等待它,仅作诊断)。
 */
export type WorkerResponse =
	| { type: 'index.progress'; payload: { done: number; total: number } }
	| { type: 'index.activity'; payload: IndexActivity }
	| { type: 'index.done'; payload: { indexed: number; errors: number; chunkCount?: number } }
	| { type: 'index.batch.done'; payload: { indexed: number; errors: number; chunkCounts: Record<string, number> } }
	| { type: 'index.cancel.done'; payload: { cancelled: boolean } }
	| { type: 'vector.search.result'; payload: Array<import('./ports/vector').VectorSearchResult> }
	| { type: 'vector.upsert.done'; payload: { docId: string } }
	| { type: 'vector.delete.done'; payload: { count: number } }
	| { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
	| { type: 'error'; payload: { code: string; message: string } };

// ==================== 用户聊天请求(侧栏 → 主循环) ====================

/**
 * 一次用户请求 — ChatView 调 `plugin.ask(req)` 时传入。
 *
 * 关键路径:`sessionId` 关联到 Persistence 存储,主循环据此加载历史消息。
 */
export interface UserChatRequest {
	sessionId: string;
	/** 写入 transcript / UI 的用户原文 */
	message: string;
	/**
	 * 仅本轮出站给模型的替换正文(斜杠 `/goal` 的确认引导)。
	 * 不入库;缺省时模型看到的就是 `message`。
	 */
	modelMessage?: string;
	/** 图片附件(S-VISION)— ChatView 从 pendingAttachments$ 取,随消息进 agent-loop */
	attachments?: AttachmentRef[];
	/**
	 * 崩溃面包屑打点（S-RENDER-STABILITY A）。agent-loop 不 import fs。
	 */
	onBreadcrumb?: (phase: BreadcrumbPhase, n?: string | number) => void;
	/** 网络重试等待态 — 仅 ChatView 主 ask 路径传入,透传到 llm.chat */
	onRetryWait?: (state: LlmRetryWait | null) => void;
}

// ==================== 用户记忆系统(Phase 1)====================

/**
 * 主题索引条目 — index.md 中每行 `[[topics/X]] — Y` 的解析结果。
 */
export interface TopicIndexEntry {
	/** 主题名(不含 .md 后缀),如 "GraphQL" */
	name: string;
	/** 主题摘要,如 "性能优化、DataLoader、Schema 设计" */
	summary: string;
}

/**
 * 记忆 frontmatter 元数据 — global.md / topics/*.md 的 YAML 头。
 */
export interface MemoryFrontmatter {
	/** 记忆类型:global / index / topic */
	memory_type: 'global' | 'index' | 'topic';
	/** 主题名(仅 topic 类型) */
	topic?: string;
	/** 最后更新时间(ISO 8601) */
	updated: string;
}

/**
 * 记忆条目 — 单条记忆(如"代码风格: TypeScript strict mode")。
 */
export interface MemoryEntry {
	/** 条目文本(一行) */
	text: string;
	/** 来源:user(用户要求记录)或 model(模型推断) */
	source: 'user' | 'model';
}

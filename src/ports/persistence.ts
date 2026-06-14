/**
 * @file src/ports/persistence.ts
 * @description 持久化端口 — Session / NoteMeta / HookLog 三个 Repository 的零实现接口契约。
 * @module ports/persistence
 * @depends ./llm
 */

import type { ChatMessage } from './llm';

/**
 * 持久化总接口,聚合三个 Repository。
 */
export interface Persistence {
	sessions: SessionRepository;
	notes: NoteMetaRepository;
	hooks: HookLogRepository;
}

/**
 * 会话仓库:Session 的 CRUD。
 */
export interface SessionRepository {
	/**
	 * 按 id 取 Session,不存在返回 null。
	 */
	get(id: string): Promise<Session | null>;
	/**
	 * 写入或更新 Session(upsert 语义)。
	 */
	upsert(session: Session): Promise<void>;
	/**
	 * 列出最近会话,按 updatedAt 倒序。
	 * @param limit - 限制返回数量(可选)。
	 */
	list(limit?: number): Promise<Session[]>;
	/**
	 * 按 id 删除。
	 */
	delete(id: string): Promise<void>;
}

/**
 * 笔记元数据仓库:用于索引管理与增量更新。
 */
export interface NoteMetaRepository {
	/** 按路径取单条元数据。 */
	get(path: string): Promise<NoteMeta | null>;
	/** 写入或更新。 */
	upsert(meta: NoteMeta): Promise<void>;
	/** 列出某路径前缀下的所有笔记(用于批量更新)。 */
	listByPath(prefix: string): Promise<NoteMeta[]>;
	/** 按路径删除。 */
	delete(path: string): Promise<void>;
}

/**
 * 钩子日志仓库:append-only,记录每次 hook 触发结果,用于审计与回放。
 */
export interface HookLogRepository {
	/** 追加一条日志。 */
	append(log: HookLogEntry): Promise<void>;
	/** 读取最近 N 条日志(按时间倒序)。 */
	list(limit?: number): Promise<HookLogEntry[]>;
}

/**
 * Session 实体:UI 侧主键 id,消息历史 messages,以及创建/更新时间戳。
 */
export interface Session {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

/**
 * 笔记元数据:用于索引同步、去重、增量判断。
 * - `hash` 用来判断文件内容是否变更(增量索引)。
 * - `tags` / `links` / `backlinks` / `frontmatter` 全部可选,由扫描器在 parse 阶段填入。
 */
export interface NoteMeta {
	path: string;
	hash: string;
	mtime: number;
	tags?: string[];
	links?: string[];
	backlinks?: string[];
	frontmatter?: Record<string, unknown>;
}

/**
 * 钩子日志单条记录。
 * `result` 三态:pass(通过)、fail(失败阻断)、skip(钩子自身选择跳过)。
 */
export interface HookLogEntry {
	phase: string;
	tool: string;
	timestamp: number;
	result: 'pass' | 'fail' | 'skip';
	message?: string;
}

// ChatMessage 真正定义在 ports/llm.ts,这里是便利 re-export,避免上层多 import。
export type { ChatMessage } from './llm';

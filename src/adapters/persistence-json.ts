/**
 * @file src/adapters/persistence-json.ts
 * @description JSON 持久化适配器 — 把 Session / NoteMeta / HookLog 存到 Obsidian loadData/saveData 之后端
 * @module adapters/persistence-json
 * @depends ports/persistence
 */

import type { Persistence, SessionRepository, NoteMetaRepository, HookLogRepository, Session, NoteMeta, HookLogEntry } from '../ports/persistence';

/**
 * 整体落盘结构 — 三个仓库共存于同一个 JSON 文件,符合 Obsidian 插件一个 `data.json` 的现实约束。
 */
interface DataStore {
	sessions: Record<string, Session>;
	notes: Record<string, NoteMeta>;
	hookLog: HookLogEntry[];
}

/**
 * 基于 Obsidian `loadData` / `saveData` 的 JSON 持久化实现。
 *
 * 设计要点:
 * - 三个仓库对象在构造期一次性创建,内部共享 `ensureLoaded` / `persist`。
 * - 加载使用共享 Promise(`loadingPromise`)合并并发请求,避免冷启动 race。
 * - 写入用 `persistPromise.then` 链串行化,保证并发写不互相覆盖。
 * - 损坏数据采用"丢弃+日志"策略,不让一个错误 JSON 把整个插件状态锁死。
 *
 * @example
 *   const persistence = new PersistenceJson(plugin.loadData, plugin.saveData);
 *   await persistence.sessions.upsert({ id, updatedAt: Date.now(), ... });
 */
export class PersistenceJson implements Persistence {
	public readonly sessions: SessionRepository;
	public readonly notes: NoteMetaRepository;
	public readonly hooks: HookLogRepository;

	private data: DataStore = { sessions: {}, notes: {}, hookLog: [] };

	constructor(
		private loadData: () => Promise<unknown>,
		private saveData: (data: unknown) => Promise<void>,
	) {
		this.sessions = {
			get: async (id: string) => {
				await this.ensureLoaded();
				const session = this.data.sessions[id] ?? null;
				return session ? { ...session } : null;
			},
			upsert: async (session: Session) => {
				await this.ensureLoaded();
				this.data.sessions[session.id] = { ...session };
				await this.persist();
			},
			list: async (limit?: number) => {
				await this.ensureLoaded();
				// 关键路径:按 updatedAt 倒序,最近的会话排前面。
				const all = Object.values(this.data.sessions)
					.sort((a, b) => b.updatedAt - a.updatedAt);
				return limit ? all.slice(0, limit) : all;
			},
			delete: async (id: string) => {
				await this.ensureLoaded();
				delete this.data.sessions[id];
				await this.persist();
			},
		};

		this.notes = {
			get: async (path: string) => {
				await this.ensureLoaded();
				const meta = this.data.notes[path] ?? null;
				return meta ? { ...meta } : null;
			},
			upsert: async (meta: NoteMeta) => {
				await this.ensureLoaded();
				this.data.notes[meta.path] = { ...meta };
				await this.persist();
			},
			listByPath: async (prefix: string) => {
				await this.ensureLoaded();
				return Object.values(this.data.notes)
					.filter((n) => n.path.startsWith(prefix));
			},
			delete: async (path: string) => {
				await this.ensureLoaded();
				delete this.data.notes[path];
				await this.persist();
			},
		};

		this.hooks = {
			append: async (log: HookLogEntry) => {
				await this.ensureLoaded();
				this.data.hookLog.push({ ...log });
				await this.persist();
			},
			list: async (limit?: number) => {
				await this.ensureLoaded();
				// 关键路径:最新的排在前面(append-only 日志通常关注尾部)。
				const all = [...this.data.hookLog].reverse();
				return limit ? all.slice(0, limit) : all;
			},
		};
	}

	private loaded = false;
	private loadingPromise: Promise<void> | null = null;
	private persistPromise: Promise<void> | null = null;

	/**
	 * 确保数据已从 `loadData` 加载到内存,后续调用直接返回。
	 *
	 * 关键路径:用共享 Promise 把"首次加载"做合并去重,避免并发请求各自拉一遍 JSON。
	 */
	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (!this.loadingPromise) {
			this.loadingPromise = (async () => {
				try {
					const raw = await this.loadData();
					const stored = (raw ?? {}) as Partial<DataStore>;
					this.data = {
						sessions: (stored.sessions as Record<string, Session>) ?? {},
						notes: (stored.notes as Record<string, NoteMeta>) ?? {},
						hookLog: (stored.hookLog as HookLogEntry[]) ?? [],
					};
					this.loaded = true;
				} catch (err) {
					// 修复:JSON 损坏时降级为空存储 + 错误日志,避免插件启动失败。
					console.error('Failed to load data, starting fresh:', err);
					this.data = { sessions: {}, notes: {}, hookLog: [] };
					this.loaded = true;
				} finally {
					this.loadingPromise = null;
				}
			})();
		}
		await this.loadingPromise;
	}

	/**
	 * 把内存数据持久化到磁盘。
	 *
	 * 关键路径:用 `persistPromise.then` 串行化写盘,避免并发改写互相覆盖。
	 * 写完清空引用,下一个写请求会作为新一轮的开头。
	 */
	private async persist(): Promise<void> {
		if (this.persistPromise) {
			this.persistPromise = this.persistPromise.then(() => this.saveData(this.data));
		} else {
			this.persistPromise = this.saveData(this.data);
		}
		await this.persistPromise;
		this.persistPromise = null;
	}
}

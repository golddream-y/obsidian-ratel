/**
 * @file src/adapters/persistence-json.ts
 * @description JSON 持久化 — notes/hooks/索引进 data.json；Session 正文进 sessions/*.json
 * @module adapters/persistence-json
 * @depends ports/persistence, session-file-store, data-json-merge
 */

import * as path from 'node:path';
import type {
	Persistence,
	SessionRepository,
	NoteMetaRepository,
	HookLogRepository,
	Session,
	SessionIndexEntry,
	NoteMeta,
	HookLogEntry,
} from '../ports/persistence';
import { devLogger } from '../logging/dev-logger';
import { DEFAULT_MAX_SESSIONS, SessionFileStore } from './session-file-store';
import { mergePluginData } from './data-json-merge';
import {
	FULL_TITLE_MAX,
	clipTitle,
	deriveShortTitle,
	normalizeTitlePair,
} from '../ui/chat/session/session-title';

/**
 * 无显式标题时用首条 user 截断作索引标题,避免列表全是「新对话」。
 * 同时补齐 shortTitle(Header chip)。
 */
function deriveSessionTitles(session: Session): { title: string; shortTitle: string } {
	let title = session.title?.trim() ?? '';
	if (!title) {
		for (const m of session.messages) {
			if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
				title = clipTitle(m.content, FULL_TITLE_MAX);
				break;
			}
		}
	}
	return normalizeTitlePair({
		title,
		shortTitle: session.shortTitle,
	});
}

/**
 * data.json 中由 Persistence 维护的字段(不含 settings 扁平键)。
 */
interface PersistenceSlice {
	sessionIndex: SessionIndexEntry[];
	lastSessionId: string | null;
	notes: Record<string, NoteMeta>;
	hookLog: HookLogEntry[];
}

/**
 * 基于 Obsidian loadData/saveData + 分文件 Session 的持久化实现。
 *
 * 设计要点:
 * - Session 正文只经 SessionFileStore；data.json 仅索引 + lastSessionId + notes + hooks
 * - persist 时 read-merge-write,保留 settings 等其它键
 * - 启动时若发现旧版内嵌 sessions Record,迁移到文件并清掉内嵌
 */
export class PersistenceJson implements Persistence {
	public readonly sessions: SessionRepository;
	public readonly notes: NoteMetaRepository;
	public readonly hooks: HookLogRepository;

	private data: PersistenceSlice = {
		sessionIndex: [],
		lastSessionId: null,
		notes: {},
		hookLog: [],
	};
	private readonly fileStore: SessionFileStore;
	private loaded = false;
	private loadingPromise: Promise<void> | null = null;
	private persistPromise: Promise<void> | null = null;

	constructor(
		private loadData: () => Promise<unknown>,
		private saveData: (data: unknown) => Promise<void>,
		pluginDir: string,
	) {
		this.fileStore = new SessionFileStore(path.join(pluginDir, 'sessions'));

		this.sessions = {
			get: async (id: string) => {
				await this.ensureLoaded();
				const session = await this.fileStore.get(id);
				return session ? { ...session, messages: [...session.messages] } : null;
			},
			upsert: async (session: Session) => {
				await this.ensureLoaded();
				const titles = deriveSessionTitles(session);
				const titled: Session = {
					...session,
					title: titles.title,
					shortTitle: titles.shortTitle,
					messages: [...session.messages],
				};
				await this.fileStore.upsert(titled);
				this.upsertIndexEntry({
					id: titled.id,
					title: titled.title,
					shortTitle: titled.shortTitle,
					createdAt: titled.createdAt,
					updatedAt: titled.updatedAt,
					messageCount: titled.messages.length,
				});
				this.data.sessionIndex = await this.fileStore.enforceMaxSessions(
					this.data.sessionIndex,
					DEFAULT_MAX_SESSIONS,
				);
				await this.persist();
			},
			list: async (limit?: number) => {
				await this.ensureLoaded();
				// 关键路径:list 只返回瘦 Session(messages: []),全文走 get — 避免列表扫全文件
				const entries = [...this.data.sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt);
				const sliced = limit ? entries.slice(0, limit) : entries;
				return sliced.map((e) => ({
					id: e.id,
					title: e.title,
					shortTitle: e.shortTitle ?? deriveShortTitle(e.title),
					messages: [] as Session['messages'],
					createdAt: e.createdAt,
					updatedAt: e.updatedAt,
				}));
			},
			delete: async (id: string) => {
				await this.ensureLoaded();
				await this.fileStore.delete(id);
				this.data.sessionIndex = this.data.sessionIndex.filter((e) => e.id !== id);
				if (this.data.lastSessionId === id) {
					const newest = [...this.data.sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt)[0];
					this.data.lastSessionId = newest?.id ?? null;
				}
				await this.persist();
			},
		};

		this.notes = {
			get: async (pathKey: string) => {
				await this.ensureLoaded();
				const meta = this.data.notes[pathKey] ?? null;
				return meta ? { ...meta } : null;
			},
			upsert: async (meta: NoteMeta) => {
				await this.ensureLoaded();
				this.data.notes[meta.path] = { ...meta };
				await this.persist();
			},
			listByPath: async (prefix: string) => {
				await this.ensureLoaded();
				return Object.values(this.data.notes).filter((n) => n.path.startsWith(prefix));
			},
			delete: async (pathKey: string) => {
				await this.ensureLoaded();
				delete this.data.notes[pathKey];
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
				const all = [...this.data.hookLog].reverse();
				return limit ? all.slice(0, limit) : all;
			},
		};
	}

	async getLastSessionId(): Promise<string | null> {
		await this.ensureLoaded();
		return this.data.lastSessionId;
	}

	async setLastSessionId(id: string | null): Promise<void> {
		await this.ensureLoaded();
		this.data.lastSessionId = id;
		await this.persist();
	}

	async listSessionIndex(limit?: number): Promise<SessionIndexEntry[]> {
		await this.ensureLoaded();
		const sorted = [...this.data.sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt);
		return limit ? sorted.slice(0, limit) : sorted;
	}

	private upsertIndexEntry(entry: SessionIndexEntry): void {
		const i = this.data.sessionIndex.findIndex((e) => e.id === entry.id);
		if (i >= 0) {
			this.data.sessionIndex[i] = entry;
		} else {
			this.data.sessionIndex.push(entry);
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (!this.loadingPromise) {
			this.loadingPromise = (async () => {
				try {
					const raw = (await this.loadData()) ?? {};
					const stored = raw as Record<string, unknown>;
					await this.hydrateFromRaw(stored);
					this.loaded = true;
				} catch (err) {
					devLogger.error('vault', 'Failed to load data, starting fresh', err);
					this.data = {
						sessionIndex: [],
						lastSessionId: null,
						notes: {},
						hookLog: [],
					};
					this.loaded = true;
				} finally {
					this.loadingPromise = null;
				}
			})();
		}
		await this.loadingPromise;
	}

	/**
	 * 从 data.json 原始对象恢复内存切片,必要时迁移旧 sessions。
	 */
	private async hydrateFromRaw(stored: Record<string, unknown>): Promise<void> {
		const notes = (stored.notes as Record<string, NoteMeta>) ?? {};
		const hookLog = (stored.hookLog as HookLogEntry[]) ?? [];
		// 安全路径:先收窄为数组再拷贝,避免对 any 做 unsafe spread
		let sessionIndex: SessionIndexEntry[] = Array.isArray(stored.sessionIndex)
			? (stored.sessionIndex as SessionIndexEntry[]).slice()
			: [];
		let lastSessionId =
			typeof stored.lastSessionId === 'string' ? stored.lastSessionId : null;

		const legacy = stored.sessions as Record<string, Session> | undefined;
		if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
			const ids = Object.keys(legacy);
			if (ids.length > 0) {
				devLogger.info('vault', `迁移 ${ids.length} 个内嵌 session → sessions/*.json`);
				for (const id of ids) {
					const s = legacy[id];
					if (!s || typeof s !== 'object') continue;
					const rawSession: Session = {
						id: typeof s.id === 'string' ? s.id : id,
						title: typeof s.title === 'string' ? s.title : '',
						shortTitle: typeof s.shortTitle === 'string' ? s.shortTitle : undefined,
						messages: Array.isArray(s.messages) ? s.messages : [],
						createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
						updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
					};
					const titles = deriveSessionTitles(rawSession);
					const session: Session = {
						...rawSession,
						title: titles.title,
						shortTitle: titles.shortTitle,
					};
					await this.fileStore.upsert(session);
					if (!sessionIndex.some((e) => e.id === session.id)) {
						sessionIndex.push({
							id: session.id,
							title: session.title,
							shortTitle: session.shortTitle,
							createdAt: session.createdAt,
							updatedAt: session.updatedAt,
							messageCount: session.messages.length,
						});
					}
				}
				sessionIndex = await this.fileStore.enforceMaxSessions(
					sessionIndex,
					DEFAULT_MAX_SESSIONS,
				);
				if (!lastSessionId && sessionIndex.length > 0) {
					lastSessionId = [...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt)[0]!.id;
				}
				this.data = { sessionIndex, lastSessionId, notes, hookLog };
				this.loaded = true;
				await this.persist();
				return;
			}
		}

		this.data = { sessionIndex, lastSessionId, notes, hookLog };
		await this.repairEmptyIndexTitles();
	}

	/**
	 * 索引 title / shortTitle 缺失时从场文件回填(一次性修复旧数据)。
	 */
	private async repairEmptyIndexTitles(): Promise<void> {
		let changed = false;
		for (let i = 0; i < this.data.sessionIndex.length; i++) {
			const entry = this.data.sessionIndex[i]!;
			const needsTitle = !entry.title?.trim();
			const needsShort = !entry.shortTitle?.trim();
			if (!needsTitle && !needsShort) continue;
			const session = await this.fileStore.get(entry.id);
			if (!session) {
				if (!needsTitle && needsShort && entry.title?.trim()) {
					this.data.sessionIndex[i] = {
						...entry,
						shortTitle: deriveShortTitle(entry.title),
					};
					changed = true;
				}
				continue;
			}
			const titles = deriveSessionTitles(session);
			if (!titles.title.trim() && !entry.title?.trim()) continue;
			const nextTitle = entry.title?.trim() ? entry.title : titles.title;
			const nextShort =
				entry.shortTitle?.trim() ||
				titles.shortTitle ||
				deriveShortTitle(nextTitle);
			this.data.sessionIndex[i] = {
				...entry,
				title: nextTitle,
				shortTitle: nextShort,
			};
			if (!session.title?.trim() || !session.shortTitle?.trim()) {
				await this.fileStore.upsert({
					...session,
					title: session.title?.trim() ? session.title : nextTitle,
					shortTitle: session.shortTitle?.trim() ? session.shortTitle : nextShort,
				});
			}
			changed = true;
		}
		if (changed) {
			await this.persist();
		}
	}

	/**
	 * 把 Persistence 切片 merge 进 data.json(保留 settings 等其它键)。
	 */
	private async persist(): Promise<void> {
		const write = async () => {
			const existing = ((await this.loadData()) ?? {}) as Record<string, unknown>;
			const { sessions: _drop, ...rest } = existing;
			void _drop;
			const next = mergePluginData(rest, {
				sessionIndex: this.data.sessionIndex,
				lastSessionId: this.data.lastSessionId,
				notes: this.data.notes,
				hookLog: this.data.hookLog,
			});
			// 关键路径:显式删除旧内嵌 sessions,避免残留全量正文
			delete next.sessions;
			await this.saveData(next);
		};

		if (this.persistPromise) {
			// 关键路径:前序 write 失败时仍继续后续 write,避免队列永久卡在 rejected promise。
			this.persistPromise = this.persistPromise.then(write, write);
		} else {
			this.persistPromise = write();
		}
		try {
			await this.persistPromise;
		} finally {
			this.persistPromise = null;
		}
	}
}

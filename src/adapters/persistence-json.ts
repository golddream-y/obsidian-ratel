import type { Persistence, SessionRepository, NoteMetaRepository, HookLogRepository, Session, NoteMeta, HookLogEntry } from '../ports/persistence';

interface DataStore {
	sessions: Record<string, Session>;
	notes: Record<string, NoteMeta>;
	hookLog: HookLogEntry[];
}

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
				const all = [...this.data.hookLog].reverse();
				return limit ? all.slice(0, limit) : all;
			},
		};
	}

	private loaded = false;

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const raw = await this.loadData();
		if (raw && typeof raw === 'object') {
			const stored = raw as Partial<DataStore>;
			this.data = {
				sessions: (stored.sessions as Record<string, Session>) ?? {},
				notes: (stored.notes as Record<string, NoteMeta>) ?? {},
				hookLog: (stored.hookLog as HookLogEntry[]) ?? [],
			};
		}
		this.loaded = true;
	}

	private async persist(): Promise<void> {
		await this.saveData(this.data);
	}
}

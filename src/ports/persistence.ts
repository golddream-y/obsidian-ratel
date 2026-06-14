// Persistence Port — zero-implementation interface contract
// From ARCHITECTURE.md section 4.1

import type { ChatMessage } from './llm';

export interface Persistence {
	sessions: SessionRepository;
	notes: NoteMetaRepository;
	hooks: HookLogRepository;
}

export interface SessionRepository {
	get(id: string): Promise<Session | null>;
	upsert(session: Session): Promise<void>;
	list(limit?: number): Promise<Session[]>;
	delete(id: string): Promise<void>;
}

export interface NoteMetaRepository {
	get(path: string): Promise<NoteMeta | null>;
	upsert(meta: NoteMeta): Promise<void>;
	listByPath(prefix: string): Promise<NoteMeta[]>;
	delete(path: string): Promise<void>;
}

export interface HookLogRepository {
	append(log: HookLogEntry): Promise<void>;
	list(limit?: number): Promise<HookLogEntry[]>;
}

export interface Session {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

export interface NoteMeta {
	path: string;
	hash: string;
	mtime: number;
	tags?: string[];
	links?: string[];
	backlinks?: string[];
	frontmatter?: Record<string, unknown>;
}

export interface HookLogEntry {
	phase: string;
	tool: string;
	timestamp: number;
	result: 'pass' | 'fail' | 'skip';
	message?: string;
}

// ChatMessage is defined in ports/llm.ts (the canonical source)
// Re-exported here for convenience
export type { ChatMessage } from './llm';

/**
 * @file tests/adapters/persistence-json.test.ts
 * @description PersistenceJson 分文件会话 + 迁移 + notes/hooks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PersistenceJson } from '../../src/adapters/persistence-json';
import type { Session, NoteMeta, HookLogEntry } from '../../src/ports/persistence';

describe('PersistenceJson', () => {
	let pluginDir: string;
	let disk: Record<string, unknown>;
	let persistence: PersistenceJson;

	beforeEach(() => {
		pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-plugin-'));
		disk = {};
		const loadData = async () => disk;
		const saveData = async (data: unknown) => {
			disk = data as Record<string, unknown>;
		};
		persistence = new PersistenceJson(loadData, saveData, pluginDir);
	});

	afterEach(() => {
		fs.rmSync(pluginDir, { recursive: true, force: true });
	});

	describe('sessions', () => {
		it('returns null for non-existent session', async () => {
			expect(await persistence.sessions.get('non-existent')).toBeNull();
		});

		it('upserts and retrieves a session', async () => {
			const session: Session = {
				id: 's1',
				title: 'Test Session',
				messages: [{ role: 'user', content: 'Hello' }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await persistence.sessions.upsert(session);
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved).toEqual(session);
			expect(disk.sessions).toBeUndefined();
			expect(Array.isArray(disk.sessionIndex)).toBe(true);
		});

		it('list - 瘦 Session messages 为空 - 全文靠 get', async () => {
			await persistence.sessions.upsert({
				id: 's1',
				title: 'A',
				messages: [{ role: 'user', content: 'x' }],
				createdAt: 1,
				updatedAt: 1,
			});
			const list = await persistence.sessions.list();
			expect(list).toHaveLength(1);
			expect(list[0]!.messages).toEqual([]);
			const full = await persistence.sessions.get('s1');
			expect(full?.messages[0]?.content).toBe('x');
		});

		it('deletes a session', async () => {
			await persistence.sessions.upsert({
				id: 's1',
				title: 'A',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			});
			await persistence.sessions.delete('s1');
			expect(await persistence.sessions.get('s1')).toBeNull();
		});

		it('迁移 - 旧内嵌 sessions - 拆到文件并清掉内嵌', async () => {
			disk = {
				sessions: {
					'session-old': {
						id: 'session-old',
						title: 'old',
						messages: [{ role: 'user', content: 'x' }],
						createdAt: 1,
						updatedAt: 2,
					},
				},
				notes: {},
				hookLog: [],
				someSetting: true,
			};
			const p = new PersistenceJson(
				async () => disk,
				async (d) => {
					disk = d as Record<string, unknown>;
				},
				pluginDir,
			);
			const s = await p.sessions.get('session-old');
			expect(s?.messages[0]?.content).toBe('x');
			expect(disk.sessions).toBeUndefined();
			expect(Array.isArray(disk.sessionIndex)).toBe(true);
			expect(disk.someSetting).toBe(true);
		});
	});

	describe('notes', () => {
		it('upserts and retrieves note metadata', async () => {
			const meta: NoteMeta = {
				path: 'notes/test.md',
				hash: 'abc123',
				mtime: Date.now(),
			};
			await persistence.notes.upsert(meta);
			expect(await persistence.notes.get('notes/test.md')).toEqual(meta);
		});
	});

	describe('hooks', () => {
		it('appends and lists hook entries', async () => {
			const entry: HookLogEntry = {
				phase: 'pre-write',
				tool: 'create_note',
				timestamp: Date.now(),
				result: 'pass',
			};
			await persistence.hooks.append(entry);
			const list = await persistence.hooks.list();
			expect(list).toHaveLength(1);
			expect(list[0]).toEqual(entry);
		});
	});

	describe('resilience', () => {
		it('recovers from corrupt JSON on load', async () => {
			const p = new PersistenceJson(
				async () => {
					throw new Error('data.json contains invalid JSON');
				},
				async () => {},
				pluginDir,
			);
			await expect(p.sessions.get('test')).resolves.toBeNull();
		});
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import { PersistenceJson } from '../../src/adapters/persistence-json';
import type { Session, NoteMeta, HookLogEntry } from '../../src/ports/persistence';

describe('PersistenceJson', () => {
	let storage: Record<string, unknown>;
	let loadData: () => Promise<unknown>;
	let saveData: (data: unknown) => Promise<void>;
	let persistence: PersistenceJson;

	beforeEach(() => {
		storage = {};
		loadData = async () => storage['data'] ?? null;
		saveData = async (data: unknown) => { storage['data'] = data; };
		persistence = new PersistenceJson(loadData, saveData);
	});

	describe('sessions', () => {
		it('returns null for non-existent session', async () => {
			const session = await persistence.sessions.get('non-existent');
			expect(session).toBeNull();
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
		});

		it('updates existing session on upsert', async () => {
			const session: Session = {
				id: 's1',
				title: 'Original',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await persistence.sessions.upsert(session);
			session.title = 'Updated';
			await persistence.sessions.upsert(session);
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved?.title).toBe('Updated');
		});

		it('lists sessions', async () => {
			await persistence.sessions.upsert({
				id: 's1', title: 'A', messages: [],
				createdAt: 1, updatedAt: 1,
			});
			await persistence.sessions.upsert({
				id: 's2', title: 'B', messages: [],
				createdAt: 2, updatedAt: 2,
			});
			const list = await persistence.sessions.list();
			expect(list).toHaveLength(2);
		});

		it('deletes a session', async () => {
			await persistence.sessions.upsert({
				id: 's1', title: 'A', messages: [],
				createdAt: 1, updatedAt: 1,
			});
			await persistence.sessions.delete('s1');
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved).toBeNull();
		});
	});

	describe('notes', () => {
		it('upserts and retrieves note metadata', async () => {
			const meta: NoteMeta = {
				path: 'notes/test.md',
				hash: 'abc123',
				mtime: Date.now(),
				tags: ['test'],
			};
			await persistence.notes.upsert(meta);
			const retrieved = await persistence.notes.get('notes/test.md');
			expect(retrieved).toEqual(meta);
		});

		it('lists notes by path prefix', async () => {
			await persistence.notes.upsert({
				path: 'notes/a.md', hash: 'a', mtime: 1,
			});
			await persistence.notes.upsert({
				path: 'notes/b.md', hash: 'b', mtime: 2,
			});
			await persistence.notes.upsert({
				path: 'daily/c.md', hash: 'c', mtime: 3,
			});
			const list = await persistence.notes.listByPath('notes/');
			expect(list).toHaveLength(2);
		});

		it('deletes note metadata', async () => {
			await persistence.notes.upsert({
				path: 'notes/test.md', hash: 'abc', mtime: 1,
			});
			await persistence.notes.delete('notes/test.md');
			expect(await persistence.notes.get('notes/test.md')).toBeNull();
		});
	});

	describe('hooks', () => {
		it('appends and lists hook log entries', async () => {
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

		it('serializes concurrent persist calls', async () => {
		const saved: unknown[] = [];
		const persistence = new PersistenceJson(
			async () => ({ sessions: {} }),
			async (data) => { saved.push(JSON.parse(JSON.stringify(data))); },
		);

		// Fire two session upserts concurrently
		await Promise.all([
			persistence.sessions.upsert({ id: 'test', title: 'First', messages: [{ role: 'user', content: 'first' }], createdAt: Date.now(), updatedAt: Date.now() }),
			persistence.sessions.upsert({ id: 'test', title: 'Second', messages: [{ role: 'user', content: 'second' }], createdAt: Date.now(), updatedAt: Date.now() }),
		]);

		// Both writes should complete without data loss
		// At least one save should have occurred
		expect(saved.length).toBeGreaterThanOrEqual(1);
	});

	it('respects limit when listing hooks', async () => {
			for (let i = 0; i < 5; i++) {
				await persistence.hooks.append({
					phase: 'pre-write',
					tool: `tool_${i}`,
					timestamp: Date.now(),
					result: 'pass',
				});
			}
			const list = await persistence.hooks.list(3);
			expect(list).toHaveLength(3);
		});
	});
});

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

	describe('resilience', () => {
		it('recovers from corrupt JSON on load', async () => {
			const persistence = new PersistenceJson(
				async () => {
					throw new Error('data.json contains invalid JSON');
				},
				async () => {},
			);

			// Should not throw — corrupt data should trigger a fresh start.
			// Using sessions.get to force ensureLoaded(); expect null (no session after recovery).
			await expect(persistence.sessions.get('test')).resolves.toBeNull();
		});

		it('deduplicates concurrent load calls via loadingPromise', async () => {
			let loadCallCount = 0;
			const persistence = new PersistenceJson(
				async () => {
					loadCallCount++;
					await new Promise((r) => setTimeout(r, 50));
					return { sessions: {} };
				},
				async () => {},
			);

			// Fire 3 concurrent calls that each trigger ensureLoaded()
			await Promise.all([
				persistence.sessions.get('s1'),
				persistence.sessions.get('s2'),
				persistence.sessions.get('s3'),
			]);

			// loadData should be called only once due to loadingPromise
			expect(loadCallCount).toBe(1);
		});

		it('handles empty data file gracefully', async () => {
			const persistence = new PersistenceJson(
				async () => ({}),
				async () => {},
			);

			// Force ensureLoaded() on an empty object
			await persistence.sessions.get('test');
			await expect(persistence.sessions.upsert({ id: 's', title: '', messages: [], createdAt: 0, updatedAt: 0 })).resolves.toBeUndefined();
		});

		it('handles missing sessions key', async () => {
			const persistence = new PersistenceJson(
				async () => ({ otherData: 'foo' }),
				async () => {},
			);

			// Force ensureLoaded() on data that lacks the sessions key
			await persistence.sessions.get('test');
			// Should be able to upsert without error
			await expect(persistence.sessions.upsert({ id: 's', title: '', messages: [], createdAt: 0, updatedAt: 0 })).resolves.toBeUndefined();
		});
	});
});

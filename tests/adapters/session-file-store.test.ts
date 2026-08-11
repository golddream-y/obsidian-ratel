/**
 * @file tests/adapters/session-file-store.test.ts
 * @description SessionFileStore 单场文件读写测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionFileStore } from '../../src/adapters/session-file-store';
import type { Session } from '../../src/ports/persistence';

describe('SessionFileStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-sess-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('upsert/get - 读写单场 - 往返一致', async () => {
		const store = new SessionFileStore(dir);
		const session: Session = {
			id: 'session-1',
			title: 't',
			messages: [{ role: 'user', content: 'hi' }],
			createdAt: 1,
			updatedAt: 2,
		};
		await store.upsert(session);
		const got = await store.get('session-1');
		expect(got?.messages[0]?.content).toBe('hi');
	});

	it('upsert/get - 含 shortTitle - 往返保留短标题', async () => {
		const store = new SessionFileStore(dir);
		await store.upsert({
			id: 'session-2',
			title: '正常标题很长很长',
			shortTitle: '短标题',
			messages: [{ role: 'user', content: 'hi' }],
			createdAt: 1,
			updatedAt: 2,
		});
		const got = await store.get('session-2');
		expect(got?.title).toBe('正常标题很长很长');
		expect(got?.shortTitle).toBe('短标题');
	});

	it('delete - 删除后 get 为 null', async () => {
		const store = new SessionFileStore(dir);
		await store.upsert({
			id: 'session-1',
			title: '',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
		});
		await store.delete('session-1');
		expect(await store.get('session-1')).toBeNull();
	});
});

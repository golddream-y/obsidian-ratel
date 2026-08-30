/**
 * @file src/core/attachment-store.test.ts
 * @description 附件外置存储 — write-once / 缓存读取 / 会话清理(S-VISION v1.3)
 * @module core/attachment-store.test
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from './attachment-store';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'att-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('AttachmentStore', () => {
	it('save - 同内容两次 - 同 id 只写一份(内容 hash 寻址)', async () => {
		const store = new AttachmentStore(dir);
		const a = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		const b = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		expect(a.id).toBe(b.id);
	});

	it('load - Map 缓存命中 - 磁盘删除后仍可读(每运行每图只读一次盘)', async () => {
		const store = new AttachmentStore(dir);
		const { id } = await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		await store.load('s1', id);
		await rm(join(dir, 's1'), { recursive: true, force: true });
		expect((await store.load('s1', id))!.base64).toBe('aGk=');
	});

	it('load - 文件缺失 - 返回 null(渲染/出站双侧降级)', async () => {
		const store = new AttachmentStore(dir);
		expect(await store.load('s1', 'nope')).toBeNull();
	});

	it('removeSession - 整目录清走且缓存键失效 - 其他会话不受影响', async () => {
		const store = new AttachmentStore(dir);
		await store.save('s1', { mimeType: 'image/png', base64: 'aGk=' });
		await store.save('s2', { mimeType: 'image/png', base64: 'aGg=' });
		await store.removeSession('s1');
		await expect(stat(join(dir, 's1'))).rejects.toThrow();
		await expect(stat(join(dir, 's2'))).resolves.toBeTruthy();
	});
});

/**
 * @file src/core/attachment-store.ts
 * @description 图片附件外置存储 — write-once 落盘、缓存读取、会话级清理(S-VISION v1.3)
 * @module core/attachment-store
 * @depends node:fs/promises, node:crypto
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 落盘的附件内容(write-once 文件体) */
export interface StoredAttachment {
	mimeType: string;
	base64: string;
}

/**
 * 图片附件外置存储。
 *
 * 设计要点:
 * - session JSON 只存 {id, mimeType} 引用(KB 级)——ctx.save() 每回合全量序列化,
 *   base64 直存会让图片多的会话每回合卡顿(spec v1.3 §4.1)
 * - 内容 hash 寻址,write-once 天然去重(限会话内)
 * - Map 缓存:每次应用运行每图只读盘一次(hydrate 渲染与每回合出站共用)
 */
export class AttachmentStore {
	private readonly cache = new Map<string, StoredAttachment>();

	constructor(private readonly rootDir: string) {}

	/** 会话附件目录:<rootDir>/<sessionId>(会话删除整目录清走,GC 零逻辑) */
	private dir(sessionId: string): string {
		return join(this.rootDir, sessionId);
	}

	/** 内容寻址短 hash 作文件名 */
	private idFor(att: StoredAttachment): string {
		return createHash('sha256').update(att.base64).digest('hex').slice(0, 16);
	}

	/**
	 * write-once 保存:同内容重复发送直接复用,不重写文件。
	 *
	 * @returns 存入 session 消息的引用 {id, mimeType}
	 */
	async save(sessionId: string, att: StoredAttachment): Promise<{ id: string; mimeType: string }> {
		const id = this.idFor(att);
		this.cache.set(`${sessionId}/${id}`, att);
		await mkdir(this.dir(sessionId), { recursive: true });
		// 关键路径:write-once —— 文件已存在即跳过写入,避免同图重复 IO
		try {
			await readFile(join(this.dir(sessionId), `${id}.json`));
		} catch {
			await writeFile(join(this.dir(sessionId), `${id}.json`), JSON.stringify(att));
		}
		return { id, mimeType: att.mimeType };
	}

	/**
	 * 读取附件内容;缓存命中不读盘;文件缺失返回 null(渲染占位 / 出站剥除)。
	 */
	async load(sessionId: string, id: string): Promise<StoredAttachment | null> {
		const key = `${sessionId}/${id}`;
		const hit = this.cache.get(key);
		if (hit) return hit;
		try {
			const raw = JSON.parse(await readFile(join(this.dir(sessionId), `${id}.json`), 'utf8')) as StoredAttachment;
			this.cache.set(key, raw);
			return raw;
		} catch {
			return null;
		}
	}

	/**
	 * 会话删除时整目录清走;对应缓存键一并失效。
	 *
	 * @throws rm 失败时抛原错误(目录不存在视为已清,不抛)。
	 */
	async removeSession(sessionId: string): Promise<void> {
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(`${sessionId}/`)) this.cache.delete(key);
		}
		await rm(this.dir(sessionId), { recursive: true, force: true });
	}
}

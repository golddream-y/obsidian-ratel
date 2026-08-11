/**
 * @file src/adapters/session-file-store.ts
 * @description 单场会话正文文件存储 — pluginDir/sessions/<id>.json
 * @module adapters/session-file-store
 * @depends ports/persistence, node:fs, node:path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session, SessionIndexEntry } from '../ports/persistence';
import { devLogger } from '../logging/dev-logger';

/** 默认最多保留的会话场数 */
export const DEFAULT_MAX_SESSIONS = 30;

/**
 * 将 session id 转为安全文件名(去掉路径分隔与可疑字符)。
 */
export function sessionIdToFileName(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
}

/**
 * 单场 Session 文件仓库。
 *
 * 设计要点:
 * - 每场一个 JSON 文件,按需读写,避免 data.json 膨胀
 * - JSON 损坏时返回 null 并打日志,不拖垮插件
 * - enforceMaxSessions 按 updatedAt 删最旧文件
 */
export class SessionFileStore {
	constructor(private readonly sessionsDir: string) {
		fs.mkdirSync(this.sessionsDir, { recursive: true });
	}

	private filePath(id: string): string {
		return path.join(this.sessionsDir, sessionIdToFileName(id));
	}

	/**
	 * 按 id 读取 Session。
	 *
	 * @returns 不存在或损坏时 null
	 */
	async get(id: string): Promise<Session | null> {
		const fp = this.filePath(id);
		if (!fs.existsSync(fp)) return null;
		try {
			const raw = fs.readFileSync(fp, 'utf8');
			const parsed = JSON.parse(raw) as Session;
			if (!parsed || typeof parsed.id !== 'string') return null;
			return {
				id: parsed.id,
				title: typeof parsed.title === 'string' ? parsed.title : '',
				// 修复:往返必须保留 shortTitle,否则 Header 已更新、编辑弹框 get 丢短标题/与芯片不一致
				shortTitle: typeof parsed.shortTitle === 'string' ? parsed.shortTitle : undefined,
				messages: Array.isArray(parsed.messages) ? parsed.messages : [],
				createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
				updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
			};
		} catch (err) {
			devLogger.error('vault', `会话文件损坏,忽略: ${fp}`, err);
			return null;
		}
	}

	/**
	 * 写入或覆盖单场 Session。
	 */
	async upsert(session: Session): Promise<void> {
		fs.mkdirSync(this.sessionsDir, { recursive: true });
		const fp = this.filePath(session.id);
		fs.writeFileSync(fp, JSON.stringify(session, null, 2), 'utf8');
	}

	/**
	 * 删除单场文件(不存在则静默)。
	 */
	async delete(id: string): Promise<void> {
		const fp = this.filePath(id);
		if (fs.existsSync(fp)) {
			fs.unlinkSync(fp);
		}
	}

	/**
	 * 列出目录内已知文件对应的 id(不去读正文)。
	 */
	async listIds(): Promise<string[]> {
		if (!fs.existsSync(this.sessionsDir)) return [];
		return fs
			.readdirSync(this.sessionsDir)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''));
	}

	/**
	 * 按索引裁剪:超出 maxN 时删最旧场文件,并返回新索引。
	 *
	 * @param index - 当前索引(将被按 updatedAt 排序)
	 * @param maxN - 保留上限
	 */
	async enforceMaxSessions(
		index: SessionIndexEntry[],
		maxN: number = DEFAULT_MAX_SESSIONS,
	): Promise<SessionIndexEntry[]> {
		const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
		if (sorted.length <= maxN) return sorted;
		const keep = sorted.slice(0, maxN);
		const drop = sorted.slice(maxN);
		for (const e of drop) {
			await this.delete(e.id);
		}
		return keep;
	}
}

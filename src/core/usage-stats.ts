/**
 * @file src/core/usage-stats.ts
 * @description 使用统计存储 — Skill 激活、记忆 topics 自动注入命中与脚本熔断计数(S-SR-LAYERING SR-03 / ADR-017)
 * @module core/usage-stats
 * @depends node:fs, logging/dev-logger
 */

import * as fs from 'node:fs';
import { devLogger } from '../logging/dev-logger';

/** 统计数据形态 — 三个命名空间:skills / memoryTopics / scriptFailures */
export interface UsageStatsData {
	skills: Record<string, number>;
	memoryTopics: Record<string, number>;
	/** 脚本熔断计数(key = `<skillName>/<scriptPath>`,ADR-017) */
	scriptFailures: Record<string, number>;
}

/**
 * 使用统计存储 — pluginDir/usage-stats.json 读写。
 *
 * 设计要点:
 * - 不进 settings/data.json:每次激活都重写主配置会污染保存节奏(spec §4)。
 * - 不进 vault/.ratel:统计非用户笔记内容,与 .memory-index 同域放 pluginDir。
 * - 只给计数,不做衰减/退役/趋势(PRD §7.5 非目标)。
 */
export class UsageStatsStore {
	private data: UsageStatsData = { skills: {}, memoryTopics: {}, scriptFailures: {} };

	/** @param filePath - 统计文件绝对路径(pluginDir/usage-stats.json) */
	constructor(private filePath: string) {
		this.data = this.readFromDisk();
	}

	/** 读取当前统计快照(浅拷贝 — 调用方意外 mutate 不会污染内部计数与落盘) */
	getAll(): UsageStatsData {
		return {
			skills: { ...this.data.skills },
			memoryTopics: { ...this.data.memoryTopics },
			scriptFailures: { ...this.data.scriptFailures },
		};
	}

	/** Skill 激活计数 +1 并落盘 */
	bumpSkill(name: string): void {
		this.bump('skills', name);
	}

	/** 记忆 topics 自动注入命中计数 +1 并落盘 */
	bumpMemoryTopic(name: string): void {
		this.bump('memoryTopics', name);
	}

	/**
	 * 记忆 topics 自动注入命中批量计数 — 一轮 ask 命中 K 条时只落盘一次。
	 *
	 * 关键路径:topics 自动注入是每轮对话路径,bumpMemoryTopic 逐条调用会同步写盘 K 次;
	 * 批量接口凑齐后一次 flush,主线程 IO 从 K 次降为 1 次。
	 *
	 * @param names - 本轮命中的 topic 名称列表(允许重复,各自 +1)
	 */
	bumpMemoryTopicsBatch(names: string[]): void {
		if (names.length === 0) return;
		for (const name of names) {
			const bucket = this.data.memoryTopics;
			bucket[name] = (bucket[name] ?? 0) + 1;
		}
		this.flush();
	}

	/** 脚本异常终止(被杀/超时/崩溃)计数 +1 并落盘 — ADR-017 熔断输入 */
	bumpScriptFailure(scriptId: string): void {
		this.bump('scriptFailures', scriptId);
	}

	/** 脚本成功执行 — 连续失败计数清零并落盘 */
	clearScriptFailure(scriptId: string): void {
		if (this.data.scriptFailures[scriptId] === undefined) return;
		delete this.data.scriptFailures[scriptId];
		this.flush();
	}

	/** 读取脚本连续失败计数(0 = 未熔断) */
	getScriptFailureCount(scriptId: string): number {
		return this.data.scriptFailures[scriptId] ?? 0;
	}

	private bump(namespace: 'skills' | 'memoryTopics' | 'scriptFailures', name: string): void {
		const bucket = this.data[namespace];
		bucket[name] = (bucket[name] ?? 0) + 1;
		this.flush();
	}

	/** 读盘;损坏时重置为空并告警(统计可丢,不可断会话) */
	private readFromDisk(): UsageStatsData {
		try {
			if (!fs.existsSync(this.filePath)) return { skills: {}, memoryTopics: {}, scriptFailures: {} };
			const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
			if (typeof parsed !== 'object' || parsed === null) return { skills: {}, memoryTopics: {}, scriptFailures: {} };
			const obj = parsed as Partial<UsageStatsData>;
			return {
				skills: this.sanitizeBucket(obj.skills),
				memoryTopics: this.sanitizeBucket(obj.memoryTopics),
				scriptFailures: this.sanitizeBucket(obj.scriptFailures),
			};
		} catch (err) {
			devLogger.warn('stats', 'usage-stats.json 损坏,统计已重置', err);
			return { skills: {}, memoryTopics: {}, scriptFailures: {} };
		}
	}

	/** 过滤桶内非有限数值与负数 — 手改文件写入字符串/负数等脏值时静默丢弃,防 NaN 与负计数落盘 */
	private sanitizeBucket(bucket: unknown): Record<string, number> {
		if (typeof bucket !== 'object' || bucket === null) return {};
		const out: Record<string, number> = {};
		for (const [key, value] of Object.entries(bucket as Record<string, unknown>)) {
			if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
		}
		return out;
	}

	/** 关键路径:同步写 — 文件极小(几行计数)、bump 频率低,不值得引入防抖复杂度 */
	private flush(): void {
		try {
			fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
		} catch (err) {
			devLogger.warn('stats', 'usage-stats.json 写入失败,仅内存计数', err);
		}
	}
}

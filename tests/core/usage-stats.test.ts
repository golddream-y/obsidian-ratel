/**
 * @file tests/core/usage-stats.test.ts
 * @description 使用统计存储测试 — Skill 激活与记忆 topics 命中计数、落盘重读与损坏降级(S-SR-LAYERING Task 4)
 * @module tests/core/usage-stats
 * @depends core/usage-stats
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStatsStore } from '../../src/core/usage-stats';

/** 新建临时目录 + 全新 store;测试自负责清理 dir */
function tmpStore(): { store: UsageStatsStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'ratel-stats-'));
	return { store: new UsageStatsStore(join(dir, 'usage-stats.json')), dir };
}

describe('UsageStatsStore', () => {
	it('bumpSkill - 计数累加并落盘可重读', () => {
		const { store, dir } = tmpStore();
		store.bumpSkill('writer');
		store.bumpSkill('writer');
		store.bumpSkill('reader');
		const reloaded = new UsageStatsStore(join(dir, 'usage-stats.json'));
		expect(reloaded.getAll().skills['writer']).toBe(2);
		expect(reloaded.getAll().skills['reader']).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});

	it('bumpMemoryTopic - 独立命名空间', () => {
		const { store, dir } = tmpStore();
		store.bumpMemoryTopic('obsidian');
		expect(store.getAll().memoryTopics['obsidian']).toBe(1);
		expect(store.getAll().skills).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});

	it('损坏 JSON - 构造时重置为空不抛错', () => {
		// 关键路径:先落损坏文件再构造,覆盖「构造函数读损坏 JSON」的真实场景
		const dir = mkdtempSync(join(tmpdir(), 'ratel-stats-'));
		writeFileSync(join(dir, 'usage-stats.json'), '{broken', 'utf-8');
		const store = new UsageStatsStore(join(dir, 'usage-stats.json'));
		expect(store.getAll().skills).toEqual({});
		expect(store.getAll().memoryTopics).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});

	it('脏计数值 - 非有限数值被过滤,合法值保留', () => {
		// 关键路径:手改文件写入字符串/NaN 时静默丢弃,防脏值参与后续累加与落盘
		const dir = mkdtempSync(join(tmpdir(), 'ratel-stats-'));
		writeFileSync(
			join(dir, 'usage-stats.json'),
			JSON.stringify({ skills: { good: 2, bad: 'x', nan: Number.NaN }, memoryTopics: {} }),
			'utf-8',
		);
		const store = new UsageStatsStore(join(dir, 'usage-stats.json'));
		expect(store.getAll().skills).toEqual({ good: 2 });
		store.bumpSkill('good');
		expect(store.getAll().skills['good']).toBe(3);
		rmSync(dir, { recursive: true, force: true });
	});

	it('getAll - 返回浅拷贝,调用方 mutate 不污染内部计数', () => {
		const { store, dir } = tmpStore();
		store.bumpSkill('writer');
		const snapshot = store.getAll();
		snapshot.skills['writer'] = 999;
		snapshot.skills['hacked'] = 1;
		expect(store.getAll().skills['writer']).toBe(1);
		expect(store.getAll().skills['hacked']).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});

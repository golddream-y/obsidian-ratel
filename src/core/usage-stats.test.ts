/**
 * @file src/core/usage-stats.test.ts
 * @description UsageStatsStore 单元测试 — scriptFailures 熔断计数(ADR-017)
 * @module core/usage-stats.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageStatsStore } from './usage-stats';

describe('UsageStatsStore — scriptFailures 熔断计数', () => {
	let store: UsageStatsStore;
	let filePath: string;

	beforeEach(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-stats-'));
		filePath = path.join(dir, 'usage-stats.json');
		store = new UsageStatsStore(filePath);
	});

	it('bumpScriptFailure - 首次失败 - 计数为 1 并落盘', () => {
		store.bumpScriptFailure('data-cleaner/clean.js');
		expect(store.getScriptFailureCount('data-cleaner/clean.js')).toBe(1);
		// 关键路径:计数持久化,插件重启后熔断状态不丢
		const reloaded = new UsageStatsStore(filePath);
		expect(reloaded.getScriptFailureCount('data-cleaner/clean.js')).toBe(1);
	});

	it('clearScriptFailure - 成功后清零 - 计数归 0 并落盘', () => {
		store.bumpScriptFailure('a/b.js');
		store.clearScriptFailure('a/b.js');
		expect(store.getScriptFailureCount('a/b.js')).toBe(0);
		// 关键路径:清零持久化,插件重启后熔断状态不残留
		const reloaded = new UsageStatsStore(filePath);
		expect(reloaded.getScriptFailureCount('a/b.js')).toBe(0);
	});

	it('readFromDisk - scriptFailures 桶含脏值 - 非数值被过滤', () => {
		fs.writeFileSync(filePath, JSON.stringify({ scriptFailures: { 'a/b.js': 'x', 'c/d.js': 2 } }), 'utf-8');
		const reloaded = new UsageStatsStore(filePath);
		expect(reloaded.getScriptFailureCount('a/b.js')).toBe(0);
		expect(reloaded.getScriptFailureCount('c/d.js')).toBe(2);
	});

	it('getAll - 返回 scriptFailures 快照 - 浅拷贝不污染内部', () => {
		store.bumpScriptFailure('a/b.js');
		const snap = store.getAll();
		snap.scriptFailures['a/b.js'] = 99;
		expect(store.getScriptFailureCount('a/b.js')).toBe(1);
	});
});

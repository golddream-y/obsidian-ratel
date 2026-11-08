/**
 * @file tests/core/thread-coordinator-restore.test.ts
 * @description 线程协调器恢复验证 — 重启后跳过是否计入 verified
 * @module tests/core/thread-coordinator-restore
 * 运行: `RATEL_REAL_GEN=1 npx vitest run tests/core/thread-coordinator-restore.test.ts`
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IndexThreadCoordinator, type ThreadIndexClient, type ThreadIndexVault } from '../../src/core/index-thread-coordinator';

const GEN_ROOT = process.env.RATEL_REAL_GEN_ROOT
	?? '/Users/golddream/ObsidianVault/.obsidian/plugins/ratel-vault/.index/generations/gen-814fcc07587d24a0';

describe.skipIf(!process.env.RATEL_REAL_GEN)('线程协调器恢复', () => {
	it('重启后跳过已索引文件 - verified 计入', async () => {
		const filesDir = path.join(GEN_ROOT, 'files');
		const receipts = fs.readdirSync(filesDir).filter((n) => n.endsWith('.json'));
		const paths = receipts.map((n) => JSON.parse(fs.readFileSync(path.join(filesDir, n), 'utf-8')).path);
		console.log(`  完成记录: ${paths.length} 条`);
		// 模拟 vault：前 100 条已索引文件 + 其余新文件
		const indexed = new Set(paths.slice(0, 100));
		const vaultFiles = [...paths.slice(0, 100), ...Array.from({ length: 50 }, (_, i) => `新文件${i}.md`)];
		let skippedCalls = 0;
		let writtenCalls = 0;
		const client: ThreadIndexClient = {
			start: async () => undefined,
			indexFile: async (filePath) => {
				if (indexed.has(filePath)) { skippedCalls += 1; return { chunkCount: 0, skipped: true }; }
				writtenCalls += 1;
				return { chunkCount: 1 };
			},
			deleteFile: async () => ({ removed: 0 }),
			recover: async () => ({ pending: 0, decisions: 0, failures: 0 }),
			close: async () => undefined,
		};
		const vault: ThreadIndexVault = {
			listMarkdownFiles: () => vaultFiles,
			readFile: async (p) => (indexed.has(p) ? '旧内容' : '新内容'),
		};
		const coordinator = new IndexThreadCoordinator({
			client,
			vault,
			start: { root: GEN_ROOT, generationId: 'gen-814fcc07587d24a0', configFingerprint: 'x'.repeat(64) },
		});
		const counters = await coordinator.start();
		console.log(`  跳过调用: ${skippedCalls}, 写入调用: ${writtenCalls}`);
		console.log(`  最终 verified(committed): ${counters.committed}`);
		expect(skippedCalls).toBeGreaterThanOrEqual(100);
		expect(counters.committed).toBeGreaterThanOrEqual(100);
	}, 60_000);
});

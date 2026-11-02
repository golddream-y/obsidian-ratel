/**
 * @file tests/core/index-thread-startup-sequence.test.ts
 * @description 启动序列 — 生产同款代际解析后线程可用（含实验命令使用的路径）
 * @module tests/core/index-thread-startup-sequence
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexGenerations } from '../../src/core/index-generations';
import { resolveIndexGeneration } from '../../src/core/index-processor-port';

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-startup-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** 与实验命令相同的写所有权替身。 */
function makeOwner() {
	return {
		epoch: 1,
		assertWritable() {},
		beginCommit() { return { settled: false, settle() {} }; },
	};
}

describe('线程启动序列', () => {
	it('无旧索引 - 解析出全新代际 - 指纹与目录可直接用于启动', async () => {
		const owner = makeOwner();
		const generations = new IndexGenerations({ indexRoot: root, owner: owner as never });
		const result = await resolveIndexGeneration({
			generations,
			indexRoot: root,
			config: {
				embeddingModelId: 'experiment:stub',
				embeddingModelRevision: null,
				embeddingDimension: 8,
				chunkerVersion: 1,
				chunkSize: 500,
				chunkOverlap: 100,
				embeddingTextVersion: null,
			},
			owner: owner as never,
			allowCreate: true,
			legacy: null,
		});
		expect(result.resolved).not.toBeNull();
		const resolved = result.resolved!;
		expect(resolved.generationId.length).toBeGreaterThan(0);
		expect(resolved.configFingerprint).toHaveLength(64);
		expect(resolved.generationRoot.startsWith(root)).toBe(true);
		expect(resolved.active).toBe(false);
	});
});

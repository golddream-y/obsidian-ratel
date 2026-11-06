/**
 * @file tests/core/index-runtime-identity-wiring.test.ts
 * @description 写运行时身份守卫接线 — 同配置幂等、换配置立即以配置语义拒绝
 * @module tests/core/index-runtime-identity-wiring
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexRuntimeIdentityGuard } from '../../src/core/index-runtime-identity-guard';
import { setupWritableIndexRuntime } from '../../src/core/index-runtime-assembly';
import { computeConfigFingerprint, type IndexConfigDescriptor } from '../../src/core/index-persistence-types';

const BASE: IndexConfigDescriptor = {
	embeddingModelId: 'local:test-model',
	embeddingModelRevision: null,
	embeddingDimension: 2,
	chunkerVersion: 3,
	chunkSize: 500,
	chunkOverlap: 100,
	embeddingTextVersion: null,
};

const vault = {
	listMarkdownFiles: (): string[] => [],
	readFile: async (): Promise<string> => '',
	stat: (): null => null,
};

const embedding = {
	dimensions: 2,
	modelId: 'test:guard',
	async embed(texts: string[]): Promise<number[][]> {
		return texts.map(() => [0.1, 0.2]);
	},
};

let root = '';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-identity-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** 组装一次写运行时所需的最小依赖。 */
function depsFor(config: IndexConfigDescriptor, fingerprint: string, guard: IndexRuntimeIdentityGuard) {
	return {
		indexRoot: root,
		config,
		configFingerprint: fingerprint,
		vault: vault as never,
		embedding: embedding as never,
		getChunkOptions: () => ({ maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length }),
		chunkLimits: { chunkSize: 500, chunkOverlap: 100 },
		expectedDimension: 2,
		isExcluded: () => false,
		fileExists: () => false,
		identityGuard: guard,
	};
}

describe('身份守卫接线', () => {
	it('同配置重复装配 - 幂等放行 - 不误报冲突', async () => {
		const guard = new IndexRuntimeIdentityGuard();
		const fingerprint = await computeConfigFingerprint(BASE);
		const first = await setupWritableIndexRuntime(depsFor(BASE, fingerprint, guard));
		expect(guard.activeFingerprint).toBe(fingerprint);
		// 关键路径:装配层以 autoInit 预热线存储;不等待它落地就删临时目录,
		// 会让 vectra 的 catalog 创建在套件高负载下以未处理拒绝收尾(见 2026-11-04 记录)。
		await first.pipeline.store.init();
		first.releaseIdentity?.();
		await first.lease.release();
		expect(guard.busy).toBe(false);
	}, 30_000);

	it('换配置再装配 - 以配置身份错误拒绝 - 旧运行时不受影响', async () => {
		const guard = new IndexRuntimeIdentityGuard();
		const fingerprintA = await computeConfigFingerprint(BASE);
		const first = await setupWritableIndexRuntime(depsFor(BASE, fingerprintA, guard));

		const changed: IndexConfigDescriptor = { ...BASE, chunkOverlap: 60 };
		const fingerprintB = await computeConfigFingerprint(changed);
		await expect(setupWritableIndexRuntime(depsFor(changed, fingerprintB, guard))).rejects.toMatchObject({
			code: 'config-identity-conflict',
		});
		// 旧运行时仍在，且指纹没被顶掉。
		expect(guard.activeFingerprint).toBe(fingerprintA);

		await first.pipeline.store.init();
		first.releaseIdentity?.();
		await first.lease.release();
	}, 30_000);
});

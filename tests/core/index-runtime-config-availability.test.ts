/**
 * @file tests/core/index-runtime-config-availability.test.ts
 * @description 配置切换受阻与只读装配的身份、可用性和磁盘保留回归
 * @module tests/core/index-runtime-config-availability
 * @depends core/index-runtime-assembly, core/index-generations
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexGenerations } from '../../src/core/index-generations';
import { INDEX_RECORD_SCHEMA_VERSION, computeConfigFingerprint, type IndexConfigDescriptor } from '../../src/core/index-persistence-types';
import {
	IndexRuntimeGenerationBlockedError,
	setupReadOnlyIndexRuntime,
	setupWritableIndexRuntime,
} from '../../src/core/index-runtime-assembly';

const config: IndexConfigDescriptor = {
	embeddingModelId: 'local:test-model',
	embeddingModelRevision: null,
	embeddingDimension: 2,
	chunkerVersion: 3,
	chunkSize: 500,
	chunkOverlap: 100,
	embeddingTextVersion: null,
};
const vault = {
	listMarkdownFiles: vi.fn((): string[] => []),
	readFile: vi.fn(async () => ''),
	stat: vi.fn(() => null),
};

/** 只对合成目录记录逐文件内容，观察失败前后是否改写旧数据。 */
function snapshot(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else result[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
		}
	};
	visit(root);
	return result;
}

describe('索引运行时配置可用性', () => {
	let root: string;
	let generations: IndexGenerations;
	let activeId: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-runtime-config-'));
		generations = new IndexGenerations({
			indexRoot: root,
			owner: { epoch: 1, assertWritable: () => {}, beginCommit: () => ({ settle: () => {} }) },
		});
		const active = await generations.ensureGeneration({ config });
		activeId = active.generationId;
		await generations.publishActiveGeneration({ generationId: activeId, mode: 'upgrade' });
	});

	afterEach(() => {
		// 关键路径：仅清理本测试创建并记录的系统临时目录。
		if (!root.startsWith(path.join(os.tmpdir(), 'ratel-runtime-config-'))) throw new Error('测试目录归属不符');
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each([
		{ embeddingModelId: 'local:other-model' },
		{ embeddingDimension: 3 },
		{ embeddingModelRevision: 'revision-2' },
		{ embeddingTextVersion: 'template-2' },
		{ chunkSize: 600 },
		{ chunkOverlap: 50 },
		{ chunkerVersion: 4 },
	])('只读装配 - 配置身份不同 %j - 明确不可用且不构造存储', async (overrides) => {
		const changed = { ...config, ...overrides };
		const before = snapshot(root);
		const createStore = vi.fn();
		const runtime = await setupReadOnlyIndexRuntime({
			indexRoot: root, config: changed, configFingerprint: await computeConfigFingerprint(changed), vault, createStore,
		});
		expect(runtime.indexDirUsable).toBe(false);
		expect(runtime.activeGenerationId).toBe(activeId);
		expect(runtime.unavailableReason).toBe('config-mismatch');
		expect(runtime.store).toBeUndefined();
		expect(runtime.journal).toBeUndefined();
		expect(runtime.readOnlySearchView).toBeUndefined();
		expect(createStore).not.toHaveBeenCalled();
		expect(vault.listMarkdownFiles).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
	});

	it('只读装配 - 调用方指纹与配置不同 - 不允许伪装成可检索', async () => {
		const runtime = await setupReadOnlyIndexRuntime({ indexRoot: root, config, configFingerprint: 'wrong', vault });
		expect(runtime.indexDirUsable).toBe(false);
		expect(runtime.unavailableReason).toBe('config-mismatch');
		expect(runtime.store).toBeUndefined();
	});

	it('只读装配 - 尚无活动代际 - 明确不可用且不扫描和落盘', async () => {
		await generations.writeControl({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION, activeGenerationId: null, generations: {} });
		const before = snapshot(root);
		const runtime = await setupReadOnlyIndexRuntime({
			indexRoot: root, config, configFingerprint: await computeConfigFingerprint(config), vault,
		});
		expect(runtime).toMatchObject({ indexDirUsable: false, activeGenerationId: null, unavailableReason: 'no-active-generation' });
		expect(vault.listMarkdownFiles).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
	});

	it('只读装配 - 控制指针损坏 - 失败关闭且保留原始文件', async () => {
		fs.writeFileSync(path.join(root, 'control.json'), '{broken');
		const before = snapshot(root);
		const runtime = await setupReadOnlyIndexRuntime({
			indexRoot: root, config, configFingerprint: await computeConfigFingerprint(config), vault,
		});
		expect(runtime).toMatchObject({ indexDirUsable: false, unavailableReason: 'control-invalid' });
		expect(runtime.store).toBeUndefined();
		expect(snapshot(root)).toEqual(before);
	});

	it('配置切换 - 第三配置被保留代际阻断且没有旧嵌入端口 - 失败关闭并保留旧数据和指针', async () => {
		await generations.ensureGeneration({ config: { ...config, embeddingModelId: 'local:pending-model' } });
		const before = snapshot(root);
		const changed = { ...config, embeddingModelId: 'local:new-model' };
		const embed = vi.fn(async () => [[1, 0]]);
		const createStore = vi.fn();
		let failure: unknown;
		try {
			await setupWritableIndexRuntime({
				indexRoot: root, config: changed, configFingerprint: await computeConfigFingerprint(changed), vault,
				embedding: { modelId: changed.embeddingModelId, dimensions: 2, embed },
				getChunkOptions: () => ({ maxTokens: 500, overlapTokens: 100, count: (text) => text.length }),
				chunkLimits: { chunkSize: 500, chunkOverlap: 100 }, expectedDimension: 2, createStore,
			});
		} catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(IndexRuntimeGenerationBlockedError);
		expect(failure).toMatchObject({ code: 'all-generations-retained', activeGenerationId: activeId });
		expect(embed).not.toHaveBeenCalled();
		expect(createStore).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
		expect(fs.existsSync(path.join(root, 'owner.lock'))).toBe(false);

		// 关键路径：保留下来的旧配置仍能按自己的完整指纹只读装配；查询端必须另接真实旧模型。
		const retained = await setupReadOnlyIndexRuntime({
			indexRoot: root, config, configFingerprint: await computeConfigFingerprint(config), vault,
		});
		expect(retained.indexDirUsable).toBe(true);
		expect(retained.activeGenerationId).toBe(activeId);
		expect(snapshot(root)).toEqual(before);
	});
});

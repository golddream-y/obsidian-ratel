/**
 * @file tests/core/index-runtime-config-switch.test.ts
 * @description 配置切换遗留缺口 — 会话内身份漂移、跨会话代际切换、只读失败关闭与切换后重复嵌入的当前真实行为
 * @module tests/core/index-runtime-config-switch
 * @depends core/index-runtime-assembly, core/index-generations, core/index-processor-port,
 *   core/index-persistence-types, helpers/index-reliability-fixture
 *
 * 关键路径(本文件是**缺口复现**,不是期望行为):
 * - A1:会话内漂移检测用的身份串(`configIdentityOf`)只含 5 个字段,模型修订与嵌入文本模板变化
 *   会改变配置指纹、却**不改变**身份串 —— 这两类配置变化在同一会话内不会被判定为漂移。
 * - A2:装配层没有「比较配置身份」的拒绝分支:同一会话内再次装配的关闭点是**写所有权占用**
 *   (`predecessor-not-closed`),不是配置指纹变化;旧会话释放 lease 后,同一路径会被当作
 *   跨会话配置切换放行(见场景 B)。生产上额外的暂停来自 `src/main.ts` 的 `rejectIndexConfigDrift`。
 * - B2:`GenerationActivationPublisher.publish` 自己写入 `migrated` / `verifiedAt`,状态机的
 *   `switch-not-verified` 因此只挡住「绕过发布器的直接切换」;「核对完成后才切指针」的时序
 *   实际由宿主「状态 Ready 才订阅调用」保证,核心层没有独立的核对证据校验。
 * - D:切换配置后新代际没有任何可复用完成记录,未修改文件会被重新嵌入(不存在跨代际复用钩子)。
 *
 * 全部用例使用系统临时目录上的真实磁盘,不访问真实 Vault、不联网、不加载模型。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GenerationActivationPublisher,
	configIdentityOf,
	setupReadOnlyIndexRuntime,
	setupWritableIndexRuntime,
} from '../../src/core/index-runtime-assembly';
import {
	computeConfigFingerprint,
	type IndexConfigDescriptor,
} from '../../src/core/index-persistence-types';
import type { IndexWriteOwner } from '../../src/core/index-write-owner';
import { FakeEmbeddingPort, T0_CHUNK_OPTIONS } from '../helpers/index-reliability-fixture';

// ==================== 夹具 ====================

/** 合成向量维度 — 保持小尺寸,避免用例把时间花在写盘上。 */
const DIMENSIONS = 8;

/** 合成笔记 — 切换配置后内容完全不改,用于观察是否被重新嵌入。 */
const NOTE_CONTENT = ['# 配置切换复现', '', '这篇笔记在切换前后逐字节相同。', '', '第二段用于保证至少一个块。'].join('\n');

/** 基准配置 — 与 `T0_CHUNK_OPTIONS` 的分块参数保持一致。 */
function baseConfig(overrides: Partial<IndexConfigDescriptor> = {}): IndexConfigDescriptor {
	return {
		embeddingModelId: 'local:test-model-a',
		embeddingModelRevision: null,
		embeddingDimension: DIMENSIONS,
		chunkerVersion: 1,
		chunkSize: T0_CHUNK_OPTIONS.maxTokens,
		chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		embeddingTextVersion: null,
		...overrides,
	};
}

/** 合成 Vault 端口 — 只暴露文件内容与 mtime,不触碰真实库。 */
function createVault(files: Record<string, string>): {
	listMarkdownFiles(): string[];
	readFile(filePath: string): Promise<string>;
	stat(filePath: string): { mtime: number; size: number } | null;
} {
	const statOf = (filePath: string): { mtime: number; size: number } | null => {
		const content = files[filePath];
		return content === undefined ? null : { mtime: 1, size: content.length };
	};
	return {
		listMarkdownFiles: () => Object.keys(files),
		readFile: async (filePath: string) => files[filePath] ?? '',
		stat: statOf,
	};
}

/** 递归快照目录内容 — 用 base64 逐字比较,避免把二进制索引文件当文本读坏。 */
function snapshotDir(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else result[path.relative(root, full)] = fs.readFileSync(full).toString('base64');
		}
	};
	visit(root);
	return result;
}

/** 捕获同步抛错 — 断言稳定错误码,不只匹配文案。 */
function captureThrow(operation: () => void): unknown {
	try {
		operation();
	} catch (error) {
		return error;
	}
	throw new Error('预期抛出错误,但调用成功返回');
}

/** 装配写路径运行时的最小依赖 — 与生产同入口,只替换 Vault 与嵌入端口。 */
async function assembleWritable(
	indexRoot: string,
	config: IndexConfigDescriptor,
	embedding: FakeEmbeddingPort,
	vault: ReturnType<typeof createVault>,
) {
	return setupWritableIndexRuntime({
		indexRoot,
		config,
		configFingerprint: await computeConfigFingerprint(config),
		vault,
		embedding,
		getChunkOptions: () => T0_CHUNK_OPTIONS,
		chunkLimits: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
		expectedDimension: config.embeddingDimension,
	});
}

describe('索引运行时配置切换', () => {
	let root: string;
	/** 本用例装配出的写所有权 — `afterEach` 统一释放,失败路径也不留下锁。 */
	let leases: IndexWriteOwner[];
	/** 本用例装配出的协调器 — 停掉看护并销毁,避免定时器泄漏。 */
	let coordinators: Array<{ destroy(): void }>;
	let watchdogs: Array<{ stop(): void }>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-config-switch-'));
		leases = [];
		coordinators = [];
		watchdogs = [];
	});

	afterEach(async () => {
		// 关键路径:只清理本测试创建并记录的系统临时目录,不递归删除任何计算出来的未知路径。
		if (!root.startsWith(path.join(os.tmpdir(), 'ratel-config-switch-'))) throw new Error('测试目录归属不符');
		for (const watchdog of watchdogs.splice(0)) watchdog.stop();
		for (const coordinator of coordinators.splice(0)) coordinator.destroy();
		for (const lease of leases.splice(0)) {
			await lease.release().catch(() => undefined);
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	/**
	 * 场景 A1 — 会话内漂移检测的字段盲区(缺口复现)。
	 *
	 * `configIdentityOf` 只比模型 ID、维度、分块代数/大小/重叠;修订与嵌入文本模板不参与,
	 * 因此这两类变化在同一会话内不会被 `src/main.ts` 的同步比对发现,而它们**确实**改变配置指纹。
	 */
	it('会话内配置身份 - 模型修订或嵌入文本模板变化 - 身份串不变但配置指纹已变化（缺口复现）', async () => {
		const current = baseConfig();
		const revisionChanged = { ...current, embeddingModelRevision: 'revision-2' };
		const textTemplateChanged = { ...current, embeddingTextVersion: 'template-2' };

		// 反向对照:真正参与身份串的字段变化必须被识别。
		const modelChanged = { ...current, embeddingModelId: 'local:test-model-b' };
		const dimensionChanged = { ...current, embeddingDimension: DIMENSIONS + 1 };

		expect(await computeConfigFingerprint(revisionChanged)).not.toBe(await computeConfigFingerprint(current));
		expect(await computeConfigFingerprint(textTemplateChanged)).not.toBe(await computeConfigFingerprint(current));

		expect(configIdentityOf(revisionChanged)).toBe(configIdentityOf(current));
		expect(configIdentityOf(textTemplateChanged)).toBe(configIdentityOf(current));
		expect(configIdentityOf(modelChanged)).not.toBe(configIdentityOf(current));
		expect(configIdentityOf(dimensionChanged)).not.toBe(configIdentityOf(current));
	});

	/**
	 * 场景 A2 — 同一会话内配置指纹变化后再次装配。
	 *
	 * 当前实现的关闭点是**写所有权占用**,不是配置身份:旧会话仍持 lease 时,第二次装配在
	 * `IndexWriteOwner.acquire` 等待前任关闭超时后以 `predecessor-not-closed` 失败关闭 ——
	 * 只报占用、不抢写,也不新建第二套代际(因此不会产生两套混写)。
	 * 这也是缺口所在:装配层并不比较配置身份;若旧 lease 已释放,同一路径会被当作跨会话切换放行。
	 */
	it('同一会话内配置变化 - 旧会话仍持写所有权 - 再次装配以 predecessor-not-closed 失败关闭', async () => {
		const configA = baseConfig();
		const configB = baseConfig({ embeddingModelId: 'local:test-model-b' });
		const vault = createVault({});

		const first = await assembleWritable(root, configA, new FakeEmbeddingPort(DIMENSIONS), vault);
		leases.push(first.lease);
		coordinators.push(first.pipeline.coordinator);
		watchdogs.push(first.pipeline.stallWatchdog);
		// 关键路径:模拟首次建库已完成(无活动代际时的 upgrade 登记),使会话内确有旧活动代际。
		await first.generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		const activeBefore = (await first.generations.readControl()).activeGenerationId;
		expect(activeBefore).toBe(first.generationId);

		// 同一会话内配置指纹变化后再次装配 —— 当前真实行为是所有权占用失败关闭。
		await expect(
			assembleWritable(root, configB, new FakeEmbeddingPort(DIMENSIONS), vault),
		).rejects.toMatchObject({ code: 'predecessor-not-closed' });

		// 关键路径:接管尝试一开始就撤销了旧 epoch —— 旧装配立即不能再写(失败关闭),
		// 即使接管最终没成功。
		expect(captureThrow(() => first.lease.assertWritable())).toMatchObject({ code: 'epoch-revoked' });

		// 没有产生第二套代际:代际表只有旧活动代际,指针不动,目录也只有一个。
		const control = await first.generations.readControl();
		expect(control.activeGenerationId).toBe(first.generationId);
		expect(Object.keys(control.generations)).toEqual([first.generationId]);
		expect(fs.readdirSync(path.join(root, 'generations'))).toEqual([first.generationId]);
	}, 20_000);

	/**
	 * 场景 B — 跨会话换配置。
	 *
	 * 旧会话装配并登记代际 A 后释放写所有权;新会话以配置 B 装配:建立隔离代际 B、
	 * 保留旧代际目录与记录、活动指针不动。核对未完成前直接 `configured-switch` 被状态机
	 * 以 `switch-not-verified` 拒绝;核对完成(`markGenerationMigrated`)后由发布器切换,
	 * 旧代际降级为 `migrated` 且 `verifiedAt` 被清空,目录仍在。
	 */
	it('跨会话换配置 - 核对完成前拒绝切换 - 核对完成后切指针且旧代际目录保留', async () => {
		const configA = baseConfig();
		const configB = baseConfig({ embeddingModelId: 'local:test-model-b' });
		const vault = createVault({});

		// 会话一:首次装配并按 upgrade 登记为活动代际,随后释放写所有权(插件卸载/下次启动)。
		const sessionA = await assembleWritable(root, configA, new FakeEmbeddingPort(DIMENSIONS), vault);
		coordinators.push(sessionA.pipeline.coordinator);
		watchdogs.push(sessionA.pipeline.stallWatchdog);
		// 关键路径:先把存储的懒初始化落盘,否则快照会读到写了一半的 `catalog.json.tmp-*`。
		await sessionA.pipeline.store.init();
		await sessionA.generations.publishActiveGeneration({ generationId: sessionA.generationId, mode: 'upgrade' });
		const generationA = sessionA.generationId;
		const dirA = path.join(root, 'generations', generationA);
		expect(fs.existsSync(dirA)).toBe(true);
		const snapshotABefore = snapshotDir(dirA);
		await sessionA.lease.release();

		// 会话二:换配置后重新装配。
		const sessionB = await assembleWritable(root, configB, new FakeEmbeddingPort(DIMENSIONS), vault);
		leases.push(sessionB.lease);
		coordinators.push(sessionB.pipeline.coordinator);
		watchdogs.push(sessionB.pipeline.stallWatchdog);

		expect(sessionB.generationId).not.toBe(generationA);
		expect(sessionB.activeGenerationId).toBe(generationA);
		const afterSwitchAssembly = await sessionB.generations.readControl();
		expect(afterSwitchAssembly.activeGenerationId).toBe(generationA);
		expect(afterSwitchAssembly.generations[sessionB.generationId]).toMatchObject({
			status: 'building',
			verifiedAt: null,
		});
		// 旧代际目录与内容都保留,新代际目录已建立。
		expect(fs.existsSync(dirA)).toBe(true);
		expect(snapshotDir(dirA)).toEqual(snapshotABefore);

		// 核对完成前:直接切换必须被稳定错误码拒绝,指针不动。
		await expect(
			sessionB.generations.publishActiveGeneration({
				generationId: sessionB.generationId,
				mode: 'configured-switch',
			}),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		expect((await sessionB.generations.readControl()).activeGenerationId).toBe(generationA);

		// 切换完成前旧代际仍然可读(只读装配按旧配置完整成功)。
		const readOldWhileSwitching = await setupReadOnlyIndexRuntime({
			indexRoot: root,
			config: configA,
			configFingerprint: await computeConfigFingerprint(configA),
			vault,
		});
		expect(readOldWhileSwitching.indexDirUsable).toBe(true);
		expect(readOldWhileSwitching.activeGenerationId).toBe(generationA);

		// 模拟本轮核对完成:写入 verifiedAt 后再由生产发布器切换。
		await sessionB.generations.markGenerationMigrated({ generationId: sessionB.generationId });
		let activePointer = sessionB.activeGenerationId;
		const publisher = new GenerationActivationPublisher({
			getGenerations: () => sessionB.generations,
			getLease: () => sessionB.lease,
			getActiveGenerationId: () => activePointer,
			setActiveGenerationId: (generationId) => {
				activePointer = generationId;
			},
		});
		await publisher.publish(sessionB.generationId);

		const switched = await sessionB.generations.readControl();
		expect(switched.activeGenerationId).toBe(sessionB.generationId);
		expect(activePointer).toBe(sessionB.generationId);
		// 旧代际降级但数据保留:`verifiedAt` 被清空,目录仍在且逐字未变。
		expect(switched.generations[generationA]).toMatchObject({ status: 'migrated', verifiedAt: null });
		expect(fs.existsSync(dirA)).toBe(true);
		expect(snapshotDir(dirA)).toEqual(snapshotABefore);

		// 切换后:旧配置只读装配失败关闭,新配置可读。
		const readOldAfterSwitch = await setupReadOnlyIndexRuntime({
			indexRoot: root,
			config: configA,
			configFingerprint: await computeConfigFingerprint(configA),
			vault,
		});
		expect(readOldAfterSwitch.indexDirUsable).toBe(false);
		expect(readOldAfterSwitch.unavailableReason).toBe('config-mismatch');
		const readNewAfterSwitch = await setupReadOnlyIndexRuntime({
			indexRoot: root,
			config: configB,
			configFingerprint: await computeConfigFingerprint(configB),
			vault,
		});
		expect(readNewAfterSwitch.indexDirUsable).toBe(true);
		expect(readNewAfterSwitch.activeGenerationId).toBe(sessionB.generationId);
	});

	/**
	 * 场景 B2 — 发布器自证核对完成(缺口复现)。
	 *
	 * `GenerationActivationPublisher.publish` 会先 `markGenerationMigrated`(写入 `verifiedAt`),
	 * 再走 `configured-switch`,因此状态机的「必须有本轮核对标记」只挡得住绕过发布器的调用。
	 * 核心层没有「本轮核对真的发生过」的独立证据校验,时序完全依赖宿主只在 Ready 时调用。
	 */
	it('核对完成标记 - 发布器自行写入 - 未做任何核对也能切换指针（缺口复现）', async () => {
		const configA = baseConfig();
		const configB = baseConfig({ embeddingModelId: 'local:test-model-b' });
		const vault = createVault({});

		const sessionA = await assembleWritable(root, configA, new FakeEmbeddingPort(DIMENSIONS), vault);
		coordinators.push(sessionA.pipeline.coordinator);
		watchdogs.push(sessionA.pipeline.stallWatchdog);
		await sessionA.pipeline.store.init();
		await sessionA.generations.publishActiveGeneration({ generationId: sessionA.generationId, mode: 'upgrade' });
		await sessionA.lease.release();

		const sessionB = await assembleWritable(root, configB, new FakeEmbeddingPort(DIMENSIONS), vault);
		leases.push(sessionB.lease);
		coordinators.push(sessionB.pipeline.coordinator);
		watchdogs.push(sessionB.pipeline.stallWatchdog);
		// 前提:本轮没有任何核对 —— 新代际仍是 building、verifiedAt 为空。
		const before = await sessionB.generations.readControl();
		expect(before.generations[sessionB.generationId]).toMatchObject({ status: 'building', verifiedAt: null });

		let activePointer = sessionB.activeGenerationId;
		const publisher = new GenerationActivationPublisher({
			getGenerations: () => sessionB.generations,
			getLease: () => sessionB.lease,
			getActiveGenerationId: () => activePointer,
			setActiveGenerationId: (generationId) => {
				activePointer = generationId;
			},
		});
		await publisher.publish(sessionB.generationId);

		const after = await sessionB.generations.readControl();
		expect(after.activeGenerationId).toBe(sessionB.generationId);
		// verifiedAt 由发布器自己写入 —— 它不是核对的事实,只是发布动作的副作用。
		expect(after.generations[sessionB.generationId]?.verifiedAt).not.toBeNull();
	});

	/**
	 * 场景 C — 配置不匹配时的只读装配。
	 *
	 * 活动代际与请求配置指纹不一致时失败关闭:`indexDirUsable=false`、明确原因码
	 * `config-mismatch`,不构造检索存储/日志/可见性视图,也不读 Vault 正文。
	 */
	it('只读装配 - 配置指纹不匹配 - 失败关闭且不构造检索存储', async () => {
		const configA = baseConfig();
		const configB = baseConfig({ embeddingModelId: 'local:test-model-b' });
		const vault = createVault({ 'note.md': NOTE_CONTENT });

		const sessionA = await assembleWritable(root, configA, new FakeEmbeddingPort(DIMENSIONS), vault);
		coordinators.push(sessionA.pipeline.coordinator);
		watchdogs.push(sessionA.pipeline.stallWatchdog);
		await sessionA.pipeline.store.init();
		await sessionA.generations.publishActiveGeneration({ generationId: sessionA.generationId, mode: 'upgrade' });
		const generationA = sessionA.generationId;
		await sessionA.lease.release();
		const before = snapshotDir(root);

		const createStore = vi.fn();
		const readFile = vi.fn(async () => '');
		const runtime = await setupReadOnlyIndexRuntime({
			indexRoot: root,
			config: configB,
			configFingerprint: await computeConfigFingerprint(configB),
			vault: { listMarkdownFiles: () => ['note.md'], readFile, stat: () => ({ mtime: 1, size: 1 }) },
			createStore,
		});

		expect(runtime.indexDirUsable).toBe(false);
		expect(runtime.unavailableReason).toBe('config-mismatch');
		// 旧活动代际的身份仍如实返回,便于宿主说明「旧索引还在,只是与当前配置不兼容」。
		expect(runtime.activeGenerationId).toBe(generationA);
		expect(runtime.indexDir).toBe(path.join(root, 'generations', generationA));
		expect(runtime.store).toBeUndefined();
		expect(runtime.journal).toBeUndefined();
		expect(runtime.readOnlySearchView).toBeUndefined();
		expect(createStore).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
		expect(snapshotDir(root)).toEqual(before);
	});

	/**
	 * 场景 D — 切换后未修改文件是否重复嵌入(缺口复现)。
	 *
	 * 当前实现没有跨代际复用完成记录的钩子:新代际的日志里没有任何可复用记录,
	 * 同一篇逐字节未改的笔记会被重新嵌入一次。用例用可计数嵌入端口直接证明调用次数,
	 * 并用目录快照证明旧代际没有被新会话写入。
	 */
	it('切换配置后 - 未修改文件在新代际没有可复用记录 - 被重新嵌入一次（缺口复现）', async () => {
		const configA = baseConfig();
		const configB = baseConfig({ embeddingModelId: 'local:test-model-b' });
		const vault = createVault({ 'note.md': NOTE_CONTENT });
		const embedding = new FakeEmbeddingPort(DIMENSIONS);

		// 会话一:配置 A 下完成一轮索引,嵌入次数与完成记录都可观测。
		const sessionA = await assembleWritable(root, configA, embedding, vault);
		coordinators.push(sessionA.pipeline.coordinator);
		watchdogs.push(sessionA.pipeline.stallWatchdog);
		// 关键路径:先把建库的 `index.json` 落盘,避免它与真实文件事务的向量提交竞争。
		await sessionA.pipeline.store.init();
		await sessionA.generations.publishActiveGeneration({ generationId: sessionA.generationId, mode: 'upgrade' });
		await sessionA.pipeline.coordinator.start();
		const fingerprintA = await computeConfigFingerprint(configA);
		const receiptA = await sessionA.pipeline.journal.readReceipt('note.md');
		expect(receiptA?.configFingerprint).toBe(fingerprintA);
		expect(embedding.callCount).toBe(1);
		const dirA = path.join(root, 'generations', sessionA.generationId);
		const snapshotABefore = snapshotDir(dirA);
		await sessionA.lease.release();

		// 会话二:换配置重新装配;新代际没有任何可复用完成记录。
		const sessionB = await assembleWritable(root, configB, embedding, vault);
		leases.push(sessionB.lease);
		coordinators.push(sessionB.pipeline.coordinator);
		watchdogs.push(sessionB.pipeline.stallWatchdog);
		expect(await sessionB.pipeline.journal.readReceipt('note.md')).toBeNull();

		// 同一篇笔记内容完全未改,仍被重新嵌入一次 —— 当前实现没有跨代际复用钩子。
		await sessionB.pipeline.coordinator.start();
		expect(embedding.callCount).toBe(2);
		const fingerprintB = await computeConfigFingerprint(configB);
		expect((await sessionB.pipeline.journal.readReceipt('note.md'))?.configFingerprint).toBe(fingerprintB);
		// 旧代际的完成记录仍在,新会话没有写进旧代际目录。
		expect((await sessionA.pipeline.journal.readReceipt('note.md'))?.configFingerprint).toBe(fingerprintA);
		expect(snapshotDir(dirA)).toEqual(snapshotABefore);
	}, 30_000);
});

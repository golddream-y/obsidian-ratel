/**
 * @file tests/main-search-processor-lifecycle.test.ts
 * @description 入口生命周期对共享检索处理器的真实装配回归
 * @module tests/main-search-processor-lifecycle
 * @depends src/main, src/worker/handler, src/adapters/vector-vectra
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import RatelVaultPlugin from '../src/main';
import { InlineWorker } from '../src/worker/inline-worker';
import { handleMessage, setProcessorForTest } from '../src/worker/handler';
import { EmbeddingLocal } from '../src/adapters/embedding-local';
import type { EmbeddingPort } from '../src/ports/embedding';

// 关键路径:仅替代宿主与 Svelte 加载边界,保留真实入口、InlineWorker 和 handler。
vi.mock('obsidian', () => ({
	App: class {}, Plugin: class {}, PluginSettingTab: class {}, SettingPage: class {},
	Setting: class {}, Notice: class {}, WorkspaceLeaf: class {}, ItemView: class {},
	FileSystemAdapter: class {}, TFile: class {}, Modal: class {}, requestUrl: vi.fn(),
}));
vi.mock('worker_threads', () => ({
	Worker: class { on = vi.fn(); postMessage = vi.fn(); terminate = vi.fn(); }, workerData: {},
}));
vi.mock('../src/ui/chat/ChatView', () => ({ ChatView: class {}, VIEW_TYPE_CHAT: 'ratel-chat' }));
vi.mock('../src/ui/memory-panel/MemoryModal', () => ({
	MemoryModal: class {}, shouldCreateMemoryModal: (current: unknown) => current === null,
}));

const apiEmbedding: EmbeddingPort = {
	modelId: 'api:test', dimensions: 3,
	embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
};

function barePlugin(autoIndex: boolean): any {
	// 关键路径:跳过 Obsidian 构造器,补齐本次生命周期读取的实例状态。
	const plugin = Object.create(RatelVaultPlugin.prototype) as any;
	plugin.settings = { embedProvider: 'api', autoIndex, lastSeenRelease: '1.2.0' };
	plugin.manifest = { version: '1.2.0' };
	plugin.indexUnavailable = null;
	plugin.indexDirUsable = true;
	plugin.embedding = apiEmbedding;
	plugin.inlineWorker = new InlineWorker();
	plugin.workerManager = { clearProgressCallback: vi.fn(), setProgressCallback: vi.fn() };
	plugin.indexController = { onLayoutReady: vi.fn(async () => null) };
	plugin.userNotice = { toastError: vi.fn() };
	return plugin;
}

async function query() {
	return handleMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 } });
}

describe('共享检索处理器生命周期', () => {
	afterEach(() => { setProcessorForTest(null); vi.restoreAllMocks(); });

	it.each([true, false])('API 启动 - autoIndex=%s 且 store 可用 - 真实 handler 返回既有文档且不写盘', async (autoIndex) => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-search-lifecycle-'));
		const plugin = barePlugin(autoIndex);
		try {
			// 夹具写入发生在启动快照之前;启动阶段使用生产工厂的 autoInit:false 实例。
			const writer = plugin.createVectraStore(false, root);
			await writer.beginFileUpdate();
			await writer.upsertItem('kept.md', [1, 0, 0], { path: 'kept.md', chunkIndex: 0 });
			await writer.endFileUpdate();
			const before = await fsp.readFile(path.join(root, 'index.json'));
			const entries = await fsp.readdir(root);
			plugin.vectraStore = plugin.createVectraStore(false, root);
			setProcessorForTest(null);
			plugin.indexController.onLayoutReady = vi.fn(async () => {
				// 必须在启动索引控制器之前可查询,避免 NULL_PROCESSOR 被上层当成空结果。
				expect(await query()).toMatchObject({
					type: 'vector.search.result', payload: [{ docId: 'kept.md' }],
				});
				return null;
			});
			await plugin.onLayoutReady();
			expect(plugin.indexController.onLayoutReady).toHaveBeenCalledWith(autoIndex);
			expect(await fsp.readFile(path.join(root, 'index.json'))).toEqual(before);
			expect(await fsp.readdir(root)).toEqual(entries);
		} finally {
			plugin.inlineWorker.terminate();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	it('本地启动 - 模型代理尚在预热 - 预热完成后才装配且使用代理端口', async () => {
		const plugin = barePlugin(false);
		plugin.settings.embedProvider = 'local';
		plugin.embedding = new EmbeddingLocal();
		const events: string[] = [];
		const search = vi.fn(async () => []);
		plugin.vectraStore = { search };
		plugin.modelManager = {
			download: vi.fn(async () => { events.push('download'); }),
			getVocabContent: () => null,
			getEmbedding: () => apiEmbedding,
		};
		plugin.feedbackController = { notifyEmbeddingReady: vi.fn() };
		let release!: () => void;
		plugin.initEmbeddingWorkerProxy = vi.fn(async () => {
			events.push('warmup');
			await new Promise<void>(resolve => { release = resolve; });
			plugin.embeddingWorkerProxy = apiEmbedding;
			events.push('ready');
		});
		const init = vi.spyOn(plugin.inlineWorker, 'initWithStore');
		const starting = plugin.onLayoutReady();
		try {
			await vi.waitFor(() => expect(events).toContain('warmup'));
			expect(init).not.toHaveBeenCalled();
			release();
			await starting;
			expect(events).toEqual(['download', 'warmup', 'ready']);
			expect(init).toHaveBeenCalledExactlyOnceWith(plugin.vectraStore, apiEmbedding);
			expect(await query()).toEqual({ type: 'vector.search.result', payload: [] });
			expect(search).toHaveBeenCalled();
		} finally { plugin.inlineWorker.terminate(); }
	});

	it('重试启动轮次 - store 已替换 - handler 查询重新绑定的同一个存储', async () => {
		const plugin = barePlugin(false);
		const oldSearch = vi.fn(async () => []);
		const newSearch = vi.fn(async () => []);
		try {
			plugin.vectraStore = { search: oldSearch };
			await plugin.startIndexRound(false);
			await query();
			plugin.vectraStore = { search: newSearch };
			await plugin.startIndexRound(false);
			await query();
			expect(oldSearch).toHaveBeenCalledTimes(1);
			expect(newSearch).toHaveBeenCalledTimes(1);
		} finally { plugin.inlineWorker.terminate(); }
	});

	it('只读启动 - 无活动代际 - 不初始化共享处理器或构造存储', async () => {
		const plugin = barePlugin(false);
		plugin.indexDirUsable = false;
		const init = vi.spyOn(plugin.inlineWorker, 'initWithStore');
		const create = vi.spyOn(plugin, 'createVectraStore');
		setProcessorForTest(null);
		try {
			await plugin.onLayoutReady();
			expect(init).not.toHaveBeenCalled();
			expect(create).not.toHaveBeenCalled();
			expect(await query()).toMatchObject({ type: 'error', payload: { code: 'NULL_PROCESSOR' } });
		} finally { plugin.inlineWorker.terminate(); }
	});
});

describe('嵌入端口的 Worker 代理时序', () => {
	it('装配早于代理创建 - embed 仍走后创建的代理 - 不退化到本体', async () => {
		const plugin = barePlugin(false) as any;
		const localCalls: string[][] = [];
		const proxyCalls: string[][] = [];
		plugin.embedding = {
			modelId: 'local:onnx', dimensions: 3,
			embed: async (texts: string[]) => { localCalls.push(texts); return texts.map(() => [0, 0, 1]); },
		};
		plugin.embeddingWorkerProxy = undefined;

		// 关键路径:先在代理尚未创建时取端口(模拟 onload 装配),之后才注入代理。
		const port = plugin.effectiveEmbedding();
		expect(port.dimensions).toBe(3);
		plugin.embeddingWorkerProxy = {
			modelId: 'proxy:worker', dimensions: 3,
			embed: async (texts: string[]) => { proxyCalls.push(texts); return texts.map(() => [1, 0, 0]); },
		};

		const result = await port.embed(['a', 'b']);
		expect(result).toEqual([[1, 0, 0], [1, 0, 0]]);
		expect(proxyCalls).toEqual([['a', 'b']]);
		expect(localCalls).toEqual([]);
	});

	it('代理始终未创建 - 回退本体 - 不吞掉调用', async () => {
		const plugin = barePlugin(false) as any;
		const seen: string[][] = [];
		plugin.embedding = {
			modelId: 'local', dimensions: 3,
			embed: async (texts: string[]) => { seen.push(texts); return texts.map(() => [0, 0, 1]); },
		};
		plugin.embeddingWorkerProxy = undefined;
		const port = plugin.effectiveEmbedding();
		expect(await port.embed(['x'])).toEqual([[0, 0, 1]]);
		expect(seen).toEqual([['x']]);
	});
});

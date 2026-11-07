/**
 * @file tests/adapters/embedding-port-contract.test.ts
 * @description EmbeddingPort 实现清单守卫 — 枚举实现类并逐类证据化 options 转发
 * @module tests/adapters/embedding-port-contract
 * @depends ports/embedding, adapters/embedding-*
 *
 * 关键路径(为什么需要这条守卫):
 * 端口第二参 `options?: EmbedOptions` 是**可选**的,实现类漏掉它(或声明了却不在
 * 关键路径上转发)时 `tsc` 完全抓不到 —— 少写参数仍满足接口,取消与批次活动会在
 * 该通道上静默消失。因此这里用三层守卫把「新增实现类忘记转发」变成测试失败:
 * 1. 源码枚举:`implements EmbeddingPort` 的类清单必须与登记清单一致;
 * 2. 签名断言:每个实现的 `embed` 声明必须保留类型为 `EmbedOptions` 的第二参;
 * 3. 行为探针:每个实现都必须在该清单里登记一条真实驱动到下游边界的转发探针。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 关键路径:EmbeddingApi 通过 obsidian requestUrl 发请求,守卫里必须 mock 掉,
// 否则探针会真的发 HTTP。
const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl: mockRequestUrl }));

import { EmbeddingApi } from '../../src/adapters/embedding-api';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';
import { EmbeddingOnnx } from '../../src/adapters/embedding-onnx';
import { EmbeddingWorkerProxy } from '../../src/adapters/embedding-worker-proxy';
import type { EmbedOptions } from '../../src/core/index-persistence-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../src');
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/bge-small-zh-v1.5');
const WASM_PATH = path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm');

/**
 * EmbeddingPort 的实现清单 — 新增实现类时必须在此登记,并补齐下面的转发探针。
 *
 * 关键路径:这是「人肉注册表 + 自动核对」的组合:清单本身由第 1 条守卫对着源码核对,
 * 探针由第 3 条守卫逐条执行,所以漏登记或只登记不写探针都会失败。
 */
const EXPECTED_IMPLEMENTATIONS = [
	'EmbeddingApi',
	'EmbeddingLocal',
	'EmbeddingOnnx',
	'EmbeddingWorkerProxy',
] as const;

/** 递归收集 src 下的 .ts 文件。 */
function listSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			files.push(...listSourceFiles(full));
		} else if (entry.endsWith('.ts')) {
			files.push(full);
		}
	}
	return files;
}

interface ImplementationSite {
	name: string;
	relativeFile: string;
	source: string;
}

/** 按 `export class X ... implements EmbeddingPort` 枚举实现类。 */
function collectImplementations(): ImplementationSite[] {
	const sites: ImplementationSite[] = [];
	for (const file of listSourceFiles(SRC_DIR)) {
		const source = readFileSync(file, 'utf-8');
		const pattern = /export\s+class\s+(\w+)\b[^{]*\bimplements\b[^{]*\bEmbeddingPort\b/g;
		for (const match of source.matchAll(pattern)) {
			sites.push({ name: match[1]!, relativeFile: path.relative(SRC_DIR, file), source });
		}
	}
	return sites;
}

/** 截取某个类在文件中的源码片段(到下一个顶层导出为止)。 */
function classSource(source: string, name: string): string {
	const start = source.search(new RegExp(`export\\s+class\\s+${name}\\b`));
	if (start < 0) throw new Error(`源码中未找到类 ${name}`);
	const rest = source.slice(start + 1);
	const next = rest.search(/\nexport\s+(class|function|interface|const|type|abstract)\b/);
	return next < 0 ? rest : rest.slice(0, next);
}

/** 断言某实现的 `embed` 声明保留了 `EmbedOptions` 类型的第二参。 */
function embedSignature(source: string, name: string): string {
	return classSource(source, name).match(/async\s+embed\s*\(([^)]*)\)/)?.[1] ?? '';
}

/** 最小的可注入推理替身 — 只用于守卫探针的观察点,不改变生产语义。 */
class ProbeWorker {
	readonly posted: unknown[] = [];
	private messageListeners: Array<(event: { data: unknown }) => void> = [];

	postMessage = (data: unknown): void => {
		this.posted.push(data);
		const msg = data as { type: string };
		if (msg.type === 'init') {
			queueMicrotask(() => this.emit({ type: 'ready' }));
		}
	};

	addEventListener = (event: string, listener: (event: unknown) => void): void => {
		if (event === 'message') this.messageListeners.push(listener as (event: { data: unknown }) => void);
	};

	removeEventListener = (): void => {};

	terminate = (): void => {};

	emit(data: unknown): void {
		for (const listener of [...this.messageListeners]) listener({ data });
	}
}

/**
 * 转发探针 — 每个实现的 embed 都必须把 options 送抵它真正的下游边界。
 *
 * 关键路径:探针观察的是**下游边界**(内层实现收到的对象 / HTTP 是否发出 /
 * 真实推理是否按批次回报 / Worker 消息),不是「方法有没有被调用」这类近似断言。
 */
const FORWARDING_PROBES: Record<string, () => Promise<void>> = {
	EmbeddingLocal: async () => {
		// 关键路径:显式声明与端口同形的参数,让 mock.calls 保留第二参的类型信息。
		const innerEmbed = vi.fn(
			async (_texts: string[], _options?: EmbedOptions): Promise<number[][]> => [[1]],
		);
		const local = new EmbeddingLocal();
		local.setEmbedding({ modelId: 'local:probe', dimensions: 1, embed: innerEmbed });
		const controller = new AbortController();
		const onBatchComplete = vi.fn();

		await local.embed(['探针'], {
			signal: controller.signal,
			onBatchComplete: (done, total) => onBatchComplete(done, total),
		});

		expect(innerEmbed).toHaveBeenCalledTimes(1);
		const forwarded = innerEmbed.mock.calls[0]![1] as
			| { signal?: AbortSignal; onBatchComplete?: unknown }
			| undefined;
		// 关键路径:必须是同一个选项对象透传,而不是「内层碰巧也被调了一次」。
		expect(forwarded?.signal).toBe(controller.signal);
		expect(forwarded?.onBatchComplete).toBeDefined();
	},

	EmbeddingApi: async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
		});
		const api = new EmbeddingApi({ apiBase: 'http://probe', apiKey: '', model: 'probe', dimensions: 4 });
		const batches: Array<[number, number]> = [];
		await api.embed(['探针'], { onBatchComplete: (done, total) => batches.push([done, total]) });
		expect(batches).toEqual([[1, 1]]);

		// 发出了请求之后才能证明「发请求前检查 signal」这条通道真的接上了。
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const abortedController = new AbortController();
		abortedController.abort();
		mockRequestUrl.mockClear();
		await expect(api.embed(['探针'], { signal: abortedController.signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(mockRequestUrl).not.toHaveBeenCalled();
	},

	EmbeddingOnnx: async () => {
		const [modelBuffer, wasmBuffer, vocabContent] = [
			readFileSync(path.join(FIXTURE_DIR, 'model_quantized.onnx')),
			readFileSync(WASM_PATH),
			readFileSync(path.join(FIXTURE_DIR, 'vocab.txt'), 'utf-8'),
		];
		const onnx = new EmbeddingOnnx(
			{
				vocabContent,
				modelBuffer: new Uint8Array(modelBuffer).buffer,
				wasmBinary: new Uint8Array(wasmBuffer).buffer,
			},
			512,
			16,
		);
		await onnx.init();

		const batches: Array<[number, number]> = [];
		await onnx.embed(['探针'], { onBatchComplete: (done, total) => batches.push([done, total]) });
		expect(batches).toEqual([[1, 1]]);

		const abortedController = new AbortController();
		abortedController.abort();
		await expect(onnx.embed(['探针'], { signal: abortedController.signal })).rejects.toMatchObject({ name: 'AbortError' });
	},

	EmbeddingWorkerProxy: async () => {
		const originalWorker = (globalThis as { Worker?: unknown }).Worker;
		const created: ProbeWorker[] = [];
		(globalThis as { Worker?: unknown }).Worker = class {
			constructor() {
				const worker = new ProbeWorker();
				created.push(worker);
				return worker;
			}
		};
		try {
			const proxy = new EmbeddingWorkerProxy(
				'probe-url',
				{ vocabContent: '', modelBuffer: new ArrayBuffer(8), wasmBinary: new ArrayBuffer(8) },
				4,
			);
			try {
				const batches: Array<[number, number]> = [];
				const pending = proxy.embed(['a', 'b'], { onBatchComplete: (done, total) => batches.push([done, total]) });
				await vi.waitFor(() => expect(created.length).toBe(1));
				const worker = created[0]!;
				let requestId = '';
				await vi.waitFor(() => {
					const embedMsg = worker.posted.find((m) => (m as { type: string }).type === 'embed');
					expect(embedMsg).toBeDefined();
					requestId = (embedMsg as { requestId: string }).requestId;
				});
				// 关键路径:进度由 Worker 消息驱动 —— 能收到说明 onBatchComplete 真的转发到了下游。
				worker.emit({ type: 'embed:progress', requestId, done: 1, total: 2 });
				worker.emit({ type: 'embed:result', requestId, vectors: [[0.1], [0.2]] });
				await expect(pending).resolves.toEqual([[0.1], [0.2]]);
				expect(batches).toEqual([[1, 2]]);

				const abortedController = new AbortController();
				abortedController.abort();
				const before = created.length;
				await expect(proxy.embed(['c'], { signal: abortedController.signal })).rejects.toMatchObject({ name: 'AbortError' });
				expect(created.length).toBe(before);
			} finally {
				proxy.terminate();
			}
		} finally {
			(globalThis as { Worker?: unknown }).Worker = originalWorker;
		}
	},
};

describe('WebGPU 后端不改写模型身份', () => {
	// 关键路径(S-WEBGPU-EMBEDDING 硬约束 1):后端开关不得改变 embeddingModelId,
	// 否则配置指纹变化,1.4.0 的索引会被全量重建。
	it('启用 WebGPU 后端 - modelId 与维度不变', () => {
		const emb = new EmbeddingOnnx({
			vocabContent: '',
			modelBuffer: new ArrayBuffer(0),
			wasmBinary: new ArrayBuffer(0),
			enableWebgpu: true,
			glueSource: 'inline-jsep-glue',
		});
		expect(emb.modelId).toBe('local:bge-small-zh-v1.5');
		expect(emb.dimensions).toBe(512);
	});
});

describe('EmbeddingPort 实现清单守卫', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('源码中 implements EmbeddingPort 的类 - 与登记清单完全一致', () => {
		const discovered = collectImplementations().map((site) => site.name);
		// 关键路径:新增/删除实现类必须同步本清单 —— 清单变了但探针没补,下面的用例会失败。
		expect(discovered.sort()).toEqual([...EXPECTED_IMPLEMENTATIONS].sort());
	});

	it.each(EXPECTED_IMPLEMENTATIONS)('%s - embed 声明保留类型为 EmbedOptions 的第二参', (name) => {
		const sites = collectImplementations().filter((site) => site.name === name);
		expect(sites).toHaveLength(1);
		const signature = embedSignature(sites[0]!.source, name);
		// 关键路径:少写第二参仍满足 EmbeddingPort,tsc 抓不到 —— 这里按声明文本兜底,
		// 保证「忘记接收 options」在签名层就被挡住。
		expect(signature, `${name}.embed 缺少 options?: EmbedOptions 第二参`).toMatch(
			/,\s*\w+\s*\?\s*:\s*EmbedOptions/,
		);
	});

	it.each(EXPECTED_IMPLEMENTATIONS)('%s - options 已登记转发探针且探针通过', async (name) => {
		const probe = FORWARDING_PROBES[name];
		// 关键路径:新增实现类只改枚举清单(不写探针)必须失败,不能靠清单登记充当证据。
		expect(probe, `新增实现类 ${name} 必须在 FORWARDING_PROBES 登记 options 转发探针`).toBeDefined();
		await probe!();
	});
});
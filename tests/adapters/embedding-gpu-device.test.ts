/**
 * @file tests/adapters/embedding-gpu-device.test.ts
 * @description 验证 WebGPU 会话由 ORT 创建设备，设备丢失监听仅作尽力观察。
 * @module tests/adapters/embedding-gpu-device
 * @depends src/adapters/embedding-onnx, vitest
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ort from 'onnxruntime-web';
import { EmbeddingOnnx } from '../../src/adapters/embedding-onnx';
import { devLogger } from '../../src/logging/dev-logger';

vi.mock('onnxruntime-web', () => ({
	env: { wasm: {}, webgpu: {} },
	Tensor: vi.fn(),
	InferenceSession: { create: vi.fn() },
}));

function createEmbedding(onGpuDeviceLost = vi.fn(), enableWebgpu = true): EmbeddingOnnx {
	return new EmbeddingOnnx({
		vocabContent: '[PAD]\n[UNK]\n[CLS]\n[SEP]\n[MASK]',
		modelBuffer: new ArrayBuffer(0),
		wasmBinary: new ArrayBuffer(0),
		enableWebgpu,
		onGpuDeviceLost,
	});
}

function observeDevice(read: () => unknown) {
	const get = vi.fn(() => {
		expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
		return read();
	});
	const set = vi.fn();
	Object.defineProperty(ort.env.webgpu, 'device', { configurable: true, get, set });
	return { get, set };
}

describe('EmbeddingOnnx GPU 设备', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(ort.InferenceSession.create).mockResolvedValue({} as ort.InferenceSession);
		vi.spyOn(devLogger, 'info').mockImplementation(() => undefined);
		vi.spyOn(devLogger, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(ort.env.webgpu, 'device');
	});

	it('创建会话 - 浏览器支持 GPU - 不请求或注入自建设备且选择默认 WebGPU EP', async () => {
		const requestDevice = vi.fn().mockResolvedValue({ lost: new Promise(() => undefined) });
		const requestAdapter = vi.fn().mockResolvedValue({ requestDevice });
		vi.stubGlobal('navigator', { gpu: { requestAdapter, requestDevice } });
		const observer = observeDevice(() => ({ lost: new Promise(() => undefined) }));

		await createEmbedding().init();

		expect(requestAdapter).not.toHaveBeenCalled();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(observer.set).not.toHaveBeenCalled();
		expect(observer.get).toHaveBeenCalledTimes(1);
		expect(ort.InferenceSession.create).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
			executionProviders: ['webgpu'], logSeverityLevel: 3,
		});
	});

	it.each(['value', 'promise'] as const)('监听丢失 - ORT 返回设备形式为 %s - 回报该设备的原因', async (form) => {
		let lose!: (info: { reason: string; message: string }) => void;
		const device = { lost: new Promise<{ reason: string; message: string }>((resolve) => { lose = resolve; }) };
		const observer = observeDevice(() => form === 'value' ? device : Promise.resolve(device));
		const onLost = vi.fn();
		await createEmbedding(onLost).init();
		expect(onLost).not.toHaveBeenCalled();

		lose({ reason: 'destroyed', message: '测试设备丢失' });
		await device.lost;

		expect(observer.get).toHaveBeenCalledTimes(1);
		expect(onLost).toHaveBeenCalledExactlyOnceWith('destroyed:测试设备丢失');
	});

	it.each(['missing', 'no-lost', 'throws', 'rejects'] as const)('监听设备 - 观察不可用为 %s - 警告但保留有效会话', async (condition) => {
		observeDevice(() => {
			if (condition === 'throws') throw new Error('设备 getter 不可用');
			if (condition === 'rejects') return Promise.reject(new Error('设备读取失败'));
			return condition === 'missing' ? undefined : {};
		});
		const embedding = createEmbedding();

		await expect(embedding.init()).resolves.toBeUndefined();
		await expect(embedding.embed([])).resolves.toEqual([]);
		expect(devLogger.warn).toHaveBeenCalledWith('index', expect.stringContaining('监听'), expect.anything());
		expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
	});

	it('创建会话 - 未启用 GPU - 选择 WASM 且不读取 GPU 设备', async () => {
		const observer = observeDevice(() => { throw new Error('不应读取 GPU'); });

		await createEmbedding(vi.fn(), false).init();

		expect(observer.get).not.toHaveBeenCalled();
		expect(ort.InferenceSession.create).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
			executionProviders: ['wasm'], logSeverityLevel: 3,
		});
	});
});

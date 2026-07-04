/**
 * @file tests/helpers/mock-ort-assets.ts
 * @description 测试用 OrtRuntimeAssets mock
 */

import { vi } from 'vitest';
import type { OrtRuntimeAssets } from '../../src/core/ort-runtime-assets';

export function createMockOrtAssets(): OrtRuntimeAssets {
	return {
		wasmPath: '/tmp/ort-wasm-simd-threaded.wasm',
		ensureWasm: vi.fn().mockResolvedValue(undefined),
		readWasmBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
	} as unknown as OrtRuntimeAssets;
}

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	// 关键路径:vitest 在 Node 环境下会命中 onnxruntime-web 的 Node 入口,
	// 该入口的 worker 模块路径与 npm 包实际结构不兼容,导致端到端测试加载 wasm 失败。
	// 这里强制测试使用 wasm bundle 入口(与 Obsidian 渲染进程一致且 wasm 内联),确保本地 Embedding 链路可验证。
	resolve: {
		alias: {
			'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
		},
	},
	test: {
		// 关键路径:tests/integration 会真实下载模型并跑 ONNX 推理,依赖网络与 wasm,
		// 默认 npm test 不运行,避免 CI 不稳定;本地手动验证时用 --config 或显式指定路径。
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/integration/**'],
		environment: 'node',
		passWithNoTests: true,
	},
});

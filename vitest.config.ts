import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	// 关键路径:vitest 在 Node 环境下会命中 onnxruntime-web 的 Node 入口,
	// 该入口的 worker 模块路径与 npm 包实际结构不兼容,导致端到端测试加载 wasm 失败。
	// 这里强制测试使用 wasm bundle 入口(与 Obsidian 渲染进程一致且 wasm 内联),确保本地 Embedding 链路可验证。
	resolve: {
		alias: {
			'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
			'@ratel/embedding-worker-code': path.resolve(
				__dirname,
				'tests/helpers/embedding-worker-code-stub.ts',
			),
			// 关键路径:esbuild 虚拟模块(内置 skill 清单)在 vitest 无构建期注入,指向空清单 stub;
			// 导入 main.ts 的测试(settings-adapter / main-rag-loop 等)只关心装配,不依赖内置 skill 内容。
			'@ratel/builtin-skills-code': path.resolve(
				__dirname,
				'tests/helpers/builtin-skills-code-stub.ts',
			),
			// 关键路径:obsidian 包在 Node 测试环境无法解析(package.json 无 main/exports),
			// 指向最小桩模块,具体行为由各测试用 vi.mock 或 spy 覆盖。
			obsidian: path.resolve(__dirname, 'tests/helpers/obsidian-mock.ts'),
		},
	},
	test: {
		// 关键路径:tests/integration 会真实下载模型并跑 ONNX 推理,依赖网络与 wasm,
		// 默认 npm test 不运行,避免 CI 不稳定;本地手动验证时用 --config 或显式指定路径。
		// 关键路径:src/skills 与 src/tools 下的测试与源码同目录放置,便于查阅;此处显式纳入。
		include: ['tests/**/*.test.ts', 'src/i18n/**/*.test.ts', 'src/skills/**/*.test.ts', 'src/tools/**/*.test.ts'],
		exclude: ['tests/integration/**'],
		environment: 'node',
		passWithNoTests: true,
		// 关键路径:源码为兼容 Obsidian popout 窗口统一用 `window.setTimeout` / `activeDocument`,
		// Node 测试环境无这些全局,setupFiles 阶段补齐指向 globalThis。
		setupFiles: ['./tests/helpers/global-polyfill.ts'],
	},
});

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	// 与 esbuild 对齐:测试环境不注入实验入口,避免缺失构建期常量。
	define: { __RATEL_INDEX_EXPERIMENT__: 'false' },
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
			// 关键路径:esbuild 虚拟模块(skill 脚本沙箱 Worker)在 vitest 无构建期注入,
			// 指向空 stub;导入 main.ts 的测试只关心装配,不执行真实脚本。
			'@ratel/skill-script-worker-code': path.resolve(
				__dirname,
				'tests/helpers/skill-script-worker-code-stub.ts',
			),
			// 关键路径:索引线程 Worker 代码同样是构建期虚拟模块;测试里给空实现,
			// 需要真实线程的验证必须在宿主内进行,不能靠 Node 测试冒充。
			'@ratel/index-runtime-worker-code': path.resolve(
				__dirname,
				'tests/helpers/index-runtime-worker-code-stub.ts',
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
		// 默认 npm test 不运行,避免 CI 不稳定。
		// 注意:`exclude` **优先于**命令行路径过滤 —— 被排除的文件即便显式传给 vitest 也只会得到
		// "No test files found"(叠加 passWithNoTests 后静默 exit 0)。因此需要手动验证的排除项
		// 一律由环境变量门控,而不是无条件排除。
		// 关键路径:src/skills、src/tools 与 src/core 下的测试与源码同目录放置,便于查阅;此处显式纳入。
		// 修复(S-VISION):补 src/ports 与 src/ui —— include 缺失时显式路径会被过滤成
		// "No test files found",叠加 passWithNoTests 吞成 exit 0(静默假绿)。
		include: ['tests/**/*.test.ts', 'src/i18n/**/*.test.ts', 'src/skills/**/*.test.ts', 'src/tools/**/*.test.ts', 'src/core/**/*.test.ts', 'src/ports/**/*.test.ts', 'src/ui/**/*.test.ts', 'src/logging/**/*.test.ts'],
		exclude: [
			'tests/integration/**',
			// 关键路径(T7 门禁):T5 追加的真实 ONNX 推理用例不在默认套件内 ——
			// 夹具 tests/fixtures/bge-small-zh-v1.5/model_quantized.onnx(23M)已被 git 跟踪,
			// 默认套件会真跑 ORT 会话初始化与推理,而默认 5s 超时对真实 ONNX 从来不够。
			// 关键路径:排除项由 `RATEL_ONNX=1` 解除,而不是无条件排除 —— 见上方 exclude 优先于
			// 路径过滤的说明;门控后的运行方式写在 tests/adapters/embedding-onnx.test.ts 文件头。
			...(process.env.RATEL_ONNX === '1' ? [] : ['tests/adapters/embedding-onnx.test.ts']),
		],
		environment: 'node',
		passWithNoTests: true,
		// 关键路径:源码为兼容 Obsidian popout 窗口统一用 `window.setTimeout` / `activeDocument`,
		// Node 测试环境无这些全局,setupFiles 阶段补齐指向 globalThis。
		setupFiles: ['./tests/helpers/global-polyfill.ts'],
	},
});

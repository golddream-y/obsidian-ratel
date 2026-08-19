import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';
import esbuildSvelte from 'esbuild-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const EMBEDDING_WORKER_OUT = path.resolve(__dirname, 'dist/embedding-worker.js');
const SKILL_SCRIPT_WORKER_OUT = path.resolve(__dirname, 'dist/skill-script-worker.js');

// 内置 Skill 源目录 — 直接子目录 + SKILL.md,与 SkillFsAdapter 扫描契约一致
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, 'src/skills/builtin');

/**
 * 将 dist/embedding-worker.js 内容作为字符串常量注入 main.js(ADR-006)。
 * 商店 release 只含 main.js,运行时通过 Blob URL 加载 Worker。
 */
function inlineEmbeddingWorkerPlugin() {
	return {
		name: 'inline-embedding-worker',
		setup(build) {
			build.onResolve({ filter: /^@ratel\/embedding-worker-code$/ }, () => ({
				path: '@ratel/embedding-worker-code',
				namespace: 'ratel-embedding-worker',
			}));
			build.onLoad({ filter: /.*/, namespace: 'ratel-embedding-worker' }, () => {
				let code = '';
				if (existsSync(EMBEDDING_WORKER_OUT)) {
					code = readFileSync(EMBEDDING_WORKER_OUT, 'utf-8');
				}
				return {
					contents: `export const EMBEDDING_WORKER_CODE = ${JSON.stringify(code)};\n`,
					loader: 'js',
				};
			});
		},
	};
}

/**
 * 将 dist/skill-script-worker.js 内容作为字符串常量注入 main.js(ADR-017)。
 * 商店 release 只有 main.js 三文件,运行时 new Worker(code, { eval: true })。
 */
function inlineSkillScriptWorkerPlugin() {
	return {
		name: 'inline-skill-script-worker',
		setup(build) {
			build.onResolve({ filter: /^@ratel\/skill-script-worker-code$/ }, () => ({
				path: '@ratel/skill-script-worker-code',
				namespace: 'ratel-skill-script-worker',
			}));
			build.onLoad({ filter: /.*/, namespace: 'ratel-skill-script-worker' }, () => {
				// 关键路径:首次 build 时 dist 尚无产物,注入空串;prod 流程先 rebuild 本 worker(见下方时序)
				let code = '';
				if (existsSync(SKILL_SCRIPT_WORKER_OUT)) {
					code = readFileSync(SKILL_SCRIPT_WORKER_OUT, 'utf-8');
				}
				return {
					contents: `export const SKILL_SCRIPT_WORKER_CODE = ${JSON.stringify(code)};\n`,
					loader: 'js',
				};
			});
		},
	};
}

/**
 * 将 src/skills/builtin 下各 skill 目录内的 SKILL.md 与 manifest version 内联进 main.js。
 * 商店 release 只有 main.js 三文件,内置 skill 靠运行时落盘分发(ADR-006 同思路)。
 */
function inlineBuiltinSkillsPlugin() {
	return {
		name: 'inline-builtin-skills',
		setup(build) {
			build.onResolve({ filter: /^@ratel\/builtin-skills-code$/ }, () => ({
				path: '@ratel/builtin-skills-code',
				namespace: 'ratel-builtin-skills',
			}));
			build.onLoad({ filter: /.*/, namespace: 'ratel-builtin-skills' }, () => {
				const skills = {};
				if (existsSync(BUILTIN_SKILLS_DIR)) {
					for (const entry of readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })) {
						if (!entry.isDirectory()) continue;
						const skillMd = path.join(BUILTIN_SKILLS_DIR, entry.name, 'SKILL.md');
						if (existsSync(skillMd)) {
							skills[entry.name] = readFileSync(skillMd, 'utf-8');
						}
					}
				}
				const manifest = JSON.parse(readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf-8'));
				return {
					contents:
						`export const BUILTIN_SKILLS = ${JSON.stringify(skills)};\n` +
						`export const APP_VERSION = ${JSON.stringify(manifest.version)};\n`,
					loader: 'js',
				};
			});
		},
	};
}

/**
 * 将 onnxruntime-node / @huggingface/transformers 整体替换为空模块,
 * 防止 Node 原生模块被打包进浏览器产物。
 *
 * 关键路径:
 * - Obsidian 渲染进程禁止加载 .node 原生模块;onnxruntime-web 的 Node 回退会引入 onnxruntime-node。
 * - 仅靠 `external` 配置无法拦截包内相对路径(如 `./binding`),需要用 onResolve/onLoad 兜底。
 * - 该插件同时用于主线程与 Worker,防止 vectra 等依赖意外把原生模块带进来。
 * - onnxruntime-web 的入口由顶层 alias 强制指向 wasm bundle,不在本插件中处理。
 */
function externalOnnxruntimeNodePlugin() {
	const emptyModulePath = path.resolve(__dirname, 'src/adapters/empty-module.cjs');
	const emptyTransformersPath = path.resolve(__dirname, 'src/adapters/empty-transformers.cjs');
	const emptyContents = 'module.exports = {};\n';

	return {
		name: 'external-onnxruntime-node',
		setup(build) {
			// 关键路径:任何包含 onnxruntime-node 的导入路径(包括子路径如 onnxruntime-node/dist/binding)
			// 全部替换为空模块,阻止 esbuild 继续解析包内文件。
			build.onResolve({ filter: /onnxruntime-node/ }, () => ({
				path: emptyModulePath,
			}));

			// 关键路径:包内相对导入(如 ./binding)的 path 不含 onnxruntime-node,
			// 但 importer 在该包目录下,此时同样替换为空模块。
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.importer && args.importer.includes('node_modules/onnxruntime-node')) {
					return { path: emptyModulePath };
				}
			});

			// 关键路径:vectra 的 LocalEmbeddings/TransformersEmbeddings 依赖 @huggingface/transformers,
			// 本项目已改用 onnxruntime-web 自写推理;将 transformers 替换为空模块,避免打包 .node 原生文件。
			build.onResolve({ filter: /@huggingface\/transformers/ }, () => ({
				path: emptyTransformersPath,
			}));

			// 关键路径:.node 原生文件直接标记为 external,避免 esbuild 因无 loader 而报错。
			build.onResolve({ filter: /\.node$/ }, () => ({
				path: 'empty.node',
				external: true,
			}));

			// 关键路径:如果 onnxruntime-node 目录下的任何 JS 文件仍被加载,直接返回空模块。
			// 这是 onResolve 兜底后的第二道防线,防止 binding.js 中的动态 require 触发解析。
			build.onLoad({ filter: /\/onnxruntime-node\//, namespace: 'file' }, (args) => {
				// package.json 等 JSON 文件交给 esbuild 默认处理,不做替换。
				if (args.path.endsWith('.json')) {
					return undefined;
				}
				return { contents: emptyContents, loader: 'js' };
			});

			// 关键路径:若 esbuild 直接尝试加载 .node 二进制,返回空模块内容,
			// 防止 "No loader" 报错中断构建。
			build.onLoad({ filter: /\.node$/, namespace: 'file' }, () => ({
				contents: emptyContents,
				loader: 'js',
			}));
		},
	};
}

// 关键路径:产物统一放 dist/ 下,避免污染仓库根。
// 开发期和发布期的 main.js / worker.js 都从 dist/ 读。
mkdirSync('dist', { recursive: true });

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = process.argv[2] === 'production';

// Main plugin bundle
const mainContext = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ['src/main.ts'],
	bundle: true,
	// 关键路径:vectra 等 node-only 依赖使用 `node:fs` / `node:path` 协议,
	// 必须在 `platform: 'node'` 下 esbuild 才识别。
	platform: 'node',
	// 关键路径:Svelte 5 的 `svelte` 包按 condition 导出 client/server 两套运行时,
	// `exports"."` 的 default 指向 server 端(无 `mount`,只有 SSR 的 `render`)。
	// Obsidian 是浏览器宿主,必须显式加 `browser` condition 才能命中 client runtime。
	conditions: ['browser', 'default'],
	// 关键路径:onnxruntime-web 强制 wasm bundle 入口;WASM 二进制由 OrtRuntimeAssets 懒下载(ADR-006)。
	mainFields: ['browser', 'module', 'main'],
	alias: {
		'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
		'onnxruntime-node': path.resolve(__dirname, 'src/adapters/empty-module.cjs'),
		'@huggingface/transformers': path.resolve(__dirname, 'src/adapters/empty-transformers.cjs'),
		// 关键路径:vectra 的 Node 入口(index.js)会 re-export server 模块,连带引入 @grpc/grpc-js。
		// Obsidian 渲染进程不需要 server 能力,强制走 browser 入口,只打包纯 JS 索引逻辑。
		'vectra': path.resolve(__dirname, 'node_modules/vectra/lib/browser.js'),
	},
	// 关键路径:本地 Embedding 改走 onnxruntime-web(纯 JS/WASM),
	// 不打包 @huggingface/transformers(已移除依赖)。
	// onnxruntime-node / transformers 由 externalOnnxruntimeNodePlugin 替换为空模块,
	// 不再出现在 external 列表中,避免残留运行时 require。
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
	],
	format: 'cjs',
	target: 'es2021',
	// 修复:verbose 会把每个 external 匹配打到 stdout，商店审核跑 npm run build 会因日志过长判失败。
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/main.js',
	minify: prod,
	metafile: true,
	// 关键路径:为 .node 原生文件配置 loader,避免 esbuild 因无 loader 而报错。
	// 这些文件仅来自 onnxruntime-node 的 Node 回退路径,实际在 Obsidian 渲染进程中不会执行。
	loader: { '.node': 'text' },
	plugins: [
		esbuildSvelte({
			compilerOptions: { css: 'injected' },
			preprocess: sveltePreprocess(),
		}),
		externalOnnxruntimeNodePlugin(),
		inlineEmbeddingWorkerPlugin(),
		inlineSkillScriptWorkerPlugin(),
		inlineBuiltinSkillsPlugin(),
	],
});

// Worker bundle (separate entry point)
const workerContext = await esbuild.context({
	entryPoints: ['src/worker/index.ts'],
	bundle: true,
	// 关键路径:Worker 也是 node 环境,vectra 同样依赖 node:fs / node:path。
	platform: 'node',
	// 关键路径:Worker 实际在 Obsidian 渲染进程内运行(InlineWorker 降级),也需要 browser 条件。
	conditions: ['browser', 'default'],
	// 关键路径:同上,Worker 不做 ONNX 推理,但 vectra 仍可能间接携带 onnxruntime-node / transformers,
	// 使用同一插件兜底替换为空模块。
	external: [
		'obsidian',
		'electron',
		...builtinModules,
	],
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/worker.js',
	minify: prod,
	alias: {
		// 关键路径:Worker 同样使用 vectra 的 browser 入口,避免 grpc 等 Node-only 依赖被打包。
		'vectra': path.resolve(__dirname, 'node_modules/vectra/lib/browser.js'),
	},
	plugins: [externalOnnxruntimeNodePlugin()],
});

// Embedding Worker bundle (Web Worker, browser platform)
// 关键路径:ONNX 推理在 Web Worker 中执行,platform 必须为 browser(不依赖 Node API)。
// format: iife — Web Worker 需要自执行,IIFE 格式最兼容。
const embeddingWorkerContext = await esbuild.context({
	entryPoints: ['src/worker/embedding-worker.ts'],
	bundle: true,
	// 关键路径:Web Worker 运行在浏览器环境,不依赖 node:fs / node:path;
	// platform: browser 让 esbuild 把浏览器内置模块当作外部,不尝试 polyfill。
	platform: 'browser',
	// 关键路径:IIFE 自执行格式,Web Worker 加载脚本后立即执行,兼容性最佳。
	format: 'iife',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/embedding-worker.js',
	minify: prod,
	// 关键路径:与 mainContext 一致的 alias — onnxruntime-web 强制走 wasm bundle 入口,
	// onnxruntime-node / @huggingface/transformers 替换为空模块,防止原生模块进浏览器产物。
	alias: {
		'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
		'onnxruntime-node': path.resolve(__dirname, 'src/adapters/empty-module.cjs'),
		'@huggingface/transformers': path.resolve(__dirname, 'src/adapters/empty-transformers.cjs'),
	},
	// 关键路径:bert-tokenizer 的 loadVocab 动态 import node:fs/promises(仅主线程调用)。
	// Worker 路径用 parseVocab(纯函数),loadVocab 经 tree-shaking 移除;
	// 但 esbuild 在 tree-shaking 前会尝试 resolve 所有 import,标记 external 让扫描阶段跳过。
	// 'obsidian' 防御性 external — Worker 不导入 obsidian,但传递依赖可能意外引入。
	external: ['node:fs/promises', 'obsidian'],
	plugins: [externalOnnxruntimeNodePlugin()],
});

// Skill script worker bundle (Node worker_threads, CJS eval string)
// 关键路径:ADR-017 — 脚本沙箱 Worker;platform node(builtins external,运行时在 Worker 内 require);
// format cjs + eval:true 加载。严禁 import obsidian。
const skillScriptWorkerContext = await esbuild.context({
	entryPoints: ['src/worker/skill-script-worker.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/skill-script-worker.js',
	minify: prod,
	// 关键路径:node builtins 保持 external — 产物作为字符串在 Worker 线程内 require 真实模块。
	external: [...builtinModules],
	plugins: [],
});

if (prod) {
	await embeddingWorkerContext.rebuild();
	await skillScriptWorkerContext.rebuild();
	const mainResult = await mainContext.rebuild();
	await workerContext.rebuild();
	if (mainResult.metafile) {
		await import('node:fs/promises').then(({ writeFile }) =>
			writeFile(path.join(__dirname, 'dist', 'meta-main.json'), JSON.stringify(mainResult.metafile)),
		);
	}
	process.exit(0);
} else {
	await embeddingWorkerContext.rebuild();
	await skillScriptWorkerContext.rebuild();
	await mainContext.watch();
	await workerContext.watch();
	await embeddingWorkerContext.watch();
	await skillScriptWorkerContext.watch();
}

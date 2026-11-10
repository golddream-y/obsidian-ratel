import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { node } from 'globals';
import svelteParser from 'svelte-eslint-parser';
import sveltePlugin from 'eslint-plugin-svelte';

export default tseslint.config(
	{
		// 关键路径:dist/ 是 esbuild 产物,.agents/skills/ 是技能文件(含第三方上游脚本),不纳入 lint。
		// .trae/ 只剩一个兼容软链,一并忽略以免重复扫描。
		// .worktrees/ 是本地 git worktree,含独立 eslint/tsconfig,扫进去会 typed-lint 炸。
		// tests/ 预存大量 unsafe/mock 债,不挡发版;typed lint 只盯 src(与 Obsidian 产物相关)。
		// eslint.config.mts / vitest*.config.ts 不在 tsconfig include 内,跳过。
		ignores: [
			'dist/**',
			// 关键路径:vendor 是逐行移植的第三方产物(仅两处 Node 判定补丁),
			// 不为它改写风格,避免与上游对照失效。
			'src/vendor/**',
			'.agents/skills/**',
			'.trae/**',
			'scripts/**',
			'.worktrees/**',
			'tests/**',
			'eslint.config.mts',
			'vitest.config.ts',
			'vitest.index-reliability.config.ts',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	// 关键路径:启用 Obsidian 官方 eslint-plugin 推荐规则集,与 plugin checker 服务端规则一致。
	// 这样迁移过程本地 npm run lint 就能复现 checker 错误,无需上传 GitHub release 验证。
	// 注意:obsidianmd.configs.recommended 内部已对 .ts 启用 tseslint recommendedTypeChecked,
	// 要求 parserOptions.project,tsconfig.json 已 include src + tests,可满足 typed linting。
	...obsidianmd.configs.recommended,
	{
		rules: {
			// 关键路径:关闭 eslint 核心 no-unused-vars,改由 @typescript-eslint 管 —
			// 否则 Svelte $props() 回调类型里的 (id: string) 参数名会被误报,
			// 且与下方 argsIgnorePattern 双轨冲突(CI Lint 长期红)。
			'no-unused-vars': 'off',
			// 关键路径:允许 _ 前缀的变量/参数作为占位,测试与 mock 中常见。
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
		},
	},
	{
		// 关键路径:TypeScript 文件启用 typed linting(parserOptions.project),
		// obsidianmd 推荐规则集中的 @typescript-eslint/await-thenable / no-floating-promises 等需要。
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
			},
			// 构建期注入的常量,类型声明在 svelte.d.ts,值由 esbuild.config.mjs 的 define 写入。
			globals: {
				__RATEL_INDEX_EXPERIMENT__: 'readonly',
				__RATEL_GPU_WORKER__: 'readonly',
				__RATEL_ORT_GLUE__: 'readonly',
			},
		},
	},
	{
		// 关键路径:Node 脚本(.mjs / .cjs)需要 process / module / require 等全局变量。
		files: ['**/*.mjs', '**/*.cjs', 'scripts/**'],
		languageOptions: {
			globals: node,
		},
	},
	{
		// 关键路径:以下模块运行在后台/Worker 环境,计时器与全局对象不绑定某个 popout UI 窗口。
		// obsidianmd 的 no-global-this 面向 UI 代码;在这些文件里 globalThis 是有意选择
		// (Node 测试、子进程与 Worker 复用同一实现),因此只对这些文件关闭该规则。
		files: [
			'src/adapters/embedding-worker-proxy.ts',
			'src/core/asset-downloader.ts',
			'src/core/index-manager.ts',
			'src/core/index-task-coordinator.ts',
			'src/core/index-write-owner.ts',
			'src/core/loop-stability.ts',
			'src/core/query-embedding.ts',
			'src/logging/breadcrumbs.ts',
			'src/worker/index-runtime-host.ts',
			'src/worker/index-runtime-worker.ts',
		],
		rules: {
			'obsidianmd/no-global-this': 'off',
		},
	},
	{
		// 关键路径:测试夹具需要按默认配置目录名构造临时 vault;
		// 运行时代码已通过 vault.configDir 注入,这里不把夹具字面量当成缺陷。
		files: ['src/skills/script-vm.test.ts', 'src/tools/run-skill-script.test.ts'],
		rules: {
			'obsidianmd/hardcoded-config-path': 'off',
		},
	},
	{
		// 关键路径:*.svelte 用 svelte-eslint-parser 解析,<script> 块走 TS parser
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				extraFileExtensions: ['.svelte'],
			},
		},
		plugins: {
			svelte: sveltePlugin,
		},
		rules: {
			...sveltePlugin.configs.recommended.rules,
		},
	},
);

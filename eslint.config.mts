import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { node } from 'globals';
import svelteParser from 'svelte-eslint-parser';
import sveltePlugin from 'eslint-plugin-svelte';

export default tseslint.config(
	{
		// 关键路径:dist/ 是 esbuild 产物,.trae/ 是技能文件,scripts/ 暂不纳入 lint。
		// eslint.config.mts 不在 tsconfig include 内,无法做 typed linting,跳过。
		ignores: ['dist/**', '.trae/**', 'scripts/**', 'eslint.config.mts'],
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

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidian from 'eslint-plugin-obsidianmd';
import { node } from 'globals';
import svelteParser from 'svelte-eslint-parser';
import sveltePlugin from 'eslint-plugin-svelte';

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		plugins: {
			obsidian,
		},
		rules: {
			// 关键路径:允许 _ 前缀的变量/参数作为占位,测试与 mock 中常见。
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
		},
	},
	{
		// 关键路径:dist/ 是 esbuild 产物,.trae/ 是技能文件,scripts/ 暂不纳入 lint。
		ignores: ['dist/**', '.trae/**', 'scripts/**'],
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

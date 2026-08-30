/**
 * @file src/adapters/skill-script-worker-code.ts
 * @description 虚拟模块再导出 — esbuild 插件把 dist/skill-script-worker.js 内容注入为字符串常量
 * @module adapters/skill-script-worker-code
 * @depends @ratel/skill-script-worker-code(esbuild 虚拟模块,ADR-006 同思路)
 */

// 关键路径:esbuild 的 inline 插件解析该 specifier;类型见 src/svelte.d.ts 模块声明。
import { SKILL_SCRIPT_WORKER_CODE } from '@ratel/skill-script-worker-code';

export { SKILL_SCRIPT_WORKER_CODE };

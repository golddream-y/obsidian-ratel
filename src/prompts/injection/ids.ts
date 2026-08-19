/**
 * @file src/prompts/injection/ids.ts
 * @description 注入源 ID 集中登记表 — 动态 prompt 段的唯一清单(S-SR-LAYERING)
 * @module prompts/injection/ids
 */

/**
 * 全部注入源 ID;新增动态 system 段必须在此登记,禁止调用点裸字符串。
 *
 * 设计要点(为什么不用 TS enum,见 AGENTS.md「枚举与 ID 集中管理」):
 * - as const 元组零运行时产物(esbuild 友好);const enum 跨文件在 isolatedModules 下退化。
 * - 一份声明同时得到可遍历的值清单与字面量联合类型;enum 的类型/值是两份维护。
 * - searchResults 不入此表:它是消息数组路径(pruneSearchBlocks 逐条 push),非单段 system 文本。
 */
export const INJECTION_SOURCE_IDS = [
	'env', // 本地时间等环境行
	'memory', // 记忆 global + topics top-K(S-SR-LAYERING)
	'skills', // Skill Discovery 段
] as const;

export type InjectionSourceId = (typeof INJECTION_SOURCE_IDS)[number];

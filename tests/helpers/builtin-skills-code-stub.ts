/**
 * @file tests/helpers/builtin-skills-code-stub.ts
 * @description Vitest 用 stub:生产构建由 esbuild 的 inlineBuiltinSkillsPlugin 注入真实 SKILL.md 清单与 manifest version
 * @module tests/helpers/builtin-skills-code-stub
 */

/** Vitest 环境不落盘内置 skill,空清单即可 */
export const BUILTIN_SKILLS: Record<string, string> = {};

/** 测试用占位版本号 */
export const APP_VERSION = '0.0.0-test';

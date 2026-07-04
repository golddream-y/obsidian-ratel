/**
 * @file src/prompts/index.ts
 * @description prompts 模块对外 re-export 入口
 * @module prompts
 */

export * from './types';
export * from './sections';
export * from './composer';
export { validatePlaceholders } from './interpolate';
export { listEditableSections } from './sections';

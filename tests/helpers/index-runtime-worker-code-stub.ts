/**
 * @file tests/helpers/index-runtime-worker-code-stub.ts
 * @description esbuild 虚拟模块在 vitest 下的空实现 — 测试只验证装配,不加载真实索引线程代码
 * @module tests/helpers/index-runtime-worker-code-stub
 */

/** 测试环境不注入 Worker 代码;需要真实线程的用例必须显式跳过。 */
export const INDEX_RUNTIME_WORKER_CODE = '';

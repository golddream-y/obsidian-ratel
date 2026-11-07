/**
 * @file tests/helpers/gpu-probe-code-stub.ts
 * @description GPU 探针 Worker 代码在 vitest 中的替身
 * @module tests/helpers/gpu-probe-code-stub
 *
 * 关键路径:真实代码由 esbuild 在构建期注入;测试只验证装配,不执行 GPU 探针。
 */

export const GPU_PROBE_WORKER_CODE = '';

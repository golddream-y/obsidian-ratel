/**
 * @file tests/helpers/gpu-embedding-worker-code-stub.ts
 * @description GPU 版嵌入 Worker 代码在 vitest 中的替身
 * @module tests/helpers/gpu-embedding-worker-code-stub
 *
 * 关键路径:真实代码由 esbuild 在构建期注入;测试只验证装配,不执行 GPU 探测。
 * 空字符串让 probeGpuWorker 立即回退 WASM,与 1.4.0 行为一致。
 */

export const GPU_EMBEDDING_WORKER_CODE = '';

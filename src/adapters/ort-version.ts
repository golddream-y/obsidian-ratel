/**
 * @file src/adapters/ort-version.ts
 * @description ORT 运行时版本常量 — 主线程与 Worker 共用，不含 Node 依赖
 * @module adapters/ort-version
 */

/** 与 package.json 中 onnxruntime-web 版本保持一致(测试会校验)。 */
export const ORT_RUNTIME_VERSION = '1.27.0';

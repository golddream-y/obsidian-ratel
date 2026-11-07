/**
 * @file scripts/gen-ort-glue.mjs
 * @description 把 ONNX jsep wasm 胶水模块内联成 TS 常量（供 GPU 探针 Worker 使用）
 *
 * 关键路径:发版只允许 main.js / manifest.json / styles.css 三个文件，不能附带 .mjs 资产；
 * GPU 探针需要 ORT 在 Worker 内 import 该胶水模块，因此构建期把它转成字符串打进产物。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SOURCE = path.resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs');
const TARGET = path.resolve('src/adapters/ort-wasm-glue.generated.ts');

const text = readFileSync(SOURCE, 'utf8');
const header = `/**
 * @file src/adapters/ort-wasm-glue.generated.ts
 * @description ONNX jsep wasm 胶水模块源码(构建期生成,请勿手改)
 * @module adapters/ort-wasm-glue.generated
 *
 * 生成命令:npm run gen:ort-glue
 */

`;
mkdirSync(path.dirname(TARGET), { recursive: true });
writeFileSync(TARGET, `${header}export const ORT_WASM_JSEP_GLUE = ${JSON.stringify(text)};\n`, 'utf8');
console.log(`已生成 ${path.relative(process.cwd(), TARGET)} (${(text.length / 1024).toFixed(0)} KB)`);

# S-WEBGPU-EMBEDDING — 本地嵌入 WebGPU 加速（1.5 专项）

- 状态：In Progress（设计中）
- 目标版本：1.5.0
- 上一版本：`1.4.0`（已发布，本地嵌入为纯 WASM）
- 参照 tag：`1.4.0`

## 背景

1.4.0 研发期尝试过 WebGPU 执行器，四种加载方式都失败。实测环境完全支持：

```
渲染进程 WebGPU:可用 (adapter=ok)
嵌入 Worker 环境:navigator.gpu=true(secureContext=true)
```

但 `executionProviders: ['webgpu']` 恒报 `backend not found`。原因是打包方式：

| | `import.meta.url` 出现次数 |
|---|---|
| ORT 原始 `ort.webgpu.bundle.min.mjs` | 11 |
| 我们的嵌入 Worker（`format: 'iife'`） | **0** |

esbuild 的 IIFE 会抹掉 `import.meta`。ORT 用它拼 glue/wasm 路径：

```js
w = import.meta.url
m: new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href
```

路径解析失败 → jsep 胶水模块加载不了 → **webgpu EP 从未注册** → `backend not found`。
此前 `ke.$b is not a function` 同源（glue 未实例化完）。

另有一个致命缺陷：同一 ORT 实例里 webgpu 尝试失败会污染 `initWasm()`，
导致**连 WASM 回退也失败**（`previous call to 'initWasm()' failed` → 索引整体挂掉）。

ESM 打包验证通过：同一 ORT 入口用 `format: 'esm'` 打包后，
`import.meta.url` 保留 13 次、含 webgpu EP 实现代码。方案可行。

## 目标

本地嵌入优先使用 WebGPU 执行器（本机 GPU），失败自动回退 WASM，
**且失败不得影响索引可用性**。

## 非目标

- 不改模型、不改维度、不改分块参数
- 不引入新的运行时下载目的地
- 不在 1.4.0 的更新说明里提 GPU（已发布，不追溯）
- 不做物理分片重分布、不做跨后端向量校验

## 详细设计

### 同一入口打两份 Worker 产物

`src/worker/embedding-worker.ts` 源码只保留一份，构建两次：

| 产物 | format | ORT 入口 | 用途 |
|---|---|---|---|
| `dist/embedding-worker.js` | `iife` | `ort.wasm.bundle.min.mjs` | 稳定 WASM 路径（不变） |
| `dist/embedding-worker-gpu.js` | `esm` | `ort.webgpu.bundle.min.mjs` | GPU 尝试路径 |

两者都构建期内联进 `main.js`（发版只允许三个文件）。

### 装配层先探测、后选择（无命令、无弹窗）

`initEmbeddingWorkerProxy` 时：

1. 创建 GPU Worker：`new Worker(gpuUrl, { type: 'module' })`
2. 发 `init`（含 deps），等 `ready`
3. 成功 → 把 `gpuUrl` + `workerType: 'module'` 交给 `EmbeddingWorkerProxy`
4. 失败 → `terminate()`，改用现有 WASM Worker（`classic`）

**两个独立 Worker、两个独立 ORT 实例** → GPU 失败不污染 WASM，回退必然可用。

GPU Worker 内部**不做 WASM 回退**：失败即让 init 失败，由装配层换 Worker。

### 胶水模块内联，不新增外发目的地

jsep 胶水（46 KB）由构建期读取并内联进 GPU Worker 产物，
运行时在 Worker 内 `new Blob([glue])` → `URL.createObjectURL` → `wasmPaths.mjs`。
不从 CDN 取，避免新增网络请求。

**但是**：webgpu EP 还依赖带 jsep 的 wasm（26 MB），与 CPU 版不是同一个文件。
`OrtRuntimeAssets.readGpuWasmBinary()` 把它单独缓存到插件目录，
来源仍是同一 jsDelivr / 同一 ORT 包，**不新增外发目的地**，
但首次 GPU 探测会多一次约 26 MB 下载（需在 1.5 更新说明里如实写明）。

### 三条硬约束 —— 保证 1.5 不重建索引

`INDEX_CONFIG_FINGERPRINT_FIELDS` 只有 7 个字段，**不含执行后端**：
`embeddingModelId`、`embeddingModelRevision`、`embeddingDimension`、
`chunkerVersion`、`chunkSize`、`chunkOverlap`、`embeddingTextVersion`。

因此：

1. **不要把后端写进 `embedLocalModel`**（如 `...:webgpu`）——会改指纹、触发全量重建
2. **不要把后端加进 `INDEX_CONFIG_FINGERPRINT_FIELDS`**
3. **不要换模型或维度**（换 Ollama `bge-m3` 1024 维属另一条路线，必须重建）

只换后端 → 指纹逐字不变 → 代际不变 → **1.4.0 的索引直接复用，零重建**。

### 追加根因：GPU 路径必须用 jsep wasm

剥离 Node 判定后报错变为 `TypeError: c is not a function`：普通
`ort-wasm-simd-threaded.wasm` 不导出 `webgpuInit` / `webgpuRegisterDevice`，
胶水实例化后 ORT 调用这些函数即失败。修复：`getDeps({ gpu: true })` 改读
`ort-wasm-simd-threaded.jsep.wasm`，probe 与 proxy 的 deps 工厂同源。

同时 GPU Worker 产物改为**不压缩**、init 失败回传 `error.stack`，
研发期能直接读到 ORT/胶水的真实函数名，而不是 `c is not a function`。

### 追加根因：胶水里的 Node 环境误判

首次主库验证拿到真实报错：

```
no available backend found. ERR: [webgpu] TypeError: Failed to resolve module specifier 'worker_threads'
```

内联的 jsep 胶水末尾有 Node 判定：

```js
var isNode = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";
if (isNode) isPthread = (await import("worker_threads")).workerData === "em-pthread";
```

Obsidian 的 Blob Worker 里 Electron 注入的 `process.type` 不是 `"renderer"`（是 `"worker"`），
ORT 误判成 Node，浏览器原生 ESM 解析裸模块名 `worker_threads` 直接失败。
胶水通过 Blob URL 由浏览器原生加载，esbuild 的 alias 管不到，**必须在构建期改字符串**：
把两处 Node 判定固定为 `!1`，并在构建时校验模式存在（ORT 升级改写法会立即构建失败）。

## 影响面

- `esbuild.config.mjs`：新增 GPU Worker 构建上下文与内联插件
- `src/worker/embedding-worker.ts`：deps 增加 `enableWebgpu` / `glueSource`
- `src/adapters/embedding-onnx.ts`：`createSession` 增加 GPU 分支（仅 GPU Worker 启用）
- `src/adapters/embedding-worker-proxy.ts`：构造参数增加 `workerType`
- `src/main.ts`：装配层探测与选择逻辑
- `scripts/gen-ort-glue.mjs`、`src/adapters/ort-wasm-glue.generated.ts`：构建期新增
- 测试：锁住指纹三条硬约束、Worker 选择回退
- 用户可见：无设置项、无命令；仅日志多一行「嵌入后端」

已知精度差异：GPU/CPU 浮点运算顺序不同，向量数值可能有 1e-5 量级偏差。
届时索引向量（1.4.0 WASM 算）与查询向量（1.5 WebGPU 算）来自不同后端，
余弦排序基本不变。不强制重建；若实测质量下降，提供「重建索引」入口让用户自选。

## 验收

> 2026-11-07 用户**临时授权**把实验构建装到日常主库验证一次（原本按 `AGENTS.local.md` 只在 Sandbox 链接）。
> 该授权仅限本轮，不解除日常主库的常规禁令；验证结束应恢复到 1.4.0 发布版或后续正式版本。


1. 出现 `嵌入后端:WebGPU(本机 GPU 加速已启用)`，且 `嵌入速度 X 秒/块` 明显低于 0.85
2. EP 注册失败时自动出现 `嵌入后端:WASM`，索引仍可正常推进
3. 全量 `tsc` / eslint / vitest 通过，产物门禁通过
4. 配置指纹对同一库前后一致（写用例锁住三条硬约束）

## 参考

- [ONNX Runtime WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [ORT issue #15796 — 必须 import onnxruntime-web/webgpu](https://github.com/microsoft/onnxruntime/issues/15796)
- [ORT issue #20876 — Service Worker 里 import() 受限](https://github.com/microsoft/onnxruntime/issues/20876)
- `docs/superpowers/specs/2026-11-04-sharded-index.md`（分片存储，本专项的前置能力）
- 1.4.0 研发期日志与回退结论见本文件「背景」

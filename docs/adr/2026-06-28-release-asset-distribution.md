# ADR-006:Obsidian 商店发版资产分发策略(Worker 内联 + WASM 懒下载)

**状态**:Accepted
**日期**:2026-06-28
**关联**:ADR-003(本地 Embedding 运行时)、ADR-005(Embedding Web Worker)
**取代**:ADR-003 §「WASM 分发策略」中「方案 B:wasm 内嵌到 main.js」的**实施表述**(ADR-003 的 ONNX 选型决策不变)

---

## Context(背景)

Ratel 0.1.0 准备通过 Obsidian 社区插件商店 / BRAT 发布。发布流程与官方 [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) 一致:GitHub Release 附件仅上传 `main.js`、`manifest.json`、`styles.css`(可选)。

### 现象(发版阻塞)

通过 BRAT / 商店安装后,默认 **local embedding** 配置下插件启动失败:

| 缺失文件 | 代码位置 | 用途 |
|---|---|---|
| `embedding-worker.js` | `main.ts` `initEmbeddingWorkerProxy` → `fs.readFileSync(workerPath)` | ONNX 推理 Web Worker 脚本 |
| `ort-wasm-simd-threaded.wasm` | `main.ts` → `ModelManager` → `readFile(wasmPath)` | onnxruntime-web WASM 二进制(~13MB) |

BRAT 源码 `BetaPlugins.ts` 的 `ReleaseFiles` 接口仅包含 `mainJs` / `manifest` / `styles` 三个字段;额外 release 附件**不会被安装到** `.obsidian/plugins/ratel-vault/`。

`worker.js` 不受影响 — 索引走 InlineWorker,该产物当前不被加载。

开发期 `npm run link:vault` 只软链 `main.js` / `worker.js` / `manifest.json`,同样不包含上述两个文件,与商店行为一致。

### ADR-003 与实现的偏差

ADR-003 决策「方案 B:使用 `ort.wasm.bundle.min.mjs`,将 WASM 内嵌到 main.js」。

实测:

- `ort.wasm.bundle.min.mjs` 仅 **~71KB**,只内联 JS wrapper,**不含** 13MB 的 `ort-wasm-simd-threaded.wasm`。
- 实现阶段改为 esbuild 复制 wasm 到 `dist/`,运行时 `readFile` + `ort.env.wasm.wasmBinary` 传入 — 这在**手动拷贝全量产物**时可用,但不符合商店三文件约束。

---

## 外部调研摘要(Tavily, 2026-06-28)

### Obsidian 生态约束(已确认)

- 官方 sample plugin / 社区共识:release 只附 `main.js` + `manifest.json` + `styles.css`。
- 手动安装同样只需这三个文件(加可选 `data.json`)。

### 方案对比(检索 + 社区先例)

| 方案 | 说明 | 评估 |
|---|---|---|
| **A. 全内联** | worker 字符串 + wasm base64 打进 main.js | 完全离线;main.js +15~17MB;Obsidian Sync 慢 |
| **A′. 混合(本 ADR)** | worker 内联 + wasm 首次下载缓存到 pluginDir | main.js 小;与模型首次下载一致;有 Obsidian 先例 |
| **B. 砍 local embedding** | 0.1.0 仅 API embedding | 可应急发版,放弃默认能力 |
| **C. CDN `wasmPaths`** | ORT 官方支持 jsdelivr | Obsidian CSP 可能拦截;离线差;ADR-003 已否决纯 CDN 运行时 |
| **D. 换 Transformers.js** | Smart Connections 生态 | 迁移量远大于发版阻塞 |

### 关键外部参考

1. **[obsidian-ruby-wasm-plugin](https://github.com/geeknees/obsidian-ruby-wasm-plugin)** — 首次执行时从 **jsDelivr** 下载 Ruby WASM,保持 `main.js` 足够小、适合 Obsidian Sync。Obsidian 插件处理「WASM 无法随 release 分发」的**正式先例**。
2. **[onnxruntime-web 部署文档](https://onnxruntime.ai/docs/tutorials/web/deploy.html)** — WASM 与 JS bundle 分离;可用 `ort.env.wasm.wasmBinary` 或 `wasmPaths`(CDN)。
3. **[obsidian-web-worker-example](https://github.com/RyotaUshio/obsidian-web-worker-example)** — Obsidian 内 Web Worker + esbuild 实践。
4. **Worker 内联模式** — `new Blob([code])` + `URL.createObjectURL` 是标准 Web API;esbuild `text` loader / 构建期注入字符串均可。
5. **Obsidian CSP** — [论坛报告](https://forum.obsidian.md/t/content-security-policy-header-in-obsidian-1-5-3-breaks-plugin/73889) 远程脚本加载不稳定;不宜把 wasm **运行时**完全依赖 CDN 每次 fetch,但**一次性下载到本地**可接受。

### 产品一致性论证

Ratel 本地 embedding **已要求首次联网**从 ModelScope 下载 ONNX 模型(~24MB)与 vocab。在此前提下,额外首次下载 ORT WASM(~13MB)到同一 `pluginDir` **不引入新的产品假设**,且避免 main.js 膨胀。

---

## Decision(决策)

采用 **方案 A′:混合分发**。

### 1. Embedding Worker — 构建期内联进 main.js

- esbuild 先产出 `dist/embedding-worker.js`,再通过 virtual module `@ratel/embedding-worker-code` 将脚本内容以字符串常量注入 `main.js`。
- 运行时 `initEmbeddingWorkerProxy` 使用内联字符串创建 Blob URL,**不再** `fs.readFileSync('embedding-worker.js')`。
- `dist/embedding-worker.js` 仍保留供调试与单元测试;**不作为**商店 release 附件。

### 2. ORT WASM — 首次使用时懒下载到 pluginDir

- 新增 `OrtRuntimeAssets`(`src/core/ort-runtime-assets.ts`):
  - 缓存路径:`<pluginDir>/ort-wasm-simd-threaded.wasm`(与现路径一致,已安装用户无迁移)。
  - 下载源:`https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/ort-wasm-simd-threaded.wasm`,版本与 `package.json` 中 `onnxruntime-web` **pin 一致**。
  - 原子写入(`.downloading` 临时文件 → `rename`);最小体积校验防损坏。
- `ModelManager.download()` 与模型下载**并行**调用 `ensureWasm()`;`readWasmBinary()` 供主线程与 `getDeps()` 使用。
- 继续通过 `ort.env.wasm.wasmBinary` 传入,**不使用** `wasmPaths` CDN 直读。

### 3. 发版产物

商店 / BRAT release **仅**上传:

- `main.js`(含内联 worker)
- `manifest.json`
- `styles.css`

不再要求用户或 CI 附带 `embedding-worker.js`、`ort-wasm-simd-threaded.wasm`。

### 不采纳

| 方案 | 原因 |
|---|---|
| 纯 base64 内联 wasm(A) | main.js 过大;Obsidian Sync 体验差;模型已需首次下载,无额外离线收益 |
| 0.1.0 仅 API embedding(B) | 放弃核心差异化能力 |
| 运行时 CDN `wasmPaths`(C) | CSP / 离线 / 审核风险 |
| 换 Transformers.js(D) | 范围失控 |

---

## Consequences(后果)

**正面**:

- 解除 0.1.0 商店发版阻塞;BRAT 安装后默认 local embedding 可用(首次需联网下载 wasm + 模型)。
- `main.js` 体积可控;worker 逻辑随插件版本一起更新,无文件遗漏。
- WASM 缓存本地复用,二次启动离线可用(模型已缓存前提下)。
- 与 ruby.wasm 插件模式一致,审核说明清晰。

**负面**:

- 首次 local embedding 初始化需额外 ~13MB 下载(与模型下载合并展示进度)。
- 依赖 jsDelivr 可用性;失败时用户需重试或切换 API embedding。
- `onnxruntime-web` 升级时需同步更新 `ORT_RUNTIME_VERSION` 与 CDN URL。

**影响面**:

| 文件 | 变更 |
|---|---|
| `src/core/ort-runtime-assets.ts` | 新增 |
| `src/core/model-manager.ts` | `wasmPath` → `OrtRuntimeAssets` |
| `src/main.ts` | 内联 worker 字符串;构造 `OrtRuntimeAssets` |
| `esbuild.config.mjs` | 注入 worker 字符串;移除 wasm 复制到 dist;调整 build 顺序 |
| `tests/core/ort-runtime-assets.test.ts` | 新增 |
| `AGENTS.md` | 更新发布产物说明 |

**安全与隐私**:

- WASM 从公共 CDN 一次性下载,写入用户 vault 下插件目录;无持续外联。
- 下载 URL 版本 pin,避免供应链漂移。

---

## 实施路径

1. `OrtRuntimeAssets` + 单元测试(mock fetch)
2. `ModelManager` 接入 `ensureWasm` / `readWasmBinary`
3. esbuild virtual module 内联 `embedding-worker.js`
4. `main.ts` 移除磁盘 worker 读取
5. 移除 `copy-ort-wasm` esbuild 插件
6. `npm test` + `npm run build` 验证

---

## 参考

- `.temp/2026-06-28-release-blocker.md` — 阻塞结论草稿
- [obsidian-sample-plugin — Releasing](https://github.com/obsidianmd/obsidian-sample-plugin)
- [geeknees/obsidian-ruby-wasm-plugin](https://github.com/geeknees/obsidian-ruby-wasm-plugin)
- [ONNX Runtime Web — Deploying](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [ONNX Runtime Web — env.wasm.wasmPaths](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- ADR-003:Ratel Vault 本地 Embedding 运行时策略
- ADR-005:索引阻塞 UI 的根因与修复策略(Embedding Web Worker)

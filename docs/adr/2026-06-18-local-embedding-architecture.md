# ADR-003:Ratel Vault 本地 Embedding 运行时策略

**状态**:Draft — 待确认 ModelScope 模型可用性后执行
**日期**:2026-06-18

---

## Context(背景)

Ratel Vault 在 Obsidian 桌面版加载时,本地 Embedding 模型权重未自动下载,模型不可用,UI 无任何提示。控制台仅显示 Worker fallback 提示,本地 Embedding 失败被状态机静默吞掉。

### 现象

```
Ratel: Worker Threads 不可用,降级到 InlineWorker The V8 platform used by this instance of Node does not support creating Workers
```

无任何后续 Notice 或 error 日志。RAG 流程中断:`EmbeddingLocal` 始终未就绪,`search_vault` 工具返回 `INDEX_NOT_READY`。

### 根因

- **L1 架构假设**:Ratel 用 `@huggingface/transformers` 库做本地 Embedding,假设其能跑在 Obsidian 桌面版
- **L2 库的 Node 入口**:`@huggingface/transformers@4.2.0` 的 `exports.node` 入口会加载三个 native addon:
  - `onnxruntime-node` — ONNX 推理(含 `.node` 原生二进制)
  - `@huggingface/tokenizers` — Rust 绑定,分词器 native 实现
  - `sharp` — libvips 图像处理 native 库
- **L3 Obsidian 环境**:Obsidian 桌面版是 Electron 应用,社区插件 `main.js` 跑在**渲染进程**;该进程**禁止加载任何 native addon**(`Worker Threads` 同样因此不可用,见 ADR-002)
- **L4 当前打包策略**:esbuild 把 `@huggingface/transformers` / `onnxruntime-node` 标 `external`,运行时 `import('@huggingface/transformers')` 在 Obsidian 渲染进程找不到模块(插件无独立 `node_modules`)
- **L5 状态机静默**:`ModelDownloader.ensureModel` 的 dynamic import 失败;`ModelManager.download` 内部 catch 不 throw,只设 `status$ = Failed`;`main.ts onLayoutReady` 原用 `void` 包装异步调用,错误被吞

### 关键环境事实

| 能力 | 状态 | 说明 |
|---|---|---|
| Node.js `fs` / `path` | ✅ 可用 | Obsidian 插件 `isDesktopOnly` 即可使用 |
| `worker_threads` | ❌ 不可用 | 见 ADR-002 |
| 任何 `.node` native addon | ❌ 不可用 | 渲染进程 V8 不支持 native addon |
| `onnxruntime-web`(WASM) | ✅ 可用 | 纯 JS/WASM,浏览器宿主通用 |
| `@huggingface/transformers` Node 入口 | ❌ 不可用 | 依赖 `onnxruntime-node` + `@huggingface/tokenizers` + `sharp` |
| `@huggingface/transformers` Web 入口 | ⚠️ 仅理论可行 | 走 `exports.default` 可避开 native addon,但仍需解决 onnxruntime-web 的 WASM 分发与 `sharp` 的引用问题;且 hack 打包条件不推荐 |

### 调研覆盖

- `obsidian-smart-connections` 的 [`esbuild.js`](https://github.com/brianpetro/obsidian-smart-connections/blob/main/esbuild.js):把 `@huggingface/transformers` / `@xenova/transformers` 标 external,依赖独立子包 `obsidian-smart-env`,后者**单独**打包 transformers 并提供运行时解析
- 社区做法(smart-connections / copilot / infio-copilot):通过独立 npm 包或 esbuild 把 transformers 整体打进去;无一例外都要处理 onnxruntime-web 的 WASM 分发
- transformers v4 的 Node 入口分析:[`package.json`](node_modules/@huggingface/transformers/package.json) `exports.node` 指向 `transformers.node.cjs`,加载 `onnxruntime-node` / `@huggingface/tokenizers` / `sharp`
- onnxruntime-web 包体积实测:
  - JS 包:`dist/ort.min.js` 约 400KB-1MB(minified)
  - WASM 文件:`dist/ort-wasm-simd-threaded.wasm` **12MB**;WebGPU 版 `jsep.wasm` 25MB;`asyncify.wasm` 22MB

---

## Decision(决策)

**采用方案 B:完全绕开 `@huggingface/transformers` 库,直接使用 `onnxruntime-web` + 自写 WordPiece tokenizer。**

不走任何运行时 hack,也不把 transformers 整体打进 bundle。

### 模型策略(关键约束)

- **本地模式只支持一个默认模型**:`Xenova/bge-small-zh-v1.5`(512 维,WordPiece tokenizer)
- **模型权重从 ModelScope 下载**(国内源,无需翻墙);不从 HuggingFace Hub 下载
- **其他模型一律走 API embedding**:用户在设置面板配置 API 端点(DeepSeek / SiliconFlow / OpenAI 等),自行选模型
- **设置面板简化**:本地模式下不暴露模型 ID,固定为 bge-small-zh-v1.5;API 模式下用户自行填写 apiBase / apiKey / model

这样做的理由:
- 本地 Embedding 的核心价值是"零配置可用",一个模型足够
- 多模型支持增加 tokenizer 复杂度(不同模型可能用 BPE / SentencePiece),收益不大
- API 模式天然支持任意模型,用户有更灵活的选择

### 架构变更

1. **依赖调整**
   - 移除 `@huggingface/transformers`(devDependency)
   - 新增 `onnxruntime-web`(纯 JS/WASM runtime)
   - 不引入 `@huggingface/tokenizers`(native addon,不可用)
2. **新增 `src/adapters/embedding-onnx.ts`**:基于 `onnxruntime-web` 的本地 Embedding 适配器,直接实现 `EmbeddingPort`
3. **新增 `src/adapters/bert-tokenizer.ts`**:基于 `vocab.txt` 的 WordPiece tokenizer
   - 不解析完整 `tokenizer.json`
   - 实现:BasicTokenizer(NFD normalization、CJK 按字切分、小写) + WordPieceTokenizer(贪心最长匹配)
   - 支持 `[CLS]` / `[SEP]` / `[PAD]` 特殊 token 与 `maxLength` 截断
   - **仅针对 bge-small-zh-v1.5 的词表**,不做多模型抽象
4. **新增 `src/core/model-downloader-onnx.ts`**:从 ModelScope 下载 .onnx 模型权重 + `vocab.txt`
   - 下载源:`https://modelscope.cn/models/Xenova/bge-small-zh-v1.5`(具体路径 Phase 0 确认)
   - 不支持 HuggingFace Hub 下载(国内用户访问不稳定)
5. **`EmbeddingLocal` 重构**:移除 `setExtractor` 注入模式;`ModelBackend.ensureModel` 直接返回 `EmbeddingPort` 构造器或实例
6. **`ModelManager` 适配**:保持 `status$` 状态机,但 `extractor` 类型从 `unknown` 改为 `EmbeddingPort | null`
7. **保留 `EmbeddingApi`**:走远端 embedding 端点,用户自行配置 API 端点与模型

### WASM 分发策略(关键决策)

采用 **方案 A:WASM 作为 release asset,运行时从插件目录加载**。

| 方案 | 说明 | 选择原因 |
|---|---|---|
| A. release asset + 插件目录加载 | esbuild 把 `ort.min.js` 打进 main.js;`ort-wasm-simd-threaded.wasm` 作为单独文件发布到 GitHub release;`main.ts` 启动时设置 `ort.env.wasm.wasmPaths = pluginDir` | ✅ 离线可用、隐私友好、main.js 只增 ~1MB |
| B. wasm 内嵌到 main.js | 用 `ort.bundle.min.mjs` | ❌ main.js 直接 +12MB,BRAT/手动安装体验差 |
| C. 首次运行时从 CDN 下载 wasm | 不打包 wasm,由 onnxruntime-web 默认从 jsdelivr 拉取 | ❌ 首次需联网,违反"默认本地/离线运行"原则 |
| D. WebGL 后端 | 用 `ort.webgl.min.js`,不加载 wasm | ❌ WebGL 后端对部分算子支持有限,精度/兼容性待验证,暂不作为默认 |

**实施方案 A 的具体要求**:

- `esbuild.config.mjs` 把 `onnxruntime-web` 的 WASM 文件通过构建后脚本复制到 `dist/`
- `version-bump.mjs` 或 release workflow 把 `ort-wasm-simd-threaded.wasm` 与 `main.js` / `worker.js` 一并上传 GitHub release
- `main.ts` 初始化时:
  ```ts
  import * as ort from 'onnxruntime-web';
  const pluginDir = (this.app.vault.adapter as any).getFullPath(
    `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
  );
  ort.env.wasm.wasmPaths = pluginDir;
  ```
- 离线场景:插件目录包含 wasm 文件即可,无需联网

### 不采纳方案(原因)

- **方案 A1:hack `IS_NODE_ENV` / `process.release.name`** —— 只能绕过 `onnxruntime-node`,但 `@huggingface/tokenizers` 与 `sharp` 仍是 native addon,库在渲染进程仍会加载失败
- **方案 A2:hack `globalThis[Symbol.for('onnxruntime')]` 强制走 web** —— 脆弱,transformers 内部逻辑微调会让 hack 失效;且仍要处理 `sharp` / `tokenizers`
- **方案 A3:esbuild 整体打包 transformers + stub native addon** —— native addon 无法被 esbuild 真正 stub;stub 后运行时 `InferenceSession` 是空对象,会抛 `ONNX_NODE.InferenceSession is not a function`;且 bundle 体积不可控
- **方案 A4:用 transformers Web 入口(`exports.default`)** —— 需要 hack esbuild 的 condition 或 alias,且 `sharp` / `tokenizers` 的 import 仍然存在,仍需一一 stub;不如直接绕开
- **方案 C:禁用本地模式,强制 API embedding** —— 是 workaround 不是解决方案,放弃了核心能力;WASM 分发可行,不应放弃

### 已知 trade-off

- **bundle 体积**:
  - `main.js` 增加约 400KB-1MB(onnxruntime-web JS)
  - 额外发布 `ort-wasm-simd-threaded.wasm`(12MB) 作为 release asset
  - 自写 tokenizer 约 +100-200 行代码,无额外依赖体积
- **代码量**:+400-600 行(ONNX adapter + tokenizer + 下载器 + 集成)
- **维护成本**:tokenizer 需对 BGE 系列词表做测试;但 WordPiece 是公开算法,边界 case 可控
- **性能**:WASM 推理速度预计比原生 Node addon 慢 1-3 倍(具体待实测);对单条 query 影响在可接受范围,批量 indexing 仍可分片避免阻塞 UI
- **模型支持范围**:本地模式固定 `bge-small-zh-v1.5`,不支持切换;其他模型走 API embedding

---

## Consequences(后果)

**正面**:

- 彻底解决 Obsidian 渲染进程无法加载任何 native addon 的问题
- 不依赖 `@huggingface/transformers` 的版本升级、入口逻辑或运行时检测
- bundle 体积可控:main.js 只增 ~1MB,12MB wasm 作为独立 asset 不影响主 bundle 解析速度
- 离线可用,无首次 CDN 下载,符合项目"默认本地/离线运行"原则
- 同一个 `ort.InferenceSession` 抽象可后续扩展到 reranker / cross-encoder
- tokenizer 自写后,对词表级错误调试更直观

**负面**:

- 需要自写 WordPiece tokenizer,并维护多语言(CJK / 拉丁)normalization 细节
- WASM 推理性能低于原生 addon,批量索引时需更细粒度切片
- 发布流程变复杂:release asset 除 `main.js` / `worker.js` / `manifest.json` / `styles.css` 外,还需包含 `ort-wasm-simd-threaded.wasm`
- 用户手动安装插件时,若漏复制 wasm 文件,本地 embedding 会失败,需有清晰错误提示
- 失去 transformers 库的 `pipeline` 高级 API,后续加 vision / reranker 需自写 forward 逻辑
- 旧版 `ModelDownloader` 下载的模型缓存(基于 transformers pipeline 格式)不再兼容,需在首次运行新版本时清理或忽略旧缓存目录

**影响面**:

- `package.json`:移除 `@huggingface/transformers`,新增 `onnxruntime-web`
- `esbuild.config.mjs`:
  - 移除 `@huggingface/transformers` / `onnxruntime-node` external
  - 把 `onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` 复制到 `dist/`
- `src/adapters/embedding-onnx.ts`:新增,实现 `EmbeddingPort`
- `src/adapters/bert-tokenizer.ts`:新增,WordPiece tokenizer
- `src/core/model-downloader-onnx.ts`:新增,手动下载 .onnx + vocab.txt
- `src/adapters/embedding-local.ts`:重构,移除 `setExtractor`,改为 `EmbeddingOnnx` 直接实现 `EmbeddingPort`
- `src/core/model-manager.ts`:`ModelBackend` 返回 `EmbeddingPort`;`extractor` 类型改为 `EmbeddingPort | null`
- `src/main.ts`:`onLayoutReady` 改用新 adapter,并设置 `ort.env.wasm.wasmPaths`
- 测试:
  - `tests/adapters/bert-tokenizer.test.ts`(与 HF 分词结果对比)
  - `tests/adapters/embedding-onnx.test.ts`(ONNX 推理正确性)
  - `tests/integration/local-embedding.test.ts`(下载 + 推理 + 索引端到端)
- 文档:
  - `docs/architecture/rag/embedding.md` 描述新架构
  - `README.md` 说明 release asset 需包含 wasm 文件
- 发布流程:`.github/workflows/release.yml` 上传 `ort-wasm-simd-threaded.wasm`

**安全与隐私**:

- 模型权重与 wasm 文件均可离线分发,**无需首次联网**
- 模型权重从 ModelScope 下载(国内源,无需翻墙);不从 HuggingFace Hub 下载
- 全部推理本地进行,无遥测
- 若用户手动删除插件目录的 wasm 文件,运行时失败并提示,不会静默恢复为 CDN 下载

---

## 实施路径

按 writing-plans 拆解为 2-5 分钟可咬合任务,任务依赖顺序:

### Phase 0:准备(1 个任务)

1. 确认 Xenova/bge-small-zh-v1.5 的 .onnx + vocab.txt 在 ModelScope 的下载 URL
   - ⚠️ **阻塞风险**:ModelScope 上的模型命名空间可能与 HuggingFace 不同,需确认实际 model ID 与文件路径
   - 候选路径:`https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model_quantized.onnx`
   - 候选路径:`https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/vocab.txt`
   - 若 ModelScope 无此模型,备选方案:在 ModelScope 创建镜像仓库,或从 HuggingFace 下载后上传到 ModelScope
   - 验证 tokenizer 输出与 transformers pipeline 一致

### Phase 1:Tokenizer 基础(不依赖 ONNX 运行时)

2. `src/adapters/bert-tokenizer.ts` — WordPiece 实现
   - `loadVocab(path: string): Promise<Map<string, number>>`:读取 vocab.txt
   - `tokenize(text: string): string[]`:basic tokenize + wordpiece
   - `encode(text: string, maxLength = 512): { inputIds: number[]; attentionMask: number[]; tokenTypeIds: number[] }`
   - 关键测试:中英文混合、unicode normalization、CJK 切分、padding/truncation
3. `tests/adapters/bert-tokenizer.test.ts` — 单元测试
   - fixture: bge-small-zh-v1.5 的 `vocab.txt`
   - 断言:同一 text,encode 结果与 HuggingFace Transformers 的 input_ids 完全一致

### Phase 2:ONNX Embedding

4. `src/adapters/embedding-onnx.ts` — ONNX 推理
   - 实现 `EmbeddingPort`
   - `loadModel(onnxBuffer: ArrayBuffer)`:ort.InferenceSession.create
   - `embed(texts: string[]): Promise<number[][]>`:batch tokenize → run → mean pooling → L2 normalize
5. `src/core/model-downloader-onnx.ts` — 仅从 ModelScope 下载权重
   - 下载源:仅 ModelScope(国内源,无需翻墙)
   - 不支持 HuggingFace Hub 下载(国内用户访问不稳定)
   - 进度回调复用 `ProgressInfo`
   - 缓存目录沿用 `~/.cache/ratel-vault/models/<modelId>/`

### Phase 3:构建与发布

6. `esbuild.config.mjs` — 调整
   - 移除 transformers / onnxruntime-node external
   - 新增 post-build 步骤:把 `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` 复制到 `dist/`
7. `package.json` — 依赖调整
8. `.github/workflows/release.yml` — 上传 wasm asset

### Phase 4:集成

9. `src/adapters/embedding-local.ts` — 删除 `setExtractor`,重命名为 `EmbeddingOnnx` 或合并到 `embedding-onnx.ts`
10. `src/core/model-manager.ts` — `ModelBackend` 返回 `EmbeddingPort`
11. `src/main.ts` — onLayoutReady 接入新 adapter,设置 `ort.env.wasm.wasmPaths`

### Phase 5:验证

12. `tests/integration/local-embedding.test.ts` — 端到端
13. 手动验证 Obsidian 加载 + wasm asset 存在 + 模型下载 + 索引 + 搜索全流程
14. 提交 + 文档更新

---

## 参考

- [onnxruntime-web 官方文档](https://onnxruntime.ai/docs/tutorials/web/)
- [onnxruntime-web WASM 路径配置](https://onnxruntime.ai/docs/tutorials/web/env-wasm-paths.html)
- [HuggingFace tokenizers 规范](https://huggingface.co/docs/transformers/tokenizer_summary)
- [BERT WordPiece 原始论文](https://arxiv.org/abs/1810.04805)
- [BGE 模型权重 — HuggingFace](https://huggingface.co/Xenova/bge-small-zh-v1.5)
- [BGE 模型权重 — ModelScope](https://modelscope.cn/models/Xenova/bge-small-zh-v1.5)(可用性待 Phase 0 验证)
- `node_modules/@huggingface/transformers/package.json`(`exports.node` 与依赖表)
- `node_modules/onnxruntime-web/package.json`(exports 与 wasm 文件路径)
- `src/core/model-manager.ts:19-80`(`ModelBackend` 与 `ModelManager`)
- `src/adapters/embedding-local.ts:25-63`(`setExtractor` 模式)
- `src/core/model-downloader.ts:1-97`(现有 transformers pipeline 包装)
- ADR-002(Ratel Vault Worker 运行时策略)

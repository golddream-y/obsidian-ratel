# 工程文件导航

本页用于定位模块，不承载独立工作流；运行边界见各级 AGENTS.md，详细机制见架构文档。

```
src/
  main.ts           # 插件入口,生命周期管理
  settings.ts       # 设置接口与默认值
  types.ts          # TypeScript 接口与类型
  core/             # Agent Loop、Context Manager、Hooks
  ports/            # 端口接口(零实现)
  adapters/         # 适配器实现
    obsidian-vault.ts   # Obsidian API 薄包装 (TS)
    persistence-json.ts # Obsidian loadData/saveData
    vector-vectra.ts    # vectra 包装(upsertItem 支持预计算向量)
    embedding-onnx.ts   # ONNX 推理(在 Web Worker 中执行)
    embedding-worker-proxy.ts # EmbeddingPort 代理,postMessage 到 Web Worker
    llm-openai-compat.ts # OpenAI 兼容适配器(DeepSeek/Ollama 等端点)
    llm-anthropic.ts    # Claude
  tools/            # 库工具(搜索、读取、创建等)
  hooks/            # 知识治理钩子
  subagents/        # Indexer、Librarian、Reviewer、Curator
  ui/               # Svelte 视图(聊天侧栏、面板)
  worker/           # Worker 入口
    index.ts            # InlineWorker 入口(索引调度,主线程模拟)
    embedding-worker.ts # Web Worker 入口(ONNX 推理,子线程)
    inline-worker.ts    # InlineWorker 实现(主线程 Worker 模拟)
    handler.ts          # Worker 消息分发
    index-processor.ts  # 索引批处理(chunkMarkdown → 批量 embed → upsertItem)
    chunker.ts          # 文本分块(标题→段落→句子四级回退)
  utils/            # 工具函数
```

构建入口与产物以 `esbuild.config.mjs` 为准。主入口 `src/main.ts` → `dist/main.js`；索引入口 `src/worker/index.ts` → `dist/worker.js`（本地开发）；嵌入与技能脚本 Worker 代码由构建内联进主包。商店附件只包含 main.js、manifest.json、styles.css。

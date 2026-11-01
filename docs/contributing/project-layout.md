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

## 工程指令与技能

```
AGENTS.md              # 指令事实源:仓库根
AGENTS.local.md        # 本机层(路径与库名,gitignore,宿主叠加加载)
.agents/skills/        # 技能目录(宿主自动发现)
  THIRD-PARTY.md       # 第三方技能来源与许可证登记
.cursor/rules/         # Cursor 兼容副本(非事实源)
```

- **指令**:`AGENTS.md` 家族是唯一事实源。宿主按「项目根 → 当前工作目录」逐层加载,并叠加同目录的 `AGENTS.local.md`(本机私有,不入库)。
- **技能**:`.agents/skills/<name>/SKILL.md` 由宿主自动发现,frontmatter 需要 `name` 与 `description`;第三方技能的上游来源与许可证登记在 [.agents/skills/THIRD-PARTY.md](../../.agents/skills/THIRD-PARTY.md)。
- **兼容层**:`.cursor/rules/*.mdc` 只在 Cursor 中工作时另读,内容与根 `AGENTS.md` 一致;两者不一致时以 `AGENTS.md` 为准。

## 2.0 需求与演进文档

| 入口 | 职责 |
|---|---|
| [总体 PRD](../prd/2.0/README.md) | 产品目标、范围、能力全景与共同原则 |
| `docs/prd/2.0/capabilities/` | 按稳定产品能力划分的需求分册 |
| [用户故事](../prd/2.0/stories/README.md) | 用户结果、完成条件与需求映射 |
| [演进路线](../roadmap/2.0.md) | 唯一维护阶段、依赖与通过条件 |
| `docs/prd/2.0/scenarios/` | 场景示例与验收素材，不独立承诺首期范围 |
| [技术调研](../research/2.0/technology-options.md) | 开源方案、证据与待验证问题 |
| [Project 管理方案](2.0-project-management.md) | 尚待确认的字段与视图；执行规则仍以项目管理 Skill 为准 |

新增能力先在总体范围中澄清，再细化对应分册；故事按结果拆分，路线引用故事编号，确认后才按交付范围建立 spec。旧文档路径保留兼容入口，不重复维护正文。

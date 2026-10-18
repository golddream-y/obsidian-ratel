# 源码目录约束

本文件作用于 `src/` 及其后代；更深目录的规则同时适用。开始源码工作时加载根目录发现表中的开发工作流和编码约定 Skill。

## 模块边界

- `main.ts` 保持精简，只承载生命周期、注册与模块装配，功能逻辑拆到独立模块。
- 工具依赖 `ports/`，Obsidian API 访问通过 `adapters/obsidian-vault.ts` 外观；不要把宿主依赖传入纯计算模块。
- 主线程承载 Agent、上下文、工具、UI、HTTP 调用与 vectra 磁盘 IO；InlineWorker 是索引调度的主线程模拟，不等于后台计算线程。
- 首次本地嵌入所需的 ORT WASM 从 jsDelivr 下载并缓存到插件目录 `pluginDir`（ADR-006）；资源下载属于网络边界，不能称作首次运行完全离线。
- ONNX 推理通过 `EmbeddingWorkerProxy` 交给 Embedding Web Worker；Worker 的具体能力边界见 `worker/AGENTS.md`。
- 保持 `onload` 轻量；文件事件进入索引前去抖；嵌入按批次调用，不逐 chunk 发请求。默认批次等参数以实现为准，不能把文档数字当成永远不变的契约。
- 用户可见字符串必须国际化；字段清单、例外和审查要求以编码约定 Skill 为准，这一要求同样适用于 UI 之外的错误和工具展示。

## 实现原则

- TypeScript 保持 strict；优先 async/await；使用插件 `register*` 管理清理，每个模块职责明确。
- 不引入原生模块；当前索引使用 vectra，持久化使用 JSON。变更这些选型需单独确认架构影响。
- 模型 API 和索引状态的失败不能伪装成功；日志、错误与工具返回遵守项目隐私边界。

# 架构决策记录索引

> 这里收录已经采纳的技术选型与边界决定。每条记录回答「当时为什么这样定」,现役行为以代码与 `docs/architecture/` 为准。

新增记录沿用「日期 + 主题」文件名,标题写明 ADR 编号;编号只增不改,避免外部引用失效。

## 记录清单

| 编号 | 主题 | 文件 |
|---|---|---|
| ADR-001 | LLM 端点的 CORS 处理策略 | [2026-06-14-ratel-cors-strategy.md](2026-06-14-ratel-cors-strategy.md) |
| ADR-002 | Worker 运行时策略 | [2026-06-18-worker-runtime-strategy.md](2026-06-18-worker-runtime-strategy.md) |
| ADR-003 | 本地 Embedding 运行时策略 | [2026-06-18-local-embedding-architecture.md](2026-06-18-local-embedding-architecture.md) |
| ADR-004 | Agent Loop 步数上限与截断处理 | [2026-06-27-agent-loop-max-steps.md](2026-06-27-agent-loop-max-steps.md) |
| ADR-005 | 索引阻塞 UI 的根因与修复策略 | [2026-06-27-index-ui-blocking.md](2026-06-27-index-ui-blocking.md) |
| ADR-006 | 商店发版资产分发(Worker 内联 + WASM 懒下载) | [2026-06-28-release-asset-distribution.md](2026-06-28-release-asset-distribution.md) |
| ADR-007 | 模型 Context Window 配置策略 | [2026-06-28-model-context-window-registry.md](2026-06-28-model-context-window-registry.md) |
| ADR-008 | Prompt Registry 设计决策 | [2026-07-04-prompt-registry.md](2026-07-04-prompt-registry.md) |
| ADR-009 | Skill 机制三源加载与端口设计 | [2026-07-06-skill-mechanism.md](2026-07-06-skill-mechanism.md) |
| ADR-012 | Skill 激活对齐 Claude | [2026-07-23-skill-activation-claude-aligned.md](2026-07-23-skill-activation-claude-aligned.md) |
| ADR-013 | 图谱检索默认「少靠人整理」 | [2026-08-03-graph-retrieval-minimize-human-curation.md](2026-08-03-graph-retrieval-minimize-human-curation.md) |
| ADR-014 | MCP Host 平台级接入 | [2026-08-03-mcp-host-platform.md](2026-08-03-mcp-host-platform.md) |
| ADR-015 | 能力池:统一意图选择 | [2026-08-03-capability-pool.md](2026-08-03-capability-pool.md) |
| ADR-016 | 分层注入与统一注入管理器 | [2026-08-19-layered-injection.md](2026-08-19-layered-injection.md) |
| ADR-017 | Skill 脚本沙箱双层运行时 | [2026-08-19-skill-script-sandbox-worker-vm.md](2026-08-19-skill-script-sandbox-worker-vm.md) |
| ADR-018 | 生态出站:官方清单 + GitHub release | [2026-09-18-ecosystem-outbound.md](2026-09-18-ecosystem-outbound.md) |
| ADR-019 | Cordis 插件框架作为技术储备 | [2026-08-20-cordis-tech-reserve.md](2026-08-20-cordis-tech-reserve.md) |
| ADR-020 | 收笔护栏 | [2026-09-27-turn-completion-guard.md](2026-09-27-turn-completion-guard.md) |
| ADR-021 | 检索链路关键决策调整 | [2026-10-26-retrieval-pipeline.md](2026-10-26-retrieval-pipeline.md) |
| ADR-022 | 索引清单独立于 data.json | [2026-06-28-index-manifest-standalone-file.md](2026-06-28-index-manifest-standalone-file.md) |
| ADR-023 | 索引「非推理开销」暂不优化 | [2026-11-08-index-non-inference-overhead.md](2026-11-08-index-non-inference-overhead.md) |

## 编号缺口

| 编号 | 状态 |
|---|---|
| ADR-010 | 内置能力与 Skill 的边界。被 ADR-012、ADR-014 引用为既有前提,但正文从未提交到仓库 |
| ADR-011 | 未提交。据 ADR-021 记载,相关引用已改指 ADR-021 与 ADR-013 |

补写缺口记录前不要复用这两个编号,以免与此前的引用产生歧义。

## 相关文档

- [架构总览](../architecture/overview.md) — 现役系统结构与各领域文档入口
- [工程文件导航](../contributing/project-layout.md) — 源码目录与文档位置

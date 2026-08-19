# S-MCP-HOST — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-19 — P-MCP-HOST-DOCS(隐私与用户文档同步)+ spec 归档

**方案时效核查:** plan 写于 2026-08-03,执行时发现 7 项勾选中 3 项(README 双语、user-guide 主体、CHANGELOG)已在此前发版流程中同步完成,实际剩 4 项:

| 项 | 文件 | 状态 | 备注 |
|---|---|---|---|
| 架构补页(新建) | `docs/architecture/host/mcp.md` | ✅ | 角色/配置/入册/权限/非目标,链 ADR-014/015;overview 与 capability-surface 互链同步更新 |
| AGENTS.md 网络边界 | `AGENTS.md` | ✅ | 「唯一网络调用/只能模型 API」→ 与 ADR-014 一致(默认模型 API;MCP opt-in) |
| S-EVOLUTION 边界修订 | `specs/2026-07-15-evolution-graph-agent.md` | ✅ | 划掉「不做联网搜索」旧表述,改指 ADR-014 + host/mcp.md |
| user-guide secret ID | `docs/user-guide.md` | ✅ | 补 `ratel-mcp-<serverId>` 表行 |

**无代码变更,无测试影响。spec 使命完成,同日归档。**

---

## 2026-08-03 — P-MCP-HOST-UI(抽屉 Modal + Trace + spawn + 动态权限)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| ManageModal / Trace / i18n + 修 spawn 重入 | `src/ui/` `src/adapters/mcp-*.ts` | ✅ | `8acc064` | feat(mcp) |

**测试总数:** 归档时未记录,详见 git log
**分支:** cursor/s-mcp-host-spec-5933(已合并)
**Plan 偏差:** 归档时未写逐 task 日志,详见 git log

---

## 2026-08-03 — P-MCP-HOST-CORE(Port + 双 transport + Client + Host + 入册,8 Task)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| McpHostPort + stdio/HTTP 双 transport | `src/ports/mcp.ts` `src/adapters/mcp-{stdio,http,sse,jsonrpc}.ts` | ✅ | 见 git log | 入 ToolRegistry |
| 随 0.1.16 发版 | — | ✅ | `c366559` | release: 0.1.16 — MCP Host |

**测试总数:** 归档时未记录,详见 git log
**分支:** cursor/s-mcp-host-spec-5933(已合并)
**Plan 偏差:** 归档时未写逐 task 日志,详见 git log

# P-MCP-HOST-DOCS — MCP 隐私与用户文档同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP Host 功能落地后，按 AGENTS.md 文档同步规则更新用户可见文档与架构补页（**执行前须向用户确认勾选**）。

**Architecture:** 无代码行为变更；只改 markdown。触发点为 finishing-a-development-branch / 本 plan 启动时用户确认。

**Tech Stack:** Markdown

**Spec:** [S-MCP-HOST](../specs/2026-08-03-mcp-host-design.md) §4.12 · **依赖:** CORE + UI 已 Completed

## Global Constraints

- **禁止**在功能未落地时抢先改 README 隐私段冒充已支持
- 执行本 plan 前向用户展示勾选清单并获确认
- 中文文档优先；README 中英同步

---

## 确认清单（启动时问用户）

```
MCP 已落地，是否同步文档：
 [ ] README / README.zh-CN（隐私：默认仅模型 API；MCP opt-in）
 [ ] docs/user-guide.md（抽屉 MCP 入口、管理 Modal、对话 Trace 标识、权限、secret ID `ratel-mcp-<id>`、stdio 确认、FAQ）
 [ ] CHANGELOG.md `[Unreleased]`（Added：可挂 MCP Server…）
 [ ] S-EVOLUTION 非目标：划掉「不做联网搜索」，链 ADR-014
 [ ] docs/architecture/host/mcp.md（新建：Client 生命周期 / transport 摘要）
 [ ] AGENTS.md 网络边界表述（若仍写「仅模型 API」则改为与 ADR-014 一致）
```

未勾选的项不改。

---

### Task 1: 按勾选项改文档

**Files（按勾选）：**
- `README.md` / `README.zh-CN.md`
- `docs/user-guide.md`
- `CHANGELOG.md`
- `docs/superpowers/specs/2026-07-15-evolution-graph-agent.md`
- `docs/architecture/host/mcp.md`（新建）
- `AGENTS.md`
- `docs/architecture/overview.md`（若需链到 host/mcp.md）
- `docs/superpowers/STATUS.md`

- [ ] **Step 1: 与用户确认勾选**

- [ ] **Step 2: 按勾选编辑；CHANGELOG 用场景语言（禁止堆模块名）**

示例 Added 条：

```markdown
### Added
- 可在设置中添加 MCP 服务器（HTTP / 本地命令）：Agent 自动发现并调用其工具；默认不配置则不额外出站。
```

- [ ] **Step 3: `host/mcp.md` 骨架（若勾选）**

含：角色图、配置字段、tools/list→register、权限默认 ask、密钥 ID、非目标（Resources…）、链 ADR-014/015 与 capability-surface。

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md docs/
git commit -m "docs: MCP Host 隐私与用户文档同步"
```

---

## 自审

| Spec §4.12 | 本 plan |
|---|---|
| 确认后改、不抢先 | ✓ |
| secret ID / user-guide | Task 1 |
| S-EVOLUTION 边界 | Task 1 勾选 |

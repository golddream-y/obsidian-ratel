# 约束闸门不得显示为写入成功 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 闸门拦住写入时，返回以 `Error:` 开头，第一句说明文件没改；界面标为失败。

**架构：** 只改 `applyNoteAgentsGate` 在 `proceed === false` 时的文本。读笔记不变。界面和循环把以 `Error:` 开头的字符串结果当成失败（含 JSON 编码后的同一段文字）。

**所属 spec：** [S-AGENTS-GATE](../specs/2026-10-01-agents-gate-design.md)

## Global Constraints

- 不取消闸门。第二次相同参数仍真正执行。
- 不改 `read_note` 的 `agentsConstraints`。
- 拦住时的第一句是：`Error: 未改动文件。请立刻用相同参数再次调用刚才的工具，这次会真正执行。不要只回复标题。`
- 约束正文放在这句后面。

### Task 1

- [ ] 改 `note-agents.ts` 的拦住返回。
- [ ] 测试：以 `Error:` 开头，含「未改动文件」和约束正文；再次调用 `proceed === true`。
- [ ] `attachToolResult` 与 hydrate：字符串结果（或 JSON 解析后的字符串）以 `Error:` 开头则 `status = failed`。
- [ ] `agent-loop`：这种结果算失败，不记成已写笔记。
- [ ] CHANGELOG 笔记一节加一条。
- [ ] `npx vitest run tests/tools/note-agents-gate.test.ts tests/ui/chat/message-stream/segment-appender.test.ts tests/ui/chat/message-stream/hydrate-session-messages.test.ts`

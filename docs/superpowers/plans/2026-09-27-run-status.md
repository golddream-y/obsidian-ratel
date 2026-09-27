# S-RUN-STATUS 实施 Plan

**Goal:** 消息球旁边一行能看出正在等、正在写（带随机气象/星象句）还是正在用哪个工具，并从第 2 步标出步数。

**Architecture:** 文案拼装放在 `src/ui/chat/run-status-line.ts`。MessageList 每 4 秒推进一拍。ChatView 在 `message.start` 上累计步数，目标进行时把原状态条文案交给这一行，状态条在对话中不再叠目标黄条。

**Spec:** [2026-09-26-run-status-design.md](../specs/2026-09-26-run-status-design.md)

## 约束

- 优先级：重试 > 工具友好名 > `撰写中 · 随机句` > 三句等待。
- 随机池 30 句，中英同下标。图标只出现在规格列出的那几句中文上。
- 相邻两拍不重复。第 1 步不加「第 n 步」。目标进行中用 `goal.strip.running` 代替步数后缀。
- 不改球的动画种类。不把索引和模型下载挪进这一行。

## 任务

1. 纯函数与测试：`src/ui/chat/run-status-line.ts`、`tests/ui/chat/run-status-line.test.ts`。
2. i18n：`orb.run.*` 写入 `types.ts`、`zh.ts`、`en.ts`。
3. 接线：`MessageList.svelte` 显示拼好的行；`ChatView.svelte` 计步并在运行中隐藏目标条、把目标文案传入消息球。

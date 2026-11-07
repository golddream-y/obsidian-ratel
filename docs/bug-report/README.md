# 缺陷诊断记录索引

> 这份索引收录按现场证据写下的缺陷诊断。它们记录当时的症状、定位过程与结论,属于历史材料;当前行为以代码、测试与 [CHANGELOG](../../CHANGELOG.md) 为准。

新增诊断沿用「日期 + 症状」文件名。正文写完之后不再改写结论,本索引只负责让它可被找到。

## 记录清单

| 日期 | 主题 | 记录内容 | 文件 |
|---|---|---|---|
| 2026-06-26 | ChatView 打开时 `e.subscribe is not a function` | 症状、根因与修改方案 | [2026-06-26-chatview-subscribe-error.md](2026-06-26-chatview-subscribe-error.md) |
| 2026-06-26 | Embedding 状态卡在「加载中」 | 症状、根因与修改方案 | [2026-06-26-embedding-status-stuck-loading.md](2026-06-26-embedding-status-stuck-loading.md) |
| 2026-06-26 | 工具权限弹窗点「允许」仍报拒绝 | 症状、根因与修改方案 | [2026-06-26-tool-confirm-allow-bug.md](2026-06-26-tool-confirm-allow-bug.md) |
| 2026-06-27 | ChatView UI 对齐与流式渲染回归 | 三类问题的成因与改动 | [2026-06-27-chat-ui-and-streaming-regression.md](2026-06-27-chat-ui-and-streaming-regression.md) |
| 2026-10-28 | 点击发送后白屏 | 系统崩溃报告取证;文档自述「不能宣称已修复」 | [2026-10-28-send-renderer-crash-diagnosis.md](2026-10-28-send-renderer-crash-diagnosis.md) |
| 2026-10-29 | 重启后重复全量索引与进度倒退 | 现状取证与待验证动作 | [2026-10-29-index-restarts-after-relaunch.md](2026-10-29-index-restarts-after-relaunch.md) |

表内不判定修复状态:这些文档写在修复当时,结论以正文为准;实际交付内容见 [CHANGELOG](../../CHANGELOG.md)。

## 相关文档

- [更新日志](../../CHANGELOG.md) — 各版本实际交付的变更
- [架构总览](../architecture/overview.md) — 现役系统结构

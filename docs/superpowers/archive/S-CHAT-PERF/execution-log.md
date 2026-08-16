# S-CHAT-PERF — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-16 — P-CHAT-PERF-3(块级虚拟滚动)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| RenderUnit 投影器 | src/ui/chat/message-stream/render-unit-projector.ts | ✅ | squash | 消息投影为稳定渲染单元 |
| 虚拟窗口 | src/ui/chat/message-stream/virtual-window.ts | ✅ | squash | 可变高度布局 + 焦点/选择保留 |
| MessageList 集成 | src/ui/chat/message-stream/MessageList.svelte | ✅ | squash | 阅读锚点补偿 |
| ChatView 虚拟跳转 | src/ui/chat/ChatView.svelte | ✅ | squash | 右侧点列跳回屏幕外消息 |

**测试总数:** 1081 tests / 0 failed
**分支:** 已 squash 合并,随 0.2.4(1efd98c)发版
**Plan 偏差:** CRLF 归一化、任务列表引用误判等审查修复随各阶段落地

---

## 2026-08-15 — P-CHAT-PERF-2(稳定 Markdown 块冻结)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 稳定块识别 | src/ui/chat/message-stream/stable-markdown.ts | ✅ | squash | marked 词法分析;引用/任务列表/CRLF 边界修复 |
| 增量投影 | StableMarkdownProjection | ✅ | squash | 流式期间最小化词法分析调用 |

**测试总数:** 1064 tests / 0 failed
**分支:** 已 squash 合并

---

## 2026-08-15 — P-CHAT-PERF-1(流式轻渲染)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 流式轻渲染 | src/ui/chat/message-stream/ | ✅ | squash | 文本段轻追加,段结束富渲染 |
| 滚动合帧 | MessageList.svelte | ✅ | squash | requestAnimationFrame 合帧 |

**测试总数:** 1044 tests / 0 failed
**分支:** 已 squash 合并

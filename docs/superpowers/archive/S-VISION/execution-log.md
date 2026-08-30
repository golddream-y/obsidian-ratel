# S-VISION — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-30 — P-VISION-1(图片消息真正发给模型)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 0 适配器正名 | llm-deepseek → llm-openai-compat | ✅ | squash | 零行为改名 |
| Task 1 端口 AttachmentRef / supportsImages | src/ports/llm.ts | ✅ | squash | |
| Task 2 AttachmentStore + 入库 | src/core/attachment-store.ts, context-manager.ts | ✅ | squash | v1.3 外置,session 只存引用 |
| Task 3 VISION_UNSUPPORTED | src/core/agent-loop.ts | ✅ | squash | |
| Task 4 适配器透传 | src/adapters/llm-openai-compat.ts | ✅ | squash | localhost `images[]`;远端开开关走 OpenAI `image_url` |
| Task 5 UI / i18n / hydrate | ChatView, hydrate, chat-error | ✅ | squash | 发送即清预览;chatVisionEnabled |
| Task 6 验证与文档 | CHANGELOG 0.5.1, user-guide §3.1, README 带图一词 | ✅ | 本归档提交 | OpenRouter 手测通过 |

**测试总数:** 视觉相关 24 passed;全量偶发 skill-script-sandbox 心跳 flake(存量,与本 plan 无关)
**分支:** feat/p-vision-1 squash → develop `99a2bce`;随后归档 + 发版号 0.5.1
**Plan 偏差:** 见 plan 末偏差表(attachments 独立字段、无 Anthropic、端点级能力、远端开关 v1.4)

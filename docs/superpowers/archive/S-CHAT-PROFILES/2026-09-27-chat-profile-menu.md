# S-CHAT-PROFILES 顶栏菜单 Plan

**Goal:** 点顶栏模型名或 `/model` 时，在按钮下展开已保存的配置菜单并切换，不再打开只读弹窗。

**Architecture:** 菜单是 ChatView 里的一层，样式对齐现有会话菜单。切换调用已有 `switchChatProfile`，并走设置里「设为当前」的同一段后续：`applyModelContextWindow`、写回该套上限、`saveSettings`、`rebuildLLM`、Notice。不发对话请求。

**Spec:** [2026-09-24-chat-profiles-design.md](../specs/2026-09-24-chat-profiles-design.md) 的 CP-08

## 约束

- 每行两行字：`name`，下面等宽 `model`。当前套有标记。
- 点另一行即切换。点当前行只收起。点空白处或再点模型名收起。
- 底部「在设置中管理」打开 Ratel 设置页，与现在 Modal 里的跳转相同。
- 不列出服务商目录，不展示密钥。
- 文案走 i18n。`model-info-modal.ts` 可以留着，但顶栏和 `/model` 不得再 `open()` 它。
- 工作区已有未提交改动，只改本任务相关文件，不要还原别人的改动。

## 任务

### Task 1

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`
- 可新建小组件，若会话菜单的浮层模式能直接复用则放在 `src/ui/chat/`

点顶栏 `.ratel-header-model` 切换菜单显隐。菜单 `position` 贴在按钮下、靠右。`/model` 打开同一菜单。

切换实现对照 `src/ui/settings/chat-profiles-render.ts` 里「设为当前」的 `onClick`：`switchChatProfile` → `applyModelContextWindow` → 写回 active profile 的上限字段 → `saveSettings` → `rebuildLLM` → `settings.chatProfiles.switched` Notice。查不到窗口时用现有 `settings.notice.contextLengthUnknown`。

i18n 新增菜单底部文案，中文「在设置中管理」，英文 “Manage in settings”。

验证：`npx vitest run src/i18n/strings.test.ts`。本任务没有合适的纯函数时，不必为 Svelte 菜单硬造渲染测试。提交只包含本任务文件。

提交说明：`feat: 顶栏模型名展开已保存配置菜单`

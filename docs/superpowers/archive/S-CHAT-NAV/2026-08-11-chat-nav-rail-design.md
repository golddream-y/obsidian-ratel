# S-CHAT-NAV — 对话进度轨（可拖左右 + 回底 + 跳 user 轮次）

> **ID:** S-CHAT-NAV  
> **状态:** Active  
> **日期:** 2026-08-11  
> **前置:** S-CHAT-UI-V3（Conversation-first / sticky-to-bottom）；P-CHAT-PROTO 已 Completed  
> **动机:** 长对话上滑后难回底、难跳回某轮提问；对标 ChatGPT/Cursor 的回底共识，并补齐扩展生态常见的「进度 + 可定位导航」，适配 Obsidian 窄侧栏。

---

## 1. 背景

调研结论：

- **官方共识**（ChatGPT / Claude / Cursor / VS Code Chat）：离开底部 → 出现「回到底部」。
- **扩展补齐**（AIChatNav / Chat Outline 等）：大纲、跳轮次、可拖浮层、跳转高亮。
- Ratel 已有 sticky-to-bottom 逻辑，但 **无可视回底控件**，也 **无阅读进度 / 跳 user 轮次**。
- StatusStrip 右侧 `%` 是 **上下文 token 占用**，与「滚到会话哪里」不同，不得混用同一视觉语言。

产品决策（brainstorming）：

- 做 **P1**：方案 **A — 右侧细轨**（非悬浮球、非完整 Outline）。
- 能力 = 滚动进度拇指 + 回底 + 点刻度跳 user 轮次 + 左右吸附可调位置。

---

## 2. 目标

1. 消息区提供 **细进度轨**：表示当前视口在会话中的阅读位置。  
2. **刻度 = user 轮次**；点击滚到该轮用户消息顶部并短暂高亮。  
3. **离开底部**时轨上出现回底控件；贴底隐藏。  
4. 轨可在消息区 **左 / 右吸附**，位置与总开关持久化。  
5. 内容不足以滚动时 **整轨隐藏**。  
6. 用户可见文案走 i18n。

成功标准（可验收）：

- 长对话上滑后可见 ↓，一点回底并恢复自动贴底。  
- 点某 user 刻度后视口落到该气泡顶部，有短暂高亮。  
- 拖到对侧吸附后，重载插件位置仍在。  
- 关闭设置开关后轨不渲染。  
- Strip 的上下文 `%` 语义与文案不变；本轨不显示「0%」类 token 占用数字。

---

## 3. 非目标

- 完整 Outline 树、搜索过滤、分支树（Claude 式）。  
- 自由拖到任意像素坐标（只左右吸附）。  
- 键盘 Alt+J/K（可列后续）。  
- 把压缩上下文 / 展开 StatusDrawer 绑到轨上。  
- 改 Agent Loop / 消息协议 / 工具权限。

---

## 4. 详细设计

### 4.1 信息架构

```
ChatView
├── Header
├── 消息区包裹层（position: relative）
│   ├── MessageList（.ratel-messages 可滚动）
│   └── ChatNavRail（绝对定位，左或右）
└── composer（StatusStrip / Drawer / Input）  ← 不动
```

- 轨挂在 **消息区包裹层**，不盖住 composer。  
- 滚动容器仍是现有 `.ratel-messages`；沿用 `containerRef` + `onScroll` + `isUserNearBottom`。

### 4.2 视觉与交互

| 元素 | 规格 |
|---|---|
| 轨宽 | 约 3–4px 轨道 + 可点热区加宽（命中约 12–16px），避免难点 |
| 拇指 | 表示视口中心（或顶部）在 `scrollTop / (scrollHeight - clientHeight)` 的比例 |
| 刻度 | 每个 `role === 'user'` 消息一个点；`title` = 该轮文本摘要（首约 24 字，去空白） |
| 回底 | 仅 `!isUserNearBottom` 时显示；点击 → 滚到底 + 恢复 sticky |
| 左右 | 默认 `right`；拖轨（或拖柄）越过中线则吸附到对侧并 `saveSettings` |
| 显隐 | `scrollHeight <= clientHeight + ε` → 不渲染；开关关闭 → 不渲染 |
| 刻度过多 | 超过阈值（建议 12）抽稀：保留首、尾、当前视口附近；其余可合并；hover 用 title 或短 popover 列出被合并项（实现可选，但不可静默丢跳转能力——至少 title 指向代表轮次） |

**跳转反馈：** `scrollIntoView({ block: 'start', behavior: 'smooth' })`（或等价计算 `scrollTop`）；目标气泡加临时 class（约 800–1200ms）后移除。

**拖拇指：** 跟手改 `scrollTop`；与点刻度共用同一滚动容器。拖左右改侧时 **不** 改变 scrollTop。

**文案禁忌：** UI 与 i18n 使用「对话位置 / 对话进度」等，避免与 Strip「上下文 %」混淆；轨上 **不** 显示 token 百分比数字。

### 4.3 设置

```typescript
/** 对话进度轨总开关 */
chatNavRailEnabled: boolean; // 默认 true

/** 进度轨吸附侧 */
chatNavRailSide: 'left' | 'right'; // 默认 'right'
```

- 设置页（聊天或外观相关分组）暴露开关 + 左右下拉（或仅开关，左右只靠拖改——**推荐两者都有**，拖改与下拉双向同步）。  
- 不进入 `toolPermissionLevel` / 工具确认流。

### 4.4 组件边界

| 单元 | 职责 |
|---|---|
| `chat-nav-rail.ts`（纯函数） | 由 `Message[]` 提取 user 锚点；抽稀；由 scroll 度量算拇指比例与「是否需要轨」 |
| `ChatNavRail.svelte` | 渲染轨 / 刻度 / 拇指 / 回底；拖侧；点击回调 |
| `ChatView.svelte` | 包裹层、传入 messages / scroll 状态 / side / enabled；执行滚动与高亮；写 settings |
| `MessageBubble` 或列表项 | 可选 `data-msg-id` / 高亮 class，供 query 与反馈 |

消息需稳定锚点：优先用现有 message `id`；若无则 plan 阶段补稳定 id（实施时不得靠脆弱的 index-only 长期方案——index 仅可作退化）。

### 4.5 数据流

1. `onScroll` → 更新 `isUserNearBottom` + 拇指比例。  
2. `messages` 变化 → 重算 user 锚点列表（抽稀）。  
3. 点刻度 → `scrollToMessage(id)` → 高亮。  
4. 点回底 → 现有滚底逻辑 + sticky=true。  
5. 拖侧 / 设置变更 → `plugin.settings.chatNavRailSide|Enabled` + `saveSettings()`（经现有 settings$ 扇出若已接）。

### 4.6 无障碍

- 轨：`role="slider"` 或导航 `aria-label`（对话位置）。  
- 回底：`button` + `aria-label`。  
- 刻度：`button` 或可聚焦点，名称含摘要。  
- 不依赖仅颜色区分当前拇指与刻度。

### 4.7 i18n（最低集）

- `chat.nav.rail.aria` — 对话位置  
- `chat.nav.backToBottom` — 回到底部  
- `chat.nav.tick.aria` — 跳到：{summary}  
- `settings.chatNavRailEnabled.name` / `.desc`  
- `settings.chatNavRailSide.name` / `.desc` / `.left` / `.right`

### 4.8 测试

纯函数优先 TDD：

- 提取 user 锚点 — 空列表 / 仅 assistant / 交错 user  
- 抽稀 — ≤12 原样；>12 含首尾与当前附近  
- `needsRail(scrollHeight, clientHeight)`  
- `thumbRatio(scrollTop, scrollHeight, clientHeight)` 钳制 [0,1]

组件冒烟：build；手动 — 长对话回底、跳轮次、换侧持久化、关开关。

---

## 5. 影响面

| 区域 | 影响 |
|---|---|
| `src/ui/chat/` | 新组件 + ChatView 包裹；MessageList/Bubble 可能加 data 属性与高亮样式 |
| `src/settings.ts` + i18n | 两字段 + 设置项 |
| `styles.css` | 若需压 Obsidian 全局样式，可补全局选择器（参考 perm-btn） |
| StatusStrip / Drawer | **无功能耦合** |
| user-guide | 实施末补一小段「对话位置轨」 |
| CHANGELOG | `[Unreleased]` Added |

架构文档 / ADR：不触发（无新子系统目录级端口；纯 UI）。若日后抽 `ports/` 再评估。

---

## 6. 参考

- Ratel sticky-to-bottom：`ChatView.svelte` + `MessageList.svelte`  
- S-CHAT-UI-V3 Conversation-first（Strip 上下文 % ≠ 本轨）  
- VS Code PR：chat scroll-to-bottom 浮钮  
- 扩展：AIChatNav / ChatNav（大纲与可拖——本 spec 只吸收「跳转 + 可定位」，不做大纲）

---

## 7. 实施建议（非 plan）

建议单 plan `P-CHAT-NAV`，任务大致：

1. 纯函数 + 测试  
2. settings + i18n  
3. `ChatNavRail.svelte` + ChatView 接线  
4. 高亮 / 抽稀 / 左右拖  
5. user-guide + CHANGELOG + STATUS  

执行前另开 writing-plans 产出可勾选 Task。

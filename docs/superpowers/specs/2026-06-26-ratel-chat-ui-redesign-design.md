# S-CHAT-UI — Ratel Chat UI 重设计

## 背景

当前 ChatView 顶部有一个 `StatusBar.svelte`，展开时堆叠多行状态文字，视觉臃肿。同时 Obsidian 原生 `Notice`（顶部 toast）与 Chat 内风格割裂，索引进度、模型下载、初始化等进度类通知频繁弹出干扰用户。

用户反馈"顶部的提示太丑了"，期望底部放一个工作条，索引状态等低频信息可展开查看。

### 当前痛点

1. **顶部 StatusBar 展开形态占位大** — 多行堆叠压缩聊天内容区域
2. **原生 Notice 风格割裂** — 进度类 toast 与 Chat 内深色 UI 不一致
3. **无上下文使用率感知** — 用户无法知道当前对话已用多少 token，接近上限时无预警
4. **无快捷操作入口** — 清空对话只能关闭重开侧栏，压缩上下文、切模型、重建索引无快捷方式
5. **无图片上传通道** — 虽底层 LLM 适配器已支持 vision，但 UI 无附件入口

## 目标

1. 删除顶部 StatusBar 展开形态，改为底部 30px 单行 `StatusLine` 常驻
2. `StatusLine` 点击向上展开 `StatusDrawer`，分"向量化 / 索引"和"上下文"两区
3. 进度类 `Notice` 迁移到 `StatusLine` 内嵌进度 + `StatusDrawer` 详情，消除顶部 toast 干扰
4. `StatusLine` 右侧常驻上下文使用率（进度条 + 百分比），80% 变黄、95% 变红
5. 输入区支持斜杠命令（`/new`、`/compact`、`/model`、`/reindex`）
6. 输入区预留图片上传通道（附件按钮 + 缩略图预览条）
7. 所有颜色复用 Obsidian CSS 变量，禁止硬编码 hex，禁止 box-shadow

## 非目标

- **不实现** LLM 多模态图片发送的完整链路 — 本 spec 只做 UI 预留（按钮 + 预览条 + 缩略图展示），图片转 base64 发送给 LLM 的逻辑留给后续 spec
- **不实现** 上下文压缩的完整 LLM 摘要算法 — 本 spec 只做 UI 入口 + 确认弹窗，压缩逻辑复用现有 context-manager 的 truncate 能力，LLM 总结式压缩留给后续 spec
- **不实现** `/model` 切换的完整模型选择器 — 本 spec 只做命令入口 + 简易下拉，模型管理逻辑复用现有设置
- **不改** `FeedbackController` 的错误类 Notice — 严重错误仍弹一次原生 Notice，只在 `StatusLine` 同步显示图标提示
- **不改** Agent Loop、Context Manager、Worker 等核心逻辑 — 纯 UI 层重构

## 详细设计

### 1. 整体布局

```
┌─────────────────────────────┐
│  ChatHeader (Ratel + badge)  │  ← 保留现有，不动
├─────────────────────────────┤
│                              │
│       Messages Area          │  ← 顶部干净，无状态条
│                              │
├─────────────────────────────┤
│  StatusLine (30px, 常驻)     │  ← 新增，替换旧 StatusBar
├─────────────────────────────┤
│  StatusDrawer (展开时出现)    │  ← 新增
├─────────────────────────────┤
│  AttachmentStrip (有附件时)   │  ← 新增预留
│  InputRow (附件按钮 + 输入框) │  ← 改造
│  SlashMenu (输入 / 时弹出)    │  ← 新增
└─────────────────────────────┘
```

**ChatHeader 保留不动** — 当前 `Ratel` 标题 + 模型 badge 已足够简洁。

**顶部彻底无状态条** — 旧 `StatusBar.svelte` 的所有信息迁移到 `StatusLine` + `StatusDrawer`。

### 2. StatusLine 组件（常驻底部）

**职责：** 单行展示高频状态，点击展开 Drawer。

**布局（左→右）：**

```
[状态点] [状态文字]              [ctx进度条] [百分比] [▲]
```

**状态点 + 文字（5 种状态）：**

| 状态 | 点样式 | 文字 | 文字色 | 触发条件 |
|------|--------|------|--------|---------|
| 就绪 | 绿点稳定（`--text-success`） | 就绪 | `--text-normal` | 模型配置完成且空闲 |
| 思考中 | 黄点脉冲（`--text-warning`） | 思考中… | `--text-warning` | Agent Loop 正在请求 LLM |
| 错误 | 红点（`--text-error`） | 请求失败 | `--text-error` | 上一次请求出错，点击查看详情 |
| 未配置 | 灰圈空心（`--text-muted` border） | 未配置 | `--text-muted` | 未配置 API Key 或模型 |
| 索引中 | 黄点脉冲（`--text-warning`） | 索引中 | `--text-warning` | Worker 正在索引（与"思考中"互斥，索引中优先显示） |

**上下文使用率（右侧常驻）：**

- `ctx-bar`：48px 宽 × 4px 高的进度条
- `ctx-pct`：百分比文字（`--font-monospace`，10px）
- 颜色阈值：
  - 0-79%：`--text-success`（绿）
  - 80-94%：`--text-warning`（黄）
  - 95-100%：`--text-error`（红）
- 点击 `ctx-meter` 区域不触发展开 Drawer（只有点 StatusLine 左侧区域才展开）

**展开提示：** 右侧 `▲` 图标，Drawer 展开后变为 `▼`。

**点击区域划分：**
- StatusLine 左侧（状态点 + 状态文字 + `▲` 图标）→ 点击展开/收起 Drawer
- StatusLine 右侧（ctx 进度条 + 百分比）→ 点击不展开 Drawer（避免误触），未来可预留跳转上下文管理

**数据源：**
- 状态点/文字 ← `userStatus.statusBar$` store（已有）
- 上下文使用率 ← 新增 `contextUsage$` store，由 context-manager 在每次 send 前计算并广播

### 3. StatusDrawer 组件（展开时出现）

**职责：** 展示低频详情，分两区。

**展开/收起动画：** `max-height: 0 → 380px` + `transition: 0.25s ease`。

**区域 1：向量化 / 索引**

| 行 | label | value |
|----|-------|-------|
| 索引进度 | 索引 | 处理中 12/30（或"就绪 128 篇"） |
| 进度条 | — | 4px 进度条（`--text-warning` 处理中 / `--text-success` 就绪） |
| 当前文件 | 当前文件 | `Guides/Link notes.md`（`--font-monospace`） |
| Embedding | Embedding | 就绪 / 处理中 / 未配置 |
| 运行模式 | 运行模式 | hint-pill 显示"内联"或"Worker" |
| 降级提示 | — | `⚠ 主线程内联模式。大库索引较慢，可在设置启用 Worker 线程。`（仅内联模式显示） |

**区域 2：上下文**

| 行 | label | value |
|----|-------|-------|
| 已用 / 上限 | 已用 / 上限 | `12,420 / 200,000 tokens` |
| 附件 | 附件 | `2 张图片 (估 374 tokens)` |
| 压缩按钮 | — | `压缩上下文` micro-btn，靠右 |

**分区标题样式：** 10px 大写灰色文字（`--text-muted`）+ 底部 1px 边框（`--background-modifier-border`）。

**数据源：**
- 索引区 ← `userStatus.statusBar$` + `userStatus.indexProgress$`（已有）
- 上下文区 ← `contextUsage$` store（新增）

### 4. Notice 迁移策略

**迁移规则：**

| Notice 类型 | 当前行为 | 迁移后 | 说明 |
|-------------|---------|--------|------|
| 模型下载进度 | 顶部 toast + 百分比 | `StatusLine` 进度条 + Drawer 详情 | 不弹 toast |
| 初始化阶段提示 | 顶部 toast | `StatusLine` 状态文字 | 不弹 toast |
| 索引进度（全量） | 顶部 toast + 逐文件 | `StatusLine` 状态文字 + Drawer 进度条 | 不弹 toast |
| 索引完成 | 顶部 toast | `StatusLine` 状态恢复"就绪" | 不弹 toast |
| 增量索引完成 | 顶部 toast | `StatusLine` 状态恢复 | 不弹 toast，不干扰 |
| 严重错误 | 顶部 toast | **保留 toast** + `StatusLine` 红点 | 仍弹一次确保可见 |
| 降级警告 | 顶部 toast | Drawer 降级提示行 | 不弹 toast |

**实现方式：** 改造 `FeedbackController`，新增 `showProgress(stage, done, total)` 和 `showStatus(text, type)` 方法，替代 `Notice` 直接调用。`showError(msg)` 仍调 `new Notice(msg)`。

### 5. 斜杠命令（SlashMenu）

**触发：** 输入框内容以 `/` 开头且不含空格时弹出。

**命令清单：**

| 命令 | 描述 | 行为 |
|------|------|------|
| `/new` | 开始新对话，清空当前上下文 | 清空 messages 数组 + 重置 contextUsage |
| `/compact` | 压缩上下文，将历史总结为摘要 | 调用 context-manager 的 truncate + 弹确认 |
| `/model` | 切换模型 | 弹出简易下拉列表（从 settings 已配置模型中选） |
| `/reindex` | 重新索引 vault | 调用 index-controller 的 fullIndex |

**交互：**
- 输入 `/` 弹出全部命令
- 继续输入过滤（如 `/n` 只显示 `/new`）
- 上下键选择，回车确认，Esc 关闭
- 点击菜单项直接执行
- 选中项高亮（`--background-modifier-border-hover`）

**布局：** 从输入框上方弹出（`position: absolute; bottom: 100%`），`--background-secondary` 背景 + 边框。

### 6. 图片上传预留

**UI 组件：**
- `AttachmentStrip`：输入框上方，横向滚动的缩略图条（56×56px）
- `attach-btn`：输入框左侧 `+` 按钮，点击触发文件选择
- 缩略图右上角 `×` 删除按钮
- 已发送图片在消息气泡内以 96×96px 缩略图展示

**数据流（本 spec 只做 UI + 状态管理，不发 LLM）：**
- 选择图片 → 存入 `pendingAttachments$` store（base64 + 文件名 + 估算 token）
- 发送消息 → 图片随消息存入 messages 历史
- Drawer 附件行显示 `N 张图片 (估 X tokens)`

**限制：**
- 仅支持图片（`image/png`、`image/jpeg`、`image/webp`、`image/gif`）
- 单张 ≤ 5MB
- 单次最多 4 张

### 7. CSS 变量映射

所有颜色必须映射到 Obsidian CSS 变量，禁止硬编码：

| 用途 | Obsidian 变量 |
|------|--------------|
| 主背景 | `--background-primary` |
| 次背景（StatusLine / Drawer / SlashMenu） | `--background-secondary` |
| 三级背景（hover / 消息卡 / 输入框） | `--background-modifier-form-field` |
| 边框 | `--background-modifier-border` |
| 悬停边框 | `--background-modifier-border-hover` |
| 主文本 | `--text-normal` |
| 次要文本 | `--text-muted` |
| 就绪/成功 | `--text-success` |
| 警告/处理中 | `--text-warning` |
| 错误 | `--text-error` |
| 主交互色（Send 按钮 / 选中高亮） | `--interactive-accent` |
| 等宽字体 | `--font-monospace` |

**圆角：** 消息卡 8px、输入框/按钮 6px、工具调用项/标签 4px、状态点 50%。

**禁止 box-shadow** — 用 `border: 1px solid var(--background-modifier-border)` 表达层次。

### 8. 新增 Store

**`contextUsage$`** — 上下文使用率 store

```typescript
interface ContextUsage {
  usedTokens: number;
  maxTokens: number;       // 模型上限
  attachmentTokens: number; // 待发送附件估算
  percentage: number;      // derived: usedTokens / maxTokens * 100
}
```

- 由 context-manager 在每次 send 前 / 收到响应后更新
- StatusLine 订阅 `percentage` 显示进度条 + 百分比
- StatusDrawer 订阅完整对象显示详情

**`pendingAttachments$`** — 待发送附件 store

```typescript
interface PendingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  base64: string;
  estimatedTokens: number;
}
```

- 图片选择时 push，删除时 remove
- 发送后清空
- StatusDrawer 附件行订阅 `length` + `estimatedTokens` 汇总

### 9. 组件文件结构

```
src/ui/
  ChatView.svelte          # 改造 — 移除旧 StatusBar，挂载新组件
  StatusBar.svelte         # 删除 — 被 StatusLine + StatusDrawer 取代
  StatusLine.svelte        # 新增 — 常驻底部单行状态
  StatusDrawer.svelte      # 新增 — 展开式详情面板
  SlashMenu.svelte         # 新增 — 斜杠命令弹窗
  AttachmentStrip.svelte   # 新增 — 图片附件预览条
  confirm-modal.ts         # 已有 — 压缩确认复用
```

### 10. 依赖关系

**不改动的模块：**
- `core/agent-loop.ts` — Agent Loop 逻辑不变
- `core/tool-permissions.ts` — 不涉及
- `worker/*` — 不涉及

**新增/改动的模块：**
- `ui/StatusLine.svelte` — 新增
- `ui/StatusDrawer.svelte` — 新增
- `ui/SlashMenu.svelte` — 新增
- `ui/AttachmentStrip.svelte` — 新增
- `ui/ChatView.svelte` — 改造布局
- `ui/StatusBar.svelte` — 删除
- `user-feedback/user-status.ts` — 新增 `contextUsage$` store
- `core/feedback-controller.ts` — 改造进度类通知
- `core/context-manager.ts` — 新增 `getContextUsage()` 方法

## 影响面

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/ui/ChatView.svelte` | 改造 | 移除 StatusBar，挂载 StatusLine / StatusDrawer / SlashMenu / AttachmentStrip |
| `src/ui/StatusBar.svelte` | 删除 | 功能被 StatusLine + StatusDrawer 取代 |
| `src/ui/StatusLine.svelte` | 新增 | 常驻底部单行状态 |
| `src/ui/StatusDrawer.svelte` | 新增 | 展开式详情面板 |
| `src/ui/SlashMenu.svelte` | 新增 | 斜杠命令弹窗 |
| `src/ui/AttachmentStrip.svelte` | 新增 | 图片附件预览条 |
| `src/user-feedback/user-status.ts` | 改造 | 新增 `contextUsage$` store |
| `src/core/feedback-controller.ts` | 改造 | 进度类通知迁移到 StatusLine |
| `src/core/context-manager.ts` | 改造 | 新增 `getContextUsage()` 方法 |
| `docs/architecture/agent/chat.md` | 更新 | 同步新布局描述 |
| `docs/architecture/host/settings.md` | 不涉及 | 无新设置项 |

## 参考

- [chat-ui-mockup.html](file:///Users/golddream/code/git-public/Ratel-CLI/.superpowers/brainstorm/chat-ui-mockup.html) — 交互式 mockup
- [obsidian-ui SKILL.md](file:///Users/golddream/code/git-public/Ratel-CLI/.trae/skills/obsidian-ui/SKILL.md) — Obsidian UI 开发规范
- [ChatView.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/ChatView.svelte) — 现有实现
- [StatusBar.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/StatusBar.svelte) — 现有实现（将被删除）
- [feedback-controller.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/core/feedback-controller.ts) — 现有 Notice 控制器

# S-MEMORY-MODAL — 记忆管理并入聊天主路径（Modal 统一壳）

> **ID:** S-MEMORY-MODAL  
> **状态:** Active  
> **日期:** 2026-07-31  
> **前置:** [S-MEMORY / P-MEMORY-UI](../archive/S-MEMORY/)（独立记忆 ItemView + brain ribbon）  
> **动机:** 独立记忆侧栏与聊天侧栏双入口抬高使用复杂度；次要能力（反馈 / 赞助 / 记忆）交互壳不统一。

---

## 1. 背景

当前记忆管理是独立 Obsidian 视图：

- `VIEW_TYPE_MEMORY`（`ratel-memory-panel`）+ `MemoryPanelView` 挂载 `MemoryPanel.svelte`
- Ribbon `brain` 与聊天 `paw-print` 并列
- 设置「打开记忆面板」调用 `activateMemoryView()`

同时，聊天侧栏状态抽屉底部已有低频入口：**问题反馈**（Modal）、**赞助**（外链）。记忆若继续用第二侧栏 / 侧栏内切页，会形成「有的弹框、有的抽屉、有的侧栏」的混杂心智。

产品判断：记忆面板是**低频治理面**（浏览 / 编辑 / 清理模型记忆），使用频率远低于对话；应与反馈同级，不应与对话平级。

---

## 2. 目标

1. **降低插件使用复杂度** — 用户默认只面对一个 Ratel 聊天侧栏。  
2. **统一次要能力壳** — 状态抽屉只做运维信息；抽屉底部链接进入次要能力：反馈 / 赞助 / 记忆。记忆与反馈均为 **Obsidian Modal**（赞助保持外链）。  
3. **能力不缩水** — Modal 内挂载现有 `MemoryPanel.svelte`，筛选 / 搜索 / 行内编辑 / 清理模型记忆全量保留。  
4. **拆除双入口** — 删除 brain ribbon 与独立记忆 ItemView；设置 / 命令改走同一 `openMemoryModal()`。

成功标准：

- 无 brain ribbon；工作区无 `ratel-memory-panel` 常驻 leaf。  
- 抽屉「记忆」与设置入口打开同一全量记忆 Modal。  
- 嵌套确认（清理 / 删除）不误关主 Modal。  
- 对话、记忆文件模型、Agent 工具行为不变。

---

## 3. 非目标

- 重做记忆视觉或信息架构大改。  
- 改 `.ratel/memory/` 格式、`MemoryStore`、记忆注入 / 工具语义。  
- 把赞助改成 Modal；把状态抽屉改成记忆内容容器。  
- 侧栏内「对话 | 记忆」分段切换（已否决，避免第三种壳）。  
- 用 Obsidian `Setting` API 重写记忆列表（无用户可感知收益）。

---

## 4. 详细设计

### 4.1 交互模型（已选定：方案 C + 实现方案 1）

| 层级 | 职责 |
|------|------|
| 状态条 / StatusDrawer | 仅索引 / Embedding / 上下文 +「压缩」 |
| 抽屉底部操作链 | 同级静默入口：问题反馈、赞助、**记忆** |
| Modal | 反馈 = `FeedbackModal`；记忆 = `MemoryModal`（内嵌 `MemoryPanel`） |
| 外链 | 赞助按语言打开 `SPONSOR*.md` |

### 4.2 入口

- **抽屉：** `onMemory` → `plugin.openMemoryModal()`；i18n `status.drawer.memory`（中文「记忆」/ 英文 `Memory`）。  
- **设置：** 原 `activateMemoryView` 按钮改为 `openMemoryModal()`（可直接 `new MemoryModal(...).open()`，不依赖聊天 leaf 已挂载）。  
- **命令：** 若存在「打开记忆面板」，改为同一 API；不强制新增命令。

### 4.3 `MemoryModal`

- `extends Modal`；`titleEl` 用 `memory.panel.title`。  
- `contentEl` 增加 `ratel-memory-modal`（或等价 class）：加宽、限制 `max-height` + 内部滚动，避免窄弹框。  
- `onOpen`：`mount(MemoryPanel, { target, props: { plugin } })`；必要时 `applyRatelAppearance`。  
- `onClose`：`unmount` + `contentEl.empty()`。  
- **单例策略（实现选定其一并写进 plan）：** 推荐 plugin 持有当前实例；已打开则 focus/忽略二次 open，避免叠多个记忆 Modal。

### 4.4 拆除清单

- 删除 ribbon `brain`。  
- 删除 `registerView(VIEW_TYPE_MEMORY)`、`MemoryPanelView.ts`（或归档后删）。  
- 删除 / 替换 `activateMemoryView()` leaf 逻辑。  
- 插件加载或 `onload` 末尾：`detachLeavesOfType(VIEW_TYPE_MEMORY)`，清理工作区残留标签。

### 4.5 嵌套 Modal

- `MemoryPanel` 内清理 / 删除确认继续用独立 `Modal`。  
- 确认框只关闭自身；取消 / 确认后主 `MemoryModal` 保持打开，列表按现逻辑刷新。

### 4.6 数据与错误

- 仍只经 `plugin.memoryStore`；打开时 `loadMemories()`，关闭不后台轮询。  
- 加载失败走现有 `loadError` UI；`memoryStore` 未就绪时 Notice 或禁用入口（与设置开关对齐）。

---

## 5. 影响面

| 区域 | 变更 |
|------|------|
| `src/ui/memory-panel/` | 新增 `MemoryModal`；删除或停用 `MemoryPanelView`；`MemoryPanel.svelte` 尽量不动 |
| `src/ui/status/StatusDrawer.svelte` + `ChatView.svelte` | 增加记忆入口 |
| `src/main.ts` | `openMemoryModal`；去 ribbon / registerView |
| `src/settings.ts` | 按钮 action 改线 |
| i18n | `status.drawer.memory` |
| `docs/user-guide.md` / README | 入口描述更新 |
| CHANGELOG | `[Unreleased]` 记用户可感知变化（发版时再收） |

---

## 6. 测试要点

- 抽屉 / 设置打开记忆 Modal，全量能力可用。  
- 无 brain ribbon；无记忆 ItemView 注册。  
- 嵌套确认不关主 Modal。  
- 反馈 / 赞助入口不回归。  
- 可选：Modal mount/unmount 单测（mock Obsidian Modal + svelte mount）。

---

## 7. 参考

- 归档：`docs/superpowers/archive/S-MEMORY/`  
- 现网反馈壳：`src/ui/chat/feedback-modal.ts`  
- 抽屉操作链：`src/ui/status/StatusDrawer.svelte`

# S-SETTINGS-SYNC — Settings 读入口统一（全局状态热更新）

> **ID:** S-SETTINGS-SYNC  
> **状态:** Active  
> **日期:** 2026-08-03  
> **前置:** `settingsRevision` / `appearanceRevision`（S-UI-APPEARANCE）；Context Length 抽屉不同步修复（`fix(settings): 上下文长度变更同步抽屉上限`）  
> **动机:** `plugin.settings` 为可变普通对象，Svelte 看不见字段赋值；靠各处手动 `void $settingsRevision` 订漏即「设置改了、界面还旧」。需要**单一读入口**收口，而不是继续打补丁。

---

## 1. 背景

### 1.1 现状（三套并行）

| 通道 | 机制 | 用途 |
|------|------|------|
| `plugin.settings` + `settingsRevision` | 可变对象 + 版本号 bump | Chat 芯片、embed 类型、上下文上限等 |
| `appearanceRevision` | 独立版本号 | `applyRatelAppearance` |
| `UserStatus` / `memoryRevision` | 正经 Svelte writable | 索引 / embedding / 上下文用量 / 记忆列表 |

`saveSettings()` 成功后会 `bumpSettingsRevision()` + `bumpAppearance()`。展示侧若忘记订阅 revision，UI 继续读到**旧语义**（对象引用未变，字段已改）。

### 1.2 已暴露与同类风险

| 症状 / 位置 | 根因类型 | 状态 |
|-------------|----------|------|
| 设置改 Context Length → 抽屉上限不变 | 写路径未同步 `chatModelMaxTokens` + 读路径未订 revision | 已有独立 fix；本 spec 将其纳入统一读模型 |
| Chat 发送 gate（是否要 Key） | 只跟 `keyTick`，改 `chatApiBase` / 预设不立刻刷新 | **待本 spec** |
| Memory 面板页脚 `memoryStorageLimitMB` | 模板直接读 `plugin.settings`，未订 revision | **待本 spec** |
| 模型芯片 / embed 类型 | 已手工 `void $settingsRevision` | 迁入统一入口后删除特例 |
| 外观 | `appearanceRevision` 专用链 | **保留**；不并入 settings$ 的 CSS apply 路径（见非目标） |

### 1.3 为什么不能继续「哪里漏了补哪里」

- 审查成本高：每个 `.svelte` 是否 `void $settingsRevision` 靠人记。  
- 写路径与读路径职责混杂（例如下拉只写 preset、token 上限另字段）。  
- 与 `UserStatus` 等真 store 心智不一致，新人易再引入同类 bug。

---

## 2. 目标

1. **单一读入口** — 常驻 UI（Chat / Status / Memory 等）展示 settings 派生值时，只通过 `settings$`（或等价 API）订阅，禁止在 `.svelte` 展示路径裸读 `plugin.settings.xxx`。  
2. **单一写通知** — 任意持久化 settings 变更仍经 `saveSettings()`（或明确登记的旁路），成功后 bump，使 `settings$` 发出新快照。  
3. **消除已知陈旧点** — gate、Memory 上限、上下文 `maxTokens` 与芯片类展示全部跟快照走。  
4. **可测试** — `bump` / 快照内容有单测；关键 UI 字段有「改 settings → 订阅方看到新值」的回归用例。

成功标准：

- `.svelte` 展示路径无裸 `plugin.settings.`（允许：事件回调内一次性读取、Modal 打开瞬间快照、非 UI 的 TS 模块命令式读取）。  
- 改 Context Length / Base URL / memoryStorageLimitMB 时，已打开的 Chat 抽屉、gate、Memory 页脚在**无需聚焦输入框**的情况下更新。  
- 不引入深层 Proxy；不把 Obsidian `loadData/saveData` 改成全量响应式框架。

---

## 3. 非目标

- 将整个 `RatelVaultSettings` 改成深度 Proxy / Immer / 细粒度字段 store。  
- 合并或废除 `appearanceRevision`（外观 apply 链继续独立；settings$ 可同时被外观订阅方用来读 scheme/accent，但 **bumpAppearance 时机与 apply 调用保留**）。  
- 把 `UserStatus`（索引进度、embedding 状态、流式 token）并入 settings$。  
- 重做设置面板 UI 或声明式 settings schema。  
- 本期上 ESLint 自定义规则（可作为后续硬化；一期用 code review 清单 + grep 守卫）。  
- 改 MCP Host / 图谱扩邻等无关功能。

---

## 4. 详细设计

### 4.1 选定方案：只读快照 store（`settings$`）

在现有 `settingsRevision` 之上（或替换对外用法）提供：

```typescript
/** 只读快照；每次 bump 后替换为浅拷贝，Svelte 可订阅 */
export const settings$: Readable<Readonly<RatelVaultSettings>>;

export function publishSettingsSnapshot(settings: RatelVaultSettings): void;
// saveSettings 末尾: publishSettingsSnapshot(this.settings) + 兼容 bumpSettingsRevision
```

设计要点：

- **写仍命令式**：业务代码继续改 `plugin.settings` 字段，再 `await saveSettings()`。  
- **读对 UI 响应式**：组件用 `$settings.chatModel`、`$settings.memoryStorageLimitMB` 等。  
- **快照形态**：`publish` 时 `{ ...settings }` 浅拷贝；嵌套对象（`toolPermissions`、`mcpServers`、`promptOverrides`）若 UI 需感知内部变更，publish 时对**已知嵌套**做一层拷贝（`{ ...toolPermissions }`、`mcpServers: [...mcpServers]` 等），避免「替换了数组引用但 store 未通知」之外的陈旧。一期列出嵌套拷贝清单（见 4.3）。  
- **循环依赖**：`settings-revision.ts`（或新 `settings-store.ts`）只依赖 `RatelVaultSettings` **类型**；`main.ts` 在 `saveSettings` 调用 `publish`；禁止 store 模块 import `main`。

### 4.2 与 `settingsRevision` 的关系

**推荐：** 保留 `settingsRevision` 数字版本（便于非 Svelte 订阅方 / 测试断言），`publishSettingsSnapshot` 内部同时 `settingsRevision.update(n => n+1)` 并 `settings$.set(snapshot)`。  

迁移期：现有 `void $settingsRevision; return plugin.settings.x` 改为直接读 `$settings.x`；迁移完成后 ChatView 内不再出现「void revision + 裸读」模式。

### 4.3 嵌套字段拷贝清单（一期）

publish 时至少：

| 字段 | 拷贝方式 |
|------|----------|
| 顶层标量 | 浅拷贝覆盖 |
| `toolPermissions` | `{ ...obj }` |
| `promptOverrides` | `{ ...obj }` |
| `mcpServers` | `[...arr]`（元素仍为原引用；改单条 server 字段后若未换数组，写路径须换新数组或显式 publish） |
| `mcpApprovedSpawns` | `[...arr]` |

写路径约定：改嵌套结构时，赋值新对象/新数组（MCP Modal 已有多数此模式），再 `saveSettings`。

### 4.4 `saveSettings` 扇出（派生投影）

除 publish 快照外，在 `saveSettings` 成功路径增加**显式派生**（双保险，抽屉即使漏订也不易旧）：

| 派生 | 动作 |
|------|------|
| 上下文上限 | `userStatus.patchContextUsage({ maxTokens: getEffectiveChatModelMaxTokens(settings) })` |
| （可选）外观 | 已有 `bumpAppearance()`，保持 |

ChatView 内仅靠 `$effect` 订 settings 的逻辑可简化为：优先信任 saveSettings 扇出；组件仍可用 `$settings` 驱动芯片文案。

### 4.5 写路径加固（与读入口配套）

| 场景 | 要求 |
|------|------|
| Context Length 下拉 | 必须 `applyContextLengthPreset`（非 custom 同步 `chatModelMaxTokens`）— 已有 fix，纳入本契约 |
| `setControlValue` | 唯一设置页写入枢纽；新增多字段 key 必须同步相关字段 |
| 旁路改 settings（外观、MCP Modal 等） | 必须最终 `saveSettings()`（或调用 `publishSettingsSnapshot` + 持久化）；禁止只改内存不 publish |
| 密钥不在 settings 明文 | gate 的 `hasChatApiKey` 仍可能需 `keyTick`/聚焦刷新；**settings 侧** `chatApiBase` 变化必须经 settings$ 更新 gate 的「是否需要 Key」分支 |

### 4.6 消费方改造清单

| 文件 | 改动 |
|------|------|
| `src/ui/settings-revision.ts` 或新 `settings-store.ts` | `settings$` + `publishSettingsSnapshot` |
| `src/main.ts` `saveSettings` | publish + 扇出 maxTokens |
| `src/ui/chat/ChatView.svelte` | 芯片 / embed / gate / maxTokens 改读 `$settings`；gate 订 `$settings`（不再只靠 keyTick 覆盖 Base 变更） |
| `src/ui/memory-panel/MemoryPanel.svelte` | 页脚上限读 `$settings.memoryStorageLimitMB` |
| `src/ui/status/*` | 继续订 `contextUsage$`；上限由扇出保证 |
| 设置页 / Modal | 保持命令式写；打开瞬间读可以继续用 `plugin.settings` |

### 4.7 错误与初始化

- `onload` `loadSettings` 完成后立刻 `publishSettingsSnapshot`，避免首屏 `$settings` 为空。  
- 插件 `onunload`：无需清空 store（进程内插件卸载即可）；若测试复用模块，提供 `resetSettingsStoreForTests()`。  
- publish 失败不阻断 `saveData`（先持久化再 publish；publish 抛错只打 devLogger）。

---

## 5. 影响面

| 区域 | 变更 |
|------|------|
| `src/ui/settings-revision.ts`（或新建 store 模块） | API 扩展 |
| `src/main.ts` | saveSettings / loadSettings 挂钩 |
| Chat / Memory 等 `.svelte` | 读路径迁移 |
| 测试 | store 单测 + gate/Memory 回归 |
| 文档 | ADR 短文可选（「settings 展示必须经 settings$」）；user-guide **不需要**（无用户可见新能力） |
| CHANGELOG | 若用户可感知「改设置立刻反映到抽屉/gate」→ `[Unreleased]` Fixed 一条；纯内部收口可发版时再写 |

架构文档：新增模块文件属于 `ui/` 下既有 revision 能力扩展，**默认不改** `docs/architecture/`；若拆新目录再评估。

---

## 6. 测试要点

1. `publishSettingsSnapshot` — 修改字段后订阅方 `get(settings$)` 为新值；旧快照对象不被原地篡改。  
2. `saveSettings`（mock loadData/saveData）— 调用后 revision +1 且 `settings$.chatModelMaxTokens` 与内存一致。  
3. Context Length — 切 `1M` 后 `getEffectiveChatModelMaxTokens` 与 `contextUsage.maxTokens` 均为 `1048576`。  
4. Gate — 仅改 `chatApiBase`（云 → localhost）后，无需 `keyTick`，硬拦状态按新 Base 更新（单元测 `evaluateChatSendGate` + 组件层订 settings$ 的胶水测择一）。  
5. Memory 页脚 — 改 `memoryStorageLimitMB` 后展示分母变化（组件测或 store 订阅读断言）。  
6. 回归：外观 bump、UserStatus 索引进度不受影响。

---

## 7. 实施拆分（供后续 plan）

建议两期 plan（writing-plans 时再拆 Task）：

1. **P-SETTINGS-SYNC-CORE** — store API、saveSettings/loadSettings 挂钩、扇出 maxTokens、单测。  
2. **P-SETTINGS-SYNC-UI** — ChatView / MemoryPanel / gate 迁移；删除「void revision + 裸读」；grep 守卫清单写入 plan 验收。

优先级：可与 MCP DOCS 并行；**不阻塞** MCP 功能合并。建议在 Context Length fix 合入 main 后基于 main 实施，避免重复冲突。

---

## 8. 参考

- `src/ui/settings-revision.ts`、`src/ui/appearance/appearance-store.ts`  
- `src/user-feedback/user-status.ts`  
- `src/utils/context-window.ts`、`src/ui/tokens/context-length-presets.ts`（`applyContextLengthPreset`）  
- 相关 fix PR：上下文长度同步抽屉（`cursor/fix-context-length-drawer-sync-5933`）  
- AGENTS.md — 文档同步规则；本变更用户可见面为「设置热更新更可靠」，finishing 时确认是否写 CHANGELOG Fixed  

# S-CHAT-SETUP 实施 Plan

**Goal:** 对话模型页按原型只编辑当前这一套；工具权限和高级里不常用的整组改成二级页。字段不减，只换地方。

**Architecture:** 提供商由地址推断，不新造一套和地址重复的存储。`windowUserSet` 记在每一套配置上。二级页用现有的设置子页（诊断已经是这种），主页只留入口。

**Spec:** [2026-09-27-chat-setup-design.md](../specs/2026-09-27-chat-setup-design.md)

**原型:** [settings-chat-setup.html](../../prototype/settings-chat-setup.html)

## 约束

- 五个顶栏名字和顺序不变。
- 嵌入、索引、精排、外观、目标、记忆开关、日记、库外、MCP 留在各自主页。
- 密钥不进 `data.json`，只在展开的那一套上。
- 窗口数字不得大于映射表查到的值。查不到才手填，并提示，不沿用上一个模型。
- 顶栏配置菜单不改。
- 文案走 i18n。

## Task 1: 当前套的提供商、模型名、窗口

**Files:**
- `src/settings/chat-profiles.ts`（`ChatProfile` 增加 `windowUserSet`）
- `src/ui/settings/chat-profiles-render.ts`（展开区：提供商、条件地址、模型名、窗口一行）
- `src/settings.ts`（删场景预设组；对话模型组里不再重复模型名和地址；高级主层删窗口组）
- `src/settings/settings-apply.ts`（提供商变更走现有预设写入）
- 测试：`tests` 里已有 chat-profiles 的文件上补：Ollama 不要求密钥；`windowUserSet` 为真时同模型不重新查表；换模型名后标志清除

点中的配置下面展开。DeepSeek / Ollama 不渲染地址框。自定义才渲染。改模型名时若 `windowUserSet` 为假则查表写上限；为真且模型名未变则不动。用户把数字改小则 `windowUserSet = true`。大于查到的窗口时钳到查到的值。

## Task 2: 二级页

**Files:**
- `src/settings.ts`（工具权限、映射表、生态开关、提示词、记忆上限、开发者改为 `type: 'page'` 入口）
- 新建子页文件，放在 `src/ui/settings/`，形态对齐 `diagnostics-setting-page.ts`
- 诊断入口留在高级，仍进现有诊断页

每页有返回（设置子页自带）。页内控件与现在相同，不改默认值。

## 自审

- 提供商不另存，避免和地址两套真相。旧库打开时用地址判断。
- `contextLengthPreset` 的档位下拉去掉后，查到的非 128k/256k/1M 整数只放在 `chatModelMaxTokens`，并用 `windowUserSet` 区分「查表结果」和「用户改小」。不能只用 `custom` 表示用户锁定，否则查表得到的 100 万也会被当成用户锁定。
- 二级页不删字段。工具权限仍是每个工具一行，只是不铺在记忆页上。
- 未纳入：从接口拉取模型列表；顶栏菜单；嵌入多套。
- 风险：声明式 `page` 的返回栈如果和诊断页不一致，Task 2 先照诊断页做，不另造一层导航。

## 执行记录 / 偏差说明

> 暂停于 2026-09-28，供下一个 Agent 衔接。分支：`feat-chat-setup`（worktree：`.worktrees/feat-chat-setup`）。

### Task 完成情况

| Task | 实现 commit | 审查修复 | 规范审查 | 质量审查 |
|---|---|---|---|---|
| Task 1 当前套的提供商、模型名、窗口 | `efa6c34` | `b01de81`（清理死代码三件套、localhost 常量单一真相、查表口径收敛） | PASS | APPROVED |
| Task 2 二级页 | `a8cac4d` | 无（两阶段审查一次通过） | PASS | APPROVED |

基线登记 commit：`833f835`（P-CHAT-SETUP → In Progress）。plan 起始点对照分支：`develop` 的 `a61a5ae`。

### 偏差（已在审查中确认合理）

1. **Task 2 采用声明式 `items` 子页**，未照 plan 文字「形态对齐诊断页的命令式 `SettingPage` 工厂」。核实 `obsidian.d.ts`：`SettingDefinitionPage.items?: SettingDefinitionItem[]`（`@since 1.13.0`，与 `page` 工厂互斥），返回栈同由框架处理；控件定义原样搬移、零行为漂移。manifest `minAppVersion: "1.13.0"` 满足。
2. `syncChatWindow` 的共享查表辅助签名定为 `lookupModelContext(registry, registryUrl, model)` 而非 `(registry, settings)`：保住 `ChatWindowSyncDeps.registryUrl` 的既有注入契约，URL 解析（`resolveRegistryUrl`）与查表正交。
3. Task 1 额外改了 `src/ui/chat/activate-chat-profile.ts`（顶栏切套复用 `syncChatWindow`），超出 plan 文件清单但符合 CS-01，改动最小。
4. 顺手删了旧迁移逻辑 `normalizeContextLengthSettings` 中「custom/0 静默回填 256k」分支（否则违反 CS-04「不静默」），运行时由 `getEffectiveChatModelMaxTokens`（`<4096` 回落 256k）兜底。

### 测试基线

- 全套约 **1824 通过 / 1 失败**：唯一失败是 `src/skills/skill-script-sandbox.test.ts` 的 progress 心跳用例（已知时序 flake，高负载触发，单独复跑 19/19 通过；该文件本分支未动）。
- typecheck / eslint：本次涉及源码文件零新增报错（仓库 tsc 基线本有约 224 个存量错误）。

### 下一个 Agent 的待办（按顺序）

1. **Sandbox 实机预览（必做，测试覆盖不到）**：`npm run build` → 只链 Obsidian Sandbox → Reload app without saving。核对：对话模型页点中一套后展开；DeepSeek/Ollama 无地址框；换模型窗口一行；六个二级页点入口能进、返回能回主页；搜索时入口放开。
2. **两个 Minor 收尾（可选，审查建议）**：
   - 六个已成孤儿的旧 group heading i18n key（`settings.toolPermissions.heading` / `promptOverrides.heading` / `memory.settings.limitsHeading` / `developer.heading` / `ecosystem.heading` / `advanced.heading`）在 zh/en/types 三处删除。
   - 契约测试低成本补强：工具权限页加代表 key 或 items 数量下限；提示词页断言 render 行数 === `listEditableSections().length + 2`。
3. **最终整体 code review**：`git diff a61a5ae..HEAD` 全量再审一次。
4. **finishing-a-development-branch 流程**：文档同步确认（重点：README 功能清单无增可不动；user-guide 设置页操作指引需评估；CHANGELOG 需补一条「设置页变短，长项收进二级页」；架构文档已在 Task 中改）→ 合并 develop → STATUS 标记 Completed → 主动询问是否归档 S-CHAT-SETUP。

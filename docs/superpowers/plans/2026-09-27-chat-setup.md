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

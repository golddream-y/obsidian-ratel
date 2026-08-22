# P-GOAL-1:Agent 目标模式(Goal Mode)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **修订:** 2026-08-22 自审修订 — F1 usage 跨步累计(message.end 新增字段)、F2 成功写判定写死、F3 UserStatus/StatusStrip 两面区分、F4 现网优先级链说明、F5 拒裸 `*`、F6 迁移表枚举、F7 绑定悬空惰性比较。

**Goal:** 落地 S-GOAL v1.1 — goal 落盘存储(单活 + 会话绑定 + 损坏隔离)、目标级 grant 白名单权限、锚定 ephemeral 注入、`manage_goal` 工具面、GoalRunner 回合编排(usage 累加 / predicate 收口 / 无进展守卫 / 预算闭环)、StatusStrip 与 onload 集成。

**Architecture:** 四层分离 — ① `goal-store.ts` 纯存储(原子写 tmp+rename,单活仲裁,corrupt 隔离,可直测);② `goal-guard.ts` 纯函数守卫(无进展主信号 + 三层预算,无 IO 可直测);③ 权限与注入两个薄钩子(`goal-grant.ts` 插入 `resolveToolPermission` deny 检查之后;injector 注册 `goal` 段,复用 S-SR-LAYERING 通道);④ `goal-runner.ts` 回合编排,**包装 `plugin.ask()`** 而非另起循环——复用现有压缩重试 / 权限门 / 钩子 / session 保存管线,消费 `AgentEvent` 流做记账与收口。

**Tech Stack:** TypeScript strict / node:fs(promises)(主线程桌面端,goal 文件在 pluginDir)/ vitest / Svelte 5(仅 StatusStrip 文案与提示条)/ 无新 npm 依赖(glob 用现成 `globToRegex`)。

**关联文档:**
- Spec: [S-GOAL v1.1](../specs/2026-08-22-agent-goal-mode.md) — 本 plan 全部语义以它为准
- 被取代设计: [S-TASK(归档)](../archive/S-TASK/2026-08-19-agent-task-store.md)

---

## 与 spec 的偏差(均为落地所需)

| spec 原文 | 实际 | 原因 |
|---|---|---|
| 4.10 `manage_goal` 动作级 ask | 工具级默认 `allow` + 动作内 Modal | 通用权限门按工具名决策,无法动作级 ask;复用 `run_skill_script` 先例(P-SKILL-2:工具 allow + 工具内 TrustGate,避免双弹窗)。用户仍可在设置中把工具整体设为 ask/deny |
| 4.4/4.5 runner 驱动回合 | runner 包装 `plugin.ask()` | ask 已含 overflow 压缩重试、权限、钩子、finally 落盘;另起循环必然复制这些管线 |
| 4.8 predicate 数据源 | `metadataCache.frontmatter` | 千级库逐文件全文读不可行;经 ObsidianVault 外观取缓存 |
| 4.11 本轮动态步骤条 | v1.1 降级不做,仅 StatusStrip 忙态 | spec 已预留降级;先验证核心循环,UI 明细条待核心稳定后评估 |
| 4.7 单回合 token 软上限 | settings 字段就绪,默认 `0`(关) | 首版由 `maxSteps`(默认 50)硬顶兜底;字段与检查逻辑就位后开默认值 |
| 4.1 `GoalPredicate` 仅 frontmatter-all | 同左,`path-covered` 不实现 | 评审 Important 7 已删 |
| 4.7 usage「自 message.end 真值累加」 | agent-loop `message.end` payload **新增可选跨步累计字段** `stepPromptTokens` / `stepCompletionTokens` | 现有 `promptTokens/completionTokens` 取自 `lastUsage`,每步覆盖、只余最后一步(F1);直接累加会系统性少算 completion。新增字段向后兼容,旧字段不动;runner 优先读新字段,缺失时降级旧字段并 devLogger.warn |
| 现网优先级链说明 | 会话 grant 实际位于破坏性检查之前(`grants.has` 先返回),本 plan **不改变**该既有行为 | spec 4.6 的链是目标态文档;goal grant 与破坏性的相对顺序因白名单排除而恒等价,无需重排现有代码(F4) |

---

## 文件结构(全量)

```
src/
  core/goal-store.ts                   [新] 类型 + CRUD + 单活仲裁 + 会话绑定 + corrupt 隔离 + 归档移动 + 扫描摘要
  core/goal-store.test.ts              [新] 单活拒绝双活 / 损坏隔离 / 原子写 / 归档 / 状态迁移合法性
  core/goal-guard.ts                   [新] 纯函数:无进展守卫(主信号)+ 三层预算检查
  core/goal-guard.test.ts              [新] 剩余集合不降 → blocked / 写入计数零 → blocked / 预算触达动作
  core/goal-grant.ts                   [新] grant 白名单评估:工具白名单 × glob × 在场条件
  core/goal-grant.test.ts              [新] grant × deny × 破坏性 × MCP × 跨会话矩阵 / 裸 ** 拒绝
  core/goal-runner.ts                  [新] 回合编排:包装 ask、事件记账、predicate 校验、runner 收口
  core/goal-runner.test.ts             [新] 假 ask 流:usage 累加 / CANCELLED 不计轮 / predicate 收口唯一 / 守卫触发
  core/tool-permissions.ts             [改] resolveToolPermission +goalGrantCheck 参数(deny 后插入);summarizeToolCall +manage_goal 分支
  core/tool-permissions.test.ts        [新/改] grant 插入点顺序测试
  core/context-manager.ts              [改] +goalAnchor 字段 + setGoalAnchor();injector 注册 'goal' 源
  core/context-manager.test.ts         [改] 锚定段在 toMessages / 不在 getTranscript / 投影后仍在
  core/agent-loop.ts                   [改] message.end payload +stepPromptTokens / stepCompletionTokens(跨步累计,向后兼容,F1)
  prompts/injection/ids.ts             [改] INJECTION_SOURCE_IDS +'goal'
  tools/manage-goal.ts                 [新] 单工具多 action(create/update/list/pause/resume/cancel/complete)
  tools/manage-goal.test.ts            [新] 动作×确认矩阵 / create 本地兜底 / predicate 型 complete 拒绝 / glob 校验
  prompts/tool-schemas.ts              [改] +manage_goal skeleton
  prompts/sections.ts                  [改] +manage_goal description / param sections
  prompts/defaults/zh.ts               [改] +新 section 默认文案
  settings.ts                          [改] +goalMaxRounds / goalRoundTokenSoftCap / goalArchiveDays;toolPermissions 默认 +manage_goal:'allow'
  settings.test.ts                     [改] 默认值迁移
  i18n/types.ts                        [改] +GoalI18n namespace
  i18n/zh.ts / en.ts                   [改] +goal namespace 全部 key
  ui/chat/ChatView.svelte              [改] busyOverride +goal 忙态;onload 未完成目标提示条;停止按钮复用现有 abort 通道
  main.ts                              [改] 装配 GoalStore/GoalRunner;onload 扫描(corrupt 隔离 + Notice);注册工具;ask() 闭包接 grant 与锚定
tests/
  integration/goal-round.test.ts       [新] 端到端:建目标→假回合→收口/守卫(视 integration 基建成本,可降为 runner 大用例)
```

---

## 关键设计速查(实现者必读)

**1. grant 插入点(`resolveToolPermission`,优先级链的落地):**

```typescript
export async function resolveToolPermission(
	toolCall: ToolCall,
	settings: ToolPermissionSettings,
	grants: ToolPermissionSessionGrants,
	confirm: (toolCall: ToolCall) => Promise<ToolConfirmResult>,
	goalGrantCheck?: (toolCall: ToolCall) => boolean, // 新增,最后一位参数(向后兼容)
): Promise<void> {
	const perm = settings.toolPermissions[toolCall.name] ?? 'ask';
	// 关键路径: deny 全链最高,goal grant 撬不开 deny(spec 4.6)
	if (perm === 'deny') throw new Error(/* 原样 */);
	// 关键路径(S-GOAL): goal grant 在 deny 之后、会话 grant 之前。
	// 白名单本身排除破坏性/MCP,故与「破坏性逐次确认 > goal grant」等价,无需重复判断。
	if (goalGrantCheck?.(toolCall)) return;
	if (grants.has(toolCall.name, path)) return;
	// ...以下原样
}
```

**2. 锚定注入(ephemeral 通道,复用 S-SR-LAYERING injector):**

```typescript
// context-manager.ts 构造器内(与 env/memory/skills 并列):
this.injector.register({
	id: 'goal',
	build: () => this.goalAnchor || null,
	ownBudgetBytes: 2048, // 兜底;composeGoalAnchor 内部已自限
});
/** 设置 goal 锚定段 — 每轮 toMessages() 现拼,不入 session.messages(D6) */
setGoalAnchor(text: string): void { this.goalAnchor = text; }
```

锚定文本由 `composeGoalAnchor(goal)` 生成(objective + 完成标准 + progressNote 三行),在 `main.ask()` 入口设置:`goalStore.getBoundActive(sessionId)` 命中时注入,否则置空串。**禁止**任何往 `session.messages` 塞锚定消息的路径(D6,评审 Critical 4)。

**3. GoalRunner 与 ask 的关系(回合 = 一次 ask 调用):**

```
startRound(goal, signal):
  roundMsg = composeRoundMessage(goal)   // 指令:从库重推导剩余 → 执行 → 末尾 update(progress)
  for await (ev of plugin.ask(goal.activeSessionId, roundMsg, signal)):
    ev.type === 'tool.result'
      && GOAL_GRANTABLE_TOOLS.has(ev.name)
      // 关键路径(F2):成功判定写死 —— 失败工具的 result 是 'Error: ' 前缀字符串;
      // 被权限拒绝的工具不产生 tool.result(agent-loop 拒绝分支 continue 前无 yield),天然不计入
      && !(typeof ev.result === 'string' && ev.result.startsWith('Error:'))
      → writesThisRound++
    ev.type === 'message.end'
      // 关键路径(F1):优先读新增的跨步累计字段(见偏差表);旧字段仅最后一步的值,只作降级回退
      → usage += {promptTokens: ev.stepPromptTokens ?? ev.promptTokens,
                  completionTokens: ev.stepCompletionTokens ?? ev.completionTokens}
    ev.type === 'error' && code === 'CANCELLED' → interrupted = true
  回合收尾(仅 !interrupted):
    roundsDone++ → 落盘
    predicate 型 → evaluateFrontmatterAll():
      通过 → runner 收口 complete(status=completed, 附证据)   // D10 单一收口
      未过 → goal-guard.evaluateNoProgress(...) → blocked? 继续
    自检型 → 不收口,等模型提议 complete(工具内 Modal)
```

**4. 打断映射(spec 4.7,实现要点):** 三种打断全部复用现有 `AbortSignal` 路径(agent-loop 已在流中掐断);runner 捕获 `CANCELLED` 后**只落盘 usage,不改 status、不动 grant**;`roundsDone` 仅在本回合发生过 ≥1 次 grant 范围成功写入时 +1;progressNote 未 update 就保持旧值——下一轮锚定注入旧游标 + 指令「先重扫库核实」,不阻塞任何事(D9:库是真相)。**绑定悬空无需清理钩子**(F7):grant 判定与续跑入口都做 `goal.activeSessionId === 当前 sessionId` 惰性比较,切走后旧绑定自然失配即「不在场失效」,resume 时重新绑定覆盖。

**5. 损坏隔离与归档路径:** `goals/<id>.json` 解析失败 → `fs.rename` 到 `goals/corrupt/<id>.json` + Notice;归档 = rename 到 `goals/archive/`;两者都退出 `list()` 扫描。原子写沿用 index-manifest 的 tmp+rename 模式。

**6. manage_goal 动作 × 确认矩阵:**

| action | 工具级权限 | 动作内确认 | 本地兜底校验 |
|---|---|---|---|
| create | allow(默认) | Modal:目标/标准/预算/glob+预估文件数 | criteria 非空且 ≠ objective;glob 非裸 `**`/vault 根;单活检查(已有 active → 只允许 pending) |
| update(progress/usage) | allow | 无 | 仅 active goal 可写 |
| list | allow | 无 | — |
| pause | allow | 无(安全方向) | — |
| resume | allow | Modal(激活=开跑授权+会话绑定) | 无双活 |
| cancel | allow | Modal | — |
| complete | allow | Modal(仅自检型;**predicate 型直接抛错**,runner 收口) | — |

---

### Task 1:GoalStore — 类型 + 落盘 + 单活 + 损坏隔离 + 归档

**文件:** `src/core/goal-store.ts` [新]、`src/core/goal-store.test.ts` [新]

**Steps:**
- [ ] 定义 `GoalStatus` / `GoalPredicate` / `AgentGoal`(字段与 spec 4.1 一致,含 `activeSessionId` / `usage` / `grant`)
- [ ] `GoalStore` 类:构造接收 `pluginDir`;`goalsDir = <pluginDir>/goals`,`archiveDir = goals/archive`,`corruptDir = goals/corrupt`
- [ ] `list(): Promise<AgentGoal[]>` — 扫 `goals/*.json`,解析失败的单个文件 rename 到 corrupt/ 并记录,不影响其余
- [ ] `get(id)` / `create(input)`(生成短 id `g_<timestamp36>`)/ `update(id, patch)`(白名单字段,禁改 objective/id/createdAt)
- [ ] `activate(id, sessionId)` — 事务性检查:无其他 `status==='active'` 才允许;置 active + activeSessionId
- [ ] `transition(id, next: 'paused'|'blocked'|'completed'|'cancelled', reason?)` — 合法迁移表校验(F6,枚举):
  - `pending → active | cancelled`
  - `active → paused | blocked | completed | cancelled`
  - `paused → active | cancelled`
  - `blocked → active(resume 重启) | cancelled`
  - 终态(completed/cancelled)不可迁移;其余一律抛错
- [ ] `archive(id)` / `listStaleTerminal(days)` — 归档移动 + 待归档查询
- [ ] 原子写:tmp + rename(index-manifest 模式);`updatedAt` 每次写入刷新
- [ ] 测试:单活仲裁拒绝双活 / 损坏文件隔离且其余可读 / 迁移表拒绝非法迁移(pending→completed 等)/ 归档后 list 不再返回 / objective 不可变

**Verification:** `npx vitest run src/core/goal-store.test.ts`;typecheck 通过。

---

### Task 2:goal-guard 纯函数 — 无进展守卫 + 预算检查

**文件:** `src/core/goal-guard.ts` [新]、`src/core/goal-guard.test.ts` [新]

**Steps:**
- [ ] `evaluateNoProgress(input): { blocked: boolean; reason?: string }` — input 含 `remainingPrev/remainingNow`(predicate 剩余集合大小,无 predicate 时为 null)、`writesPrevRound/writesThisRound`(grant 范围成功写计数)、`progressNotePrev/Now`(仅记录进 reason,不参与决策)
- [ ] 决策规则:主信号连续两轮零变化 → blocked,reason 附两轮数值对比(spec 4.7)
- [ ] `checkBudgets(input): { action: 'continue' | 'endRound' | 'askRounds' }` — `stepsUsed >= maxSteps → endRound`;`roundTokenSoftCap > 0 && roundTokens >= cap → endRound`;`roundsDone >= maxRounds → askRounds`
- [ ] 测试:有 predicate 剩余不降两轮 → blocked / 无 predicate 写计数两轮零 → blocked / 剩余下降 → 不 blocked / 三层预算各自触达动作正确 / progressNote 变化但主信号零 → 仍 blocked(防假进展)

**Verification:** `npx vitest run src/core/goal-guard.test.ts`。

---

### Task 3:goal-grant + resolveToolPermission 插入点

**文件:** `src/core/goal-grant.ts` [新]、`src/core/goal-grant.test.ts` [新]、`src/core/tool-permissions.ts` [改]

**Steps:**
- [ ] `GOAL_GRANTABLE_TOOLS = new Set(['write_note', 'edit_note', 'append_note'])`(将来 +update_frontmatter)
- [ ] `validateGrantGlobs(globs: string[]): void` — 拒绝:空数组、裸 `**`、**裸 `*`(无目录前缀,F5)**、vault 根、含 `..`、绝对路径
- [ ] `createGoalGrantCheck(deps): (tc) => boolean` — deps = `{ goalStore, currentSessionId }`;判定:绑定会话存在 active goal → 工具在白名单 → `args.path` 命中任一 grant glob(`globToRegex`)+ 通过 path-safety 排除(configDir 等)
- [ ] `resolveToolPermission` 加第 5 参 `goalGrantCheck?`,插在 deny 检查之后、`grants.has` 之前(见速查 1)
- [ ] 测试矩阵:deny 工具 grant 仍拒 / `delete_note` 不被放行 / `mcp__*` 不被放行 / 非绑定会话不放行 / paused 后不放行 / 白名单工具命中 glob 放行 / 未命中走原流程

**Verification:** `npx vitest run src/core/goal-grant.test.ts src/core/tool-permissions.test.ts`;现有 tool-permissions 用例不回归。

---

### Task 4:锚定注入源 'goal'

**文件:** `src/prompts/injection/ids.ts` [改]、`src/core/context-manager.ts` [改]、`src/core/context-manager.test.ts` [改]

**Steps:**
- [ ] `INJECTION_SOURCE_IDS` 追加 `'goal'`(注释注明:S-GOAL 复述锚定,ephemeral 不入 transcript)
- [ ] ContextManager:+`private goalAnchor = ''`;构造器注册 injector 源(速查 2);`setGoalAnchor(text)` 公开方法
- [ ] 测试:`setGoalAnchor('X')` 后 `toMessages()` 含 X 且位于 system 段;`getTranscript()` 不含 X;构造 compact markers 投影后 `toMessages()` 仍含 X;未设置时 buildSections 无 goal 段

**Verification:** `npx vitest run src/core/context-manager.test.ts`。

---

### Task 5:manage_goal 工具 + schema + i18n + settings

**文件:** `src/tools/manage-goal.ts` [新] + test、`prompts/tool-schemas.ts`、`prompts/sections.ts`、`prompts/defaults/zh.ts`、`src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`settings.ts`、`src/core/tool-permissions.ts`(summarizeToolCall)

**Steps:**
- [ ] settings:`goalMaxRounds=10`、`goalRoundTokenSoftCap=0`(0=关)、`goalArchiveDays=7`;`toolPermissions` 默认 +`manage_goal:'allow'`
- [ ] schema skeleton:`action`(enum 七值)+ `goalId` + `objective` + `criteriaText` + `predicate{pathGlob,property}` + `maxRounds` + `grant[]` + `progressNote`
- [ ] 工具实现:按速查 6 矩阵;Modal 复用现有 confirm-modal 基建;create 调 `goalStore.create` + 可选直接 `activate`
- [ ] `summarizeToolCall` +manage_goal 分支(`tNow('tool.goal.*', { action, objective 截断 })`)
- [ ] i18n:GoalI18n namespace 全量 key(zh/en 同步,含 Modal 文案、Notice、Strip 文案)
- [ ] 测试:动作矩阵逐格 / create 兜底(criteria 空或同 objective → 抛错)/ complete 对 predicate 型抛错 / validateGrantGlobs 拒绝裸 `**`

**Verification:** `npx vitest run src/tools/manage-goal.test.ts`;`npm run typecheck`。

---

### Task 6:GoalRunner 回合编排

**文件:** `src/core/goal-runner.ts` [新]、`src/core/goal-runner.test.ts` [新]

**Steps:**
- [ ] agent-loop(F1):`for` 循环内累加 `stepPromptTokensSum += delta.usage.promptTokens`、`stepCompletionTokensSum += delta.usage.completionTokens`;`message.end` payload 增加这两个可选字段(现字段不动,向后兼容)
- [ ] `composeRoundMessage(goal): string` — 中文指令:目标重述 + 「从库重扫剩余工作,勿信旧游标」+ 末尾要求「回合结束前调 manage_goal(update) 写 progressNote」
- [ ] `composeGoalAnchor(goal): string` — 三行锚定文本(≤2048 字节自限)
- [ ] `evaluateFrontmatterAll(vault, pathGlob, property)` — 经 ObsidianVault 外观取 metadataCache,返回 `{ total, missing: string[] }`
- [ ] `startGoalRound(deps, goalId, signal)` — 速查 3 流程;deps 注入 `ask` 函数(便于测试注入假流);事件消费按速查 3 写死的判定:`tool.result` 成功写计数(F2 规则)、`message.end` usage 累加(F1 新字段优先)、`CANCELLED` 置 interrupted
- [ ] 收尾逻辑(速查 3):roundsDone/usage 落盘 → predicate 收口 → 无进展守卫 → blocked/继续
- [ ] 测试(假 ask generator):usage 跨步累加正确(**多步流总和,非最后一步值**)/ CANCELLED 回合不计轮不触发守卫 / predicate 通过时 complete 恰好一次(D10)/ 守卫两轮零进展 → blocked 附原因 / 自检型不自动 complete / 失败写入(`Error:` 前缀)不计入成功写计数

**Verification:** `npx vitest run src/core/goal-runner.test.ts`。

---

### Task 7:ChatView / StatusStrip / onload 集成

**文件:** `src/ui/chat/ChatView.svelte` [改]、`src/main.ts` [改]

**Steps:**
- [ ] main.onload:`goalStore = new GoalStore(pluginDir)` → 扫描(corrupt 隔离自动发生)→ 有未完成目标时经 **`UserStatus`(Obsidian 插件状态栏,F3:onload 时 ChatView 多半未开)** 提示「N 进行 / M 排队 / K 挂起 / J 受阻」,点击打开 chat
- [ ] main.ask():闭包内 `setGoalAnchor`(绑定会话命中时)/ `toolPermissionCheck` 传入 `createGoalGrantCheck`
- [ ] main:注册 `createManageGoalTool(...)`;装配 `GoalRunner` 单例;ChatView「继续」入口调 `runner.startGoalRound`(复用现有 AbortController 供停止按钮)
- [ ] chat 内 StatusStrip busyOverride(仅回合进行中、chat 已打开):goal 推进文案「目标:<objective 截断> · 步 x/y」,优先级插入现有 deriveBusyOverride 链(indexing 之后);与 UserStatus 提示是**两个面**(F3),不复用同一通道
- [ ] i18n 全部新 key 落位;无硬编码文案
- [ ] 验证:`npm run typecheck` + `npm run svelte-check`;手动:`npm run link:vault` 链 Sandbox → Reload app without saving

**Verification(手动脚本,Sandbox):**
1. 对话「立个目标:把 projects/ 下所有笔记补 status 属性」→ 协商卡 → 确认 → 回合推进,Strip 显示目标忙态
2. 回合中点停止 → 立即断;goal 仍 active;再「继续」→ 从库重扫接着干
3. 执行中插话 → 打断 + 插话被正常回答
4. `/new` 后 onload 提示未完成目标 → 点继续 → 绑定转移,grant 生效
5. 另一会话尝试推进 → 收到「正在另一场对话推进」
6. predicate 全满足 → 自动 completed + 证据;7 天后(改 goalArchiveDays=0 加速)出现归档提示

---

### Task 8:全量验证 + 收尾

**Steps:**
- [ ] `npm run typecheck` / `npm run lint` / `npm run test` 全绿
- [ ] `git grep` 检查无本机路径泄漏;新增文件头注释齐备(@file/@description/@module)
- [ ] i18n 审查:新用户可见字符串零硬编码
- [ ] 文档同步评估留到 `finishing-a-development-branch`(user-guide 斜杠外能力 / CHANGELOG [Unreleased] / README 功能 bullet)

---

## 自审

- **风险最高点**:Task 3 权限插入点——已有测试必须零回归;插入顺序在 deny 之后有白名单前提保证等价性,测试矩阵覆盖。
- **风险次高**:Task 6 runner 对 `CANCELLED` 的语义(不计轮、不触发守卫、usage 照记)——用假流显式用例钉死。
- **明确不做**(本 plan):UI 步骤明细条、token 软上限默认开启、append_to_daily 依赖、定时触发。

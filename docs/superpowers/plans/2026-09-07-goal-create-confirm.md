# P-GOAL-CONFIRM:创建目标改为对话确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 S-GOAL **v1.8** — `/goal` 与自然语言立目标先在对话里确认完成标准与当前回合预算,用户点头后才 `manage_goal` create;改预算走 `ratel-config` + `goalMaxRounds` 白名单;创建不再弹 `GoalCreateModal`。

**Architecture:** 斜杠只转发模型(冲突仍用 `composeGoalConflictSteer`;新建用 `composeGoalCreateSteer`)。`handleCreate` 去掉 `promptCreate`;若本轮用户原文解析为 `/goal <陈述>` 则拒绝落盘。回合上限是全局设置,经 `update_app_config` 写入,create 读当时的 `settings.goalMaxRounds`。

**Tech Stack:** TypeScript / Vitest / 现有 manage_goal、slash、config-whitelist。无新 npm。

**关联文档:**
- Spec: [S-GOAL v1.8](../specs/2026-08-22-agent-goal-mode.md) §4.3 / §4.10 create / §4.11 面 4
- 不取代 [P-GOAL-1](2026-08-22-agent-goal-mode.md);本 plan 只改创建确认时序

## Global Constraints

- 用户可见字符串走 i18n(`zh.ts` + `en.ts` + `types.ts`),禁止硬编码
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`
- 源码注释 / 文件头中文(`@file` `@description` `@module`)
- **提示词**( `src/prompts/defaults/zh.ts`、`src/skills/builtin/ratel-config/SKILL.md` )由主会话已改好,**本 plan 子代理不要改写提示词正文**,缺 key 清单时只补 i18n / 白名单 / 接线
- 只链 Obsidian Sandbox;`npm run link:vault` 禁止日常主库
- 提交只暂存本 task 文件清单,禁止 `git add -A`(工作区混有 P-GOAL-1 其他 WIP)
- 工作目录:当前仓库,分支 `feat/p-goal-1`(不要另开 worktree)
- 用户未要求不要在本 plan 里改架构文档 `docs/architecture/`
- `GoalCreateModal.ts` 本 plan **不删除**(避免无关 diff);只断开 create 调用

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/settings/config-whitelist.ts` | 白名单 + `goalMaxRounds` 数值 1–100 |
| `tests/settings/config-whitelist.test.ts` | 期望列表含 `goalMaxRounds`;越界拒绝 |
| `src/prompts/defaults/zh.ts` | 已由主会话改好 |
| `src/skills/builtin/ratel-config/SKILL.md` | 已由主会话改好 |
| `src/core/goal-runner.ts` | `composeGoalCreateSteer(objective, maxRounds)` |
| `src/core/goal-runner.test.ts` | steer 含陈述与回合数、禁止本回合 create |
| `src/tools/manage-goal.ts` | create 无 Modal;斜杠回合拒绝;`getLastUserText` |
| `src/tools/manage-goal.test.ts` | 无 Modal 落盘;斜杠原文拒绝 |
| `src/main.ts` | 去掉 create 的 `showGoalCreateModal`;注入 last user;删或掏空 `startGoalFromSlash` 落盘 |
| `src/ui/chat/ChatView.svelte` | `/goal` 有陈述则发模型+steer,不 `startGoalFromSlash` 落盘 |
| `src/i18n/{types,zh,en}.ts` | `goal.slash.createSteer` / `goal.tool.createNeedConfirm` / slash 描述 |
| `docs/user-guide.md` | `/goal` 一行改为先确认再创建 |

---

### Task 1:`goalMaxRounds` 进入 update_app_config 白名单

**Files:**
- Modify: `src/settings/config-whitelist.ts`
- Modify: `tests/settings/config-whitelist.test.ts`
- Test: `tests/settings/config-whitelist.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS.goalMaxRounds`(默认 10);设置页 number `min: 1, max: 100`(`src/settings.ts` 约 766 行)
- Produces: `CONFIG_UPDATE_WHITELIST` 含 `'goalMaxRounds'`;`NUMBER_CONSTRAINTS.goalMaxRounds = { min: 1, max: 100 }`

- [ ] **Step 1:写失败测试**

在 `tests/settings/config-whitelist.test.ts` 的「含常规配置 key」数组末尾加 `'goalMaxRounds'`。新增:

```typescript
	it('goalMaxRounds - 1 与 100 通过,0 与 101 拒绝', () => {
		expect(validateConfigValue('goalMaxRounds', 1).ok).toBe(true);
		expect(validateConfigValue('goalMaxRounds', 100).ok).toBe(true);
		expect(validateConfigValue('goalMaxRounds', 10).ok).toBe(true);
		expect(validateConfigValue('goalMaxRounds', 0).ok).toBe(false);
		expect(validateConfigValue('goalMaxRounds', 101).ok).toBe(false);
	});
```

- [ ] **Step 2:跑测试确认 RED**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: FAIL — 期望列表缺 key 或校验无约束

- [ ] **Step 3:最小实现**

`CONFIG_UPDATE_WHITELIST` 在记忆块之后加 `'goalMaxRounds'`(或单独 `// --- 目标模式 ---` 注释)。
`NUMBER_CONSTRAINTS` 加 `goalMaxRounds: { min: 1, max: 100 }`。

- [ ] **Step 4:跑测试确认 GREEN**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: PASS

- [x] **Step 5:Commit**

```bash
git add src/settings/config-whitelist.ts tests/settings/config-whitelist.test.ts
git commit -m "$(cat <<'EOF'
feat(goal): 允许 ratel-config 代改默认回合上限

对话确认创建时改预算走 update_app_config,白名单补 goalMaxRounds。
EOF
)"
```

---

### Task 2:斜杠转发 + create 无表单 + 斜杠同回合硬拒

**Files:**
- Modify: `src/core/goal-runner.ts`(若主会话未落地 `composeGoalCreateSteer` 则补齐;已有则只接线)
- Modify: `src/core/goal-runner.test.ts`
- Modify: `src/ui/chat/input/slash-commands.ts` — 导出 `isSlashGoalCreateTurn(text: string): boolean`
- Modify: `src/tools/manage-goal.ts`
- Modify: `src/tools/manage-goal.test.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`(若主会话已加 key 则勿改提示词口吻)
- Test: `src/core/goal-runner.test.ts`、`src/tools/manage-goal.test.ts`、`tests/ui/slash-commands.test.ts`

**Interfaces:**
- Consumes: `parseSlashGoalInput`;`composeGoalCreateSteer(objective: string, maxRounds: number): string`;`commitGoalCreate`
- Produces:
  - `isSlashGoalCreateTurn(text: string): boolean` — `parseSlashGoalInput(text)?.objective` 非空则为 true
  - `createManageGoalTool(..., prompts, defaultMaxRounds, getLastUserText?: () => string)`
  - 斜杠有陈述:`sendMessage({ text: '/goal …', llmText: composeGoalCreateSteer(obj, plugin.settings.goalMaxRounds), bypassSlashGoal: true })`,**禁止** `startGoalFromSlash` 落盘
  - 冲突路径保持现有 `composeGoalConflictSteer`(仍 `findIncomplete` 于发送前)

- [ ] **Step 1:写失败测试**

`slash-commands.ts` 测:

```typescript
	it('isSlashGoalCreateTurn - /goal 加陈述 - true;空 /goal 与普通句 - false', () => {
		expect(isSlashGoalCreateTurn('/goal 审查妖市')).toBe(true);
		expect(isSlashGoalCreateTurn('/goal')).toBe(false);
		expect(isSlashGoalCreateTurn('审查妖市')).toBe(false);
	});
```

`goal-runner.test.ts`(若尚无):

```typescript
	it('composeGoalCreateSteer - 含陈述与回合数且禁止本回合 create', () => {
		setLang('zh');
		const text = composeGoalCreateSteer('审查妖市', 10);
		expect(text).toContain('审查妖市');
		expect(text).toContain('10');
		expect(text).toMatch(/不要.*create|禁止.*create|先.*确认/i);
	});
```

`manage-goal.test.ts`:

```typescript
	it('create - 无 promptCreate 仍落盘并激活', async () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10, () => '可以,就按这个标准');
		const result = await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(result).toMatch(/已创建|开始/);
		expect((await store.list())[0]!.status).toBe('active');
	});

	it('create - 本轮用户是 /goal 陈述 - 不落盘并返回需确认', async () => {
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts(),
			() => 10,
			() => '/goal 审查妖市',
		);
		const result = await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(result).toMatch(/确认/);
		expect(await store.list()).toHaveLength(0);
	});
```

删除或改写「用户取消 Modal - 不落盘」(创建不再有 Modal)。`autoConfirmPrompts` 的 `promptCreate` 可留空实现以免编译,但 `handleCreate` 不得调用它。

- [ ] **Step 2:跑测试确认 RED**

Run: `npx vitest run tests/ui/slash-commands.test.ts src/core/goal-runner.test.ts src/tools/manage-goal.test.ts`
Expected: FAIL — 缺导出或仍弹/仍落盘

- [ ] **Step 3:最小实现**

1. `isSlashGoalCreateTurn`:对 trim 后文本 `parseSlashGoalInput`,`Boolean(parsed?.objective)`。
2. `composeGoalCreateSteer`:返回 `tNow('goal.slash.createSteer', { objective, rounds: String(maxRounds) })`。文案若主会话已写入 i18n 则直接用。
3. `handleCreate`:在 `findIncomplete` 之后、`commitGoalCreate` 之前:

```typescript
	const lastUser = getLastUserText?.() ?? '';
	if (isSlashGoalCreateTurn(lastUser)) {
		return tNow('goal.tool.createNeedConfirm');
	}
	return commitGoalCreate(store, sessionId, {
		confirmed: true,
		activate: true,
		objective,
		criteriaText,
		maxRounds,
		grant,
		predicate,
	}, { objective, criteriaText, maxRounds, grant, predicate });
```

不要 `await prompts.promptCreate`。

4. `main.ts`:`createManageGoalTool` 增加 `() => { /* 从当前会话取最后一条 user 文本 */ }`。实现:读 `this.persistence` 当前 `currentChatSessionId` 的 messages,从后往前找 `role === 'user'` 的 `content` 字符串;取不到返回 `''`。**不要**为取文本新开 GoalCreateModal。`promptCreate` 可改为 `async () => ({ confirmed: true })` 占位,只要 execute 不再调用。
5. **删除或停止调用** `startGoalFromSlash` 的 `commitGoalCreate`。推荐:ChatView 有陈述时:

```javascript
				const incomplete = await plugin.goalStore.findIncomplete();
				if (incomplete) {
					await sendMessage({
						text: `/goal ${slashGoal.objective}`,
						llmText: composeGoalConflictSteer(incomplete.objective, slashGoal.objective),
						bypassSlashGoal: true,
					});
					return;
				}
				await sendMessage({
					text: `/goal ${slashGoal.objective}`,
					llmText: composeGoalCreateSteer(slashGoal.objective, plugin.settings.goalMaxRounds),
					bypassSlashGoal: true,
				});
```

空 `/goal` 仍 Notice 用法。`goalRound: true` **不要**在首次确认轮设置(目标尚未存在)。

6. `getLastUserText` 必须能读到刚入会话的 `/goal …`(ask 已 addUserMessage)。若 persistence 尚未含本轮,改为 ChatView 把原文存到 `plugin.pendingGoalUserText` 或工具闭包从 ContextManager 取——优先:在 `createManageGoalTool` 的 getter 里用 **当前 ask 正在用的 session 最后一条 user**。可在 `RatelVaultPlugin` 加 `lastAskUserText: string` 于 `ask()` 入口赋值。这是推荐接线,避免读盘竞态:

```typescript
// ask() 开头
this.lastAskUserText = message;
```

getter: `() => this.lastAskUserText ?? ''`

- [ ] **Step 4:跑测试确认 GREEN**

Run: `npx vitest run tests/ui/slash-commands.test.ts src/core/goal-runner.test.ts src/tools/manage-goal.test.ts`
Expected: PASS

- [x] **Step 5:Commit**

```bash
git add src/core/goal-runner.ts src/core/goal-runner.test.ts src/ui/chat/input/slash-commands.ts src/tools/manage-goal.ts src/tools/manage-goal.test.ts src/main.ts src/ui/chat/ChatView.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts tests/ui/slash-commands.test.ts
git commit -m "$(cat <<'EOF'
feat(goal): 立目标先对话确认再落盘

斜杠不再当场创建;create 去掉表单,斜杠同回合拒绝抢建。
EOF
)"
```

只 add 实际改动的文件。

---

### Task 3:使用手册斜杠说明

**Files:**
- Modify: `docs/user-guide.md`(约 `/goal` 那一行)

- [ ] **Step 1:改文案**

将「立目标并立刻开始」改为:先由助手复述完成标准与当前回合上限,你确认后再创建;要改回合上限可让助手走配置技能;已有未完成目标时仍问放弃或继续。

- [ ] **Step 2:Commit**

```bash
git add docs/user-guide.md
git commit -m "$(cat <<'EOF'
docs: /goal 改为对话确认后再创建

EOF
)"
```

---

## 自审

| spec v1.8 | 任务 |
|---|---|
| 对话确认完成标准+回合 | Task 2 steer + 提示词(主会话) |
| 改预算 ratel-config / whitelist | Task 1 + SKILL(主会话) |
| 无 GoalCreateModal | Task 2 |
| 斜杠同回合硬拒 | Task 2 `isSlashGoalCreateTurn` |
| 冲突仍问放弃/继续 | Task 2 保留 conflictSteer |
| user-guide | Task 3 |

无 TBD。`GoalCreateModal.ts` 故意保留不删。

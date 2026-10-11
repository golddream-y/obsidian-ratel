# P-CHAT-PROFILE-ACTIVE — 设置页「设为当前」改调共用 activateChatProfile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development 按 RED-GREEN-REFACTOR 实施。

**目标:** 消灭 S-CHAT-PROFILES 最后一处实现债。设置页配置详情里的「设为当前」按钮当前内联手写 6 步切换(与顶栏菜单逻辑重复),改为调用已有的共用函数 `activateChatProfile`;两条路径行为同序、漂移风险归零。完成后 S-CHAT-PROFILES 可归档。

**所属 spec:** [S-CHAT-PROFILES](../specs/2026-09-24-chat-profiles-design.md) CP-08 / §「已保存的配置」(点「设为当前」与顶栏菜单同一条路径)

**背景事实(已核实):**
- 共用函数 `src/ui/chat/activate-chat-profile.ts` 已存在,顶栏菜单在用(`ChatView.svelte:368/384`),文件头注释写明「与设置页设为当前同序」,但设置页没调它。
- 内联副本在 `src/ui/settings/chat-profiles-render.ts:232-248`。与共用函数的差异仅两点(均为设置页本地需要):
  1. `saveSettings({ refreshSettingsTab: false })`(共用函数是无参 `saveSettings()`)
  2. 末尾 `this.renderPage()`
- 内联副本少了 `profileSelectNeedsSwitch` 短路,但按钮只在 `profile.id !== activeChatProfileId` 时渲染,语义等价。
- `chat-profiles-render.ts` 中 `switchChatProfile` 仅内联副本使用(import 可移除);`syncChatWindow`、`Notice` 在文件别处仍用(保留)。

## Global Constraints

- TypeScript strict;中文注释;i18n 沿用现有 key(`settings.chatProfiles.switched`、`settings.notice.contextLengthUnknown`),不新增用户可见字符串。
- 不改变任何用户可见行为;不动顶栏菜单调用点。

## 任务清单

### Task 1:共用函数加选项 + 设置页改调 + 测试锁同序

**Files:**
- 改:`src/ui/chat/activate-chat-profile.ts`
- 改:`src/ui/settings/chat-profiles-render.ts`
- 新建:`tests/ui/chat/activate-chat-profile.test.ts`

**Step 1 — RED。** 新建 `tests/ui/chat/activate-chat-profile.test.ts`,`vi.mock('obsidian')` 捕获 `Notice` 构造(参考 `tests/ui/confirm-modal.test.ts` 的 mock 模式);构造最小 plugin 替身(`settings` 用真实 `chat-profiles.ts` 纯函数生成两套配置,`modelsDevCatalog.ensureCatalog`、`saveSettings`、`rebuildLLM` 均为 vi.fn 并记录调用顺序)。用例:

1. `activateChatProfile - 顶栏默认调用 - saveSettings 不带 refreshSettingsTab,无 onActivated`:切到另一套后,调用序为 switchChatProfile 效果(当前四字段=目标套)→ ensureCatalog → syncChatWindow → saveSettings(参数 undefined)→ rebuildLLM;出现 switched Notice。
2. `activateChatProfile - 设置页选项 - saveSettings 透传 refreshSettingsTab:false 并回调 onActivated`:传入 `{ refreshSettingsTab: false, onActivated }`,断言 saveSettings 收到 `{ refreshSettingsTab: false }`、onActivated 在 switched Notice 之后被调用一次。
3. `activateChatProfile - 目标套即当前套 - 短路不保存`:调 `profileSelectNeedsSwitch` 为 false 的 id,saveSettings/rebuildLLM 均零调用(锁既有行为,防止改签名时破坏)。

先确认 2、3 失败(选项不存在),1 若现有行为可过则作为回归锁。

**Step 2 — GREEN(共用函数)。** `activate-chat-profile.ts`:

```typescript
export interface ActivateChatProfileOptions {
	/** 透传 saveSettings;设置页在 Modal 内切换时传 false,避免设置页重绘抖动 */
	refreshSettingsTab?: boolean;
	/** 切换落库后的本地钩子;设置页用于 renderPage()。在 Notice 之后执行 */
	onActivated?: () => void;
}
```

- 签名改为 `activateChatProfile(plugin, profileId, options?)`。
- `saveSettings` 调用:`options?.refreshSettingsTab === false ? { refreshSettingsTab: false } : undefined` 透传。
- 末尾 switched Notice 之后调用 `options?.onActivated?.()`。
- 更新文件头/函数 JSDoc(中文),删掉「与设置页同序」的 TODO 式描述,改为「顶栏菜单与设置页共用」。

**Step 3 — GREEN(设置页)。** `chat-profiles-render.ts:232-248` 内联 6 步整段替换为:

```typescript
btn.onClick(() => {
	void activateChatProfile(this.plugin, profile.id, {
		refreshSettingsTab: false,
		onActivated: () => this.renderPage(),
	});
});
```

- 新增 import `activateChatProfile`;从 `../../settings/chat-profiles` 的 import 列表移除仅此处使用的 `switchChatProfile`(先确认全文件无其他引用再删);`syncChatWindow`、`Notice` 保留。
- 保持按钮其余部分(CTA、文案)不动。

**Step 4 — 全量验证。**
`npx vitest run tests/ui/chat/activate-chat-profile.test.ts` → `npm run typecheck` → `npm run lint` → `npm test`(基线 flake 除外)→ `npm run build`。

**Step 5 — 自审。** `git diff --check`;无新 i18n 字面量;无本机隐私;设置页交互无法被单测覆盖的部分(renderPage 重绘)在执行记录注明,留给 Sandbox 预览。

**Step 6 — 提交。** `refactor: 设置页设为当前改调共用 activateChatProfile`

## 自审与验收依据

| 要求 | 直接证据 |
|---|---|
| 两条路径同一函数 | Task1 用例 1/2;grep 无第二份 switchChatProfile 调用副本 |
| 设置页行为不变 | refreshSettingsTab:false + onActivated(renderPage) 断言 |
| 短路语义保留 | 用例 3 |
| 不新增用户可见文案 | 无新 i18n key |

**完成后:** S-CHAT-PROFILES spec 全部需求落地,按归档流程询问后归档。

---

## 执行记录 / 偏差说明

(执行时填写:commit、测试结果、偏差、Sandbox 验证情况)

### 2026-10-11 — P-CHAT-PROFILE-ACTIVE 实施记录

**Commit:** 本次提交,SHA 见 `git log -1`(refactor: 设置页设为当前改调共用 activateChatProfile)。

**改动文件:**
- 改:`src/ui/chat/activate-chat-profile.ts` — 新增 `ActivateChatProfileOptions`(`refreshSettingsTab?` / `onActivated?`),签名加第三可选参数;`saveSettings` 仅在 `refreshSettingsTab === false` 时透传 `{ refreshSettingsTab: false }`,否则无参;`onActivated` 在 switched Notice 之后执行;文件头/JSDoc 改为「顶栏菜单与设置页共用」。
- 改:`src/ui/settings/chat-profiles-render.ts` — 「设为当前」内联 6 步整段替换为 `activateChatProfile(plugin, profile.id, { refreshSettingsTab: false, onActivated: () => this.renderPage() })`;移除仅此处使用的 `switchChatProfile` import(grep 确认全文件无其他引用),新增 `../chat/activate-chat-profile` import;`syncChatWindow`/`Notice`/按钮 CTA 与文案不动。
- 新建:`tests/ui/chat/activate-chat-profile.test.ts`(3 用例)。
- 顶栏调用点 `ChatView.svelte:368/384` 未动;无新增 i18n key。

**TDD 红绿证据:**
- RED(旧实现跑新测试):1 failed | 2 passed。
  - ✓ 用例 1(顶栏默认调用:四字段换目标套、调用序、saveSettings 参数 undefined、switched Notice)旧实现即通过,作为默认路径回归锁。
  - × 用例 2(设置页选项):`expected undefined to deeply equal { refreshSettingsTab: false }` 失败;其后 onActivated「调用一次且在 switched Notice 之后」断言同为红色。
  - ✓ 用例 3(目标套即当前套短路、零副作用)旧实现即通过,作为短路语义回归锁。
- GREEN(改完实现后):3 passed(3 tests)。
- 偏差说明:plan Step 1 文字称「先确认 2、3 失败」,实测用例 3 锁定的短路是旧实现既有行为(`profileSelectNeedsSwitch` 早返回),旧码下本就通过;真正 RED 的是用例 2 中**两条选项相关断言**(选项透传、回调顺序),与任务委派「选项相关两条失败」一致。未刻意造红。

**全量验证(真实输出):**
- `npx vitest run tests/ui/chat/activate-chat-profile.test.ts`:Test Files 1 passed,Tests 3 passed。
- `npx tsc -noEmit -skipLibCheck`:全仓 241 errors,与 develop 基线 241 一致;筛 `activate-chat-profile|chat-profiles-render` 仅 3 条 `chat-profiles-render.ts` 的 `Property 'settingTab' is private`(现 246/255/270 行,HEAD 同内容在 256/265/280 行,纯行号位移,属未触碰代码);新测试文件 0 错误(tsconfig 含 `tests/**/*.ts`)。
- `svelte-check`:改前/改后均为 253 errors、21 warnings、71 files(stash 基线对比),零新增;本次两个源文件仅剩前述 3 条既有 settingTab 报错。
- `npm run lint`:改前/改后均 `✖ 17 problems (0 errors, 17 warnings)`,零新增;`tests/` 目录被 eslint ignore(与既有 tests/ui/* 一致)。
- `npm test`:**Test Files 272 passed (272),Tests 2038 passed (2038)**(基线 271 文件/2035 用例 + 本任务新增 1 文件/3 用例);skill-script-sandbox 19 用例本轮全部通过,未触发心跳 flake,无需重跑。
- `npm run build`:exit 0,18 warnings(均为既有 Svelte a11y 警告,日志中无本次两个文件);`dist/main.js`、`dist/worker.js` 产物正常生成。
- `git diff --check`:clean。

**Sandbox 未覆盖项:**
- 单测锁定了共用函数的步骤顺序、选项透传与短路,但设置页 `onActivated: () => this.renderPage()` 引发的真实 DOM 重绘(Obsidian Setting/Modal 环境)无法在 node 单测覆盖。需 Sandbox 手验:设置 → 对话模型 → 进入一套**非当前**配置详情 → 点「设为当前」→ 出现 switched Notice、「设为当前」按钮随重绘消失、列表行出现当前标记,且设置页不被弹回列表/无整页抖动(refreshSettingsTab:false 生效);顶栏菜单切换行为不变。

- **审查 PASS 后 test-only Minor 增强(新提交,未 amend):** `3811946` — `test: 锁定切换 Notice 时长与短路时不触发回调`(2026-10-11)。M1 用例 1(顶栏默认调用)补 `order.notices` 精确断言:本用例 `ensureCatalog` 返回 null、`syncChatWindow` 走 clearOnMiss 清空分支(applied/skipped 皆 false),unknown 与 switched 两条 Notice 均出现,逐条锁定文案与 timeout — unknown 5000ms、switched 3000ms;M2 用例 3(目标套即当前套短路)传入 `onActivated` vi.fn 并断言 `not.toHaveBeenCalled()`(短路发生在 `profileSelectNeedsSwitch` 早返回,钩子不得触发),saveSettings/rebuildLLM 零调用既有断言保持不变。验证:`npx vitest run tests/ui/chat/activate-chat-profile.test.ts` 3/3 通过(用例内部断言增加,用例数仍为 3);src 零改动。

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

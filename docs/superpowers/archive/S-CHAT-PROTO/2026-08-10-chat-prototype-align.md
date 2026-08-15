# P-CHAT-PROTO — Chat 原型对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发送/停止对齐原型 ↑ 方钮；落地安全/自动/危险三级权限；composer 底避让状态栏；回写原型反映 0.1.18+ 本批 UI。

**Architecture:** 产品侧改 `ChatView` 发送态与 hint 分段；`toolPermissionLevel` 进入 settings 并改写 `resolveToolPermission`（`deny` → grant → 档位 → 单工具 allow → 弹窗）；`trustMode:true` 迁移为 `danger`。原型 HTML 静态回写 P1–P7。

**Tech Stack:** TypeScript / Svelte 5 / Obsidian Plugin / Vitest / i18n

**Spec:** [S-CHAT-PROTO](../specs/2026-08-10-chat-prototype-align-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出按 AGENTS.md 中文注释
- **不改** Agent Loop 步数、MCP transport、工具 execute 语义
- **不**拉外网字体
- `deny` 在所有档位生效（修正旧 `trustMode` 连 deny 也跳过的行为）
- MCP 工具在 `auto` 下一律仍 ask（一期保守）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/tool-permissions.ts` | `ToolPermissionLevel`；`isDestructiveTool`；改写 `resolveToolPermission` |
| `tests/core/tool-permissions.test.ts` | 三档 × 写/删/deny/grant/MCP |
| `src/settings.ts` | 字段 + 默认 + 设置页三档下拉；弃用信任 toggle |
| `src/main.ts` | `loadSettings` 迁移 `trustMode`→`danger`；`toolPermissionCheck` 传 level |
| `src/ui/chat/ChatView.svelte` | ↑/■ 发送钮；hint 分段；composer padding；读 settings$ |
| `src/i18n/types.ts` / `zh.ts` / `en.ts` | 档位与 hint 文案 |
| `docs/prototype/chat-ui-mockup.html` | 回写 P1–P7 + 发送态 |
| `docs/user-guide.md` | § 多场会话旁补权限三档 |
| `CHANGELOG.md` | `[Unreleased]` |
| `docs/superpowers/STATUS.md` | P-CHAT-PROTO 状态 |

---

### Task 1: 权限核心 — level + resolveToolPermission（TDD）

**Files:**
- Modify: `src/core/tool-permissions.ts`
- Modify: `tests/core/tool-permissions.test.ts`

**Interfaces:**
- Produces:
  - `export type ToolPermissionLevel = 'safe' | 'auto' | 'danger'`
  - `export function isDestructiveTool(name: string): boolean`
  - `ToolPermissionSettings` 含 `toolPermissionLevel?: ToolPermissionLevel`；保留可选 `trustMode?: boolean` 仅测试迁移前兼容（实现里若传入 `trustMode` 且无 level，则 `true`→当作 `danger`）
  - `resolveToolPermission` 签名不变，行为按 spec §5.5

- [ ] **Step 1: 写失败测试（档位矩阵）**

在 `tests/core/tool-permissions.test.ts` 追加（可删改旧 `trustMode - 直接放行` 中「deny 仍放行」用例）：

```typescript
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	isDestructiveTool,
} from '../../src/core/tool-permissions';
import type { ToolCall } from '../../src/ports/llm';

const writeCall: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };
const deleteCall: ToolCall = { id: '2', name: 'delete_note', args: { path: 'a.md' } };
const mcpCall: ToolCall = { id: '3', name: 'mcp__srv__tool', args: {} };

describe('isDestructiveTool', () => {
	it('isDestructiveTool - delete_note / forget_memory - true', () => {
		expect(isDestructiveTool('delete_note')).toBe(true);
		expect(isDestructiveTool('forget_memory')).toBe(true);
		expect(isDestructiveTool('write_note')).toBe(false);
		expect(isDestructiveTool('mcp__x__y')).toBe(true);
	});
});

describe('resolveToolPermission 档位', () => {
	it('deny - 任意档位 - 仍抛错', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(
				writeCall,
				{ toolPermissionLevel: 'danger', toolPermissions: { write_note: 'deny' } },
				grants,
				vi.fn(),
			),
		).rejects.toThrow('已被禁用');
	});

	it('auto - write_note ask - 不弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'auto', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('auto - delete_note ask - 仍弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			deleteCall,
			{ toolPermissionLevel: 'auto', toolPermissions: { delete_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('auto - MCP 工具 - 仍弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			mcpCall,
			{ toolPermissionLevel: 'auto', toolPermissions: {} },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('danger - write ask - 不弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'danger', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('safe - write ask - 弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('兼容 - 仅 trustMode true 无 level - 等同 danger', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ trustMode: true, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});
});
```

保留原有会话 grant / path 无关用例；**删除或改写**旧用例 `trustMode - 直接放行` 里 `deny` 仍放行的期望。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/tool-permissions.test.ts`

Expected: FAIL（`isDestructiveTool` / `toolPermissionLevel` 未定义，或旧行为不符）

- [ ] **Step 3: 实现最小代码**

在 `src/core/tool-permissions.ts`：

```typescript
export type ToolPermissionLevel = 'safe' | 'auto' | 'danger';

export interface ToolPermissionSettings {
	/** @deprecated 迁移期兼容；优先用 toolPermissionLevel */
	trustMode?: boolean;
	toolPermissionLevel?: ToolPermissionLevel;
	toolPermissions: Record<string, ToolPermission>;
}

const DESTRUCTIVE_TOOLS = new Set(['delete_note', 'forget_memory']);

/** 破坏性工具 — auto 档仍需确认；MCP 一律视为破坏性 */
export function isDestructiveTool(name: string): boolean {
	if (name.startsWith('mcp__')) return true;
	return DESTRUCTIVE_TOOLS.has(name);
}

function effectiveLevel(settings: ToolPermissionSettings): ToolPermissionLevel {
	if (settings.toolPermissionLevel) return settings.toolPermissionLevel;
	if (settings.trustMode) return 'danger';
	return 'safe';
}

export async function resolveToolPermission(
	toolCall: ToolCall,
	settings: ToolPermissionSettings,
	grants: ToolPermissionSessionGrants,
	confirm: (toolCall: ToolCall) => Promise<ToolConfirmResult>,
): Promise<void> {
	const path = extractToolPath(toolCall);
	const perm: ToolPermission = settings.toolPermissions[toolCall.name] ?? 'ask';
	if (perm === 'deny') {
		throw new Error(tNow('error.tool.rejectedDisabled', { toolName: toolCall.name }));
	}
	if (grants.has(toolCall.name, path)) return;

	const level = effectiveLevel(settings);
	if (level === 'danger') return;
	if (level === 'auto' && !isDestructiveTool(toolCall.name)) return;

	if (perm === 'allow') return;

	const decision = await confirm(toolCall);
	if (decision === 'deny') {
		throw new Error(tNow('error.tool.rejected'));
	}
	if (decision === 'session') {
		grants.grant(toolCall.name, path);
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/tool-permissions.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-permissions.ts tests/core/tool-permissions.test.ts
git commit -m "$(cat <<'EOF'
feat(permissions): 三级档位驱动 resolveToolPermission

safe/auto/danger；deny 优先；auto 下写放行、删与 MCP 仍问。
EOF
)"
```

---

### Task 2: settings 字段 + loadSettings 迁移 + 设置页下拉

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/main.ts`（`loadSettings`）
- Modify: `src/main.ts`（`toolPermissionCheck` 传入 level）

**Interfaces:**
- Consumes: `ToolPermissionLevel` from `tool-permissions.ts`
- Produces: `RatelVaultSettings.toolPermissionLevel`；迁移后内存中 level 已设

- [ ] **Step 1: 扩展 settings 类型与默认值**

在 `src/settings.ts`：

```typescript
import type { ToolPermission, ToolPermissionLevel } from './core/tool-permissions';

// RatelVaultSettings 内：
toolPermissions: Record<string, ToolPermission>;
/** 工具权限档位 — safe/auto/danger；取代产品语义上的 trustMode */
toolPermissionLevel: ToolPermissionLevel;
/** @deprecated 迁移后由 toolPermissionLevel 取代；读盘兼容 */
trustMode: boolean;

// DEFAULT_SETTINGS:
toolPermissionLevel: 'safe',
trustMode: false,
```

- [ ] **Step 2: loadSettings 迁移**

在 `src/main.ts` `loadSettings` 内 `Object.assign` 之后：

```typescript
const legacyTrust = loaded.trustMode === true;
const level = loaded.toolPermissionLevel;
if (level === 'safe' || level === 'auto' || level === 'danger') {
	this.settings.toolPermissionLevel = level;
} else if (legacyTrust) {
	this.settings.toolPermissionLevel = 'danger';
} else {
	this.settings.toolPermissionLevel = 'safe';
}
```

`toolPermissionCheck` 闭包改为：

```typescript
resolveToolPermission(
	tc,
	{
		toolPermissionLevel: this.settings.toolPermissionLevel,
		toolPermissions: this.settings.toolPermissions,
	},
	this.toolSessionGrants,
	(call) => showToolConfirmModal(this.app, call),
);
```

- [ ] **Step 3: 设置页 — 用下拉替换信任模式 toggle**

找到 `trustMode` 的 `control: { type: 'toggle', key: 'trustMode' }`，改为（文案 key 见 Task 3）：

```typescript
{
	name: tNow('settings.toolPermissionLevel.name'),
	desc: tNow('settings.toolPermissionLevel.desc'),
	control: {
		type: 'dropdown',
		key: 'toolPermissionLevel',
		options: {
			safe: tNow('settings.toolPermissionLevel.safe'),
			auto: tNow('settings.toolPermissionLevel.auto'),
			danger: tNow('settings.toolPermissionLevel.danger'),
		},
	},
},
```

确认 `setControlValue` 对顶层 string key 可写（已有通用路径）；若 dropdown 值需类型断言，在 `setControlValue` 对 `toolPermissionLevel` 校验三值。

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts src/main.ts
git commit -m "$(cat <<'EOF'
feat(settings): 增加 toolPermissionLevel 并迁移 trustMode

设置页用三档下拉；旧 trustMode:true 读入为 danger。
EOF
)"
```

---

### Task 3: i18n 文案

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 增加 key**

```typescript
// types.ts — 在 chat.input / settings 附近追加
'settings.toolPermissionLevel.name': string;
'settings.toolPermissionLevel.desc': string;
'settings.toolPermissionLevel.safe': string;
'settings.toolPermissionLevel.auto': string;
'settings.toolPermissionLevel.danger': string;
'chat.perm.safe': string;
'chat.perm.auto': string;
'chat.perm.danger': string;
'chat.perm.desc.safe': string;
'chat.perm.desc.auto': string;
'chat.perm.desc.danger': string;
'chat.perm.aria': string;
'chat.input.sendAria': string; // 可复用 chat.input.send
'chat.input.stopAria': string;
```

中文示例：

```typescript
'settings.toolPermissionLevel.name': '工具权限档位',
'settings.toolPermissionLevel.desc': '快捷预设；单工具「拒绝」始终优先。与聊天输入下方开关同步。',
'settings.toolPermissionLevel.safe': '安全',
'settings.toolPermissionLevel.auto': '自动',
'settings.toolPermissionLevel.danger': '危险',
'chat.perm.safe': '安全',
'chat.perm.auto': '自动',
'chat.perm.danger': '危险',
'chat.perm.desc.safe': '写与删除会询问',
'chat.perm.desc.auto': '读写放行 · 删除仍确认',
'chat.perm.desc.danger': '全部放行 · 不再确认',
'chat.perm.aria': '工具权限档位',
'chat.input.sendAria': '发送',
'chat.input.stopAria': '停止生成',
```

英文对应：`Safe` / `Auto` / `Danger`；desc 用 spec §5.2 英文句。

- [ ] **Step 2: Commit**

```bash
git add src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(i18n): 工具权限三档与发送 aria 文案"
```

---

### Task 4: ChatView — 发送 ↑ / 停止 ■ + hint 分段 + 底避让

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `styles.css`（若全局需覆盖 Obsidian button 默认，可补 `button.ratel-send`）

**Interfaces:**
- Consumes: `$settingsStore.toolPermissionLevel`；`plugin.saveSettings`

- [ ] **Step 1: 替换发送 / 停止按钮标记**

将：

```svelte
{#if isRunning}
  <button class="ratel-send ratel-stop" ...>{$t('chat.input.stop')}</button>
{:else}
  <button class="ratel-send" ...>{$t('chat.input.send')}</button>
{/if}
```

改为：

```svelte
{#if isRunning}
	<button
		class="ratel-send ratel-stop"
		type="button"
		onclick={stopGeneration}
		title={$t('chat.input.stopAria')}
		aria-label={$t('chat.input.stopAria')}
	>■</button>
{:else}
	<button
		class="ratel-send"
		type="button"
		onclick={sendMessage}
		disabled={!input.trim() || !gate.canSend}
		title={$t('chat.input.sendAria')}
		aria-label={$t('chat.input.sendAria')}
	>↑</button>
{/if}
```

- [ ] **Step 2: 调整 `.ratel-send` CSS 为固定方钮**

```css
.ratel-send {
	flex-shrink: 0;
	align-self: flex-end;
	width: 34px;
	min-width: 34px;
	height: 34px;
	padding: 0;
	border-radius: 10px;
	border: none;
	background: var(--interactive-accent);
	color: var(--text-on-accent, #fff);
	font-size: 14px;
	font-weight: 700;
	line-height: 1;
	/* ...其余 hover/disabled/stop 保持 */
}
```

- [ ] **Step 3: 在输入壳下方增加 hint 行**

紧接 `</div>` of `ratel-input-shell-wrap` 之后、`ratel-input` 结束前：

```svelte
{@const permLevel = $settingsStore.toolPermissionLevel ?? 'safe'}
<div class="ratel-perm-hint" data-level={permLevel}>
	<div class="ratel-perm-seg" role="radiogroup" aria-label={$t('chat.perm.aria')}>
		{#each (['safe', 'auto', 'danger'] as const) as lv}
			<button
				type="button"
				role="radio"
				class:is-active={permLevel === lv}
				aria-checked={permLevel === lv}
				data-level={lv}
				onclick={() => void setToolPermissionLevel(lv)}
			>{$t(`chat.perm.${lv}`)}</button>
		{/each}
	</div>
	<span class="ratel-perm-keys">
		<span class="ratel-perm-desc">{$t(`chat.perm.desc.${permLevel}`)}</span>
	</span>
</div>
```

```typescript
async function setToolPermissionLevel(level: 'safe' | 'auto' | 'danger'): Promise<void> {
	plugin.settings.toolPermissionLevel = level;
	await plugin.saveSettings();
}
```

样式对齐原型：`.ratel-perm-seg` 圆角分段；`[data-level=safe|auto|danger]` 激活色用 `--text-success` / accent / `--text-error`（或现有 copper CSS 变量）。

- [ ] **Step 4: composer 底避让**

```css
.ratel-composer {
	/* 已有 flex 等 */
	padding-bottom: max(22px, env(safe-area-inset-bottom, 0px));
}
```

- [ ] **Step 5: build 冒烟**

Run: `node esbuild.config.mjs production`  
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/ui/chat/ChatView.svelte styles.css
git commit -m "$(cat <<'EOF'
feat(ui): 发送↑方钮、权限三档 hint、composer 底避让

对齐 S-CHAT-PROTO 产品侧 I1–I5。
EOF
)"
```

---

### Task 5: 回写原型 HTML（P1–P7）

**Files:**
- Modify: `docs/prototype/chat-ui-mockup.html`

- [ ] **Step 1: 按清单改静态结构**

必须可见：

1. Header：session chip 旁 ✎ 按钮  
2. 来源区：折叠「来源 N 篇」pill（默认收起）  
3. 抽屉底：记忆 / MCP / 反馈 / 赞助 四个入口  
4. Trace 某行带 `MCP` 小徽章  
5. 输入上方附件 chip 一条  
6. 发送为 ↑；可用按钮切换演示 ■ 停止态  
7. 保留三级权限 + composer `padding-bottom`  
8. **不要**恢复可见的长「确认点」说明文；生成中切换确认可用 HTML comment 一句带过  

- [ ] **Step 2: 浏览器打开目视**

Run: `open docs/prototype/chat-ui-mockup.html`  
Expected: 上述 1–7 均可辨认

- [ ] **Step 3: Commit**

```bash
git add docs/prototype/chat-ui-mockup.html
git commit -m "docs(prototype): 回写 0.1.18 能力与发送/权限态"
```

---

### Task 6: user-guide + CHANGELOG + STATUS

**Files:**
- Modify: `docs/user-guide.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: user-guide**

在「多场会话」或「设置速查」增加一小段：

```markdown
### 工具权限档位

聊天输入下方可切换：**安全**（写/删询问） / **自动**（读写放行，删除仍确认） / **危险**（不再确认）。  
设置 → 记忆与权限 中有同一选项。单个工具设为「拒绝」时始终生效。
```

- [ ] **Step 2: CHANGELOG `[Unreleased]`**

```markdown
### Added
- **工具权限三档** — 输入下方可切换安全 / 自动 / 危险；自动档读写放行、删除仍确认

### Changed
- **发送钮改为 ↑ 方钮** — 生成中显示停止方块，窄侧栏不再被「发送」二字撑宽
- **聊天底栏避开 Obsidian 状态栏** — 权限开关与提示不再被挡
```

- [ ] **Step 3: STATUS**

将 `P-CHAT-PROTO` 标为 Completed（执行结束时）；本 Task 创建 plan 时先标 Pending → 执行中 In Progress。

- [ ] **Step 4: Commit**

```bash
git add docs/user-guide.md CHANGELOG.md docs/superpowers/STATUS.md
git commit -m "docs: S-CHAT-PROTO 用户说明与 CHANGELOG"
```

---

## 自审（对照 spec）

| Spec 项 | Task |
|---|---|
| I1/I2 发送↑停止■ | Task 4 |
| I3/I4 三档 + hint | Task 1–4 |
| I5 底避让 | Task 4 |
| P1–P7 原型回写 | Task 5 |
| trustMode 迁移 / deny 优先 | Task 1–2 |
| i18n | Task 3 |
| user-guide / CHANGELOG | Task 6 |
| MCP auto 仍 ask | Task 1 `isDestructiveTool` |

无 TBD；旧 trustMode+deny 测试期望已按 spec 纠正。

---

## 执行交接

Plan 完成后请选择：

1. **Subagent-Driven（推荐）** — 每 Task 新 subagent + 两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做  

**Which approach?**

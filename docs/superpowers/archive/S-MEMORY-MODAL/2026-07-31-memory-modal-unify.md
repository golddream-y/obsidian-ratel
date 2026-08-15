# P-MEMORY-MODAL — 记忆管理并入聊天 Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆除独立记忆侧栏与 brain ribbon，从状态抽屉 / 设置用同一 `MemoryModal` 打开全量 `MemoryPanel`，与问题反馈同属 Modal 壳，降低使用复杂度。

**Architecture:** 新建 `MemoryModal` 在 `onOpen` mount 现有 `MemoryPanel.svelte`，`onClose` unmount；`RatelVaultPlugin.openMemoryModal()` 单例持有实例；StatusDrawer 增加与反馈同级的「记忆」入口；删除 `MemoryPanelView` / `VIEW_TYPE_MEMORY` / brain ribbon / `activateMemoryView` leaf 逻辑，并 detach 残留 leaf。

**Tech Stack:** TypeScript / Svelte 5 (`mount`/`unmount`) / Obsidian `Modal` / Vitest / i18n

**Spec:** [S-MEMORY-MODAL](../specs/2026-07-31-memory-modal-unify-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 描述中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出按 AGENTS.md 中文注释规范
- **不改** `MemoryStore`、记忆文件格式、Agent 记忆工具、注入逻辑
- **不改** `MemoryPanel` 业务能力（筛选 / 搜索 / 行内编辑 / 清理）；仅允许为 Modal 嵌入加可选 prop
- 次要能力壳：状态抽屉只放入口；记忆 / 反馈 = Modal；赞助 = 外链
- 单例：`openMemoryModal` 若已打开则直接 return（不叠多个记忆 Modal）
- Modal 内隐藏面板自带大标题（避免与 `titleEl` 重复）；用 prop `embeddedInModal`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/memory-panel/MemoryModal.ts` | 新建：Modal 壳 + mount/unmount MemoryPanel |
| `src/ui/memory-panel/MemoryPanel.svelte` | 小改：`embeddedInModal` 时隐藏 `.ratel-memory-title` |
| `src/ui/memory-panel/MemoryPanelView.ts` | **删除** |
| `src/main.ts` | `openMemoryModal`；去 registerView / brain ribbon / activateMemoryView；detach 旧 leaf |
| `src/ui/status/StatusDrawer.svelte` | `onMemory` 入口按钮 |
| `src/ui/chat/ChatView.svelte` | 传入 `onMemory` |
| `src/settings.ts` | viewMemory action → `openMemoryModal` |
| `styles.css` | `.modal .ratel-memory-modal` 加宽与滚动 |
| `src/i18n/types.ts` / `zh.ts` / `en.ts` | `status.drawer.memory`；更新 `memory.settings.viewMemory.desc` |
| `tests/ui/memory-panel/memory-modal.test.ts` | 单例 open 行为（可测控制器） |
| `docs/user-guide.md` | 入口描述 |
| `CHANGELOG.md` | `[Unreleased]` |
| `docs/superpowers/STATUS.md` | P-MEMORY-MODAL 状态 |

---

### Task 1: MemoryModal + 嵌入 prop + CSS

**Files:**
- Create: `src/ui/memory-panel/MemoryModal.ts`
- Modify: `src/ui/memory-panel/MemoryPanel.svelte`
- Modify: `styles.css`

**Interfaces:**
- Produces: `export class MemoryModal extends Modal`
- Consumes: `MemoryPanel.svelte` props `{ plugin, embeddedInModal?: boolean }`

- [ ] **Step 1: 给 MemoryPanel 增加 embeddedInModal**

在 `MemoryPanel.svelte` 的 props 中：

```typescript
let {
	plugin,
	embeddedInModal = false,
}: {
	plugin: RatelVaultPlugin;
	/** 嵌在 MemoryModal 内时隐藏面板自带标题,避免与 Modal titleEl 重复 */
	embeddedInModal?: boolean;
} = $props();
```

模板标题处：

```svelte
<div class="ratel-memory-header">
	{#if !embeddedInModal}
		<span class="ratel-memory-title">{$t('memory.panel.title')}</span>
	{/if}
	<input
		type="text"
		class="ratel-memory-search"
		placeholder={$t('memory.panel.searchPlaceholder')}
		bind:value={searchQuery}
	/>
</div>
```

- [ ] **Step 2: 实现 MemoryModal**

```typescript
/**
 * @file src/ui/memory-panel/MemoryModal.ts
 * @description 记忆管理 Modal — 挂载全量 MemoryPanel,与 FeedbackModal 同属次要能力壳
 * @module ui/memory-panel/MemoryModal
 * @depends obsidian, svelte, ./MemoryPanel.svelte, ../../i18n
 */

import { App, Modal } from 'obsidian';
import { mount, unmount } from 'svelte';
import MemoryPanel from './MemoryPanel.svelte';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';

/**
 * 记忆管理 Modal。
 *
 * 设计要点:
 * - onOpen mount MemoryPanel(embeddedInModal=true);onClose unmount + empty
 * - 关键路径:Svelte 5 必须用 mount/unmount,禁止 new Component
 */
export class MemoryModal extends Modal {
	private component: ReturnType<typeof mount> | null = null;
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('memory.panel.title'));
		this.contentEl.empty();
		this.contentEl.addClass('ratel-memory-modal');
		applyRatelAppearance(this.contentEl, {
			uiColorScheme: this.plugin.settings.uiColorScheme,
			uiAccent: this.plugin.settings.uiAccent,
		});
		this.component = mount(MemoryPanel, {
			target: this.contentEl,
			props: { plugin: this.plugin, embeddedInModal: true },
		});
	}

	onClose(): void {
		if (this.component) {
			void unmount(this.component);
			this.component = null;
		}
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}
}
```

- [ ] **Step 3: 添加 Modal 尺寸 CSS**

在 `styles.css` 末尾追加：

```css
/* ==================== 记忆管理 Modal ==================== */
.modal .ratel-memory-modal {
	width: min(720px, 92vw);
	max-height: min(80vh, 720px);
	overflow-y: auto;
	padding-top: 4px;
}
```

- [ ] **Step 4: 提交**

```bash
git add src/ui/memory-panel/MemoryModal.ts src/ui/memory-panel/MemoryPanel.svelte styles.css
git commit -m "feat(memory): MemoryModal 挂载全量 MemoryPanel"
```

---

### Task 2: plugin.openMemoryModal 单例 + 拆除独立视图

**Files:**
- Modify: `src/main.ts`
- Delete: `src/ui/memory-panel/MemoryPanelView.ts`
- Create: `tests/ui/memory-panel/open-memory-modal.test.ts`

**Interfaces:**
- Produces: `openMemoryModal(): void`（public）
- Removes: `activateMemoryView`, `VIEW_TYPE_MEMORY` 注册, brain ribbon

- [ ] **Step 1: 写单例行为测试（控制器纯逻辑）**

为便于测试，在 `MemoryModal.ts` 旁或同文件导出：

```typescript
/** 是否应新建 Modal — 已有实例则 false */
export function shouldCreateMemoryModal(current: MemoryModal | null): boolean {
	return current === null;
}
```

测试：

```typescript
/**
 * @file tests/ui/memory-panel/open-memory-modal.test.ts
 * @description openMemoryModal 单例判定
 */
import { describe, it, expect } from 'vitest';
import { shouldCreateMemoryModal } from '../../../src/ui/memory-panel/MemoryModal';

describe('shouldCreateMemoryModal', () => {
	it('shouldCreateMemoryModal - 无实例 - 允许新建', () => {
		expect(shouldCreateMemoryModal(null)).toBe(true);
	});

	it('shouldCreateMemoryModal - 已有实例 - 不再新建', () => {
		expect(shouldCreateMemoryModal({} as never)).toBe(false);
	});
});
```

- [ ] **Step 2: 跑测试确认失败后实现 helper 并再跑通过**

Run: `npx vitest run tests/ui/memory-panel/open-memory-modal.test.ts`  
Expected: PASS

- [ ] **Step 3: main.ts 接线**

在 `RatelVaultPlugin` 类中增加：

```typescript
private memoryModal: MemoryModal | null = null;

/**
 * 打开记忆管理 Modal(单例)。
 *
 * 关键路径:已打开则忽略,避免叠多个记忆窗。
 */
openMemoryModal(): void {
	if (!shouldCreateMemoryModal(this.memoryModal)) return;
	const modal = new MemoryModal(this.app, this);
	this.memoryModal = modal;
	modal.onClosed = () => {
		if (this.memoryModal === modal) this.memoryModal = null;
	};
	modal.open();
}
```

`onload` 中：

1. **删除** `import { MemoryPanelView, VIEW_TYPE_MEMORY }` 与 `registerView(VIEW_TYPE_MEMORY, ...)`
2. **删除** brain `addRibbonIcon` 整段
3. 在合适位置（registerView 聊天之后或 onunload 对称处）清理残留：

```typescript
// 修复:旧版独立记忆 leaf 残留 — 合并到 Modal 后拆除
for (const leaf of this.app.workspace.getLeavesOfType('ratel-memory-panel')) {
	leaf.detach();
}
```

（字符串字面量即可，因 `VIEW_TYPE_MEMORY` 常量文件将删除。）

4. **删除**整个 `activateMemoryView` 方法；所有调用改为 `openMemoryModal()`

5. import `MemoryModal, { shouldCreateMemoryModal }` from `./ui/memory-panel/MemoryModal`

- [ ] **Step 4: 删除 MemoryPanelView.ts**

```bash
git rm src/ui/memory-panel/MemoryPanelView.ts
```

全仓确认无残留 import：`rg MemoryPanelView|VIEW_TYPE_MEMORY|activateMemoryView src`

- [ ] **Step 5: 提交**

```bash
git add src/main.ts src/ui/memory-panel/MemoryModal.ts tests/ui/memory-panel/open-memory-modal.test.ts
git add -u src/ui/memory-panel/MemoryPanelView.ts
git commit -m "feat(memory): openMemoryModal 单例并拆除独立记忆视图"
```

---

### Task 3: 抽屉入口 + i18n

**Files:**
- Modify: `src/ui/status/StatusDrawer.svelte`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

**Interfaces:**
- Consumes: `plugin.openMemoryModal`
- Produces: 抽屉 `onMemory` 与反馈 / 赞助同级

- [ ] **Step 1: i18n**

`types.ts` StatusStrings 增加：

```typescript
'status.drawer.memory': string;
```

`zh.ts`: `'status.drawer.memory': '记忆',`  
`en.ts`: `'status.drawer.memory': 'Memory',`

- [ ] **Step 2: StatusDrawer 增加 onMemory**

在 props 中增加 `onMemory?: () => void`；条件改为 `onFeedback || onSponsor || onMemory`。

在 `ratel-drawer-actions` 内追加（图标可用简单 book/brain 线框 SVG，风格对齐反馈按钮；**禁止**给 `<nav>` 加会弹出「相关操作」的 `aria-label`）：

```svelte
{#if onMemory}
	<button type="button" class="ratel-drawer-action" onclick={onMemory}>
		<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
			<path
				d="M6 4.5h9.5A2.5 2.5 0 0 1 18 7v12.2l-3.2-1.6L12 19l-2.8-1.4L6 19.2V7A2.5 2.5 0 0 1 8.5 4.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linejoin="round"
			/>
		</svg>
		<span>{$t('status.drawer.memory')}</span>
	</button>
{/if}
```

- [ ] **Step 3: ChatView 传入**

```typescript
function openMemory(): void {
	plugin.openMemoryModal();
}
```

```svelte
<StatusDrawer
	...
	onFeedback={openFeedback}
	onSponsor={openSponsor}
	onMemory={openMemory}
/>
```

（若当前分支尚无 feedback/sponsor 接线，本 Task **仍只加 memory**；不要在本 plan 重做赞助/反馈。）

- [ ] **Step 4: 提交**

```bash
git add src/ui/status/StatusDrawer.svelte src/ui/chat/ChatView.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(memory): 状态抽屉增加记忆入口"
```

---

### Task 4: 设置按钮改线

**Files:**
- Modify: `src/settings.ts`（约 666 行 `viewMemory` action）
- Modify: `src/i18n/zh.ts` / `en.ts`（`memory.settings.viewMemory.desc`）

- [ ] **Step 1: 改 action**

```typescript
action: () => this.plugin.openMemoryModal(),
```

- [ ] **Step 2: 更新描述文案**

zh: `'memory.settings.viewMemory.desc': '打开记忆管理窗口',`  
en: `'memory.settings.viewMemory.desc': 'Open the memory manager',`  

（name 可保持「查看记忆」类现有 key，若需同步改 name 一并改 zh/en/types。）

- [ ] **Step 3: 提交**

```bash
git add src/settings.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(memory): 设置页打开记忆改为 Modal"
```

---

### Task 5: 文档 + CHANGELOG + STATUS

**Files:**
- Modify: `docs/user-guide.md`（§5 记忆入口句）
- Modify: `CHANGELOG.md` `[Unreleased]`
- Modify: `docs/superpowers/STATUS.md`（P-MEMORY-MODAL → Completed；执行结束时）

- [ ] **Step 1: user-guide**

将类似「侧栏可开『记忆』面板」改为：

> 在聊天侧栏展开状态条 → 底部「记忆」，或设置 → 记忆与权限 → 查看记忆；在弹窗中浏览 / 编辑 / 清理模型记忆。

并删除 brain / 独立记忆侧栏表述（若有）。

- [ ] **Step 2: CHANGELOG `[Unreleased]`**

```markdown
### Changed
- **记忆管理并入聊天** — 不再单独开记忆侧栏；从状态抽屉或设置打开同一记忆窗口（能力不变）

### Removed
- **记忆专用侧栏图标** — 去掉 ribbon 上的大脑图标入口
```

- [ ] **Step 3: 回归命令**

```bash
npx vitest run tests/ui/memory-panel/open-memory-modal.test.ts
rg -n "MemoryPanelView|VIEW_TYPE_MEMORY|activateMemoryView|addRibbonIcon\\('brain'" src || true
```

Expected: 测试 PASS；src 中无旧符号（`rg` 无匹配或仅注释/归档外）。

- [ ] **Step 4: STATUS**

将 P-MEMORY-MODAL 标为 `✅ Completed`，备注分支名。

- [ ] **Step 5: 提交**

```bash
git add docs/user-guide.md CHANGELOG.md docs/superpowers/STATUS.md
git commit -m "docs: 记忆 Modal 入口与 P-MEMORY-MODAL Completed"
```

---

## Spec 覆盖自检

| Spec 要求 | Task |
|---|---|
| MemoryModal 挂载全量 MemoryPanel | Task 1 |
| 单例 openMemoryModal | Task 2 |
| 拆 brain / ItemView / activateMemoryView / detach | Task 2 |
| 抽屉同级入口 | Task 3 |
| 设置改线 | Task 4 |
| 嵌套确认不关主窗 | Task 1（保留 Panel 内 Modal）；手工验收 |
| user-guide / CHANGELOG | Task 5 |
| 不改 MemoryStore / 工具 | 全 plan 约束 |

## Placeholder 扫描

无 TBD；单例策略已钉死；`embeddedInModal` 已写清。

---

## 执行方式

Plan 已保存。两种执行选项：

1. **Subagent-Driven（推荐）** — 每 Task 新 subagent，两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做  

要哪种？

# 用户记忆系统 — Plan B：UI + 设置

> ⚠️ **本 plan 已适配声明式 settings API**(S-SETTINGS-DECLARATIVE 完成后重写)。Task 1 原 `display()` + `new Setting(containerEl)` 已改为 `getSettingDefinitions()` 声明式 group。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现记忆管理侧边栏面板（Svelte 5）+ 设置页 6 个记忆参数。

**Architecture:** 新增 `MemoryPanelView`（Obsidian ItemView 包装）挂载 `MemoryPanel.svelte` 组件，通过 `plugin.memoryStore` 读写记忆。设置页在 `RatelVaultSettingTab.getSettingDefinitions()` 中追加「记忆」group(声明式 API)。

**前置依赖:** Plan A 完成。`MemoryStore` 类、`memoryStore` 实例、三个工具均已就绪。

**Spec 参考:** `docs/superpowers/specs/2026-07-05-memory-system-design.md` §7-8

---

## 文件清单（Plan B）

```
新建:
  src/ui/memory-panel/MemoryPanel.svelte   ← 记忆面板 Svelte 组件
  src/ui/memory-panel/MemoryPanelView.ts   ← Obsidian ItemView 包装

修改:
  src/settings.ts                          ← 新增 6 个记忆设置项 + 默认值
  src/main.ts                              ← 注册面板 + 加载设置
```

---

## 对接 Plan A 的接口

| Plan A 产出 | Plan B 使用方式 |
|-------------|-----------------|
| `plugin.memoryStore` 实例 | `MemoryPanel.svelte` 通过 props 注入，调用 `readGlobal()`, `readIndex()`, `readTopic()`, `writeGlobal()`, `getTotalSize()` |
| `MemoryEntry` 类型 | 面板解析 markdown 条目时使用 |
| `TopicIndexEntry` 类型 | 面板渲染主题列表时使用 |
| `plugin.settings.memoryEnabled` 等 | 设置页读写；面板判断是否渲染 |

---

## Task 1: 设置页记忆参数

**Files:** `src/settings.ts`

- [ ] Step 1: 在 `RatelVaultSettings` 接口末尾追加 6 个字段：

```typescript
	// Memory
	memoryEnabled: boolean;
	memoryAutoWrite: boolean;
	memoryStorageLimitMB: number;
	memoryInjectLimitKB: number;
	memoryDynamicLimitKB: number;
	memoryContextTotalLimitKB: number;
```

- [ ] Step 2: 在 `DEFAULT_SETTINGS` 末尾追加默认值：

```typescript
	memoryEnabled: true,
	memoryAutoWrite: true,
	memoryStorageLimitMB: 10,
	memoryInjectLimitKB: 20,
	memoryDynamicLimitKB: 30,
	memoryContextTotalLimitKB: 50,
```

- [ ] Step 3: 在 `getSettingDefinitions()` 返回数组中追加 Memory group,插入到 Diagnostics page 与 Developer group 之间。用声明式 `control: { type: 'toggle' / 'number' }` 表达 6 个设置项 + 1 个 action 按钮(打开记忆面板)。

代码示例:

```typescript
			// ==================== Memory ====================
			{
				type: 'group',
				heading: '记忆',
				items: [
					{
						name: '启用记忆功能',
						desc: '关闭后 Agent 不读写记忆',
						control: { type: 'toggle', key: 'memoryEnabled' },
					},
					{
						name: '自动记忆写入',
						desc: '关闭后 Agent 仅响应显式"记住"指令,不主动推断写入',
						control: { type: 'toggle', key: 'memoryAutoWrite' },
					},
					{
						name: '存储总上限(MB)',
						desc: '所有记忆文件磁盘占用上限,默认 10 MB',
						control: { type: 'number', key: 'memoryStorageLimitMB', min: 1, max: 1000 },
					},
					{
						name: '基础记忆注入上限(KB)',
						desc: 'global.md 注入系统提示的硬限制,默认 20 KB',
						control: { type: 'number', key: 'memoryInjectLimitKB', min: 1, max: 500 },
					},
					{
						name: '动态记忆注入上限(KB)',
						desc: '单次 search_memory 返回内容硬限制,默认 30 KB',
						control: { type: 'number', key: 'memoryDynamicLimitKB', min: 1, max: 500 },
					},
					{
						name: '上下文总记忆上限(KB)',
						desc: '基础 + 动态记忆在上下文中的合计硬限制,默认 50 KB',
						control: { type: 'number', key: 'memoryContextTotalLimitKB', min: 1, max: 500 },
					},
					{
						name: '查看记忆',
						desc: '打开记忆管理面板',
						action: () => void this.plugin.activateMemoryView(),
					},
				],
			},
```

**关键决策:**
- 用声明式 `control: { type: 'toggle' / 'number' }`,不再用 `new Setting(containerEl)`(S-SETTINGS-DECLARATIVE 已删除 `display()`)
- 数值字段用 `control: { type: 'number', min, max }`,框架自动处理 parseInt 与边界校验,无需手动 `parseInt(value, 10)` + `isNaN` 判断
- "查看记忆"按钮用 `action`,调 `this.plugin.activateMemoryView()`(Task 4 在 `main.ts` 中实现该方法);若 Task 4 方法名调整,以此处调用为准
- 副作用(重建索引 / 通知 MemoryStore)由 `setControlValue` override 处理(已在 S-SETTINGS-DECLARATIVE 实现),无需手动 `await this.plugin.saveSettings()` + `this.display()`
- field 名与 Step 1/Step 2 一致(`memoryEnabled` / `memoryAutoWrite` / `memoryStorageLimitMB` / `memoryInjectLimitKB` / `memoryDynamicLimitKB` / `memoryContextTotalLimitKB`),对应 spec §8.3 六个配置项

- [ ] Step 4: `npx tsc --noEmit` → 无新增错误
- [ ] Step 5: 提交

---

## Task 2: MemoryPanelView（ItemView 包装）

**Files:** `src/ui/memory-panel/MemoryPanelView.ts`

- [ ] Step 1: 创建 `MemoryPanelView` 类，参考 `ChatView.ts` 模式：

```typescript
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import type { RatelVaultPlugin } from '../../main';
import MemoryPanelComponent from './MemoryPanel.svelte';

export const VIEW_TYPE_MEMORY = 'ratel-memory-panel';

export class MemoryPanelView extends ItemView {
	component: ReturnType<typeof mount> | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: RatelVaultPlugin) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_MEMORY; }
	getDisplayText(): string { return 'Ratel 记忆'; }
	getIcon(): string { return 'brain'; }

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		this.component = mount(MemoryPanelComponent, {
			target: container,
			props: { plugin: this.plugin },
		});
	}

	async onClose(): Promise<void> {
		if (this.component) {
			await unmount(this.component);
			this.component = null;
		}
	}
}
```

- [ ] Step 2: `npx tsc --noEmit` → 无新增错误（Svelte import 由 esbuild 处理）
- [ ] Step 3: 提交

---

## Task 3: MemoryPanel.svelte 组件

**Files:** `src/ui/memory-panel/MemoryPanel.svelte`

- [ ] Step 1: 创建 Svelte 5 runes 组件。使用 `$props()` 接收 `plugin`，`$state()` 管理 UI 状态。关键数据流：

```
props.plugin.memoryStore
  → readGlobal() → globalEntries: MemoryEntry[]
  → readIndex()  → topicIndex: TopicIndexEntry[]
  → getTotalSize() → totalSize: number

用户操作：
  - 筛选标签 [全部|用户要求|模型推断] → filter: 'all'|'user'|'model'
  - 搜索框输入 → 实时过滤条目
  - 点击条目 → 展开行内编辑 textarea → 保存 → writeGlobal/writeTopic
  - 删除条目 → 确认弹窗 → 修改文件 → 写回
  - "清理模型推断的记忆" → 遍历所有文件 → 删除 source=model 行 → 写回
```

- [ ] Step 2: 组件结构：

```svelte
<div class="ratel-memory-panel">
  <!-- 搜索框 -->
  <input type="text" placeholder="搜索记忆..." bind:value={searchQuery} />

  <!-- 筛选标签 -->
  <div class="filter-tabs">
    <button class:active={filter==='all'} onclick={() => filter='all'}>全部</button>
    <button class:active={filter==='user'} onclick={() => filter='user'}>用户要求</button>
    <button class:active={filter==='model'} onclick={() => filter='model'}>模型推断</button>
  </div>

  <!-- 全局基础 -->
  <details open>
    <summary>📌 全局基础</summary>
    {#each filteredGlobalEntries as entry}
      <div class="memory-entry">
        <span class="source-icon">{entry.source === 'user' ? '👤' : '🤖'}</span>
        <span class="content">{entry.content}</span>
      </div>
    {/each}
  </details>

  <!-- 主题列表 -->
  {#each topicIndex as topic}
    <details>
      <summary>📂 {topic.name}</summary>
      <!-- 加载 readTopic(topic.name) → 渲染条目 -->
    </details>
  {/each}

  <!-- 底部状态栏 -->
  <div class="footer">
    记忆总大小: {formatBytes(totalSize)} / {settings.memoryStorageLimitMB} MB
    <button onclick={clearModelMemories}>清理模型推断的记忆</button>
  </div>
</div>
```

- [ ] Step 3: 在组件 `<script>` 中实现核心逻辑：
  - `loadMemories()` — 并行调 `readGlobal()` + `readIndex()` + `getTotalSize()`，解析 global.md 内容为 `MemoryEntry[]`（按 section 分组）
  - `filteredGlobalEntries` — `$derived` 按 filter + searchQuery 过滤
  - `clearModelMemories()` — 弹出 `Notice` 确认 → 遍历所有文件删除 `source: model` 行 → 刷新
  - 行内编辑 — `editingId` state → 双击切换 → textarea → blur 保存
- [ ] Step 4: 添加 `<style>` 块，参考现有 ChatView 的毛玻璃、圆角、间距风格
- [ ] Step 5: `npm run build` → 无错误
- [ ] Step 6: 提交

---

## Task 4: main.ts 面板注册

**Files:** `src/main.ts`

- [ ] Step 1: 在 import 区追加：
```typescript
import { MemoryPanelView, VIEW_TYPE_MEMORY } from './ui/memory-panel/MemoryPanelView';
```

- [ ] Step 2: 在 `onload()` 的 `registerView(VIEW_TYPE_CHAT, ...)` 之后追加：
```typescript
this.registerView(VIEW_TYPE_MEMORY, (leaf) => new MemoryPanelView(leaf, this));
```

- [ ] Step 3: 添加 ribbon 图标（在现有 ribbon 图标之后）：
```typescript
this.addRibbonIcon('brain', 'Ratel 记忆', () => {
  this.activateView(VIEW_TYPE_MEMORY);
});
```

- [ ] Step 4: 添加 `activateView` 方法（如果尚未有通用版本，参考 ChatView 的激活逻辑）：
```typescript
async activateMemoryView() {
  const workspace = this.app.workspace;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_MEMORY)[0];
  if (!leaf) {
    leaf = workspace.getRightLeaf(false);
    if (leaf) await leaf.setViewState({ type: VIEW_TYPE_MEMORY, active: true });
  }
  workspace.revealLeaf(leaf!);
}
```

- [ ] Step 5: `npx tsc --noEmit` → 无新增错误
- [ ] Step 6: 提交

---

## Task 5: Plan A + Plan B 联调验证

- [ ] Step 1: `npm run build` → 无错误
- [ ] Step 2: `npx vitest run` → 全部 PASS
- [ ] Step 3: 在 Obsidian 中手动验证：
  - 设置页 → 「记忆」区域 → 6 个参数可见可调
  - 左侧功能区 → 脑图标 → 打开记忆面板
  - 面板显示 global.md 内容 + 主题列表
  - 筛选标签切换正常
  - 聊天中对 Agent 说"记住 X" → 面板实时显示新条目
  - "清理模型推断的记忆" → 仅删除 source=model 条目
- [ ] Step 4: 提交

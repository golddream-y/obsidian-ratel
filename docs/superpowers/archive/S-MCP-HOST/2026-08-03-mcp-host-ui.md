# P-MCP-HOST-UI — 抽屉管理 Modal + 对话 MCP 展示 + spawn/权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户从 StatusDrawer 打开 MCP 管理 Modal 完成安装/启停/删除；对话 Trace 中 MCP 调用可一眼辨认；stdio 首次 spawn 确认；动态权限；全 i18n。

**Architecture:** 主路径对齐 MemoryModal：`StatusDrawer.onMcp` → `plugin.openMcpManageModal()` → `McpManageModal` 读写 `settings.mcpServers` 并 `mcpHost.sync`。对话侧不改 AgentEvent：在 `formatToolDisplayName` + `ToolSegment` 识别 `mcp__` 前缀加展示名与徽标。设置页仅补动态权限 +「打开管理」跳转。

**Tech Stack:** TypeScript / Obsidian Modal + Setting API / Svelte（StatusDrawer / ToolSegment）/ Vitest / i18n

**Spec:** [S-MCP-HOST](../specs/2026-08-03-mcp-host-design.md) §4.11 · **依赖:** [P-MCP-HOST-CORE](2026-08-03-mcp-host-core.md)

## Global Constraints

- 用户可见字符串必须 `tNow` / `t`，`zh.ts` + `en.ts` + `types.ts` 同步
- 测试描述中文：`行为 - 条件 - 期望结果`
- **不以插件设置长表单为主路径**；CRUD 在 `McpManageModal`
- **不做** MCP 应用商店 / `.mcpb` / OAuth
- 密钥只展示 secret ID，不展示值
- CORE 的 `confirmSpawn` 占位（恒 false）必须替换为真 Modal
- 不新增 `mcp.call` 事件类型

---

## UI 三部分（对照用户需求）

| # | 部分 | 落点 |
|---|---|---|
| A | **对话过程中 MCP 调用展示** | `formatToolDisplayName` + `ToolSegment` 徽标 + 权限确认文案 |
| B | **抽屉 MCP 按钮** | `StatusDrawer` 动作区，旁记忆/反馈 |
| C | **点击弹框安装与管理** | `McpManageModal`：列表 / 添加 HTTP·stdio / 启停删除 / 状态 / 钥匙串 hint |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/i18n/types.ts` / `zh.ts` / `en.ts` | Drawer / Modal / Trace / 错误文案 |
| `src/core/mcp-config.ts` | 配置校验纯函数 |
| `src/ui/mcp/parse-mcp-tool-name.ts` | 解析 `mcp__server__tool` |
| `src/ui/mcp/McpManageModal.ts` | 管理 Modal 单例（类比 MemoryModal） |
| `src/ui/mcp/mcp-spawn-confirm-modal.ts` | stdio 首次确认 |
| `src/ui/status/StatusDrawer.svelte` | `onMcp` 按钮 |
| `src/ui/chat/ChatView.svelte` | 传入 `onMcp` |
| `src/ui/chat/format-tool-display.ts` | MCP 友好展示名 |
| `src/ui/chat/message-stream/ToolSegment.svelte` | MCP 徽标 |
| `src/ui/chat/message-stream/types.ts` | 可选 `kind?: 'mcp'`（或纯靠 name 前缀，不强制改类型） |
| `src/core/tool-permissions.ts` | `summarizeToolCall` MCP 分支 |
| `src/settings.ts` | 动态权限 +「打开 MCP 管理」 |
| `src/main.ts` | `openMcpManageModal`、`confirmSpawn`、Drawer 接线 |
| `tests/ui/mcp/parse-mcp-tool-name.test.ts` | 新建 |
| `tests/core/mcp-config-validate.test.ts` | 新建 |
| `tests/ui/chat/format-tool-display` 相关 | 追加 MCP 用例 |

---

### Task 1: i18n + 校验 + 解析工具名

**Files:**
- Modify: `src/i18n/types.ts`, `zh.ts`, `en.ts`
- Create: `src/core/mcp-config.ts`
- Create: `src/ui/mcp/parse-mcp-tool-name.ts`
- Test: `tests/core/mcp-config-validate.test.ts`
- Test: `tests/ui/mcp/parse-mcp-tool-name.test.ts`

- [ ] **Step 1: 解析测试**

```typescript
/**
 * @file tests/ui/mcp/parse-mcp-tool-name.test.ts
 * @description 解析 mcp__server__tool 注册名
 * @module tests/ui/mcp/parse-mcp-tool-name
 */

import { describe, it, expect } from 'vitest';
import { parseMcpToolName, isMcpToolName } from '../../../src/ui/mcp/parse-mcp-tool-name';

describe('parseMcpToolName', () => {
	it('isMcpToolName - mcp__ 前缀 - true', () => {
		expect(isMcpToolName('mcp__tavily__search')).toBe(true);
		expect(isMcpToolName('search_vault')).toBe(false);
	});

	it('parseMcpToolName - 标准三段 - 拆出 server 与 tool', () => {
		expect(parseMcpToolName('mcp__tavily__search')).toEqual({
			serverId: 'tavily',
			toolName: 'search',
		});
	});

	it('parseMcpToolName - tool 名含下划线 - 只按前两段 __ 切分', () => {
		expect(parseMcpToolName('mcp__tavily__search_web')).toEqual({
			serverId: 'tavily',
			toolName: 'search_web',
		});
	});

	it('parseMcpToolName - 非 MCP - 返回 null', () => {
		expect(parseMcpToolName('read_note')).toBeNull();
	});
});
```

实现：

```typescript
/**
 * @file src/ui/mcp/parse-mcp-tool-name.ts
 * @description 解析 ToolRegistry 中的 MCP 工具名
 * @module ui/mcp/parse-mcp-tool-name
 */

export function isMcpToolName(name: string): boolean {
	return name.startsWith('mcp__');
}

/**
 * 格式固定为 mcp__<serverId>__<toolName>（toolName 可含 `_`）。
 */
export function parseMcpToolName(
	name: string,
): { serverId: string; toolName: string } | null {
	if (!isMcpToolName(name)) return null;
	const rest = name.slice('mcp__'.length);
	const i = rest.indexOf('__');
	if (i <= 0) return null;
	const serverId = rest.slice(0, i);
	const toolName = rest.slice(i + 2);
	if (!serverId || !toolName) return null;
	return { serverId, toolName };
}
```

- [ ] **Step 2: validateMcpServerConfig**（同原 plan：invalid_id / missing_url / missing_command）

- [ ] **Step 3: i18n keys（最小集）**

| key | zh 示例 |
|---|---|
| `status.drawer.mcp` | MCP |
| `modal.mcpManage.title` | MCP 服务器 |
| `modal.mcpManage.empty` | 尚未添加。添加后 Agent 可调用该服务器的工具；默认不配置则不额外出站。 |
| `modal.mcpManage.addHttp` | 添加 HTTP |
| `modal.mcpManage.addStdio` | 添加本地命令 |
| `modal.mcpManage.stop` / `delete` / `enabled` | … |
| `modal.mcpManage.status.*` | 离线/连接中/在线/错误 |
| `modal.mcpSpawn.*` | 确认启动… |
| `tool.name.mcp` | MCP · {server} · {tool} |
| `chat.tool.mcpBadge` | MCP |
| `settings.mcp.openManage` | 打开 MCP 管理 |
| `settings.toolPermissions.mcpSection` | MCP 工具权限 |

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp): i18n、配置校验与工具名解析"
```

---

### Task 2: 对话内 MCP 调用展示（部分 A）

**Files:**
- Modify: `src/ui/chat/format-tool-display.ts`
- Modify: `src/ui/chat/message-stream/ToolSegment.svelte`
- Modify: `src/core/tool-permissions.ts`（`summarizeToolCall`）
- Test: 既有 format-tool-display 测试文件（若无则建 `tests/ui/chat/format-tool-display-mcp.test.ts`）

- [ ] **Step 1: 失败测试**

```typescript
it('formatToolDisplayName - mcp__ 工具 - 使用 MCP 模板', () => {
	// 需能注入 label 查找：推荐 formatToolDisplayName(name, args, { mcpLabel?: (id)=>string })
	// 或读闭包/可选第三参；最小：无 label 时用 serverId
	expect(formatToolDisplayName('mcp__tavily__search', { query: 'x' })).toContain('tavily');
	expect(formatToolDisplayName('mcp__tavily__search', {})).toMatch(/search/);
});
```

钉死 API（避免全局 settings 耦合测试）：

```typescript
export interface FormatToolDisplayOptions {
	/** 把 serverId 映射为展示名；缺省返回 serverId */
	resolveMcpServerLabel?: (serverId: string) => string;
}

export function formatToolDisplayName(
	name: string,
	args: unknown,
	opts?: FormatToolDisplayOptions,
): string {
	const parsed = parseMcpToolName(name);
	if (parsed) {
		const server = opts?.resolveMcpServerLabel?.(parsed.serverId) ?? parsed.serverId;
		return tNow('tool.name.mcp', { server, tool: parsed.toolName });
	}
	// …原有 switch
}
```

调用点（ChatView / hydrate）：传入

```typescript
resolveMcpServerLabel: (id) =>
  plugin.settings.mcpServers.find((s) => s.id === id)?.label ?? id
```

- [ ] **Step 2: ToolSegment 徽标**

在 label 前：

```svelte
{#if isMcpToolName(toolCall.name)}
	<span class="ratel-trace-mcp-badge">{$t('chat.tool.mcpBadge')}</span>
{/if}
```

样式：小 caps / 弱边框，不抢状态色；`prefers-reduced-motion` 无额外动画。

- [ ] **Step 3: summarizeToolCall**

```typescript
default: {
	const parsed = parseMcpToolName(toolCall.name);
	if (parsed) {
		return tNow('tool.name.mcp', {
			server: parsed.serverId,
			tool: parsed.toolName,
		});
	}
	return path ? `${toolCall.name} → ${path}` : toolCall.name;
}
```

- [ ] **Step 4: PASS → Commit**

```bash
git commit -m "feat(mcp): 对话 Trace 与权限文案可辨认 MCP"
```

---

### Task 3: McpManageModal（部分 C）+ spawn 确认

**Files:**
- Create: `src/ui/mcp/McpManageModal.ts`
- Create: `src/ui/mcp/mcp-spawn-confirm-modal.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 单例打开（对齐 MemoryModal）**

```typescript
/**
 * @file src/ui/mcp/McpManageModal.ts
 * @description MCP 安装与管理 Modal
 * @module ui/mcp/McpManageModal
 */

export function shouldCreateMcpManageModal(current: McpManageModal | null): boolean {
	return current == null || !(current as { isOpen?: boolean }).isOpen;
}

export class McpManageModal extends Modal {
	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(tNow('modal.mcpManage.title'));
		this.renderBody();
	}

	private renderBody() {
		this.contentEl.empty();
		const servers = this.plugin.settings.mcpServers;
		if (servers.length === 0) {
			this.contentEl.createEl('p', { text: tNow('modal.mcpManage.empty') });
		}
		for (const cfg of servers) {
			this.renderServerRow(cfg);
		}
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.addHttp')).onClick(() => this.openAddForm('http')),
			)
			.addButton((b) =>
				b.setButtonText(tNow('modal.mcpManage.addStdio')).onClick(() => this.openAddForm('stdio')),
			);
	}

	// renderServerRow: status = plugin.mcpHost.getStatus(cfg.id)
	// enable toggle → saveSettings → mcpHost.sync
	// stop → mcpHost.stop + enabled=false
	// delete → 从数组移除 + 清 mcpApprovedSpawns + sync
	// secret hint: mcpSecretId(cfg.id)
}
```

添加表单：可用二级 Modal 或同 Modal 切换视图；字段校验走 `validateMcpServerConfig`；重复 id → `duplicate_id` Notice。

- [ ] **Step 2: spawn 确认**

`requestMcpSpawnConfirmation(app, cfg): Promise<boolean>`（settled 防双 resolve）。

`main.ts`：

```typescript
confirmSpawn: async (cfg) => {
	if (cfg.transport !== 'stdio') return true;
	if (this.settings.mcpApprovedSpawns.includes(cfg.id)) return true;
	const ok = await requestMcpSpawnConfirmation(this.app, cfg);
	if (ok) {
		this.settings.mcpApprovedSpawns = [...this.settings.mcpApprovedSpawns, cfg.id];
		await this.saveSettings();
	}
	return ok;
},
```

```typescript
openMcpManageModal() {
	if (shouldCreateMcpManageModal(this.mcpManageModal)) {
		this.mcpManageModal = new McpManageModal(this.app, this);
	}
	this.mcpManageModal.open();
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): McpManageModal 安装管理与 spawn 确认"
```

---

### Task 4: 抽屉按钮（部分 B）+ ChatView 接线

**Files:**
- Modify: `src/ui/status/StatusDrawer.svelte`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/main.ts`（若 Drawer 不经 ChatView）

- [ ] **Step 1: StatusDrawer props**

```typescript
onMcp?: () => void;
```

在 `onMemory` 旁增加按钮：

```svelte
{#if onMcp}
	<button type="button" class="ratel-drawer-action" onclick={onMcp}>
		<!-- 简洁几何图标，避免 emoji -->
		<span>{$t('status.drawer.mcp')}</span>
	</button>
{/if}
```

条件：`{#if onFeedback || onMemory || onSponsor || onMcp}`

- [ ] **Step 2: ChatView**

```typescript
function openMcp() {
	plugin.openMcpManageModal();
}
// …
onMcp={openMcp}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): StatusDrawer MCP 入口"
```

---

### Task 5: 设置页动态权限 + 打开管理 + 回归

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1:** Agent 权限区追加 `mcp__*` 动态项；缺失 get 为 `'ask'`

- [ ] **Step 2:** Advanced/Agent 增加按钮 `settings.mcp.openManage` → `plugin.openMcpManageModal()`

- [ ] **Step 3: 跑测**

```bash
npx vitest run tests/ui/mcp/ tests/core/mcp-config-validate.test.ts tests/core/mcp-host.test.ts
```

- [ ] **Step 4: 手工冒烟**

1. 抽屉 → MCP → 空态文案  
2. 添加 HTTP（假 URL）→ 列表出现 → status error/online  
3. Agent 若调到 MCP 工具 → Trace 有 MCP 徽标与友好名  
4. stdio 首次 → 确认框；拒绝则不 spawn  

- [ ] **Step 5: Commit + STATUS**

```bash
git commit -m "feat(mcp): 设置页动态权限与打开管理入口"
```

---

## 自审（对照 spec §4.11）

| Spec | Task |
|---|---|
| 对话 MCP 可辨 | T2 |
| 抽屉按钮 | T4 |
| 管理 Modal 安装/管理 | T3 |
| spawn 确认 | T3 |
| i18n | T1 |
| 动态权限 | T5 |
| 不做商店 | ✓ 非目标 |

**与旧 UI plan 差异：** 设置页长列表降级为次要；主路径 = 抽屉 Modal；新增 Trace 展示任务。

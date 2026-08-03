# P-MCP-HOST-UI — MCP 设置页 / i18n / spawn 确认 / 动态权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在设置里增删改 MCP Server、看状态/停止、首次 stdio spawn 确认、钥匙串 hint，以及 MCP 工具动态权限项；全部用户可见字符串走 i18n。

**Architecture:** 在 Agent 或 Advanced Tab 增加「MCP Servers」声明式设置区块；列表数据读写 `settings.mcpServers`；变更后调用 `plugin.mcpHost.sync`。spawn 确认用 Obsidian Modal，同意后写入 `mcpApprovedSpawns`。权限下拉动态读取当前 Registry 中 `mcp__*` 工具名。

**Tech Stack:** TypeScript / Obsidian Setting API / Svelte 非必须（跟随现有 declarative settings）/ Vitest / i18n

**Spec:** [S-MCP-HOST](../specs/2026-08-03-mcp-host-design.md) · **依赖:** [P-MCP-HOST-CORE](2026-08-03-mcp-host-core.md) 先完成

## Global Constraints

- 用户可见字符串必须 `tNow` / `t`，`zh.ts` + `en.ts` + `types.ts` 同步
- 测试描述中文：`行为 - 条件 - 期望结果`
- **不**在 UI 层发裸 HTTP；只调 `mcpHost`
- 密钥只展示 secret ID hint，不展示密钥值
- CORE 里 `confirmSpawn` 恒 false 的占位必须替换为本 Modal 逻辑

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/i18n/types.ts` | MCP 相关 key 类型 |
| `src/i18n/zh.ts` / `en.ts` | 文案 |
| `src/ui/mcp/mcp-spawn-confirm-modal.ts` | 新建：stdio 首次确认 Modal |
| `src/ui/settings/mcp-servers-render.ts` | 新建：MCP 列表 / 添加 / 删除 / 启停渲染 |
| `src/settings.ts` | 挂载 MCP 设置区块；权限列表含动态 mcp__* |
| `src/main.ts` | `confirmSpawn` 接 Modal + 持久化 `mcpApprovedSpawns` |
| `tests/ui/mcp/mcp-spawn-confirm-modal.test.ts` | 新建（若 Modal 可单测逻辑） |
| `tests/core/mcp-config-validate.test.ts` | 新建：id/url/command 校验纯函数（可抽到 `src/core/mcp-config.ts`） |

---

### Task 1: i18n keys + 配置校验纯函数

**Files:**
- Modify: `src/i18n/types.ts`, `zh.ts`, `en.ts`
- Create: `src/core/mcp-config.ts`
- Test: `tests/core/mcp-config-validate.test.ts`

- [ ] **Step 1: 校验测试**

```typescript
/**
 * @file tests/core/mcp-config-validate.test.ts
 * @description MCP Server 配置校验
 * @module tests/core/mcp-config-validate
 */

import { describe, it, expect } from 'vitest';
import { validateMcpServerConfig } from '../../src/core/mcp-config';

describe('validateMcpServerConfig', () => {
	it('合法 http - 返回 null', () => {
		expect(
			validateMcpServerConfig({
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://mcp.tavily.com/mcp',
			}),
		).toBeNull();
	});

	it('非法 id - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'Tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://x',
			}),
		).toBe('invalid_id');
	});

	it('http 缺 url - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
			}),
		).toBe('missing_url');
	});

	it('stdio 缺 command - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'local',
				label: 'Local',
				enabled: true,
				transport: 'stdio',
			}),
		).toBe('missing_command');
	});
});
```

- [ ] **Step 2: 实现 `validateMcpServerConfig` + i18n**

```typescript
/**
 * @file src/core/mcp-config.ts
 * @description MCP Server 配置校验
 * @module core/mcp-config
 */

import type { McpServerConfig } from '../ports/mcp';
import { isValidMcpServerId } from '../ports/mcp';

export type McpConfigErrorCode =
	| 'invalid_id'
	| 'missing_url'
	| 'missing_command'
	| 'duplicate_id';

export function validateMcpServerConfig(cfg: McpServerConfig): McpConfigErrorCode | null {
	if (!isValidMcpServerId(cfg.id)) return 'invalid_id';
	if (cfg.transport === 'http' && !cfg.url?.trim()) return 'missing_url';
	if (cfg.transport === 'stdio' && !cfg.command?.trim()) return 'missing_command';
	return null;
}
```

i18n 最小集合（`types.ts` SettingsStrings 或独立 namespace，按项目现有 spread 方式合并）：

| key | zh | en |
|---|---|---|
| `settings.mcp.heading` | MCP 服务器 | MCP servers |
| `settings.mcp.desc` | 默认关闭。仅你添加的端点会出站；密钥请写入钥匙串。 | Off by default. Only endpoints you add can send traffic; store keys in the keychain. |
| `settings.mcp.addHttp` | 添加 HTTP | Add HTTP |
| `settings.mcp.addStdio` | 添加 stdio | Add stdio |
| `settings.mcp.id` | Server ID | Server ID |
| `settings.mcp.label` | 显示名 | Display name |
| `settings.mcp.url` | URL | URL |
| `settings.mcp.command` | 命令 | Command |
| `settings.mcp.args` | 参数（空格分隔） | Args (space-separated) |
| `settings.mcp.enabled` | 启用 | Enabled |
| `settings.mcp.stop` | 停止 | Stop |
| `settings.mcp.delete` | 删除 | Delete |
| `settings.mcp.status.offline` | 离线 | Offline |
| `settings.mcp.status.connecting` | 连接中 | Connecting |
| `settings.mcp.status.online` | 在线 | Online |
| `settings.mcp.status.error` | 错误 | Error |
| `settings.mcp.secretHint` | 钥匙串名称 | Keychain secret name |
| `settings.mcp.error.invalid_id` | ID 须小写字母开头… | ID must start with a lowercase letter… |
| `settings.mcp.error.missing_url` | HTTP 需要 URL | URL required for HTTP |
| `settings.mcp.error.missing_command` | stdio 需要命令 | Command required for stdio |
| `settings.mcp.error.duplicate_id` | ID 已存在 | ID already exists |
| `modal.mcpSpawn.title` | 确认启动本地 MCP | Confirm local MCP launch |
| `modal.mcpSpawn.body` | 将执行：{{command}} | Will run: {{command}} |
| `modal.mcpSpawn.confirm` | 允许并记住 | Allow and remember |
| `modal.mcpSpawn.cancel` | 取消 | Cancel |
| `settings.toolPermissions.mcpSection` | MCP 工具权限 | MCP tool permissions |

- [ ] **Step 3: PASS → Commit**

```bash
git add src/core/mcp-config.ts src/i18n/ tests/core/mcp-config-validate.test.ts
git commit -m "feat(mcp): 配置校验与 MCP i18n 键"
```

---

### Task 2: Spawn 确认 Modal + main confirmSpawn

**Files:**
- Create: `src/ui/mcp/mcp-spawn-confirm-modal.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现 Modal**

参考现有 `ConfirmModal` 模式（`src/ui/` 下同类）：

```typescript
/**
 * @file src/ui/mcp/mcp-spawn-confirm-modal.ts
 * @description stdio MCP 首次 spawn 确认
 * @module ui/mcp/mcp-spawn-confirm-modal
 */

import { App, Modal, Setting } from 'obsidian';
import { tNow } from '../../i18n';
import type { McpServerConfig } from '../../ports/mcp';

export function requestMcpSpawnConfirmation(
	app: App,
	cfg: McpServerConfig,
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			onOpen() {
				this.titleEl.setText(tNow('modal.mcpSpawn.title'));
				const cmd = [cfg.command, ...(cfg.args ?? [])].join(' ');
				this.contentEl.createEl('p', {
					text: tNow('modal.mcpSpawn.body', { command: cmd }),
				});
				new Setting(this.contentEl)
					.addButton((btn) =>
						btn.setButtonText(tNow('modal.mcpSpawn.cancel')).onClick(() => {
							this.close();
							resolve(false);
						}),
					)
					.addButton((btn) =>
						btn
							.setButtonText(tNow('modal.mcpSpawn.confirm'))
							.setCta()
							.onClick(() => {
								this.close();
								resolve(true);
							}),
					);
			}
			onClose() {
				// 若未点按钮直接关：视为拒绝（用 settled 标志防双 resolve）
			}
		})(app);
		modal.open();
	});
}
```

实现时加 `settled` 标志，避免 `onClose` 与按钮双 resolve。

- [ ] **Step 2: main 接线**

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

删除 Server 时：从 `mcpApprovedSpawns` 去掉对应 id（在设置删除逻辑里做）。

- [ ] **Step 3: Commit**

```bash
git add src/ui/mcp/mcp-spawn-confirm-modal.ts src/main.ts
git commit -m "feat(mcp): stdio spawn 首次确认 Modal"
```

---

### Task 3: 设置页 MCP Servers 列表 UI

**Files:**
- Create: `src/ui/settings/mcp-servers-render.ts`
- Modify: `src/settings.ts`

- [ ] **Step 1: 渲染模块**

`renderMcpServersSection(plugin): SettingGroupItem[]` 或 declarative `render` 回调：

行为清单：
1. Heading + 隐私短 desc（i18n）
2. 遍历 `plugin.settings.mcpServers`：显示 label、transport、`plugin.mcpHost.getStatus(id)`、enable toggle、Stop、Delete
3. 「添加 HTTP」「添加 stdio」按钮：用简单 Modal 或内联 Setting 收集 id/label/url 或 command/args → `validateMcpServerConfig` → push → `saveSettings` → `mcpHost.sync`
4. 每行钥匙串 hint：`mcpSecretId(id)` + `hasMcpSecret`
5. args 输入：空格分隔拆成 `string[]`（注意引号不做复杂 shell 解析；文档说明）

Stop：`await plugin.mcpHost.stop(id)` 并可把 `enabled=false` 持久化。

Delete：从数组移除 + 清 `mcpApprovedSpawns` + sync。

- [ ] **Step 2: 挂到 settings**

在 Agent Tab（推荐，与工具权限相邻）或 Advanced Tab 调用 `renderMcpServersSection`。

- [ ] **Step 3: 手动冒烟**（无自动化 E2E）
  - 添加非法 id → Notice 显示 i18n 错误
  - 添加 HTTP（可先假 URL）→ 列表出现 → enable → status 变 error/online
  - Delete → 列表空

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/mcp-servers-render.ts src/settings.ts
git commit -m "feat(mcp): 设置页 MCP Server 列表"
```

---

### Task 4: 动态 MCP 工具权限项

**Files:**
- Modify: `src/settings.ts`（`buildToolPermissionItems`）

- [ ] **Step 1: 在内置权限列表后追加 MCP 段**

```typescript
// 内置 map 循环之后：
const mcpNames = this.plugin.tools
	.definitions()
	.map((d) => d.name)
	.filter((n) => n.startsWith('mcp__'))
	.sort();

if (mcpNames.length > 0) {
	items.push({
		type: 'heading',
		heading: tNow('settings.toolPermissions.mcpSection'),
		// …与现有 heading 形状一致
	});
	for (const name of mcpNames) {
		// 与内置相同的 dropdown allow/ask/deny；label 用 name 本身（或剥前缀）
		if (!(name in this.plugin.settings.toolPermissions)) {
			// 不强制写入；resolve 缺省 ask。若 UI 需要显示当前值：
			// getControlValue 对缺失返回 'ask'
		}
		items.push(/* dropdown key: toolPermissions.${name} */);
	}
}
```

- [ ] **Step 2: `getControlValue` / `setControlValue`**

对 `toolPermissions.${mcp__…}`：缺失时 get 返回 `'ask'`；set 时写入对象。

- [ ] **Step 3: Commit**

```bash
git add src/settings.ts
git commit -m "feat(mcp): 设置页动态 MCP 工具权限"
```

---

### Task 5: 回归测试 + STATUS

- [ ] **Step 1: 跑测试**

```bash
npx vitest run tests/core/mcp-config-validate.test.ts tests/core/mcp-host.test.ts tests/prompts/composer.test.ts
```

Expected: PASS

- [ ] **Step 2: 更新 STATUS**

`P-MCP-HOST-UI` → Completed（执行结束时）

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(status): P-MCP-HOST-UI 完成标记"
```

---

## 自审

| Spec §4.11 / 4.7 / 4.8 UI | Task |
|---|---|
| 设置列表 / 添加 / 启停 | T3 |
| spawn 确认 | T2 |
| 钥匙串 hint | T3 |
| 动态权限 | T4 |
| i18n | T1 |
| 校验 | T1 |

**依赖：** 必须先合并或同分支完成 P-MCP-HOST-CORE。

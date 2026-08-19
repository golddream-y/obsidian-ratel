# S-MCP-HOST — 平台级 MCP Host（双 Transport + 入 ToolRegistry）

> **ID:** S-MCP-HOST  
> **状态:** Active  
> **日期:** 2026-08-03  
> **关联:**
> - [ADR-014](../../adr/2026-08-03-mcp-host-platform.md)（平台决策：不自建 websearch、双 transport、隐私边界）
> - [ADR-015](../../adr/2026-08-03-capability-pool.md)（能力池：MCP 为 `kind=mcp` 供给）
> - [capability-surface](../../architecture/agent/capability-surface.md)（生命周期总图）
> - [ADR-001](../../adr/2026-06-14-ratel-cors-strategy.md)（`requestUrl` 绕 CORS）
> - [ADR-010](../../adr/2026-07-21-skill-vs-builtin-capability.md)（MCP 属平台，不是 Skill）
> - [S-EVOLUTION](2026-07-15-evolution-graph-agent.md)（网络边界修订）
>
> **动机:** 把 Ratel 做成可挂外部能力的 Agent 平台；网页搜索等交给 MCP 生态，不在 `tools/` 里逐家内置。

---

## 1. 背景

当前 Agent 可执行面只有**内置工具**（约 23 个）+ **Skill 元工具**（`activate_skill` / `deactivate_skill`）。要吃到网页搜索、第三方检索等生态能力，有两条路：

| 路线 | 含义 | 结论 |
|---|---|---|
| A. 逐家内置 | `web_search` / `fetch_url` 等一等公民工具 | **否决**（技术债、重复适配） |
| B. 平台级 MCP Host | 挂官方/社区 MCP Server，工具自动发现入册 | **采纳**（ADR-014） |

已锁定约束：

1. **不自建抓网页** — extract / search 交给 MCP Server 侧
2. **HTTP + stdio 一期到位** — 无「先做 HTTP」中间态
3. **默认零出站** — 不配置 MCP 时网络面与今天一致；仅用户显式配置的端点可出站
4. **治理零增量** — MCP 工具进 `ToolRegistry` 后走现有权限 / 钩子 / `tool.result`（ADR-015 红利）

---

## 2. 目标

1. **MCP Host 主线程落地** — 连接、发现、调用、断开；Worker 不参与
2. **双 Transport** — Streamable HTTP（`requestUrl`）+ stdio（`child_process.spawn`，`shell: false`）
3. **工具入能力池** — `tools/list` → 注册为 `mcp__<serverId>__<toolName>`，`kind=mcp`，进 FC `tools[]`
4. **权限默认 ask** — 前缀规则或解析缺省为 `ask`；复用确认 Modal / 会话 grants
5. **密钥走钥匙串** — `ratel-mcp-<serverId>`，不进 `settings.json`，不进 spawn 明文日志
6. **生命周期对称** — 移除 Server / 断连 / `onunload` 时 unregister + close（stdio kill）
7. **对话内可辨认** — Agent 调用 MCP 工具时，聊天 Trace 明确标出「MCP / 服务器 / 工具」，不与内置工具混同
8. **抽屉一键管理** — StatusDrawer 增加 MCP 入口；点击打开管理 Modal，可安装（添加）与启停/删除 Server

成功标准：

- 用户从抽屉打开 MCP Modal，添加 1 个 HTTP MCP 后，Agent 能调其工具；时间线里该次调用带 MCP 标识
- 用户添加 1 个 stdio MCP 后，首次有命令确认；进程可停；工具同样入册
- 零 MCP 配置时：无子进程、无额外 HTTP、隐私面与现状一致；抽屉按钮仍可见（空态引导添加）
- 不改 Agent Loop 主循环结构、不改融合检索、不改 MemoryStore

---

## 3. 非目标

| 非目标 | 说明 |
|---|---|
| 自建 `web_search` / `fetch_url` / 爬虫 | ADR-014 明确否决 |
| MCP Resources / Sampling / Roots / Prompts | **一期砍掉**；仅 Tools（list + call）。后续另开 spec |
| MCP Server 聚合代理 / 自建网关 | Host 直连用户配置的 Server |
| 预置任何 MCP Server | 默认空列表 |
| 移动端 MCP | `isDesktopOnly: true` |
| 独立 CapabilityExecutor | Loop + Registry 即执行流水线（ADR-015） |
| 把 Skill 包注册成业务工具 | Skill 仍走元工具（ADR-012） |
| 本期改能力池 prompt 装配到「单一话术终态」 | MCP 入 FC 即可；Skill Discovery 与池叙事收敛可跟 ADR-015 另任务，不阻塞 Host |
| MCP 应用商店 / `.mcpb` 一键市场 / OAuth 向导 | 一期不做目录聚合；用户手动填 URL 或 command（见 §4.11 业界对照） |
| 会话级「仅本会话启用某 Server」开关 | 一期全局 `enabled`；会话级可后续加（llm-hub 有类似能力） |

---

## 4. 详细设计

### 4.1 角色与分层

```
设置页 / 抽屉 Modal → mcpServers[]
        │
        ▼
┌───────────────────┐
│     McpHost       │  多 Server 编排：启停、状态、入册/出册
└─────────┬─────────┘
          │ 每 Server 一个 Client
          ▼
┌───────────────────┐
│    McpClient      │  initialize / listTools / callTool / close
└─────────┬─────────┘
          │ Transport 可替换
     ┌────┴────┐
     ▼         ▼
 McpHttp     McpStdio
 (requestUrl) (spawn)
          │
          ▼
   ToolRegistry.register
   (mcp__server__tool → execute → callTool)
```

**归属：** 全部主线程。Worker / Embedding Worker 禁止参与（禁 HTTP、无子进程、禁 Obsidian API）。

**与能力池：** Host 只负责供给；入册后的工具在池中为 `kind=mcp`。Agent Loop **不**分支「是不是 MCP」——只 `resolveToolPermission` → `tools.execute`。

### 4.2 配置模型

```typescript
/** settings.json 中的 MCP Server 条目（无密钥明文） */
export interface McpServerConfig {
	/** 稳定 ID：小写字母数字与连字符；用于命名前缀与钥匙串 */
	id: string;
	/** 展示名（设置页 / 确认 Modal） */
	label: string;
	enabled: boolean;
	transport: 'http' | 'stdio';
	/** http：端点 URL（Streamable HTTP） */
	url?: string;
	/** stdio：可执行文件（如 npx、node、绝对路径） */
	command?: string;
	/** stdio：参数列表（禁止拼进 shell 字符串） */
	args?: string[];
	/** 可选：额外环境变量名列表；值从钥匙串或空注入，禁止把 secret 写进 settings */
	envKeys?: string[];
	/** 初始化 / 单次 call 超时（ms）；缺省常量 */
	timeoutMs?: number;
}
```

设置字段：

```typescript
// RatelVaultSettings 增量
mcpServers: McpServerConfig[]; // 默认 []
```

**校验：**

- `id` 唯一、匹配 `^[a-z][a-z0-9-]{0,31}$`
- `http` 必须有合法 `url`（https 优先；http 仅本地调试，文档警示）
- `stdio` 必须有非空 `command`；`args` 为数组；`shell: false`
- `enabled: false` 的 Server 不连接、不占进程

### 4.3 Port 契约

新增 `src/ports/mcp.ts`（零实现）：

```typescript
export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>; // JSON Schema
}

export interface McpCallResult {
	/** 归一化为可喂回 LLM 的文本或结构化 JSON 字符串 */
	content: string;
	isError?: boolean;
}

export interface McpTransport {
	start(): Promise<void>;
	request(method: string, params?: unknown): Promise<unknown>;
	close(): Promise<void>;
}

export interface McpClientPort {
	readonly serverId: string;
	initialize(): Promise<void>;
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	close(): Promise<void>;
}

export type McpServerStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface McpHostPort {
	/** 按 settings 同步：启停/重连；幂等 */
	sync(servers: McpServerConfig[]): Promise<void>;
	getStatus(serverId: string): McpServerStatus;
	/** 卸载 / 设置清空时调用 */
	dispose(): Promise<void>;
}
```

实现文件（plan 钉死路径）：

| 文件 | 职责 |
|---|---|
| `src/ports/mcp.ts` | 上述契约 |
| `src/adapters/mcp-jsonrpc.ts` | JSON-RPC 2.0 编解码、id 关联、错误映射 |
| `src/adapters/mcp-http.ts` | Streamable HTTP + SSE / `mcp-session-id` |
| `src/adapters/mcp-stdio.ts` | spawn、`Content-Length` / 换行双分帧、stderr 日志 |
| `src/adapters/mcp-client.ts` | 通用 Client：握手 + list/call |
| `src/core/mcp-host.ts` | 多 Server、入册出册、熔断 |
| `src/core/mcp-tool-bridge.ts` | `McpToolInfo` → `Tool`（前缀、schema 透传、`readOnly` 启发式） |

### 4.4 Transport 细节

#### 4.4.1 Streamable HTTP

- 出站：**仅** Obsidian `requestUrl`（ADR-001），禁止裸 `fetch`（CORS / 审核一致性）
- 支持：POST JSON-RPC；若响应为 SSE，按事件解析结果
- 会话：响应头 `mcp-session-id` 存于 Client 内存，后续请求带回
- 鉴权：`Authorization: Bearer <key>`，key 自钥匙串 `ratel-mcp-<serverId>`；无 key 则不带（部分公开 MCP）

#### 4.4.2 stdio

- `child_process.spawn(command, args, { shell: false, env, stdio: ['pipe','pipe','pipe'] })`
- `env` = 过滤后的 `process.env` + 用户声明的 `envKeys` 注入（密钥值从钥匙串读，**禁止** `devLogger` 打印 env 值）
- 分帧：优先 LSP 风格 `Content-Length`；兼容按行 JSON（部分社区 Server）
- stderr：写入 `devLogger`（module 建议扩 `mcp`），截断单行长度
- **首次启动确认：** 该 `serverId` 未在「已确认 spawn」持久集合中时，弹出 Modal 展示完整 `command + args`；用户同意后写入本地标记（settings 或独立小文件）；拒绝则保持 offline
- 进程列表：设置页显示 online/error +「停止」按钮 → `client.close()` → SIGTERM/kill

### 4.5 握手与发现

```
enabled Server
  → transport.start()
  → initialize({ protocolVersion, capabilities, clientInfo: { name: 'ratel-vault', version } })
  → 校验 Server 回包（最低：支持 tools）
  → tools/list
  → 对每个 tool: register Tool
  → status = online
```

失败：

- 超时 / 握手失败 / list 失败 → `status = error`，**不**注册部分工具（全有或全无，避免半残）
- 连续 N 次 call 失败（默认 3）→ 标记 error/offline，停止将该 Server 工具暴露（unregister）；指数退避重连（可配置上限）

### 4.6 工具桥接（入 ToolRegistry）

命名：

```
mcp__<serverId>__<toolName>
```

- `toolName` 中的非 `[A-Za-z0-9_-]` 替换为 `_`；冲突时后缀 `_2`（极少）
- `definition.description` = 原 description（可加短前缀「[MCP:<label>]」供人读；模型侧仍以场景描述为主）
- `parameters` = MCP `inputSchema` 透传为现有 `ToolDefinition.parameters` 形状
- `execute(args)` → `client.callTool(originalName, args)` → 结果序列化为 string / JSON string 返回 Agent Loop
- `readOnly`：一期默认 `false`（保守，走写钩子与 ask）；若 MCP annotations 标明 readOnly 且无副作用，可映射 `true`（可选增强，非必须）

**Registry 缺口：** 当前 `ToolRegistry` 仅有 `register` / `updateDefinition`，**无 `unregister`**。本期必须新增：

```typescript
unregister(name: string): void;
unregisterByPrefix(prefix: string): void; // 例如 mcp__tavily__
```

出册时机：Server disable / 删除 / dispose / 熔断下线 / 重连前清旧。

### 4.7 权限与确认

现有 `resolveToolPermission`：

```typescript
const perm = settings.toolPermissions[toolCall.name] ?? 'ask';
```

对 MCP：

1. **缺省即 ask** — 未写入 `toolPermissions` 的 `mcp__*` 自然走 ask（与现状默认一致）
2. **设置 UI** — Agent 权限区增加「MCP 工具」动态列表（online 后出现），或按 Server 折叠；允许用户改为 allow/deny
3. **trustMode** — 全局信任时 MCP 也放行（与内置一致）；文档警示
4. **stdio 首次确认 ≠ 工具权限** — spawn 确认管进程启动；每次 `tools/call` 仍可再 ask（除非 allow / session grant）
5. **summarizeToolCall** — MCP 回退到 `name` 或 `name + JSON 摘要`；i18n 友好名可用动态 label

### 4.8 密钥

| 用途 | 钥匙串 ID |
|---|---|
| 某 MCP Server 的 API Key / Bearer | `ratel-mcp-<serverId>` |

- 在 `src/secrets/ratel-secrets.ts` 增加**动态**解析函数（非整表常量枚举）：`resolveMcpSecret(app, serverId)` / `mcpSecretId(serverId)`
- 设置页每 Server 旁「钥匙串提示」（复用现有 secret-hint 模式）
- user-guide：登记 secret ID 形态（文档同步在 plan 完成时确认）

### 4.9 生命周期（与 capability-surface §2.5 / §3 对齐）

| 事件 | 行为 |
|---|---|
| `onload` + settings 有 enabled Servers | `mcpHost.sync(settings.mcpServers)`（异步，不阻塞 UI；失败 Notice） |
| 设置增删改 / enable 切换 | `sync` 幂等差分 |
| Server 成功 list | register 全部工具 |
| Server 移除 / disable / error 熔断 | `unregisterByPrefix('mcp__'+id+'__')` + `close` |
| `tools/list` 热更新（可选一期） | 清前缀后重注册；或 diff 增量 |
| 插件 `onunload` | `mcpHost.dispose()` |
| `/new` / 切会话 | 仅清 `ToolPermissionSessionGrants`；**不断** MCP 连接 |

### 4.10 与 Agent Loop / 能力池

- **不动** `agent-loop.ts` 主结构；MCP 对 Loop 透明
- `definitions()` 自动含 MCP 工具 → FC 可见
- `toolGuide` / `{{toolList}}`：若 Composer 从 Registry 拉列表，MCP 自动进入；若硬编码内置清单，plan 中补「动态拼接」一小步
- Skill Discovery 独立段保留；本期不强制合并话术（ADR-015 终态可另任务）

### 4.11 用户可见 UI（抽屉优先 + 对话可辨 + 设置补强）

#### 4.11.0 业界对照（调研摘要，2026-08）

| 产品 | 安装 / 管理入口 | 对话侧可见性 | 对 Ratel 的借鉴 |
|---|---|---|---|
| **Claude Desktop** | Settings → Extensions 市场 / Connectors；高级用户改 JSON；`.mcpb` 一键包 | 聊天底栏锤子图标显示工具数；Connectors 列表 | **不做市场**；借鉴「聊天旁可见已接能力」与「安装≠改 JSON 文件」 |
| **Cursor** | Customize → MCPs；Add to Cursor；`mcp.json` | Agent 工具列表可开关；MCP 调用默认要批准 | 借鉴 **toggle 启停** + **调用前 ask**（我们已有权限门） |
| **obsidian-llm-hub** | 插件设置 MCP 段 + `McpServerModal`；可 Test connection | 聊天里 Database 图标按会话开关 Server | 同为 Obsidian：**Modal 管 CRUD** 最贴近；我们改用 **StatusDrawer 入口**（对齐记忆 Modal 模式） |

**Ratel 一期选型：**

- **主入口：StatusDrawer「MCP」按钮 → `McpManageModal`**（安装 + 管理）
- **设置页：** 可保留精简「已配置 N 个 / 打开管理」跳转或只读摘要，**不以设置长表单为主路径**
- **不做** Extensions 市场 / `.mcpb` / OAuth 向导（非目标）

#### 4.11.1 抽屉入口（对齐 MemoryModal）

```
StatusDrawer
  └── 动作区（反馈 / 记忆 / 赞助旁）新增「MCP」
        └── onclick → plugin.openMcpManageModal()
              └── McpManageModal（Obsidian Modal，单例）
```

- 空态：Modal 内文案引导「添加 HTTP 或本地命令」；隐私一句（默认不出站）
- 有 Server：列表展示 label、transport、status 芯片、enable、停止、编辑、删除
- 「添加」：选 HTTP / stdio → 表单（id / label / url 或 command+args）→ 校验 → 写入 `mcpServers` → `mcpHost.sync`
- 钥匙串 hint：`ratel-mcp-<id>`（不展示密钥值）
- stdio 首次启动：仍走 spawn 确认 Modal（与管理 Modal 分离）
- 全部字符串 i18n

#### 4.11.2 对话内 MCP 调用展示

现有链路：`tool.call` / `tool.result` → `ToolCallEntry` → `ToolSegment.svelte`（与内置同形流水线，**红利保留**）。

一期增强（可辨认，不另起事件类型）：

| 点 | 行为 |
|---|---|
| **识别** | `toolCall.name.startsWith('mcp__')` → 视为 MCP |
| **展示名** | `formatToolDisplayName`：解析 `mcp__<serverId>__<tool>`，输出 i18n 如 `MCP · {label} · {tool}`（label 从 `mcpServers` 查，缺失则用 serverId） |
| **Trace 行** | `ToolSegment` 对 MCP 加轻量徽标/前缀（如 `MCP` chip），状态色仍用 calling/done/failed |
| **展开详情** | 首行注明 serverId / transport（若可得）；下方仍为规范化旁注，禁止 dump 密钥 |
| **权限确认 Modal** | `summarizeToolCall` 对 MCP 用同一友好展示名，避免只显示生硬 `mcp__…` |

**不改：** `AgentEvent` 判别联合；不新增 `mcp.call` 事件（避免第三条旁路）。

#### 4.11.3 设置页权限补强

- Agent 权限区：online 后动态列出 `mcp__*`，allow/ask/deny（缺省 ask）
- 可选：设置页底部「打开 MCP 管理」按钮 → 同 `openMcpManageModal()`

#### 4.11.4 UI 模块边界

| 文件（plan 钉死） | 职责 |
|---|---|
| `src/ui/mcp/McpManageModal.ts` | 安装/管理主 Modal（类比 MemoryModal） |
| `src/ui/mcp/mcp-spawn-confirm-modal.ts` | stdio 首次确认 |
| `src/ui/mcp/mcp-manage-view.ts` 或内嵌渲染 | 列表 + 添加表单（可用 Setting API 或轻量 Svelte mount） |
| `src/ui/status/StatusDrawer.svelte` | 新增 `onMcp` 按钮 |
| `src/ui/chat/format-tool-display.ts` | MCP 展示名 |
| `src/ui/chat/message-stream/ToolSegment.svelte` | MCP 徽标 |
| `src/main.ts` | `openMcpManageModal`；Drawer 接线 |

### 4.12 隐私与文档影响（实现后确认同步）

按 AGENTS.md 文档同步规则，**落地后**需向用户确认是否改：

- [ ] README 隐私：默认仅模型 API；MCP opt-in
- [ ] user-guide：MCP 配置、权限、secret ID、FAQ
- [ ] CHANGELOG `[Unreleased]`
- [ ] S-EVOLUTION 非目标条划掉「不做联网搜索」并链 ADR-014
- [ ] 架构：`docs/architecture/host/mcp.md`（报文级细节；spec 批准后可与 plan 同期起草）

**本期 spec 本身不改 README**（避免未实现就改用户文档）。

### 4.13 错误与降级

| 情况 | 行为 |
|---|---|
| call 超时 | 返回 isError 文本给模型；`tool.result` 带错误；触发 `post-tool-failure` |
| Server offline 时模型仍调旧名 | Registry 已 unregister → `Tool not found` → Loop 既有 TOOL_ERROR 降级 |
| spawn 被用户拒 | status offline；Notice |
| 恶意/失控 Server | 无法根除；靠 ask + 文档警示 + 可停进程 |

### 4.14 协议版本

- Client 声明当前稳定协议版本（实现时对照 MCP 规范选用；写入常量 `MCP_PROTOCOL_VERSION`）
- Server 若版本不兼容：拒绝入册并 Notice，不 silent 降级乱调

---

## 5. 影响面

| 区域 | 影响 |
|---|---|
| `ports/` / `adapters/` | 新增 MCP 契约与双 transport |
| `core/mcp-host.ts` 等 | 新模块 |
| `core/tool-registry.ts` | 新增 unregister API |
| `main.ts` | 持有 `mcpHost`；onload sync；onunload dispose；settings 变更触发 sync |
| `settings.ts` / i18n / Drawer / McpManageModal / ToolSegment | 抽屉入口 + 管理 Modal + 对话 MCP 标识 |
| `secrets/ratel-secrets.ts` | 动态 MCP secret |
| `tool-permissions` / 设置权限列表 | 动态 MCP 工具项 |
| Agent Loop / 检索 / Memory / Worker | **无结构改动**（Loop 事件同形；仅 UI 展示层识别 `mcp__`） |
| 网络边界 / AGENTS.md 铁律 | 实现后修订表述（文档任务） |

---

## 6. 测试策略（plan 细化）

- 单元：JSON-RPC 编解码、工具命名净化、前缀 unregister、权限缺省 ask
- Transport：HTTP 用 mock `requestUrl`；stdio 用假进程或可注入 Transport
- 集成：`McpHost.sync` 启停差分；dispose 无泄漏
- **不做**对真实 Tavily 的 CI 依赖（可手工验收清单）

---

## 7. 实施分期建议（仍同一 spec，可多 plan）

| 阶段 | 内容 | 说明 |
|---|---|---|
| P-MCP-HOST-CORE | Port + JSON-RPC + 双 Transport + Client + Host + Registry unregister + 入册 | **必做**，无中间态砍 transport |
| P-MCP-HOST-UI | 抽屉 MCP 按钮 + McpManageModal（安装/管理）+ 对话 Trace MCP 标识 + i18n + spawn 确认 + 动态权限 | 依赖 CORE |
| P-MCP-HOST-DOCS | README / user-guide / S-EVOLUTION / host/mcp.md | finishing 时确认勾选 |

不建议「只做 HTTP」的独立发版（违背 ADR-014）。

---

## 8. 自审

| 检查项 | 结果 |
|---|---|
| 与 ADR-014/015 矛盾？ | 无；本 spec 是落地设计 |
| 占位符 / TBD？ | 协议 version 常量钉死 `2024-11-05`；Resources 等明确砍掉 |
| 范围过大？ | 砍掉市场/OAuth/会话级开关；UI 收敛为抽屉 Modal + Trace 标识 |
| 图谱扩邻？ | **不在本 spec**；P-GRAPH-EXPAND 另排期 |
| unregister 缺口？ | 已写入必做 |
| i18n？ | UI/Notice/Drawer/Modal/Trace 徽标强制；开发者日志中文 |
| UI 是否只有设置页？ | **否** — 主路径抽屉 Modal；对话必须可辨 MCP |

---

## 9. 参考

- [Model Context Protocol](https://modelcontextprotocol.io/)
- Tavily / Brave 官方 MCP Server
- Claude Desktop Extensions / Connectors；Cursor Customize → MCPs；[obsidian-llm-hub MCP](https://github.com/takeshy/obsidian-llm-hub)
- 本仓库：`capability-surface.md` §3、ADR-001 `requestUrl`、MemoryModal + StatusDrawer 入口模式

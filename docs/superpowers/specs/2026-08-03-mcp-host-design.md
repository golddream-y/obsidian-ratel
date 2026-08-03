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

成功标准：

- 用户配置 1 个 HTTP MCP（如 Tavily Remote）后，Agent 能调其工具并在聊天时间线看到与内置同形的 `tool.result`
- 用户配置 1 个 stdio MCP（如 `npx …`）后，首次有命令确认；进程可停；工具同样入册
- 零 MCP 配置时：无子进程、无额外 HTTP、隐私面与现状一致
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

---

## 4. 详细设计

### 4.1 角色与分层

```
设置页 mcpServers[]
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

### 4.11 设置 UI（用户可见，须 i18n）

- Advanced 或 Agent Tab 下「MCP Servers」区块：
  - 列表：label、transport、status 芯片、enable 开关、编辑/删除、停止
  - 添加：选 HTTP 或 stdio → 填 id/label/url 或 command+args
  - 钥匙串 hint、隐私短文案（默认不出站，仅配置端点）
- 全部字符串走 `src/i18n/zh.ts` + `en.ts`

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
| `settings.ts` / i18n | `mcpServers` + UI |
| `secrets/ratel-secrets.ts` | 动态 MCP secret |
| `tool-permissions` / 设置权限列表 | 动态 MCP 工具项 |
| Agent Loop / 检索 / Memory / Worker | **无结构改动** |
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
| P-MCP-HOST-UI | 设置页、i18n、钥匙串 hint、spawn 确认、状态/停止 | 可紧随 CORE |
| P-MCP-HOST-DOCS | README / user-guide / S-EVOLUTION / host/mcp.md | finishing 时确认勾选 |

不建议「只做 HTTP」的独立发版（违背 ADR-014）。

---

## 8. 自审

| 检查项 | 结果 |
|---|---|
| 与 ADR-014/015 矛盾？ | 无；本 spec 是落地设计 |
| 占位符 / TBD？ | 协议具体 version 字符串留给实现常量；Resources 等明确砍掉 |
| 范围过大？ | 砍掉 Resources/Sampling/Roots/Prompts；能力池话术终态不阻塞 |
| 图谱扩邻？ | **不在本 spec**；P-GRAPH-EXPAND 另排期 |
| unregister 缺口？ | 已写入必做 |
| i18n？ | UI/Notice 强制；开发者日志中文 |

---

## 9. 参考

- [Model Context Protocol](https://modelcontextprotocol.io/)
- Tavily / Brave 官方 MCP Server
- 社区：obsidian-llm-hub、obsidian-gemini、local-runner（spawn 先例）
- 本仓库：`capability-surface.md` §3、ADR-001 `requestUrl`

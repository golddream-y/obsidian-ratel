# MCP Host — 平台级 MCP 接入

> 决策依据:[ADR-014 MCP 平台](../../adr/2026-08-03-mcp-host-platform.md) · [ADR-015 能力池](../../adr/2026-08-03-capability-pool.md)
> 入口总图:[capability-surface](../agent/capability-surface.md)

本文档回答:**外部 MCP Server 怎么接进来、工具怎么进 Registry、权限与密钥怎么管。**

---

## 角色

```
settings(mcpServers)
   │  sync(差分)
   ▼
McpHost ── createTransport ──► http: mcp-http.ts(Streamable HTTP / SSE 回退)
   │                            stdio: mcp-stdio.ts(子进程,首次需用户确认)
   │  initialize / tools/list
   ▼
mcp-tool-bridge:createMcpTool ──► ToolRegistry(入册,形状同内置工具)
   │
   ▼
Agent Loop ── tool_call ──► 同一道权限门(默认 ask) ──► tools/call
```

| 组件 | 职责 |
|---|---|
| `core/mcp-host.ts` | 多 Server 编排:差分 sync、入册/出册、熔断(连续失败阈值)、dispose |
| `core/mcp-config.ts` | 配置校验/归一化;Claude/Cursor JSON 导入(`parseMcpServersJson`) |
| `core/mcp-tool-bridge.ts` | `tools/list` 项 → 内置 `Tool` 形状;注册名 `mcp_<serverId>_<tool>` |
| `adapters/mcp-client.ts` | 会话生命周期、requestId 关联、超时 |
| `adapters/mcp-jsonrpc.ts` / `mcp-sse.ts` / `mcp-stdio-framing.ts` | 协议编解码与传输帧 |
| `ui/mcp/McpManageModal.ts` | 抽屉管理入口:增删改、开关、刷新、JSON 导入 |

## 配置(settings.mcpServers)

```typescript
interface McpServerConfig {
  id: string;            // 小写字母数字连字符;用于工具前缀与钥匙串
  label: string;
  enabled: boolean;
  transport: 'http' | 'stdio';
  url?: string;          // http:端点
  command?: string;      // stdio:可执行文件
  args?: string[];       // stdio:参数列表(数组直传,禁止拼 shell 字符串)
  envKeys?: string[];    // 环境变量名;值运行时从钥匙串解析,不落 settings
  timeoutMs?: number;
}
```

- **密钥**:stdio 环境变量值存 Obsidian Keychain,secret ID 为 `ratel-mcp-<serverId>`(见 `src/secrets/ratel-secrets.ts`);settings 只存变量**名**。
- **stdio 首启确认**:本地命令首次拉起前弹确认 Modal(`ui/mcp/mcp-spawn-confirm-modal.ts`);HTTP 无需。

## 工具入册

`initialize → tools/list → createMcpTool → registry.register`。MCP 工具与内置工具同形状(`definition/execute/readOnly`),对 Agent Loop 透明;时间线、事件流(`tool.call`/`tool.result`)、钩子全部复用。

## 权限

- 注册名前缀 `mcp_`,命中 `toolPermissions` 前缀规则,**默认 ask**。
- per-server / per-tool 可在权限页调 allow/ask/deny;会话内 grants 同内置工具。

## 非目标

- MCP **Resources / Prompts / Sampling** 不做(仅 tools)。
- 不自建 websearch / fetch_url 内置工具(ADR-014:交给 MCP 生态)。
- 不支持远程图片/文件双向同步。

## 相关

- [ADR-014](../../adr/2026-08-03-mcp-host-platform.md) — 平台决策、网络边界修订、双 transport
- [ADR-015](../../adr/2026-08-03-capability-pool.md) — 能力池:内置 / Skill / MCP 三源
- [capability-surface](../agent/capability-surface.md) — 生命周期与权限门总图

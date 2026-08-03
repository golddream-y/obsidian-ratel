# ADR-014: MCP Host — 平台级接入外部能力,不自建 websearch

**状态**:Accepted  
**日期**:2026-08-03  
**关联**:
- [ADR-001](2026-06-14-ratel-cors-strategy.md)(`requestUrl` 绕 CORS,HTTP MCP 复用)
- [ADR-010](2026-07-21-skill-vs-builtin-capability.md)(内置能力 vs Skill 边界;MCP 属平台,不是 Skill)
- [ADR-013](2026-08-03-graph-retrieval-minimize-human-curation.md)(融合检索卖点;MCP 是其外延)
- [S-EVOLUTION](../superpowers/specs/2026-07-15-evolution-graph-agent.md)(原「网络仅模型 API」约束 — 本 ADR 修订该边界)

---

## Context(背景)

Ratel 定位是「Obsidian 里的 Agent 平台」。要让 Agent 吃到生态能力(网页搜索、文档检索、第三方工具),有两条路:

| 立场 | 含义 |
|---|---|
| **A. 每家能力单独内置** | `web_search` / `fetch_url` / `xxx_search` 一个个写进 `tools/`,各自 Port + Adapter |
| **B. 平台级 MCP Host** | 实现 MCP 客户端,挂官方/社区 MCP Server,工具自动发现注册 |

此前铁律「**网络仅模型 API**」(AGENTS.md / README / S-EVOLUTION 非目标)明确排除了联网搜索。用户现在确认:

1. **目标是 Agent 平台** — 需要可扩展的外部能力通道,不是一次性塞个 websearch
2. **不自建抓网页** — 网页搜索交给生态(Tavily / Brave 等),Ratel 不做爬虫 / 不做任意 `fetch_url`
3. **一步到位** — HTTP + stdio 双通道都支持,不留「先做 HTTP 下期 stdio」的中间态

业界现状(2026-08 调研):

- Tavily / Brave 均有**官方 MCP Server**(stdio + Streamable HTTP;Tavily 还有 Remote MCP `mcp.tavily.com`)
- Obsidian 桌面插件可用 `child_process.spawn`(`isDesktopOnly: true` 即可,审核额外关注但合规;local-runner / llm-hub / obsidian-gemini 已有先例)
- MCP over HTTP 可走 Obsidian `requestUrl`(复用 ADR-001 CORS 策略)
- 无「统一搜索协议」行业标,MCP 就是当下最通用的 Agent ↔ 工具协议

---

## Decision(决策)

### 1. 平台级 MCP Host,不做独立 websearch 工具

- **采纳**:实现 MCP 客户端(MCP Host),Agent 工具面通过挂 MCP Server 扩展
- **否决**:为网页搜索单独写 `web_search` / `fetch_url` / `crawl` 一等公民工具
- **理由**:平台目标是「可插拔生态能力」;单独内置每家搜索是技术债,MCP 一次接入、工具自动发现

### 2. 双 Transport 一期到位

| Transport | 用途 | 实现要点 |
|---|---|---|
| **Streamable HTTP** | 远程 MCP(Tavily Remote、自托管) | `requestUrl`(ADR-001 CORS);SSE 解析;`mcp-session-id` 头续会话 |
| **stdio** | 本地 MCP(`npx tavily-mcp`、`@brave/brave-search-mcp-server`) | `child_process.spawn`,`shell: false`;LSP `Content-Length` / 换行双分帧;stderr 捕获 |

- **不留中间态**:两个 transport 同一期交付,配置层统一
- **desktop-only 前提**:`isDesktopOnly: true` 已满足,stdio 仅在桌面可用(本来就是)

### 3. 网络边界修订(改隐私铁律)

| 旧 | 新 |
|---|---|
| 网络仅模型 API(DeepSeek / Claude / Ollama) | **默认**仍仅模型 API;**用户显式配置 MCP Server 后**,允许发往该 MCP 端点 |

- **默认关**:不配置任何 MCP Server 时,网络面与今天完全一致
- **opt-in**:MCP Server 由用户在设置里逐个添加(URL 或命令),不内置、不预置
- **出站范围**:仅用户配置的 MCP 端点;插件自身仍**无遥测、无数据收集**
- **README 隐私说明**同步改写(见 §Consequences)

### 4. 安全与权限模型

- **工具命名空间**:MCP 工具注册为 `mcp__<server>__<tool>`,与内置工具区分,权限模型统一生效
- **默认 `ask`**:MCP 工具(尤其会写 / 会出网的)默认走权限确认,同内置写工具
- **stdio spawn 确认**:首次启动某 stdio server 需用户确认命令行;进程列表可见、可停
- **密钥**:MCP Server 的 API Key 走钥匙串(`ratel-mcp-<server>`),**不**进 settings.json,不进 spawn env 明文日志
- **超时与熔断**:每 server 初始化 / 调用独立超时;连续失败自动标记 offline,网络恢复自动重连(参考 obsidian-gemini 模式)

### 5. 架构归属

- **MCP Host 在主线程**(与 LLM HTTP 同侧);Worker 不参与(Worker 禁 HTTP / 无子进程)
- 新增 `ports/mcp.ts`(零实现契约)+ `adapters/mcp-http.ts` / `adapters/mcp-stdio.ts`
- 工具发现结果注入 `ToolRegistry`,走现有权限与 `tool.result` 事件流
- **不动**:Agent Loop 主循环、融合检索管线(ADR-013)、MemoryStore、vectra 索引

### 6. 明确不做

- 不做任意 `fetch_url` / 爬虫(网页内容获取交给 MCP Server 侧的 extract 能力)
- 不做 MCP Server 聚合代理 / 自建网关
- 不做移动端 MCP(`isDesktopOnly`,移动端本来就排除)
- 不预置任何 MCP Server(默认零配置零出站)

---

## Consequences(后果)

### 正面

- Agent 能力边界从「内置 23 工具」扩到「整个 MCP 生态」,一次接入长期复用
- 网页搜索交给专业方(Tavily / Brave),Ratel 不背爬虫复杂度与反爬风险
- 隐私叙事仍成立:**默认仅模型 API,MCP 是用户显式开的门**
- HTTP 复用 ADR-001;stdio 有 desktop-only 与社区先例背书,审核口径可预期

### 负面 / 风险

- MCP Host 工程量大:双 transport、工具发现、会话管理、超时熔断、权限接线
- stdio spawn 审核更严,需在提交说明里写清「用户显式配置才启动、命令可见、密钥走钥匙串」
- Electron singleton 冲突(Claude Desktop 类)在 stdio 场景可能出现,需正确 spawn 姿势或 relay
- 用户配了恶意 MCP Server 风险与「装任意 npm 包」同级 — 靠 `ask` 权限 + 文档警示缓解,不能根除

### 后续影响

- README「Why Ratel」与隐私段改写(用户已要求,文案单独确认)
- user-guide 新增 MCP 配置章节(服务器添加、权限、密钥)
- 本 ADR 落地后,S-EVOLUTION 的「网络仅模型 API / 不做联网搜索」非目标条需划掉并链回此处
- 融合检索(ADR-013)与 MCP 是两条独立卖点:前者库内,后者库外;README 并列呈现

---

## 参考

- [Tavily MCP](https://github.com/tavily-ai/tavily-mcp)(官方,stdio + Remote HTTP)
- [Brave Search MCP](https://github.com/brave/brave-search-mcp-server)(官方)
- [Obsidian 插件提交要求 — Node/Electron API 仅桌面](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- 社区先例:obsidian-llm-hub(MCP Host 双 transport)、obsidian-gemini(MCP servers)、local-runner(child_process spawn)
- [Model Context Protocol 官方](https://modelcontextprotocol.io/)

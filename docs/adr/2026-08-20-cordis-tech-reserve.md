# ADR-019:Cordis 插件框架 — 技术储备,不自研插件运行时

**状态**:Accepted(技术储备)
**日期**:2026-08-20
**修订**:2026-08-22 — 对照 [DeepSeek Harness Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) 确认「不直接换」;澄清 S-ECOSYSTEM 不是引入触发条件
**关联**:
- [ADR-014](2026-08-03-mcp-host-platform.md)(平台化方向的先例 — Ratel 定位是平台)
- [ADR-017](2026-08-19-skill-script-sandbox-worker-vm.md)(Skill 是数据不是代码插件,暂不需要插件框架)
- [S-ECOSYSTEM](../superpowers/specs/2026-08-20-ecosystem-management-design.md)(生态管理 — 对话安装/配置/回滚**其他** Obsidian 社区插件,见下文「非触发」)

---

## Context(背景)

调研了 DeepSeek Harness 底层插件框架 [Cordis](https://github.com/cordiverse/cordis)(官方 primer + npm 生态 + DeepSeek Harness [Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer))。结论:它解决的正是「插件能装能卸、副作用可逆、依赖自动编排」问题,且被 DeepSeek Harness 以 vendor 方式采纳,有北大 + DeepSeek 联合论文对其「时空可组合性」做形式化证明。

**关键事实:**

| 维度 | 结论 |
|---|---|
| 出身 | Koishi 聊天机器人内核,作者 Shigma(Koishi 创始人,现任 DeepSeek-AI) |
| 成熟度 | 4 年生产验证,4000+ Koishi 插件生态,MIT 协议;社区线 API 仍可能变动,引入时必须钉版本 |
| 体量 | 核心约 2000 行,`@cordisjs/core` 仅 1 个依赖(cosmokit) |
| 环境兼容 | 浏览器 + Node 双支持(Koishi webui 跑在浏览器;`@cordisjs/plugin-http` 明确双环境) |
| npm 包 | `cordis`(cordiverse 官方 3.x)/ `@deepseek-ai/cordis`(DeepSeek vendor 版 4.x) |
| 打包 | esbuild 友好,预估 minified 增量 30-60KB(相对 main.js 现状可接受,仍须实测) |

### DeepSeek Harness 怎么用 Cordis(产品形态,不是我们该抄的组装方式)

Primer 的读者是 **harness 插件作者**。在 DeepSeek Harness 里,模型适配、工具表、session、实时 Agent 协调都是进程内可装卸插件:服务占稳定的 `ctx.tools` / `ctx.llm` / `ctx.agents`,用 `inject` 等依赖,用 `ctx.effect()` / `ctx.on()` 保证卸载撤回,用 `emit` / `waterfall` / `parallel` / `serial` 做策略拦截。另有 Loader、`!!js` 插值、overlay 按环境选插件——那是「按配置拼一台 Agent」的操作系统。

Ratel 不是这个产品。我们是 **一个** Obsidian 社区插件:生命周期是 `onload` / `onunload` + `this.register*`;第三方扩展今天是 Skill(数据 + 沙箱脚本)和 MCP(进程外),不是往主线程热装社区 JS。商店产物仍是 ADR-006 三文件,不是 DeepSeek Harness 插件包。

**Ratel 现状与 Cordis 的映射:**

| Cordis 概念 | Ratel 现状 | 差距 |
|---|---|---|
| `ctx.<key>` 服务容器 | ports/adapters 显式注入 | 我们是编译期 IoC,无运行时服务查找 |
| `inject` 声明依赖 | main.ts 手工组装 | 无声明式依赖编排 |
| `ctx.effect()` 可逆副作用 | `this.register*`(Obsidian 原生) | 只覆盖 Obsidian 事件,不覆盖工具/提示词等一切注册 |
| `waterfall/parallel/serial` 事件分发 | 无(只有 ToolPermission 单点拦截) | 拦截/策略无通用管道 |

概念可映射,不代表现在要把组装层换成 Cordis。

---

## Decision(决策)

**技术储备:记录选型结论与触发条件,当前不引入、不把组装层「直接换成」Cordis。触发条件满足时直接依赖社区 `cordis`,不自研插件运行时。**

### 1. 为什么现在不引入(含 2026-08-22 对照 Primer 的确认)

- Ratel 当前没有第三方**代码**扩展机制:Skill 是数据(说明书 + 脚本),不是代码插件;插件框架解决的核心问题(进程内第三方插件热装卸)今天不存在
- ports/adapters + `register*` 对当前规模够用;引入 Cordis 是组装层推翻性变更,违背「架构文档默认不动」的保守原则
- 会叠两套生命周期(Obsidian Plugin + Cordis Context),disposer 与 `onunload` 顺序必须先 spike,尚未做
- AGENTS.md 红线「无外部服务 / 最小依赖」下,为不存在的需求加运行时依赖不划算
- 跟 DeepSeek 的 vendor 栈(4.x + Loader + overlay + `!!js`)走,等于复制 coding-agent harness,而不是在 Obsidian 里做一个知识 Agent

### 2. 触发条件(满足任一即启动引入评估;评估 ≠ 当天合入)

1. **开放第三方代码扩展**:Ratel 允许社区写进程内 JS/TS 插件扩展 Agent 能力(类似 Koishi / DeepSeek Harness 插件模式)
2. **热重载复杂度越界**:Skill / 工具 / 子代理的重载副作用清理逻辑复杂到自研易错、维护成本超过依赖成本
3. **拦截/策略管道需求**:Agent 主路径上**多处**需要 waterfall 式环绕拦截(例如工具调用链的多层策略),单点 ToolPermission 不再够用,且自研一条总线会变成「假 Cordis」

**明确非触发:**

- **S-ECOSYSTEM** 管的是对话发现 / 安装 / 配置 / 回滚**其他** Obsidian 社区插件(`community-plugins.json`、插件目录),与 `ctx.plugin()` 不是一类问题。变更日志扇出可以是小范围本地事件,不构成引入 Cordis 的理由
- 仅「想和 DeepSeek Harness 文案对齐」或「想把 Agent Loop 拆成可替换插件」——产品形态未变时不引入

### 3. 引入时的包选择

- 优先 **`cordis`(cordiverse 官方)**:社区主线,版本节奏独立于 DeepSeek;钉死版本,按当时 changelog 再评估 API 稳定性
- `@deepseek-ai/cordis`(vendor 版)仅当需要与 DeepSeek Harness **进程内插件生态互操作**时评估。发 Obsidian 三文件包、不加载 dsh 插件,则不跟 vendor 线
- 引入范围限定组装层(`main.ts` 的组装逻辑 → `ctx.plugin`),**ports/adapters 接口层保持不变**——契约不依赖实现框架
- **不引入**(除非触发条件 1 已成立且产品就是「可配置拼装的 harness」):Loader / overlay / `!!js`、把 Agent Loop 本身做成对用户可替换的插件

### 4. 引入前必做验证

- Obsidian Electron 渲染进程兼容性 spike(参照 ADR-017 的 Worker 教训:浏览器 / Node 双环境假设必须实测)
- esbuild 打包体积与商店产物约束(ADR-006 三文件)实测
- 与 `register*` 生命周期的协同(disposer 与 Obsidian unload 顺序)

### 5. 现在就可以用、不必引包的实践规则

从 Primer 立即借鉴,写进日常设计即可:

- **拦截和策略优先走事件;直接能力调用优先走服务方法**(端口方法),不要为策略去改 adapter 内部
- **每处注册都要有对应 disposer**(与 `register*` / 卸载成对);teardown 顺序有要求时放在同一清理作用域
- 新的工具策略、生态路径白名单、权限门仍落在现有 ports / 工具层,不自研一套 Cordis 克隆

---

## Consequences(后果)

**正向:**
- 未来扩展机制建设方向已定,避免届时重复调研或错误自研
- Primer 的实践规则可立即用在 ToolPermission 演进与 S-ECOSYSTEM 白名单拦截上,不依赖引入框架本身

**负向/风险:**
- cordis 4.x(vendor 线)与 3.x(社区线)存在分叉;社区 API 未完全稳定,引入时需重新评估版本并钉死
- 若触发条件长期不出现,本 ADR 仅作认知储备,无代码产出

**中性:**
- 现有架构零改动;本修订不产生任何依赖变更

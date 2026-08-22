# ADR-019:Cordis 插件框架 — 技术储备,不自研插件运行时

**状态**:Accepted(技术储备)
**日期**:2026-08-20
**关联**:
- [ADR-014](2026-08-03-mcp-host-platform.md)(平台化方向的先例 — Ratel 定位是平台)
- [ADR-017](2026-08-19-skill-script-sandbox-worker-vm.md)(Skill 是数据不是代码插件,暂不需要插件框架)
- [S-ECOSYSTEM](../superpowers/specs/2026-08-20-ecosystem-management-design.md)(生态管理 — 未来可能需要变更后事件分发)

---

## Context(背景)

调研了 DeepSeek Harness 底层插件框架 [Cordis](https://github.com/cordiverse/cordis)(读其官方 primer + npm 生态调研)。结论:它解决的正是「插件能装能卸、副作用可逆、依赖自动编排」问题,且被 DeepSeek Harness 以 vendor 方式采纳,有北大 + DeepSeek 联合论文对其「时空可组合性」做形式化证明。

**关键事实:**

| 维度 | 结论 |
|---|---|
| 出身 | Koishi 聊天机器人内核,作者 Shigma(Koishi 创始人,现任 DeepSeek-AI) |
| 成熟度 | 4 年生产验证,4000+ Koishi 插件生态,MIT 协议 |
| 体量 | 核心约 2000 行,`@cordisjs/core` 仅 1 个依赖(cosmokit) |
| 环境兼容 | 浏览器 + Node 双支持(Koishi webui 跑在浏览器;`@cordisjs/plugin-http` 明确双环境) |
| npm 包 | `cordis`(cordiverse 官方 3.x)/ `@deepseek-ai/cordis`(DeepSeek vendor 版 4.x) |
| 打包 | esbuild 友好,预估 minified 增量 30-60KB(相对 main.js 现状可接受) |

**Ratel 现状与 Cordis 的映射:**

| Cordis 概念 | Ratel 现状 | 差距 |
|---|---|---|
| `ctx.<key>` 服务容器 | ports/adapters 显式注入 | 我们是编译期 IoC,无运行时服务查找 |
| `inject` 声明依赖 | main.ts 手工组装 | 无声明式依赖编排 |
| `ctx.effect()` 可逆副作用 | `this.register*`(Obsidian 原生) | 只覆盖 Obsidian 事件,不覆盖工具/提示词等一切注册 |
| `waterfall/parallel/serial` 事件分发 | 无(只有 ToolPermission 单点拦截) | 拦截/策略无通用管道 |

---

## Decision(决策)

**技术储备:记录选型结论与触发条件,当前不引入。触发条件满足时直接依赖 cordis,不自研插件运行时。**

### 1. 为什么现在不引入

- Ratel 当前没有第三方代码扩展机制:Skill 是数据(说明书+脚本),不是代码插件;「插件框架解决的核心问题(第三方插件热装卸)今天不存在」
- ports/adapters + register* 对当前规模够用;引入 Cordis 是组装层推翻性变更,违背「架构文档默认不动」的保守原则
- AGENTS.md 红线「无外部服务/最小依赖」下,为不存在的需求加运行时依赖不划算

### 2. 触发条件(满足任一即启动引入评估)

1. **开放第三方扩展**:Ratel 允许社区写代码插件扩展 Agent 能力(类似 Koishi 模式)
2. **热重载复杂度越界**:Skill/工具/子代理的重载副作用清理逻辑复杂到自研易错、维护成本超过依赖成本
3. **拦截/策略管道需求**:多处需要 waterfall 式环绕拦截(如工具调用链的策略注入、S-ECOSYSTEM 变更后的事件扇出),单点 ToolPermission 不再够用

### 3. 引入时的包选择

- 优先 **`cordis`(cordiverse 官方)**:社区主线,版本节奏独立于 DeepSeek
- `@deepseek-ai/cordis`(vendor 版)仅当需要与 DeepSeek Harness 插件生态互操作时评估
- 引入范围限定组装层(main.ts 的组装逻辑 → ctx.plugin),**ports/adapters 接口层保持不变**——契约不依赖实现框架

### 4. 引入前必做验证

- Obsidian Electron 渲染进程兼容性 spike(参照 ADR-017 的 Worker 教训:浏览器/Node 双环境假设必须实测)
- esbuild 打包体积与商店产物约束(ADR-006 三文件)实测
- 与 `register*` 生命周期的协同(disposer 与 Obsidian unload 顺序)

---

## Consequences(后果)

**正向:**
- 未来扩展机制建设方向已定,避免届时重复调研或错误自研
- 「拦截走事件、调用走服务方法」的实践规则可立即借鉴到日常设计(如 S-ECOSYSTEM 的白名单拦截、ToolPermission 演进),不依赖引入框架本身

**负向/风险:**
- cordis 4.x(vendor 线)与 3.x(社区线)存在分叉,引入时需重新评估版本选择
- 若触发条件长期不出现,本 ADR 仅作认知储备,无代码产出

**中性:**
- 现有架构零改动;本 ADR 不产生任何依赖变更

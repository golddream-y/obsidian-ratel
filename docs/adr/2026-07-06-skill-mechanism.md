# ADR-009:Skill 机制三源加载与端口设计

**状态**:Accepted
**日期**:2026-07-06

---

## Context(背景)

S-SKILL spec 要求 Ratel Vault 支持用户用 Markdown 文件扩展 Agent 行为,不修改插件代码。设计阶段评估了 3 个关键决策点:

1. **skill 文件存哪?** — 用户既需要跨 vault 通用配置(如"我的写作风格偏好"),又需要跟随 vault 同步的配置(如"这个项目的领域知识"),还需要插件自带的预置 skill。单一目录无法覆盖三种使用场景。
2. **如何抽象文件访问?** — 三个源访问方式不同:builtin/global 走 node:fs,vault 走 Obsidian API。如果让 `SkillLoader` 直接调 fs 和 ObsidianVault,会破坏六边形架构(Engine 不依赖 Adapter)。
3. **激活态如何注入 system prompt?** — 已有 `ContextManager.toMessages()` 拼装 system + memory + searchResults 三段,skills 段要插入哪个位置?复用现有 `prompts/` 注册表还是单独建一套?

---

## Decision(决策)

### 1. 三源合并存储(vault > global > builtin)

定义 3 个加载源,按优先级从低到高扫描,后者覆盖前者:

| 源 | 路径 | 适配器 |
|---|---|---|
| builtin | `<pluginDir>/skills/` | `SkillFsAdapter` |
| global | `~/.ratel/skills/` | `SkillFsAdapter` |
| vault | `<vaultRoot>/.ratel/skills/` | `SkillVaultAdapter` |

`SkillLoader.loadAll()` 用 `Map<name, Skill>` 实现 "后者覆盖前者":扫描 builtin 先入 Map,扫描 global 时同名 key 覆盖,扫描 vault 时再覆盖。最终 Map.values() 即合并结果。这样 vault 级配置可定制/重写全局或预置 skill,符合"用户最终决定权"原则。

**不采纳**:
- 单一目录(只 vault 或只 global) — 无法覆盖三种使用场景
- 优先级 builtin > global > vault — 违反"用户配置优先"原则,预置 skill 反而覆盖不了
- 数据库合并算法(冲突合并工具) — 过度设计,后者覆盖前者已满足需求

### 2. SkillPort 端口 + 双适配器

定义 `src/ports/skill-port.ts`:

```typescript
export interface SkillPort {
  readonly source: SkillSource;
  readonly rootDir: string;
  listSkillFolders(): Promise<string[]>;
  readSkillManifest(skillName: string): Promise<string>;
}
```

两个实现:
- `SkillFsAdapter`(node:fs)用于 builtin 与 global 源 — 构造时注入 `source` 与 `rootDir`,运行时只读。`readSkillManifest` 内部做 path traversal 校验(`path.resolve` + `startsWith(rootDir + path.sep)`),防 `../` 越权。
- `SkillVaultAdapter` 走 `VaultPort` 接口(非 `ObsidianVault` 具体类)— 关键设计点。ObsidianVault 是 facade 而非 Port,直接依赖会让 Adapter 不可单测。VaultPort 是已存在的端口接口,SkillVaultAdapter 依赖它即可 mock。

**与 ObsidianVault facade 的区别**:ObsidianVault 是单实现 facade(项目内只有 Obsidian 一个实例),做成 Port 接口意义不大;SkillPort 是真正的多实现 Port(fs 与 VaultPort),符合六边形架构的 Port 契约。

**不采纳**:
- 让 SkillLoader 直接调 fs + ObsidianVault — 破坏六边形架构,不可单测
- 把 SkillVaultAdapter 做成依赖 ObsidianVault 具体类 — 不可单测 mock
- path traversal 在 SkillLoader 层做 — 职责越界,Adapter 应自管安全

### 3. Discovery + Active 段双注入

`ContextManager.toMessages()` 在 `memory.systemPrompt` 之后、`searchResults` 之前插入 skills 段:

```typescript
const skillsSegment = [skillsDiscovery, skillsActive]
  .filter(s => s.length > 0)
  .join('\n\n');
```

- **Discovery 段**:`agent.skills` prompt section(zone: 'dynamic', `allowOverride: false`),注入 `{{skillList}}` 占位符。zone='dynamic' 让 Composer 知道该段运行时拼装,不从 defaults/zh.ts 静态取值。
- **Active 段**:激活 skills 的 `instructions` 用 `\n\n` 拼接,作为系统消息插入。

`allowOverride: false` 防止用户覆盖 Discovery 段 — 该段内容是 skill 列表(动态),用户覆盖无意义且会破坏 `{{skillList}}` 占位符。

**`agent-loop` 重组触发**:`activate_skill` / `deactivate_skill` 工具执行成功后,`agent-loop` 调 `ctx.setSkillsContext(skillActivator.composeDiscovery(ctx.getOverrides()), skillActivator.composeActive())` 重组 skills 段,让 LLM 下一次调用即可见 active 变化。

**不采纳**:
- Discovery 段允许 override — 用户覆盖会破坏 `{{skillList}}` 占位符机制
- Active 段包 retrieval wrapper(与 memory 同源防注入) — skill 指令是用户主动激活的"半信任"内容,无需 wrapper;memory 的 wrapper 是因为 global.md 在启动时全文注入(可能含恶意 LLM 写入的内容)
- 每次激活都重发完整 system prompt — 改为 ContextManager 内部状态变更,下一次 `toMessages()` 调用即生效,无需主动推送

### 4. 三态管理:enabled / active / always

| 状态 | 字段 | 作用域 | 改变方式 |
|---|---|---|---|
| `enabled` | `manifest.enabled` | 持久 | Settings 面板 toggle / `setEnabled()` |
| `active` | `activeSkills` Set | 会话级 | `activate_skill` 工具 / `/skill` 命令 |
| `always` | `manifest.activation === 'always'` | 持久 | frontmatter 字段 |

`SkillRegistry.reload()` 时,所有 `activation === 'always'` 的 skill 自动加入 `activeSkills` Set。`setEnabled(false)` 同步清除该 skill 的 active 状态(避免禁用的 skill 仍注入指令)。

`getDiscovered()` 只返回 `enabled === true && activation !== 'manual'` 的 skill,manual 类型不出现在 Discovery 段(只能 `/skill <name>` 手动激活)。

### 5. v1 简化:identity wrapper + ZH 默认值

`composer.ts` 提供 2 个 identity wrapper:

```typescript
export function composeSkillsDiscovery(discoveryText: string): string { return discoveryText; }
export function composeActiveSkills(activeText: string): string { return activeText; }
```

v1 不做 i18n fallback(`resolveDescription` 直接返回 `manifest.description`),v2 会扩展为按当前 locale 取 `i18n.description[locale]`。wrapper 是 v2 扩展点,不需要现在改 SkillActivator 签名。

`resolveSection('agent.skills', overrides)` 复用 Composer 既有的 override + ZH_DEFAULTS 解析链,让用户可改 `agent.skills` section 模板(虽然 allowOverride: false,但 ZH_DEFAULTS 内的模板本身可改)。

---

## Consequences(后果)

**正面**:
- 三源合并满足"用户配置优先"原则,vault 级可重写预置/全局 skill
- SkillPort 让 SkillLoader 可单测(注入 mock SkillPort),符合六边形架构
- Discovery + Active 双段设计让 LLM 知道"有哪些 skill 可用"和"哪些 skill 已激活",激活后 LLM 即可见指令
- enabled/active/always 三态分离:持久态(enabled/always)与会话态(active)清晰,易推理
- agent-loop 重组触发让 skill 激活/反激活立即对 LLM 可见,无需重启会话

**负面**:
- 三源合并可能让用户困惑("我改了 global 的 skill 怎么没生效?" — 因为 vault 同名覆盖)— 通过 devLogger 在 reload 时输出每个 skill 的最终 source 缓解
- SkillVaultAdapter 依赖 VaultPort 而非 ObsidianVault,引入额外抽象层 — 但换来了可测试性,值得
- identity wrapper 在 v1 是死代码 — 为 v2 i18n fallback 留扩展点,避免后续改 SkillActivator 签名

**后续影响**:
- P-SKILL-2-EXECUTION 会扩展 references/scripts 子目录读取,需在 SkillPort 加 `readSkillReference` / `readSkillScript` 方法
- P-SKILL-3-UI 会做 skill 管理面板,SkillRegistry 的 `setEnabled` 是 UI 操作的入口
- P-SKILL-4-SANDBOX 会限制 script 执行,但本 ADR 的端口设计与 sandbox 无耦合

---

## 参考

- [S-SKILL spec](../docs/superpowers/specs/2026-07-06-skill-mechanism-design.md)
- [ARCHITECTURE.md §8.5 Skill 子系统](../docs/ARCHITECTURE.md#85-skill-子系统)
- [ADR-008:Prompt Registry 设计决策](2026-07-04-prompt-registry.md) — agent.skills section 复用 Prompt Registry 注册表机制

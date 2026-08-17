# S-SKILL-UX — Skill 体验对齐 Claude/Cursor 设计

**日期**:2026-08-17
**状态**:Active
**关联**:
- [S-SKILL](2026-07-06-skill-mechanism-design.md)(机制层 — 本 spec 修订其 activation 三态与 enable 开关结论)
- [ADR-009](../../../adr/2026-07-06-skill-mechanism.md)(三源加载 — 修订 §5)
- [ADR-012](../../../adr/2026-07-23-skill-activation-claude-aligned.md)(激活即写会话 — 修订 §3 always)
- [S-MCP-HOST](2026-08-03-mcp-host-design.md) §4.11(管理 Modal 模式对齐目标)

---

## 1. 背景

### 1.1 用户反馈

1. Skill 默认就该开启,设置里的「启用 Skill 机制」总开关无人理解也无人需要
2. Skill 管理入口应与 MCP 管理一致(抽屉 Modal),而非设置页长表单
3. 「激活」概念混乱 —— 用户不知道什么叫激活、为什么要激活

### 1.2 现状诊断:五个概念、三种角色,全部暴露

| 概念 | 位置 | 面向 |
|---|---|---|
| `enableSkills` 总开关 | 设置 Agent tab | 用户 |
| per-skill `enabled` | frontmatter(**无 UI,内存态不持久化**) | 文件作者 |
| `activation: auto/manual/always` | frontmatter 三态 | 文件作者 |
| `activate_skill`/`deactivate_skill` 工具 | 聊天 trace 可见 | 模型 |
| `/skill` `/skills` `/skill off` 斜杠 | 输入框 | 用户 |

### 1.3 业界调研结论(2026-08)

**Claude(Anthropic Agent Skills,2025-10,开放标准 agentskills.io):**
- 三层渐进披露:启动只加载 `name + description`(~100 tokens/个)→ 相关时读全文 → 附属资源按需
- **无「激活」概念**:装了就生效,Claude 自动判断;用户唯一操作是 per-skill 开/关
- 无总开关;手动路径为 Claude Code `/技能名`

**Cursor(遵循同一标准):**
- 同「描述匹配自动用」+ `/技能名` 手动调
- 管理 UI:Settings → Rules 技能列表,每行一个 toggle
- `disable-model-invocation: true` = 只许手动(对应 Ratel `manual`)

**结论:Ratel 底层机制(Discovery 段 + activate_skill 写会话消息)与业界完全同构,是 progressive disclosure 的正确实现。乱的只是表达层** —— 术语、入口、开关归属。

---

## 2. 目标

1. **删总开关** — 技能装了就生效,设置页「Skill 管理」组整组移除
2. **抽屉管理** — StatusDrawer「技能」按钮 → SkillManageModal,对齐 McpManageModal 模式
3. **术语隐形化** — 用户侧永不出现「激活」;模型侧机制原样保留
4. **frontmatter 收敛** — `activation` 合法值收敛为 `auto|manual`,`always` 删除
5. **per-skill 开关持久化** — 替代当前不落盘的内存 `enabledOverrides`
6. **三源管理权限明确** — 内置只读、库内/全局可改可删

## 3. 非目标

| 非目标 | 说明 |
|---|---|
| 改激活机制架构 | Discovery + activate_skill 写 Session 消息(ADR-012)原样保留 |
| Skill 注册为业务工具 | 能力池模型不变(ADR-015):skill 走元工具,不进 ToolRegistry |
| 动态 `/技能名` 斜杠 | 斜杠命令全删,手动触发 = 自然语言「用 xxx 技能」 |
| scripts/references 沙箱 | 仍是 P-SKILL-2-EXECUTION 范围 |
| 补写 ADR-010 | 文件缺失问题另行处理,本 spec 不夹带 |
| Agent 写技能目录特殊通道 | `.ratel/skills/` 是 vault 普通文件,普通笔记工具可写,无需特殊权限 |

---

## 4. 详细设计

### 4.1 用户可见行为(before → after)

| 场景 | 现在 | 改后 |
|---|---|---|
| 设置页 | Agent tab「Skill 管理」组 + 总开关 | 整组删除 |
| 管理 | 无入口 | 抽屉「技能」→ Modal(见 4.3) |
| 斜杠 | `/skill` `/skills` `/skill off` | 全删;手动 = 自然语言 |
| 聊天 trace | 「激活技能」 | 「使用技能 xxx」 |
| 技能作者 | `auto/manual/always` 三态 | 两态:省略(自动)/ `manual`(点名才用) |

### 4.2 数据模型

- **删** `settings.enableSkills`(data.json 旧值无害残留,不主动清理;`DEFAULT_SETTINGS` 与 config-whitelist 同步删)
- **增** `settings.skillEnabled: Record<string, boolean>` — per-skill 开关持久化;加载后应用为 Registry override
- `activation` 校验收敛:`auto|manual`;`always` 按 `auto` 降级加载并记 warning「always 已废弃」

### 4.3 SkillManageModal(对齐 McpManageModal)

- **列表项**:名称、描述、来源徽标(内置/全局/库内)、版本、开关、查看全文(只读展开)
- **空态**:引导「把 SKILL.md 放进 `.ratel/skills/<技能名>/`」,附三源路径说明
- **同名合并**:vault > global > builtin,列表只显示实际生效那份,徽标标生效来源

### 4.4 三源管理权限

| 能力 | 内置(pluginDir/skills) | 库内(.ratel/skills/) | 全局(~/.ratel/skills/) |
|---|---|---|---|
| 开关(停用) | ✓ 存 settings,不碰源文件 | ✓ | ✓ |
| 查看全文 | ✓ 只读 | ✓ | ✓ |
| 编辑 | ✗ 行内注明「内置技能,随插件更新」 | ✓ Obsidian 打开 SKILL.md | ✓ 系统打开目录 |
| 删除 | ✗(升级会重新落盘) | ✓ 二次确认后删文件夹 | ✓ 同左 |

内置技能升级幂等重写(builtin-writer 按 version),用户编辑必被覆盖,故不提供编辑。

### 4.5 机制层改动(表达层简化,架构不动)

- **删** `getAlwaysSkills` / `ensureAlwaysSkillsInjected` 链路(always 消亡)
- `activate_skill` / `deactivate_skill` 模型侧工具保留;instructions 写 Session 消息(ADR-012)不变
- `manual` 语义不变:不进 Discovery;用户点名 → 模型调 `activate_skill` 成功(registry 本就不拦)
- Discovery prompt(`agent.skills` section)话术去「激活」字样,改为「任务匹配时读取该技能的完整做法」
- `main.ts` 无条件 `reloadSkills()`(原 enableSkills 条件删除)
- 斜杠清单删 3 条命令,ChatView 内对应 handler 清理

### 4.6 内置 skill 与内置工具的关系(澄清,不改)

[capability-surface.md](../../../architecture/agent/capability-surface.md) 能力池模型:**统一发现、分链路执行**。

- 内置工具 `kind=tool` → ToolRegistry.execute → 本地 TS(产出结果)
- MCP 工具 `kind=mcp` → ToolRegistry.execute → tools/call(产出结果)
- 技能 `kind=skill` → activate_skill 元工具 → Session 指令注入(不产出结果)

一句话:**工具是「手」,技能是「SOP」**。技能教模型何时、按什么顺序编排工具(ratel-config 教模型编排 get_app_config → 分诊 → update_app_config)。技能不进 ToolRegistry,是设计选择(ADR-012/015),本 spec 不改。

---

## 5. 影响面

### 5.1 代码

| 层 | 文件 | 动作 |
|---|---|---|
| 设置 | `src/settings.ts`、`src/settings/config-whitelist.ts` | 删 enableSkills 定义+白名单(2 处);删「Skill 管理」组 |
| UI | `src/ui/skills/SkillManageModal.ts`(新)、`src/ui/status/StatusDrawer.svelte`、`src/ui/chat/ChatView.svelte`、`src/main.ts`(openSkillManageModal 单例+接线) | 对齐 McpManageModal 模式 |
| 斜杠 | `src/ui/chat/input/slash-commands.ts` + handler | 删 3 命令及处理逻辑 |
| 术语 | `src/i18n/zh.ts`/`en.ts`/`types.ts`、`src/prompts/defaults/zh.ts` | 「使用技能」话术;删激活类 key;新增 Modal/抽屉 key |
| core | `src/skills/skill-registry.ts`(always 链路删、enabledOverrides→settings)、`skill-loader.ts`(activation 收敛)、`src/main.ts`(无条件加载) | 简化 |

### 5.2 架构文档(AGENTS.md 触发条件已核对)

| 文档 | 触发 | 动作 |
|---|---|---|
| ADR-012 | 推翻 §3 always 结论 | 追加修订记录 |
| ADR-009 | 推翻 §5「不改 enabled/always 语义」 | 追加修订记录 |
| `architecture/agent/capability-surface.md` | Skill 生命周期变更 | 更新供给方段落与生命周期图 |
| `architecture/host/settings.md` | 设置项增删 | enableSkills 删、skillEnabled 增 |
| `architecture/agent/tools.md` | 不触发 | 不动 |

### 5.3 用户文档(落地后确认)

- [ ] user-guide:删 /skill 斜杠说明,新增抽屉技能管理与三源说明
- [ ] CHANGELOG `[Unreleased]`
- [ ] README 功能清单如提及

### 5.4 兼容性

- `always` 技能退化为 auto + warning;当前唯一内置技能 ratel-config 是 auto,无实际影响
- data.json 残留 `enableSkills` 无副作用
- 已写 `manual` 技能行为不变

## 6. 参考

- [Anthropic — Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Agent Skills 开放标准](https://agentskills.io/)
- [Cursor — Agent Skills 文档](https://cursor.com/docs/skills)
- [Claude Skills 三层加载机制解析](https://aitoolsguidebook.com/en/articles/claude-skills-walkthrough-workflow/)

# ADR-012:Skill 激活对齐 Claude — 写入会话消息,不维护独立激活表

**状态**:Accepted  
**日期**:2026-07-23  
**关联**:
- [ADR-009](2026-07-06-skill-mechanism.md)(三源加载 / Discovery / 端口 — **本 ADR 修正其中「Active 段 + activeSkills Set」注入模型**)
- [ADR-010](2026-07-21-skill-vs-builtin-capability.md)(产品边界不变)
- [S-SKILL](../superpowers/specs/2026-07-06-skill-mechanism-design.md) §4.5(激活作用域)

---

## Context(背景)

Ratel 当前实现(ADR-009 §3–§4):

1. Discovery 段每轮注入(name + description)— 符合 progressive disclosure,保留
2. `activate_skill` / `/skill` 后把 name 记入插件级 `SkillRegistry.activeSkills`
3. 每轮 `toMessages()` 再拼 **Active 段**(完整 instructions)进 system prompt
4. Spec 写「激活态会话级、关 session 清空」,但代码是**全局 Set**,与 `sessionId` 脱节

会话管理 / 多会话续聊设计时暴露问题:

- `/new` 或切换 session 若不显式 `clearActive`,旧 Skill 指令会串台
- 若把 `activeSkillNames` 再挂到 Session 上并每轮重注,等于多维护一份与消息并行的状态
- 与 Claude Code / Codex / agentskills.io 主流不一致

### 业界对照(调研摘要)

| 产品 | Discovery | 激活后如何「保持」 | 跨会话 |
|---|---|---|---|
| **agentskills.io** | name + description | 需要时再读全文 | 无独立跨会话激活表 |
| **Claude Code** | 描述常驻 | 激活一次 → **渲染后的 SKILL.md 作为一条消息进入 conversation,本 session 一直留着**;后续回合不重读文件 | 文件仍在;激活不跨会话 |
| **Codex** | 启动目录(+长度预算) | 匹配或显式 `$skill` 时再读全文 | 不强调独立激活持久化 |
| **Ratel(改前)** | Discovery 段 | Registry Set + **每轮 Active 段重注** | 设计会话级、实现全局 |

Claude 文档要点:invoke 后 skill 正文进入会话并留在本场对话;权限类 grant 另算(下一条用户消息可清)。**「保持」的载体是会话 transcript,不是旁路激活表。**

---

## Decision(决策)

### 1. 对齐 Claude:激活 = 写入本 Session 的消息历史

- `activate_skill` 与 `/skill <name>`:**把该 skill 的完整指令(渲染后的 SKILL.md 正文,或约定包装后的 system/user 片段)追加进当前 `Session.messages`**
- 之后各轮 LLM 调用靠 **已落盘/已在 memory 的消息** 看见指令,**不再**依赖 `activeSkills` Set 每轮拼 Active 段
- Discovery 段保留:仍只注入目录,供模型决定何时 activate

### 2. 废除「插件级激活表」作为注入源

- **不采纳**长期保留「全局 `activeSkills` + Active 段每轮注入」作为正确模型
- **不采纳**仅把同一套 Set 改挂 `Session.activeSkillNames` 仍每轮重注(多一份同步态,且与 Claude 不一致)
- 迁移期可暂时保留 Registry API 外壳,但语义改为:激活副作用是写消息;查询「是否已在本会话注入」应扫 session 消息或一次性标记,而非跨 session 的全局 Set

### 3. `always` 与 `deactivate`

- **`activation: always`**:在 **session 首次 load / `/new` 后第一次组上下文** 时,若尚未注入,则各写一次进该 session 消息(或等价的一次性注入),避免全局 Set
- **`deactivate_skill`**:transcript 模型下无法从历史上物理删掉已注入正文。约定为:
  - 追加一条简短「supersede」说明(该 skill 此后不再作为有效指令),**或**
  - 降级为 best-effort / 文档标明局限
  - 不恢复「从 Active 段摘掉即对模型不可见」的假象(历史里仍在,除非后续做针对性 compact)

### 4. 与会话持久化的关系

- 会话续聊恢复 `Session.messages` 后,**曾激活过的 skill 正文自然恢复** — 无需另存激活列表
- `/new`(有内容则归档旧 session)→ 新 session 无旧 skill 消息;`always` 按 §3 再注入
- 本 ADR **不**定义会话列表 UX(那是会话管理 spec);只保证 Skill 激活模型与「消息即会话」一致

### 5. 明确不改动的部分

- 三源加载、SkillPort、Discovery 段、`enabled` / `manual` / `always` frontmatter 语义(产品层)
- ADR-010 产品边界(何为内置、何为 Skill)

---

## Consequences(后果)

### 正面

- 与 Claude / 开放标准心智一致:用时激活,保持靠对话
- 多会话 / 续聊不再与全局 `activeSkills` 打架;串台面自然消失
- 少一套要和 session 同步的状态;实现与推理更简单
- `data.json` 里 session 消息已是单一事实源(对 skill 指令而言)

### 负面 / 风险

- `deactivate` 变弱(历史已写入)— 需产品文案或 supersede 消息;与旧「摘掉 Active 段」体验不同
- 多次 activate 同一 skill 可能重复占 token — 激活前应检查本 session 是否已注入,已注入则 no-op 或提示
- 迁移:现有依赖 `setSkillsContext` Active 段的代码路径要改;需独立 plan(可挂在会话管理或 S-SKILL 修订后)

### 后续影响

- 修订 S-SKILL §4.5 / ADR-009 §3–§4 的「现行描述」指向本 ADR(加载与 Discovery 仍以 ADR-009 为准)
- 会话管理 spec 假定:恢复消息 ≈ 恢复曾激活的 skill 指令
- 实施前写 plan:改 `activate_skill` / `/skill` / `always` 注入点、删除或掏空 Active 段路径、补测试

---

## 参考

- [Claude Code — Extend Claude with skills](https://code.claude.com/docs/en/skills)(激活后进入 conversation 并留在本 session)
- [Agent Skills — progressive disclosure](https://agentskills.io/home)
- [OpenAI Codex — Skills](https://developers.openai.com/codex/skills)
- [ADR-009](2026-07-06-skill-mechanism.md) · [ADR-010](2026-07-21-skill-vs-builtin-capability.md)

---

## 修订记录

| 日期 | 修订 | 来源 |
|---|---|---|
| 2026-08-17 | §3 `always` 机制废弃:`activation` 收敛两态后 `always` 按 `auto` 降级加载,按场一次性注入链路(`ensureAlwaysSkillsInjected`)删除;§5「明确不改动的部分」中 `always` frontmatter 语义一条随之失效,`enabled` 开关迁移至 `settings.skillEnabled`(持久化,Registry 加载后 `applyEnabledOverrides` 应用)。Discovery + activate_skill 写会话的核心模型不变;用户侧术语「激活」改「使用」 | [S-SKILL-UX](../superpowers/specs/2026-08-17-skill-ux-claude-aligned-design.md) |

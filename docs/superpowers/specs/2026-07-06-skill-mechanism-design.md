# Ratel Vault Skill 机制设计

> 日期: 2026-07-06
> 状态: Active
> 作者: Erwin(用户自定义指令包需求)
> 关联: docs/architecture/overview.md / 2026-07-05-i18n-v2-design.md / agentskills.io 标准

---

## 1. 背景

### 1.1 问题

当前 Ratel Vault 的 Agent 能力由三类硬编码资产决定:

- **Tools**(`src/tools/`):9 个内置工具,用户无法扩展
- **Subagents**(`src/subagents/`):Indexer / Librarian / Reviewer / Curator,代码级专用
- **Prompt sections**(`src/prompts/sections.ts`):可 override 文案,但结构固定

用户想在 vault 内定义自己的"专长领域"(如代码审查者、学术写作助手、卡片笔记整理),目前只能通过改 prompt override 间接实现,粒度粗、不结构化、不可跨 vault 复用。

### 1.2 目标

引入 **Skill** 机制,让用户通过 markdown 文件扩展 Agent 行为:

- **agentskills.io 兼容**:Ratel Vault 加载的 skill 也能在 Claude Code / Cursor / Trae / OpenAI Codex 等 30+ 客户端使用(反之亦然)
- **Progressive disclosure**:Discovery(name+description)→ Activation(读完整 SKILL.md)→ Execution(可选读 references / 跑 scripts),节省 context
- **三源合并**:预置(插件目录)+ 全局(`~/.ratel/skills/`)+ vault 内(`.ratel/skills/`),vault 内优先
- **双激活**:LLM 自动路由 + 手动 `/skill` 斜杠命令
- **完整能力**:纯指令文本 + references 只读引用 + scripts 沙箱执行
- **i18n 合规**:所有 UI 文案走 `t('skill.xxx')`,SKILL.md 内支持 `i18n.description` 多语言描述

### 1.3 非目标

- 不做 skill marketplace(从外部安装,留 v2)
- 不做 skill 之间依赖声明(`depends-on: [other-skill]`)
- 不做 skill 版本管理(由用户 git 处理)
- 不做 skill 自动更新
- 不做 hook 触发 skill(v2 考虑)
- 不做 skill 国际化翻译贡献流程(SKILL.md 的 `i18n.description` 由 skill 作者维护)

---

## 2. 设计决策(Erwin 明确要求)

| # | 决策 | 说明 |
|---|------|------|
| 1 | Skill 定位 = 用户自定义指令包 | 类 Claude Code Skills,agentskills.io 兼容 |
| 2 | 能力边界 = 指令 + references + scripts | 完整 spec,实施拆 3 个 plan 渐进落地 |
| 3 | 激活方式 = LLM 自动 + 手动斜杠 | LLM 自动路由为默认,用户 `/skill <name>` 强制激活 |
| 4 | 三源合并存储 | 预置 + 全局 + vault 内,vault 内同名覆盖 |
| 5 | scripts 沙箱 | 网络禁用、fs 限制、超时 30s、白名单、首次询问 |
| 6 | Plan 拆 3 个 | P-SKILL-1-CORE / P-SKILL-2-EXECUTION / P-SKILL-3-UI |

---

## 3. 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                         Agent Loop                              │
│                                                                │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐ │
│  │ Discovery    │  │  Activation     │  │  Execution         │ │
│  │ 注入到       │  │  activate_skill │  │  read_skill_ref    │ │
│  │ system prompt│  │  deactivate_    │  │  run_skill_script  │ │
│  │ (name+desc)  │  │  skill          │  │                    │ │
│  └──────┬───────┘  └────────┬────────┘  └─────────┬──────────┘ │
│         │                   │                     │            │
└─────────┼───────────────────┼─────────────────────┼────────────┘
          │                   │                     │
          ▼                   ▼                     ▼
┌────────────────────────────────────────────────────────────────┐
│                       Skill Layer                               │
│                                                                │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────────┐ │
│  │ SkillLoader    │  │ SkillRegistry    │  │ ScriptSandbox   │ │
│  │ 三源扫描 +     │  │ enabled/active   │  │ Node vm +       │ │
│  │ frontmatter    │  │ 状态管理         │  │ 权限白名单 +    │ │
│  │ 解析 + 合并    │  │                  │  │ 超时            │ │
│  └────────┬───────┘  └──────────────────┘  └─────────────────┘ │
│           │                                                    │
│           ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              三源文件系统(合并加载,vault 优先)         │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ 预置         │  │ 全局         │  │ vault 内     │  │   │
│  │  │ <pluginDir>/ │  │ ~/.ratel/    │  │ .ratel/      │  │   │
│  │  │ skills/      │  │ skills/      │  │ skills/      │  │   │
│  │  │ (只读)      │  │ (跨 vault)  │  │ (跟 vault)  │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. 详细设计

### 4.1 Skill 文件结构(agentskills.io 兼容)

每个 skill 是一个文件夹,至少含 `SKILL.md`:

```
my-skill/
├── SKILL.md            # 必须:metadata + instructions
├── references/         # 可选:Agent 激活后可读的参考文档
│   ├── style-guide.md
│   └── glossary.json
├── scripts/            # 可选:可执行脚本(Node.js,沙箱内)
│   └── clean-data.mjs
└── assets/             # 可选:模板、资源文件(目前不参与加载,v2)
    └── template.md
```

### 4.2 SKILL.md frontmatter

```yaml
---
name: code-reviewer         # 必填,唯一标识(kebab-case,全小写+连字符)
description: 审查代码改动    # 必填,LLM 据此判断是否激活(Discovery 注入)
version: 1.0.0              # 可选,SemVer(显示用,不参与兼容判断)
author: ratel-vault         # 可选,作者标识
enabled: true               # 可选,默认 true(可在 settings 内改)
activation: auto            # 可选:auto | manual | always,默认 auto
                            #   auto: LLM 自主决定是否激活
                            #   manual: 只能通过 /skill <name> 手动激活
                            #   always: 加载后持续激活(类似全局指令)
tags: [code, review]        # 可选,辅助分类与未来筛选
i18n:
  description:              # 可选,多语言 description
    zh: 审查代码改动
    en: Review code changes
---

# 指令正文(在 activation 时全文注入 system prompt)

你是一个代码审查者。当用户请求审查代码时:
1. 先 read_note 读完整文件
2. 按以下维度评估:
   - 可读性
   - 性能
   - 安全
3. 输出结构化反馈...
```

**字段约束**:

- `name`:正则 `^[a-z][a-z0-9-]{0,63}$`,全小写字母数字+连字符,首字母必须字母
- `description`:非空字符串,建议 ≤200 字符(避免 Discovery 段过长)
- `version`:符合 SemVer(解析失败时记 warning,不影响加载)
- `activation`:`auto` / `manual` / `always` 之一,非法值降级 `auto`

### 4.3 三源合并存储

| 源 | 路径 | 用途 | 优先级 | 写权限 |
|---|---|---|---|---|
| 预置 | `<pluginDir>/skills/` | 插件出厂自带示例 | 最低(被覆盖) | 只读 |
| 全局 | `~/.ratel/skills/` | 跨 vault 通用 skill | 中 | 用户在文件系统手动管理 |
| vault 内 | `<vaultRoot>/.ratel/skills/` | 跟随 vault git/syncthing 同步 | 最高 | 用户在文件系统手动管理 |

**合并规则**:

- 同名 skill(`name` 冲突)按优先级覆盖,后者覆盖前者
- Discovery 阶段记录来源(`source: 'builtin' | 'global' | 'vault'`),供 UI 展示
- 加载顺序:预置 → 全局 → vault 内,后者覆盖前者同名 skill 的 manifest 与正文

**安全约束**(对齐 AGENTS.md):

- vault 内 skills 严格限制在 `<vaultRoot>/.ratel/skills/` 下,禁止 path traversal(`../` 越界)
- 全局 skills 限制在 `~/.ratel/skills/` 内
- 预置 skills 限制在 `<pluginDir>/skills/` 内,只读
- 加载时解析 frontmatter 失败的 skill 记 warning,跳过加载,不阻塞其他 skill

### 4.4 Discovery(发现)

**触发时机**:

- 插件 `onload` 时扫描三源
- vault 内 `.ratel/skills/` 文件变更(去抖 500ms,复用现有 file watcher 模式)
- 全局目录扫描仅在 onload(不监听文件变更,避免跨 vault 误触发)
- 手动刷新命令:`Reload skills`(命令面板,`cmd-ratel-reload-skills`)

**Discovery 阶段只读**:

- frontmatter 的 `name` + `description` + `enabled` + `activation` + `tags`
- 不读 instructions 正文(节省 context)

**Discovery 注入 system prompt**:

新增 prompt section `agent.skills`(zone: 'dynamic', `allowOverride: false`),由 SkillRegistry 在 prompt 组装时注入:

```
## 可用 Skills

以下 skill 已加载,你可在任务需要时调用 `activate_skill(name)` 激活对应指令集。激活后该 skill 的完整指令会注入上下文,直到任务完成或你主动 deactivate。

- code-reviewer: 审查代码改动
- zettelkasten-curator: 卡片笔记整理
- academic-writer: 学术写作助手
```

**注入条件**:

- 仅当 `enableSkills: true`(settings)且存在至少 1 个 enabled skill 时注入
- 注入位置:`agent.rag.toolGuide` 之后、检索结果之前
- 超过 50 个 skill 时按 `tags` 与当前 query 关键词粗筛(简单字面量匹配,v2 再优化)

### 4.5 Activation(激活)

**a. LLM 自动路由**:

- Discovery 信息注入 system prompt(见 4.4)
- Agent Loop 接收 LLM 的特殊 tool call:`activate_skill(name)`(新工具,见 4.7)
- 激活后:
  - 读完整 SKILL.md instructions 正文
  - 作为动态 segment 追加到 system prompt(在 Discovery 段之后)
  - session 内常驻,直到 deactivate

**b. 手动斜杠命令**:

- `/skill <name>`:直接激活指定 skill(用户输入 `/` 触发现有 slash 命令机制)
- `/skills`:列出全部可用 skill(可点击激活)
- `/skill off <name>`:关闭指定 skill
- `/skills list`:同 `/skills`(显式动词形式)

**Activation 状态管理**:

- 一个 chat session 内激活的 skill 持续生效
- session 关闭时全部清空(不跨会话持久化激活态)
- `activation: 'always'` 的 skill 在 Discovery 阶段就自动激活(等效于全局指令)
- `activation: 'manual'` 的 skill 不出现在 Discovery 的"可激活"提示中,仅 `/skill <name>` 可触发

> **修订(2026-07-23):** 「持续生效」的载体改为 **写入 Session 消息**(对齐 Claude),不再用插件级 `activeSkills` + 每轮 Active 段。见 [ADR-012](../../adr/2026-07-23-skill-activation-claude-aligned.md)。`always` = 新 session 首次组上下文时写入一次;`deactivate` 见该 ADR(transcript 模型下为 supersede / best-effort)。

**激活时上下文注入示例**:

```markdown
## 当前激活的 Skill: code-reviewer

[此处插入 SKILL.md 的 instructions 正文]
```

### 4.6 Execution(执行)— 三种能力

**a. 指令文本**(纯 markdown):

- 激活后注入 system prompt,作为额外指令
- 无副作用,无安全风险
- v1 实现范围:P-SKILL-1-CORE

**b. references 引用资源**:

- Agent 通过 `read_skill_reference(skillName, path)` 工具读取
- 路径限制在 skill 文件夹的 `references/` 子目录内(防 traversal)
- 只读,不写
- v1 实现范围:P-SKILL-2-EXECUTION

**c. scripts 脚本执行**:

- `run_skill_script(skillName, scriptPath, args)` 工具
- **沙箱限制**:
  - 工作目录:skill 文件夹
  - fs 访问:仅 vault 内 + skill 文件夹(通过受限 `require('fs')` 包装)
  - 网络访问:**禁用**(AGENTS.md 约束 — 只有模型 API 能发网络)
  - 执行超时:30s(可在 settings 配置 `skillScriptTimeout`)
  - 子进程:禁止 `child_process.spawn/exec`
  - 全局对象:禁止 `globalThis.fetch` / `XMLHttpRequest`
- **权限询问**:首次运行某 script 弹 Modal 询问用户授权(类 Obsidian plugin 权限模型)
- **白名单**:用户可在 settings 加 `trustedScripts: string[]`(格式 `<skillName>/<scriptPath>`)跳过询问
- v1 实现范围:P-SKILL-2-EXECUTION

### 4.7 新增工具(Tool Registry)

| 工具名 | 类型 | readOnly | 说明 |
|---|---|---|---|
| `activate_skill` | LLM 工具 | true | 激活指定 skill,读完整 SKILL.md 注入 system prompt |
| `deactivate_skill` | LLM 工具 | true | 关闭指定 skill,从 system prompt 移除指令段 |
| `read_skill_reference` | LLM 工具 | true | 读 skill `references/` 内文件,路径限制在 skill 文件夹内 |
| `run_skill_script` | LLM 工具 | false | 执行 skill `scripts/` 内脚本(带沙箱 + 权限) |

**工具 schema**:

```ts
// activate_skill
{
  name: 'activate_skill',
  description: '激活一个已加载的 Skill。激活后该 skill 的指令会注入到上下文,直到任务完成或你主动 deactivate。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称(kebab-case)' }
    },
    required: ['name']
  }
}

// deactivate_skill
{
  name: 'deactivate_skill',
  description: '关闭一个已激活的 Skill,从上下文移除其指令。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称' }
    },
    required: ['name']
  }
}

// read_skill_reference
{
  name: 'read_skill_reference',
  description: '读取 Skill 的 references/ 目录内文件。路径限制在 skill 文件夹内。',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Skill 名称' },
      path: { type: 'string', description: 'references/ 内的相对路径' }
    },
    required: ['skillName', 'path']
  }
}

// run_skill_script
{
  name: 'run_skill_script',
  description: '执行 Skill 的 scripts/ 目录内脚本。首次运行会询问用户授权。脚本在沙箱内执行:无网络、fs 限制在 vault 与 skill 文件夹、超时 30s。',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Skill 名称' },
      scriptPath: { type: 'string', description: 'scripts/ 内的相对路径' },
      args: { type: 'array', items: { type: 'string' }, description: '传给脚本的命令行参数' }
    },
    required: ['skillName', 'scriptPath']
  }
}
```

**prompt section 注册**(`src/prompts/sections.ts` 新增):

- `tool.activate_skill.description` / `tool.activate_skill.param.name`
- `tool.deactivate_skill.description` / `tool.deactivate_skill.param.name`
- `tool.read_skill_reference.description` / `tool.read_skill_reference.param.skillName` / `tool.read_skill_reference.param.path`
- `tool.run_skill_script.description` / `tool.run_skill_script.param.skillName` / `tool.run_skill_script.param.scriptPath` / `tool.run_skill_script.param.args`

### 4.8 Context 管理与预算

**Discovery 阶段(每个 skill)**:

- `name`(~10 tokens)+ `description`(~30-50 tokens)
- 100 个 skill ≈ 4000-6000 tokens(可接受)
- 超过 50 个时按 `tags` 与当前 query 关键词粗筛

**Activation 后**:

- SKILL.md instructions 正文注入(几百到几千 tokens)
- references 按需读取(不主动全读,Agent 决定何时 `read_skill_reference`)
- chat session 内常驻,直到 deactivate

**deactivation 触发**:

- LLM 自主 `deactivate_skill(name)`(任务完成)
- 用户 `/skill off <name>` 强制
- chat 关闭时全部清空

### 4.9 UI 与 i18n

**Settings 面板**(declarative,`getSettingDefinitions` 风格,对齐 S-SETTINGS-DECLARATIVE):

新增 "Skills" group / sub-page:

- **总开关**:`enableSkills: boolean`(toggle,默认 true)
- **脚本超时**:`skillScriptTimeout: number`(slider,5-120s,默认 30)
- **可信脚本**:`trustedScripts: string[]`(render 自定义,列表 + 添加/删除)
- **Skills 总览页**(sub-page):列出所有 skill
  - 每行:`name` + 来源标签(预置/全局/vault)+ `enabled` toggle + 当前激活态(只读显示)
  - 点击进入详情:展示完整 SKILL.md(只读)、修改 `enabled` 与 `activation`、查看 references/scripts 列表

**Chat 状态显示**:

- 当前激活的 skill 在 chat 头部 chip 显示(如 `🦡 code-reviewer`)
- 触发激活时显示 brief 状态:`Activating code-reviewer...`
- 触发脚本执行时:`Running clean-data.mjs in sandbox...`
- 多 skill 激活时 chip 累加,水平滚动

**i18n**(遵循 AGENTS.md `i18n 强制规则`):

- 新增 `SkillStrings` namespace 到 `src/i18n/types.ts`
- 所有 UI 文案(标签、提示、Modal、状态)走 `t('skill.xxx')`
- `zh.ts` / `en.ts` 加对应翻译

**SkillStrings 关键 key 清单**(后续 plan 细化):

```ts
export interface SkillStrings {
  'skill.settings.title': string;              // "Skill 管理"
  'skill.settings.enableSkills': string;        // "启用 Skill 机制"
  'skill.settings.scriptTimeout': string;       // "脚本执行超时(秒)"
  'skill.settings.trustedScripts': string;      // "可信脚本白名单"
  'skill.settings.openSkillsPage': string;      // "查看所有 Skill"
  'skill.skillList.title': string;              // "已加载的 Skill"
  'skill.skillList.empty': string;              // "暂无已加载的 Skill"
  'skill.skillList.column.name': string;        // "名称"
  'skill.skillList.column.source': string;      // "来源"
  'skill.skillList.column.enabled': string;     // "启用"
  'skill.skillList.column.active': string;      // "当前激活"
  'skill.source.builtin': string;              // "预置"
  'skill.source.global': string;               // "全局"
  'skill.source.vault': string;                // "vault 内"
  'skill.activation.auto': string;             // "自动"
  'skill.activation.manual': string;           // "手动"
  'skill.activation.always': string;           // "常驻"
  'skill.notice.activating': string;           // "正在激活 {name}..."
  'skill.notice.activated': string;            // "已激活 {name}"
  'skill.notice.deactivated': string;           // "已关闭 {name}"
  'skill.notice.notFound': string;             // "未找到 Skill: {name}"
  'skill.notice.alreadyActive': string;         // "{name} 已激活"
  'skill.notice.reloadDone': string;            // "已重新加载 {count} 个 Skill"
  'skill.cmd.skill': string;                   // "激活 Skill"
  'skill.cmd.skills': string;                  // "列出 Skill"
  'skill.cmd.reloadSkills': string;            // "重新加载 Skill"
  'skill.modal.scriptPermission.title': string; // "执行 Skill 脚本"
  'skill.modal.scriptPermission.body': string; // "Skill {skillName} 请求执行脚本 {scriptPath},是否允许?"
  'skill.modal.scriptPermission.trust': string;// "信任此脚本(加入白名单)"
  // ...
}
```

### 4.10 模块结构(预想)

```
src/
  skills/
    types.ts                    # Skill, SkillManifest, SkillSource 类型
    skill-loader.ts             # 三源扫描 + frontmatter 解析 + 合并
    skill-registry.ts          # 内存注册表(enabled/disabled/active 状态)
    skill-activator.ts         # 激活/反激活逻辑,注入 system prompt
    skill-script-sandbox.ts    # 脚本执行沙箱(Node vm + restricted require)
    skill-script-permission.ts # 权限询问 + 白名单
  ports/
    skill-port.ts              # SkillPort 接口(零实现,符合现有架构)
  adapters/
    skill-vault.ts             # ObsidianVault 适配器,读 vault 内 skills
    skill-fs.ts                # 全局 + 预置 skills 文件系统适配器(Node fs)
  tools/
    activate-skill.ts          # activate_skill 工具实现
    deactivate-skill.ts        # deactivate_skill 工具实现
    read-skill-reference.ts   # read_skill_reference 工具
    run-skill-script.ts       # run_skill_script 工具
  prompts/sections.ts          # 加 agent.skills section + 4 个工具 section
  i18n/types.ts                # 加 SkillStrings namespace
  i18n/zh.ts, en.ts            # 加 skill.* 翻译
  settings.ts                  # 加 enableSkills, skillScriptTimeout, trustedScripts
```

### 4.11 与现有架构的关系

| 现有 | 关系 |
|---|---|
| `prompts/sections.ts` | 新增 `agent.skills` section(zone: 'dynamic', `allowOverride: false`)+ 4 个工具 section |
| `prompts/composer.ts` | 加 `composeSkillsDiscovery(registry)` 与 `composeActiveSkills(registry)` 函数,在 system prompt 拼装时注入 |
| `core/tool-registry.ts` | 注册 4 个新工具 |
| `core/agent-loop.ts` | 处理 `activate_skill` / `deactivate_skill` tool call 后,触发 system prompt 重组(类似 RAG 注入检索结果) |
| `tools/` | 加 4 个新工具,均通过 ToolRegistry 注册 |
| `subagents/` | 不冲突 — skill 是横向扩展(任意 Agent 可激活),subagent 是纵向专用(特定任务专用 worker) |
| `hooks/` | 不冲突 — skill 可触发 hook(但 v1 不实现 hook 监听 skill 激活) |
| `i18n` | 加 `SkillStrings` namespace,遵循 S-I18N-V2 扩展性约束 |
| `settings.ts` | 加 `enableSkills: boolean`、`skillScriptTimeout: number`、`trustedScripts: string[]` 字段 |
| `adapters/obsidian-vault.ts` | 加 `readSkillManifest(source, name)`、`readSkillReference(skillName, path)` 方法 |
| `main.ts` | `onload` 时初始化 SkillLoader + SkillRegistry,注册 4 个工具,监听 `.ratel/skills/` 文件变更 |

---

## 5. Plan 拆分

实施时拆 3 个 plan,依赖清晰:

### 5.1 P-SKILL-1-CORE(基础 + 激活)

**范围**:

- `src/skills/types.ts` — 类型定义
- `src/skills/skill-loader.ts` — 三源扫描 + frontmatter 解析 + 合并
- `src/skills/skill-registry.ts` — 内存注册表
- `src/skills/skill-activator.ts` — 激活/反激活逻辑
- `src/ports/skill-port.ts` — SkillPort 接口
- `src/adapters/skill-vault.ts` — vault 内 + ObsidianVault 适配
- `src/adapters/skill-fs.ts` — 全局 + 预置 fs 适配
- `src/tools/activate-skill.ts` — activate_skill 工具
- `src/tools/deactivate-skill.ts` — deactivate_skill 工具
- `src/prompts/sections.ts` — 加 `agent.skills` section + 2 个工具 section
- `src/prompts/composer.ts` — discovery 与激活段注入
- `src/core/agent-loop.ts` — 处理 activate/deactivate tool call
- `src/main.ts` — onload 初始化
- `src/settings.ts` — 加 `enableSkills` 字段
- `src/ui/chat/slash-commands.ts` — 加 `/skill` / `/skills` / `/skill off`
- `src/i18n/types.ts` + `zh.ts` + `en.ts` — SkillStrings 基础 key
- 单元测试:loader / registry / activator / 工具

**依赖**:无

**风险**:低(纯指令注入,无副作用)

**验收**:

- 用户在 `.ratel/skills/code-reviewer/SKILL.md` 创建 skill
- 重启 Obsidian 或运行 `Reload skills` 命令后,Discovery 段出现在 system prompt
- LLM 调用 `activate_skill('code-reviewer')`,SKILL.md 指令注入,Agent 行为按指令改变
- `/skill code-reviewer` 手动激活同样生效
- `/skill off code-reviewer` 关闭

### 5.2 P-SKILL-2-EXECUTION(references + scripts)

**范围**:

- `src/skills/skill-script-sandbox.ts` — Node vm 沙箱
- `src/skills/skill-script-permission.ts` — 权限询问 + 白名单
- `src/tools/read-skill-reference.ts` — read_skill_reference 工具
- `src/tools/run-skill-script.ts` — run_skill_script 工具
- `src/prompts/sections.ts` — 加 2 个工具 section
- `src/settings.ts` — 加 `skillScriptTimeout`、`trustedScripts` 字段
- `src/ui/settings/` — 权限询问 Modal
- `src/i18n/` — 加执行相关 key
- 单元测试:沙箱安全限制 / 权限流程 / 工具

**依赖**:P-SKILL-1-CORE

**风险**:高(沙箱安全需谨慎设计,需全面测试 fs 限制、网络禁用、超时、子进程禁止)

**验收**:

- Agent 可调用 `read_skill_reference('code-reviewer', 'style-guide.md')` 读取 references 内文件
- Agent 可调用 `run_skill_script('data-cleaner', 'clean.mjs', ['--input', 'data.json'])` 执行脚本
- 脚本内 `fetch('https://...')` 抛错(网络禁用)
- 脚本内 `fs.readFile('../secret')` 抛错(path traversal)
- 脚本执行超 30s 自动终止
- 首次运行弹 Modal,用户拒绝则不执行
- 加入白名单后下次直接执行

### 5.3 P-SKILL-3-UI(settings 面板 + chat 状态)

**范围**:

- `src/ui/settings/skills-setting-page.ts` — Skills 总览 + 详情 sub-page
- `src/ui/settings/skills-trusted-scripts-render.ts` — 白名单 render
- `src/ui/chat/` — 激活状态 chip 显示
- `src/settings.ts` — Skills group / sub-page 注册
- `src/i18n/` — 加 UI 相关 key
- 预置示例 skills(放 `<pluginDir>/skills/`)
- 单元测试:settings 渲染 / 状态显示

**依赖**:P-SKILL-1-CORE(P-SKILL-2-EXECUTION 可并行,UI 不阻塞执行能力)

**风险**:中(UI 与现有 settings 集成,需对齐 S-SETTINGS-DECLARATIVE 模式)

**验收**:

- settings 面板有 "Skills" group,点开总览页列出所有 skill
- 每个 skill 可 toggle `enabled`,可改 `activation`
- 白名单 render 可添加/删除条目
- chat 头部显示当前激活的 skill chip
- 预置示例 skill(`ratel-default-skills/code-reviewer` 等)开箱可用

---

## 6. 影响面

### 6.1 新增文件

- `src/skills/` 整个目录(6 个文件)
- `src/ports/skill-port.ts`
- `src/adapters/skill-vault.ts`、`src/adapters/skill-fs.ts`
- `src/tools/activate-skill.ts`、`src/tools/deactivate-skill.ts`、`src/tools/read-skill-reference.ts`、`src/tools/run-skill-script.ts`
- `src/ui/settings/skills-setting-page.ts`、`src/ui/settings/skills-trusted-scripts-render.ts`
- 测试文件若干

### 6.2 修改文件

- `src/prompts/sections.ts` — 加 `agent.skills` section + 4 个工具 section
- `src/prompts/composer.ts` — 加 skill 段注入函数
- `src/prompts/types.ts` — 加 `PromptSectionId` 新值
- `src/prompts/defaults/zh.ts` — 加默认文案
- `src/core/agent-loop.ts` — 处理 activate/deactivate tool call
- `src/main.ts` — onload 初始化 + 文件监听
- `src/settings.ts` — 加 `enableSkills` / `skillScriptTimeout` / `trustedScripts` 字段
- `src/ui/chat/slash-commands.ts` — 加 `/skill` / `/skills` / `/skill off`
- `src/ui/chat/`(ChatView.svelte 等)— 激活状态 chip
- `src/i18n/types.ts`、`zh.ts`、`en.ts` — 加 SkillStrings

### 6.3 文档同步(对齐 AGENTS.md `文档同步规则`)

**触发条件评估**(在 finishing-a-development-branch 阶段执行):

- **README**:需要更新(新增 skill 创建与使用说明,作为功能亮点)
- **user-guide**:需要更新(斜杠命令 `/skill` / `/skills` / `/skill off` / `Reload skills` + skill 编写指南)
- **CHANGELOG**:由 release 工作流处理
- **ARCHITECTURE.md**:需要更新(新增 `skills/` 子系统目录 + 跨线程通信无变化但新增 Skill 注入 system prompt 的数据流)
- **adr/**:可能新增 ADR(若 skill 沙箱用 Node vm 的决策非显然)

### 6.4 依赖

- 无新增 npm 依赖
- 复用现有:`gray-matter`(frontmatter 解析,如已在 dependencies 则复用,否则加)、`svelte/store`、Node `vm` 模块、`os.homedir()`

### 6.5 测试

- 单元测试:loader / registry / activator / sandbox / 4 个工具
- 集成测试:Discovery 注入 system prompt / Activation 触发 prompt 重组
- 安全测试:沙箱逃逸尝试(网络、fs traversal、子进程、超时)

### 6.6 性能

- Discovery 扫描在 onload 异步执行,不阻塞 Obsidian 启动
- 三源合并后内存常驻 manifest(每个 skill ~1KB,100 个 = 100KB,可接受)
- 文件变更去抖 500ms,避免频繁重载
- 脚本执行在主线程之外(用 InlineWorker 模式或 child_process 隔离,具体在 P-SKILL-2 决策)

### 6.7 安全

- **指令注入风险**:SKILL.md 内容是用户自定义,视为可信指令(用户自己写的);从外部安装的 skill 首次激活时提示(预置 + 全局 + vault 内用户自创的视为可信)
- **references 读取**:路径严格限制在 skill 文件夹内,防 traversal
- **scripts 执行**:沙箱隔离,网络禁用,fs 限制,超时,白名单,首次询问
- **跨 vault 同步**:用户自己 git/syncthing,插件不强制

---

## 7. 安全模型总结

| 能力 | 风险 | 缓解 |
|---|---|---|
| 指令文本(SKILL.md instructions) | prompt injection(用户自创视为可信) | 外部 skill 首次激活提示 |
| references 读取 | path traversal | 路径限制在 skill 文件夹内,严格校验 |
| scripts 执行 | 任意代码执行 | 沙箱:网络禁用、fs 限制、超时、子进程禁止、白名单、首次询问 |

---

## 8. 参考

- [Agent Skills 标准](https://agentskills.io/home) — agentskills.io 开放规范
- [Claude Code Skills](https://docs.claude.com/en/docs/claude-code/skills) — Anthropic Claude Code 的 skill 机制
- AGENTS.md `i18n 强制规则(mandatory)` — 所有新增 UI 字符串必须走 i18n
- [S-I18N-V2](2026-07-05-i18n-v2-design.md) — i18n V2 设计,新增 SkillStrings namespace 遵循其扩展性约束
- [S-SETTINGS-DECLARATIVE](../archive/S-SETTINGS-DECLARATIVE/) — settings 面板用 `getSettingDefinitions` 声明式 API(已归档,作为参考)
- AGENTS.md `架构` 章节 — 端口/适配器模式,所有 fs 访问通过 ObsidianVault 外观

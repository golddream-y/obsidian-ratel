# S-CFG-01/02 — open_note 工具与内置配置 Skill 设计

> **状态:** Active
>
> **日期:** 2026-08-16
>
> **类型:** Feature Spec
>
> **关联:** [PRD](../../../PRD.md) CFG-01 / CFG-02、[ADR-006](../../adr/2026-07-27-embedding-worker-inline.md)(内联分发先例)、S-SKILL-1-CORE(三源 Skill 机制)

## 1. 背景

Ratel 0.2.4 已具备完整工具链与 Skill 机制,但存在两个体验缺口:

1. **对话中无法打开笔记(CFG-02):** Agent 检索到笔记后只能在对话里贴内容,用户说「打开这篇」时无能为力。Obsidian 原生 `Workspace.openLinkText()` 支持 `笔记#标题` 与 `笔记#^blockId` 锚点定位,可直接复用。
2. **配置门槛高(CFG-01):** 新用户面对 5 个设置 Tab 不知道从哪配起;模型/密钥/索引/诊断的排查流程全靠用户翻 user-guide。PRD 要求内置「应用配置」Skill,让模型自助引导用户完成配置。

同时存在一个**工程矛盾**:builtin skill 源是 `pluginDir/skills/`,但商店 release 只有 main.js + manifest.json + styles.css 三文件(ADR-006),装完后该目录为空,内置 skill 实际无法分发。

## 2. 目标

1. 新增 `open_note` 工具:Agent 可在 Obsidian 中为用户打开笔记并定位到标题/块。
2. 新增 `ratel-config` 内置 Skill + 3 个配套工具(`get_app_config` / `update_app_config` / `open_settings`):模型能读取配置现状、在白名单内代改、打开设置页定位。
3. 解决 builtin skill 分发矛盾:构建时内联 SKILL.md,启动时幂等写出到 `pluginDir/skills/`,版本号与应用版本一致。
4. 抽取共享的设置应用模块,消除 SettingTab 与工具双写漂移隐患。

## 3. 非目标

- 不支持行号定位(官方不支持 `#L42` 语法,且阅读视图无 editor;标题/块 ID 已覆盖主流场景)。
- 不允许模型改工具权限、MCP 配置、prompt 覆盖、API Key(安全红线,见 §7)。
- 不做配置 Skill 的多语言正文(prompt 不走 i18n,遵循现有约定)。
- 不改动商店三文件发布约束。

## 4. 详细设计

### 4.1 WorkspacePort 扩展

`src/ports/workspace.ts` 语义从「活动上下文」扩展为「工作区 UI 操作」:

```typescript
export interface WorkspacePort {
	getActiveFilePath(): string | null;
	getActiveSelection(): string | null;
	/** 打开笔记并滚动定位到锚点(标题或块 ID);linktext 语法同 wikilink */
	openNote(linktext: string): Promise<boolean>;
	/** 打开 Ratel 设置面板并定位到指定 tab;省略 tab 打开默认 tab */
	openPluginSettings(tab?: string): Promise<boolean>;
}
```

`src/adapters/obsidian-workspace.ts` 实现:

- `openNote`:`app.workspace.openLinkText(linktext, '', false)` — 复用当前 tab,与点击双链行为一致。锚点语法 `path#标题` / `path#^blockId` 由 Obsidian 原生处理(含阅读视图滚动)。
- `openPluginSettings`:`app.setting.open()` → `app.setting.openTabById('ratel-vault')`;Plugin 在 `addSettingTab` 时保存 SettingTab 实例引用,`openPluginSettings` 直接调用实例的 `focusTab(tab)` 公有方法(SettingTab 设置 activeSettingsTab 后 `refreshDomState()` 切换内容区)。

### 4.2 open_note 工具

`src/tools/open-note.ts`:

- **参数:** `path`(必填,vault 相对路径,可省略 `.md` 扩展名)+ `anchor`(可选,裸标题名或 `^blockId` 前缀块 ID)。
- **流程:** 先 `vault.fileExists()`(可省略 `.md` 时归一化后验证)→ 不存在返回降级提示(建议改用 search_vault / glob 定位),不抛错;存在则拼 linktext 调 `workspace.openNote()`。
- **权限:** `readOnly: true`(纯 UI 导航,不写任何文件),默认 `allow`。

### 4.3 Builtin Skill 内联分发

**源码位置:** `src/skills/builtin/ratel-config/SKILL.md`(frontmatter 不写死 version)。

**构建内联:** `esbuild.config.mjs` 新增 `inlineBuiltinSkillsPlugin`(仿 `inlineEmbeddingWorkerPlugin`):

- esbuild virtual module `@ratel/builtin-skills-code`,内容为 `src/skills/builtin/**/SKILL.md` 的 JSON 清单(**skill 目录名 → 文件全文**,如 `ratel-config` → SKILL.md 内容),构建期注入 main.js。
- 同时把 `manifest.json` 的 `version` 作为常量注入(供写出时写进 frontmatter)。

**启动写出:** `src/skills/builtin-writer.ts`:

```typescript
export function syncBuiltinSkills(
	skillsDir: string,          // pluginDir/skills
	builtinSkills: Record<string, string>,  // skill 目录名 → SKILL.md 原文,写出到 <skillsDir>/<目录名>/SKILL.md
	appVersion: string,
): { written: string[]; skipped: string[] };
```

- onload 时(reloadSkills 之前)执行,幂等:
  - 磁盘不存在 SKILL.md 或 frontmatter `version` ≠ 应用版本 → 解析原文、注入/覆盖 `version: <应用版本>`、写出;
  - version 相同 → 跳过,零 IO 差异。
- 用户在 vault 源放同名 skill 可覆盖内置版(三源合并既有行为,vault > builtin)。

### 4.4 ratel-config Skill 内容

`SKILL.md` frontmatter:`name: ratel-config`、`description`(Discovery 段,说明何时激活:用户问配置/模型/密钥/索引/诊断问题时)、`activation: auto`、`tags: [config]`。

正文(中文,LLM 收到的 prompt 不走 i18n)教 LLM 固定流程:

1. 先调 `get_app_config` 看现状(配置快照 + 密钥配置状态 + 索引状态)。
2. 诊断问题,给出方案;能代改的在白名单内 → 征得用户同意后调 `update_app_config`。
3. 白名单外(工具权限、MCP、prompt 覆盖)→ 调 `open_settings` 定位 + 文字引导手动改。
4. API Key 一律不代改:引导用户去 Obsidian 设置 → 钥匙串,secret ID 以 `get_app_config` 返回的 `requiredSecretId` 为准(不硬编码映射表)。
5. 红线写死:绝不尝试修改工具权限、MCP 配置、prompt 覆盖;绝不向用户索要或展示 API Key 明文。

### 4.5 配套 3 工具

| 工具 | 权限 | readOnly | 参数 | 返回 |
|---|---|---|---|---|
| `get_app_config` | allow | true | 无 | 脱敏配置快照 + `hasChatApiKey` 等 boolean + 索引状态(已索引文件数 / 队列待处理数 / indexPaused) |
| `update_app_config` | ask | false | `updates: Record<string, unknown>` | 每个 key 的应用结果(成功/拒绝原因) |
| `open_settings` | allow | true | `tab: chat\|index\|agent\|appearance\|advanced` | 打开结果 |

**脱敏规则(get_app_config):** API Key 一律只返回 boolean 存在性(`hasChatApiKey` / `hasEmbedApiKey` / `hasRerankApiKey`),绝不返回值或前缀;同时返回**当前 provider 所需的 secret ID**(复用现有 `resolveChatSecretId` / `resolveEmbedSecretId` 计算,如 DeepSeek/OpenAI 兼容端点 → `ratel-chat-openai-compatible`),LLM 无需记忆映射表;其余配置项为非敏感偏好,原样返回。

**共享设置应用模块(关键架构决定):** 现有设置写入副作用(chatModel→rebuildLLM、embed*→rebuildEmbeddingAdapter、language→applyLangPreference、contextLengthPreset→同步 maxTokens、chatPreset 多字段、嵌套 key 分发)散在 `RatelVaultSettingTab.setControlValue`。抽成 `src/settings/settings-apply.ts`:

```typescript
export function applySettingValue(
	plugin: RatelVaultPlugin,
	key: string,
	value: unknown,
): void;
```

SettingTab 的 `setControlValue` 改为调用该函数(保留 saveSettings + update 收尾),`update_app_config` 工具走同一函数。两处逻辑永不漂移(这正是「改 preset 抽屉长度不变」这类 bug 的根源预防)。

**白名单(update_app_config):**

```
chatModel, chatApiBase, contextLengthPreset, chatModelMaxTokens, autoCompactEnabled,
chunkSize, chunkOverlap, autoIndex, indexPaused,
embedProvider, embedApiBase, embedApiModel, embedApiDimensions,
rerankerApiBase, rerankerModel,
memoryEnabled, memoryAutoWrite, memoryStorageLimitMB, memoryInjectLimitKB,
memoryDynamicLimitKB, memoryContextTotalLimitKB,
enableSkills, dailyNoteFolder, dailyNoteFormat,
language, uiColorScheme, uiAccent, chatNavRailEnabled, chatNavRailSide, chatMotionEnabled
```

白名单外 key(toolPermissions、mcpServers、mcpApprovedSpawns、promptOverrides、chatPreset、debugLog、agentMaxSteps、modelRegistryUrl、secret 相关)一律拒绝,返回结构化错误指明「该项需手动修改」与设置面板位置。

**值校验:** 白名单内 key 仍走类型/枚举校验(dropdown 枚举、number 范围),非法值拒绝并返回原因,复用 settings-apply 内的校验逻辑。

### 4.6 i18n 与权限注册

- 4 个工具的 `ui.tool_name.*`(friendly name,format-tool-display 用)进 zh.ts/en.ts。
- tool schema description 走 `prompts/sections.ts`(LLM 看的描述,中英两份)。
- `DEFAULT_SETTINGS.toolPermissions` 补 4 项:`open_note: 'allow'`、`get_app_config: 'allow'`、`update_app_config: 'ask'`、`open_settings: 'allow'`。
- 工具执行的用户可见错误(路径不存在降级提示、白名单拒绝提示)走 i18n;面向开发者的 throw 用中文。
- settings.ts 的 toolPermissions label map 补 4 个 key。

## 5. 数据流

```
用户:「帮我配模型」
  → Discovery 注入 ratel-config skill(auto 激活,LLM 判断相关)
  → LLM 调 get_app_config
      → 返回脱敏快照 + hasChatApiKey:false
  → LLM:「当前用 DeepSeek 预设但没配密钥,去 Obsidian 设置 → 钥匙串加 ratel-chat-openai-compatible」
  → LLM 调 open_settings(tab: chat)
  → 用户手动加 Key 后回来说「好了」
  → LLM 调 get_app_config 复查 → hasChatApiKey:true → 引导测试一条消息

用户:「打开那篇读书笔记」
  → LLM 调 search/glob 定位 → open_note(path, anchor)
  → Obsidian 打开笔记,滚动到标题/块
```

## 6. 错误处理

- **open_note 文件不存在:** 返回结构化降级提示(含建议的替代工具),不抛错,Agent 可自行改用检索工具定位。
- **open_note anchor 无效:** Obsidian 原生行为是打开文件不滚动;工具层面不预校验 anchor 存在性(避免重复读文件),返回成功即可。
- **update_app_config 白名单外 key:** 单 key 拒绝不影响同批次其他 key;整个调用在权限系统(ask)确认后才执行。
- **update_app_config 值非法:** 枚举/范围校验失败,该 key 拒绝并返回原因,其余 key 照常应用。
- **builtin skill 写出失败(磁盘只读等):** devLogger 记 warning,不阻塞启动;skill 只是不能覆盖升级,vault/global 源照常加载。
- **open_settings 非法 tab:** 工具层枚举校验(chat/index/agent/appearance/advanced 之外拒绝),非法值返回降级提示;省略 tab 打开默认 tab。
- **openPluginSettings 失败:** 返回 false,工具层返回提示让用户手动打开设置。

## 7. 安全与隐私

- `update_app_config` 权限 `ask`:每次批量代改走现有 Write Gate 用户确认,确认 UI 展示完整 key=value 变更清单。
- **模型不能给自己提权:** toolPermissions、toolPermissionLevel、mcpServers、mcpApprovedSpawns、promptOverrides 永不在白名单,源码层硬编码,不可通过配置扩展。
- **密钥零暴露:** get_app_config 只返回 boolean 存在性;update_app_config 白名单不含任何 secret 写入路径;Skill 正文明令禁止索要/展示密钥明文。
- **open_note 只读导航:** 不写文件、不越权打开 vault 外路径(路径校验沿用现有 vault 边界规则)。

## 8. 影响面

| 文件 | 变更 |
|---|---|
| `src/ports/workspace.ts` | +openNote / openPluginSettings 方法 |
| `src/adapters/obsidian-workspace.ts` | 实现两个新方法 |
| `src/tools/open-note.ts` | 新增 |
| `src/tools/get-app-config.ts` | 新增 |
| `src/tools/update-app-config.ts` | 新增 |
| `src/tools/open-settings.ts` | 新增 |
| `src/settings/settings-apply.ts` | 新增(从 SettingTab 抽取) |
| `src/settings.ts` | setControlValue 改调 settings-apply;toolPermissions 默认值与 label map 补 4 项 |
| `src/skills/builtin/ratel-config/SKILL.md` | 新增 |
| `src/skills/builtin-writer.ts` | 新增(幂等写出) |
| `esbuild.config.mjs` | +inlineBuiltinSkillsPlugin |
| `src/main.ts` | 注册 4 工具、onload 调 syncBuiltinSkills、保存 SettingTab 引用 |
| `src/i18n/zh.ts` / `en.ts` | 工具友好名、错误提示 |
| `src/prompts/sections.ts` | 4 个工具 schema description |

不触发架构文档/ADR(无模块边界变更,esbuild 插件沿用既有内联模式)。

## 9. 测试策略

- **open-note:** 路径归一化(带/不带 .md)、anchor 拼接(标题/块 ID)、文件不存在降级、权限 readOnly 标记。
- **update-app-config:** 白名单 key 应用成功、白名单外拒绝、枚举非法值拒绝、批量部分成功、副作用触发(rebuildLLM mock)。
- **settings-apply:** 嵌套 key 分发、chatPreset 多字段、contextLengthPreset 同步 maxTokens、language 触发 applyLangPreference。
- **builtin-writer:** version 不同重写、相同跳过、frontmatter version 注入、损坏 SKILL.md 降级。
- **obsidian-workspace adapter:** openNote/openPluginSettings 的 Obsidian API 调用(mock app)。

## 10. 参考

- Obsidian `Workspace.openLinkText` 官方 API(锚点语法同 wikilink)
- [Advanced URI 插件](https://github.com/Vinzent03/obsidian-advanced-uri)(行号定位需组合 API,本设计不采用)
- [S-SKILL-1-CORE](../STATUS.md)(三源 Skill 机制)

# S-CHAT-PROFILES — 多套对话模型配置与切换

> 日期: 2026-09-24
> 状态: Active
> Spec ID: **S-CHAT-PROFILES**
> 关联: [chat-preset](../../../src/settings/chat-preset.ts)、[ratel-secrets](../../../src/secrets/ratel-secrets.ts)、[ADR-007](../../adr/2026-06-28-model-context-window-registry.md)（窗口上限）、S-CONTEXT-ACCURACY（上下文真值，另 spec）

---

## 1. 背景

对话模型只有一份配置：预设 + 模型 + API Base + 一个钥匙串密钥。换模型就是覆盖当前这份，旧配置不保留。用户要在 DeepSeek、本地 Ollama、另一个兼容端点之间来回切时，每次都要重填 Base、模型和密钥。

嵌入和重排不在本 spec。它们仍各一份。

## 2. 目标

1. 用户可以保存多套对话配置，每套含名称、API Base、模型、上下文上限，以及自己的密钥。
2. 切换是显式动作：选中一套，当前对话配置换成它，不发请求。切换后发送走这套的密钥。
3. 当前这套仍是默认。新装时只有一套默认（DeepSeek），行为与现网一致。
4. 密钥仍只进 Obsidian 钥匙串，不写 `data.json`，不进对话。
5. 切换模型时按映射表更新上下文上限；查不到就明确提示，不沿用旧值（与 S-CONTEXT-ACCURACY 共用这一步）。

## 3. 非目标

- 不做嵌入 / 重排的多套配置。
- 不做按场景自动选模型（日记用 A、检索用 B）。
- 不在聊天输入区再加一个模型切换器；切换在设置里。
- 不把密钥写进 `data.json` 或任何可同步文件。
- 不动 `update_app_config` 白名单语义：配置切换不交给对话工具代做（见 5.4）。

## 4. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| CP-01 | 可增删多套对话配置 | 新增一套不影响当前；删除当前这套时先要求切走 |
| CP-02 | 每套独立密钥 | 切到 A 用 A 的密钥，切回 B 用 B 的；不串 |
| CP-03 | 切换不改历史会话 | 已发出的消息和已算的 token 不回填 |
| CP-04 | 切换后探测用当前这套 | 探测按钮读当前选中配置的 Base/模型/密钥 |
| CP-05 | 旧库升级不丢配置 | 只有一份旧配置时，自动成为唯一一套，密钥沿用现有槽位 |
| CP-06 | 对话工具不能代切 | `update_app_config` 不含切换动作；改模型仍只能改当前这套的字段 |
| CP-07 | 可另存当前配置为新一套 | 另存后两套各自独立，密钥复制到新槽位，不共用 |

## 5. 详细设计

### 5.1 数据形态

新增 `chatProfiles`：数组，每项 `{ id, name, apiBase, model, contextLengthPreset, chatModelMaxTokens }`。`id` 稳定（创建时生成，改名不改 id）。现有 `chatModel` / `chatApiBase` / `contextLengthPreset` / `chatModelMaxTokens` 保留为「当前这套」的展开字段，读取路径不变；`chatProfiles` 里 `activeChatProfileId` 指向当前这套。

升级：旧库没有 `chatProfiles` 时，用现有四个字段合成一套默认（名称为当前预设名），`activeChatProfileId` 指向它，密钥沿用现有 `ratel-chat-openai-compatible` 槽位。

### 5.2 密钥

每套的密钥按 `ratel-chat-profile-<id>` 存进钥匙串。当前这套的密钥解析顺序：先读 `ratel-chat-profile-<activeId>`，没有则回退到旧的 `ratel-chat-openai-compatible`（兼容升级）。`resolveChatApiKey` 增加按当前 active profile 解析的路径；`hasChatApiKey` 同步。删除一套时删除它的钥匙串项。密钥值永不进 `data.json`，也永不作为工具参数或对话内容出现。

钥匙串写入用 `app.secretStorage.setSecret(id, value)`，删除用 `deleteSecret(id)`。设置面板在「已保存的配置」每套行内提供一个密钥输入框（password 类型），保存时写钥匙串，不回显。

### 5.3 切换

设置 → 对话模型 顶部加「已保存的配置」列表：每套一行（名称、模型、Base），当前这套有标记。操作：设为当前、改名、删除。点「设为当前」把该套字段写入当前四个字段并保存；不发请求。改名只改 `name`，不动 id 和密钥。删除当前这套时禁用，提示先切到另一套。

新增一套：在列表底部「把当前配置存为一套」。读取当前四个字段生成新 id 写入 `chatProfiles`；当前这套的密钥（无论来自旧槽位还是已有 profile 槽位）复制一份到新 id 的钥匙串项。这样「另存」之后两套各自独立，不会共用一把密钥。

### 5.4 与对话工具的关系

`update_app_config` 白名单仍只含当前这套的字段（`chatModel`、`chatApiBase`、`contextLengthPreset`、`chatModelMaxTokens`）。不新增「切换配置」动作；切换是用户在设置里的显式操作。这样对话不会替用户换到另一把密钥。

### 5.5 上限跟随

切换或保存一套时，用映射表查该模型的窗口：查到就写入这套的 `contextLengthPreset` / `chatModelMaxTokens`；查不到则保留该套已有值，并在切换后给一次 Notice「未查到该模型窗口，沿用 X tokens」。这一步与 S-CONTEXT-ACCURACY 的「换模型更新上限」是同一段逻辑，两处共用。

## 6. 影响面

| 区域 | 变化 |
|---|---|
| `src/settings.ts` | `chatProfiles` / `activeChatProfileId` 字段、默认值、升级合成、设置 UI 列表 |
| `src/settings/chat-preset.ts` | 预设仍写当前这套；不直接管 profiles |
| `src/secrets/ratel-secrets.ts` | 按 profile 解析密钥 + 旧槽位回退 + 删除清理 |
| `src/ui/settings/` | 对话模型页加已保存配置列表 |
| `src/i18n` | 列表、按钮、Notice 文案 zh/en |
| `src/settings/config-whitelist.ts` | 不加切换动作；`chatProfiles` / `activeChatProfileId` 列入永不白名单 |
| 测试 | 升级合成、密钥解析顺序、删除当前禁用、上限跟随 |

## 7. 参考

- [ADR-007](../../adr/2026-06-28-model-context-window-registry.md)
- 现网预设：`src/settings/chat-preset.ts`
- 现网密钥：`src/secrets/ratel-secrets.ts`

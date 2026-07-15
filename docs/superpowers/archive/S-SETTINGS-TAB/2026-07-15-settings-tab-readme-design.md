# 设置页 Tab 改版 + README 产品介绍增强

> 日期: 2026-07-15  
> 状态: Active  
> Spec ID: **S-SETTINGS-TAB**  
> 关联: 商店设置体验反馈；声明式 `getSettingDefinitions`（Obsidian 1.13+）；诊断页已有 `createTabBar`

---

## 1. 背景

当前 Ratel 设置页约 13 个 group **平铺**：工具权限近 20 个下拉、钥匙串指引埋在 Advanced、Chat / Context / Registry 割裂。新用户难在一屏内完成「能对话」。

同时商店 / GitHub README 虽有安装与卖点，但**场景叙事弱、特性列表偏薄**，产品能力（环境感知、记忆、Skill、权限等）介绍不够。

诊断子页已有成熟的 **Embedding / LLM / Rerank Tab 栏**（`createTabBar`）；用户明确不要「Diagnostics 那种再点一层 page」的入口感，而要**打开 Ratel 设置即见顶栏 Tab**。

## 2. 目标

1. 设置根布局改为 **4 个顶栏 Tab**，名实与内容对齐  
2. **对话模型** Tab 提供场景预设 + 钥匙串状态前置，降低首次配置成本  
3. **默认对话模型**改为 `deepseek-v4-flash`（`DEFAULT_SETTINGS`、DeepSeek 预设、placeholder、相关用户文档）  
4. README 中英改为 **场景叙事 + 精简特性列表**（安装仍仅商店）  
5. 继续满足商店 checker：不恢复 deprecated `PluginSettingTab.display()`；`getSettingDefinitions()` 非空  

## 3. 非目标

- 在设置里提供 API Key 输入框（仍走 Obsidian 钥匙串）  
- 自定义脱离声明式的整页 `PluginSettingTab.display()` 重写（禁止）  
- 合并 / 删除 Memory、Skill、Prompt 等产品能力（只搬家与降噪）  
- 大改 Prompt overrides 编辑器交互  
- 本轮不发版商店审核文案以外的架构 ADR（除非实现时发现必须）

---

## 4. 设计决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 真 Tab，非 page 入口 | 复用 `createTabBar`；打开 Ratel 设置即见顶栏 |
| 2 | 按内容归栏命名 | 不用「基础/Agent」黑话；用「对话模型 / 笔记索引 / 记忆与权限 / 高级」 |
| 3 | 声明式宿主 + 命令式 Tab 内容 | `getSettingDefinitions` 提供可搜索/合规定义；根用自定义 `render` 挂 Tab；各 Tab 内可用 `new Setting` 或现有 control 路径 |
| 4 | 场景预设落盘 | `chatPreset: 'deepseek' \| 'ollama' \| 'custom'` |
| 5 | 默认模型 | `chatModel` 默认与 DeepSeek 预设均为 **`deepseek-v4-flash`** |
| 6 | 诊断垫底 | 诊断放在「高级」Tab 末尾（可内嵌 `createTabBar` 三测，或保留进入 `DiagnosticsSettingPage` 的入口，优先内嵌减少跳转） |
| 7 | README 双结构 | 场景（你可以说…）+ 特性列表；链接继续 GitHub 绝对路径 |

---

## 5. Tab 信息架构

```
┌──────────────────────────────────────────────────────────┐
│ [对话模型]  [笔记索引]  [记忆与权限]  [高级]                 │
├──────────────────────────────────────────────────────────┤
│ 当前 Tab 内容                                              │
└──────────────────────────────────────────────────────────┘
```

### 5.1 对话模型

| 控件 | 说明 |
|---|---|
| 界面语言 | `language` |
| 场景预设 | DeepSeek / Ollama / 自定义 |
| 模型名 | `chatModel`，placeholder `deepseek-v4-flash` |
| API Base | `chatApiBase` |
| 钥匙串状态 | 已配置/未配置 + secret ID 说明（现 `renderChatSecretHint` 上移并 checklist 化） |

### 5.2 笔记索引

| 控件 | 说明 |
|---|---|
| Embedding provider | local / api + 条件字段 |
| Embed 钥匙串 hint | 仅 api 时 |
| chunkSize / chunkOverlap / autoIndex | 现有 |
| Reranker base/model + hint | 现有 |

### 5.3 记忆与权限

| 控件 | 说明 |
|---|---|
| memoryEnabled / memoryAutoWrite | 两开关 |
| 打开记忆面板 | action |
| enableSkills | Skills 总开关 |
| dailyNoteFolder / dailyNoteFormat | 日记约定 |
| trustMode | 信任模式 |
| toolPermissions.* | 全量工具权限下拉（从主平铺迁入） |

### 5.4 高级

| 控件 | 说明 |
|---|---|
| Context Length 预设 / 探测 / 自定义 tokens | 现有 |
| modelRegistryUrl + 重置 | 现有 |
| Prompt overrides | 现有整组 |
| Memory 四个容量数字 | 从记忆 Tab 拆出 |
| debugLog / agentMaxSteps | Developer |
| 诊断 | Embedding / LLM / Rerank 测试（优先同页内嵌 Tab） |

---

## 6. 场景预设行为

| 预设 | 写入字段 |
|---|---|
| DeepSeek | `chatApiBase=https://api.deepseek.com`，`chatModel=deepseek-v4-flash`，`contextLengthPreset=256k`，`chatPreset=deepseek` |
| Ollama | Base 与现适配器对齐（`http://localhost:11434` 或带 `/v1`，实现时与 `DeepSeekLLM`/钥匙串 localhost 判定一致），模型给合理占位（可改），文案提示通常免 Key，`chatPreset=ollama` |
| 自定义 | **不覆盖**已有 Base/模型；仅 `chatPreset=custom` |

附加规则：

- 用户手改 `chatModel` 或 `chatApiBase` → 自动将 `chatPreset` 置为 `custom`  
- 切换预设后：`saveSettings()` + `rebuildLLM()`  
- Context Length 控件在「高级」；DeepSeek 预设仍写入 `contextLengthPreset`，用户可在高级覆盖  

---

## 7. 默认模型变更（代码必改）

| 位置 | 变更 |
|---|---|
| `DEFAULT_SETTINGS.chatModel` | `deepseek-chat` → **`deepseek-v4-flash`** |
| DeepSeek 预设 | 同上 |
| 设置 placeholder | `deepseek-v4-flash` |
| 用户可见文档 | README / user-guide / architecture settings 表中默认模型描述同步（若写死旧名） |

说明：已安装用户 `data.json` 里已有 `chatModel` 的**不强制迁移**；仅新装与「选 DeepSeek 预设」走新默认。

---

## 8. README 改版结构（中英同步）

1. 标题 + 语言切换（绝对链接）+ 徽章  
2. 一句定位  
3. **安装**：仅社区插件浏览搜索 Ratel  
4. **你可以说什么**（3～5 条场景）：带出处问答 / 多步整理 / 当前笔记与时间 / 记忆 / Skill  
5. **特性**精简列表：本地索引、工具权限、模型与钥匙串、隐私、桌面 only 等  
6. 文档链接（手册 / 架构 / CHANGELOG）+ License  

非目标：恢复 BRAT/手传包为安装主路径。

---

## 9. 实现约束与风险

| 项 | 处理 |
|---|---|
| 商店 `no-deprecated-display` | 禁止 `PluginSettingTab.display()`；Tab 挂在声明式 `render` / `SettingPage` |
| CI 空 stub 门禁 | `getSettingDefinitions` 必须返回真实非空定义（可供搜索的 key 仍应覆盖主要字段） |
| Obsidian 设置全局搜索 | 尽量让定义数组仍声明各 `key`，避免搜索全失效；若根 `render` 独占 UI，应用隐藏/并行定义或 page items 保搜索（实现 plan 细化） |
| i18n | 新 Tab 名、预设名、钥匙串 checklist 走 `zh.ts` / `en.ts` |
| 测试 | 声明式单测：Tab 归属、预设写入、`chatModel` 默认值、手改变 custom |

---

## 10. 影响面

| 区域 | 影响 |
|---|---|
| [`src/settings.ts`](../../src/settings.ts) | IA 重组、`chatPreset`、默认模型 |
| [`src/ui/diagnostics/tab-bar.ts`](../../src/ui/diagnostics/tab-bar.ts) | 可能抽到共用 settings Tab（或复用） |
| [`src/i18n/*`](../../src/i18n/) | 新文案 |
| [`README.md`](../../README.md) / [`README.zh-CN.md`](../../README.zh-CN.md) | 场景 + 特性 |
| [`docs/user-guide.md`](../user-guide.md) | 设置速查按 Tab 改写 |
| [`docs/architecture/host/settings.md`](../architecture/host/settings.md) | 分组文档同步 |

---

## 11. 验收

1. 打开设置即见四 Tab；默认落在「对话模型」  
2. 选 DeepSeek 预设 → Base/模型为官方 + `deepseek-v4-flash`，能配合钥匙串对话  
3. 新装默认 `chatModel === 'deepseek-v4-flash'`  
4. 工具权限仅在「记忆与权限」；诊断在「高级」末  
5. README 含场景段 + 特性列表；商店相对链接不回归  
6. CI release gate：无 `this.display()`、非空 `getSettingDefinitions`  

---

## 12. 参考

- 诊断 Tab：`src/ui/settings/diagnostics-setting-page.ts` + `src/ui/diagnostics/tab-bar.ts`  
- 声明式设置：`src/settings.ts` `getSettingDefinitions`  
- 先前讨论结论：page 入口体验差 → 真 Tab；命名走内容归栏方案 B  

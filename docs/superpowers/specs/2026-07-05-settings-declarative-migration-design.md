# 设置面板声明式迁移设计

> **Spec ID**: S-SETTINGS-DECLARATIVE
> **创建日期**: 2026-07-05
> **状态**: Active
> **关联**: 修复 Obsidian plugin checker 报告的 `Disabling 'obsidianmd/no-deprecated-display' is not allowed` 错误,解除 0.1.1 发版阻塞

## 背景

Obsidian 1.13.0 起,`PluginSettingTab` 推出 `getSettingDefinitions()` 声明式 API,`display()` 被标记 `@deprecated`。官方 eslint-plugin 的 `obsidianmd/no-deprecated-display` 规则禁止在 `display()` 上加 `eslint-disable`,导致 0.1.1 release 在 plugin checker 自动审核中报 Error,无法通过 community directory 提交。

之前因误判声明式 API 无法表达复杂交互(Tab 切换、动态按钮、条件渲染),在 `display()` 上加了 `eslint-disable-next-line obsidianmd/no-deprecated-display`。本轮迁移彻底去除 `display()`,全量改用 `getSettingDefinitions()`。

## 目标

1. **核心目标**:删除 `display()` 方法,通过 plugin checker 的 `no-deprecated-display` 规则
2. **次级目标**:顺带修复 lint 暴露的其他 warnings:
   - `prefer-update-over-display`(6 处 `this.display()` → `this.update()`)
   - `@typescript-eslint/no-deprecated`(6 处 display 引用)
   - `ui/sentence-case`(英文 UI 文本改 sentence case)
3. **保持目标**:用户可见行为零变化 — 同样的设置项、同样的交互、同样的视觉效果
4. **过程目标**:迁移过程本地 `npm run lint` 即可验证,无需上传 GitHub release

## 非目标

- 不修改 `RatelVaultSettings` 接口与 `DEFAULT_SETTINGS`(数据结构不变)
- 不修改 `saveSettings` / `loadSettings` 逻辑
- 不重构 `renderSecretHint` / `renderEmbeddingTest` 等子组件(只改调用入口)
- 不迁移 sentence-case 规则对中文文本的要求(规则对中文不强制)

## 详细设计

### 整体架构

```
RatelVaultSettingTab (extends PluginSettingTab)
├── getSettingDefinitions(): SettingDefinitionItem[]
│   ├── [group] Chat Model
│   ├── [group] Context length
│   ├── [group] Advanced
│   ├── [group] Embedding model
│   ├── [group] Reranker
│   ├── [group] Indexing
│   ├── [group] Tool permissions
│   ├── [group] Prompt overrides (advanced)
│   ├── [page] Diagnostics
│   └── [group] Developer
├── setControlValue(key, value) — override,集中处理 onChange 副作用 + 嵌套 key 写入
├── getControlValue(key) — override,处理嵌套 key 读取
└── (display() 完全删除)

DiagnosticsSettingPage (extends SettingPage)
└── display() — 命令式渲染 3 个子 tab (Embedding/LLM/Rerank)
   (注:SettingPage 的 display() 是 abstract 方法,非 deprecated)
```

### 关键技术决策

#### 1. onChange 副作用处理

**问题**:声明式 `control` 没有 `onChange` 回调,但当前代码在 onChange 时需要触发:
- `rebuildLLM()`(chatModel / chatApiBase 变更)
- `rebuildEmbeddingAdapter()`(embedProvider / embedApiBase / embedApiModel 变更)
- `syncToolDefinitions()`(promptOverrides 变更)

**解决**:override `setControlValue(key, value)` 在 SettingTab 子类集中处理。注意返回类型是 `void | Promise<void>`(API 定义见 obsidian.d.ts:5173),因为 `saveSettings()` 是 async:

```typescript
async setControlValue(key: string, value: unknown): Promise<void> {
  // 关键路径:嵌套 key(tooPermissions.xxx / promptOverrides.xxx)默认实现
  // 会写入 settings["toolPermissions.xxx"] 字面量字段,必须手动分发到嵌套对象。
  if (key.startsWith('toolPermissions.')) {
    const toolName = key.split('.')[1];
    this.plugin.settings.toolPermissions[toolName] = value as ToolPermission;
  } else if (key.startsWith('promptOverrides.')) {
    const sectionId = key.split('.').slice(1).join('.');
    this.plugin.settings.promptOverrides[sectionId] = value as string;
    this.plugin.syncToolDefinitions();
  } else {
    // 直接字段:走默认实现(写入 this.plugin.settings[key])
    (this.plugin.settings as Record<string, unknown>)[key] = value;
  }

  // 副作用分发
  if (key === 'chatModel' || key === 'chatApiBase') this.plugin.rebuildLLM();
  if (key.startsWith('embed') && key !== 'embedLocalModel') {
    this.plugin.rebuildEmbeddingAdapter();
  }
  if (key === 'debugLog') devLogger.setDebugEnabled(value as boolean);

  await this.plugin.saveSettings();
  this.update(); // 关键路径:替代 this.display(),触发 declarative 重渲染
}

// 关键路径:override 读取,处理嵌套 key。
// 不 override 的话默认实现是 this.plugin.settings[key],嵌套 key 会读到 undefined。
getControlValue(key: string): unknown {
  if (key.startsWith('toolPermissions.')) {
    const toolName = key.split('.')[1];
    return this.plugin.settings.toolPermissions[toolName];
  }
  if (key.startsWith('promptOverrides.')) {
    const sectionId = key.split('.').slice(1).join('.');
    return this.plugin.settings.promptOverrides[sectionId];
  }
  return (this.plugin.settings as Record<string, unknown>)[key];
}
```

#### 2. 重渲染机制

**问题**:当前代码在 Provider 切换、Preset 切换、useCustom toggle 后调 `this.display()` 整体重渲染。

**解决**:
- `visible: () => boolean` 函数会在 `this.update()` 时重新求值
- 不需再手动重渲染,框架自动处理条件项的显示/隐藏
- action 回调内修改 settings 后调 `this.update()` 刷新依赖项

#### 3. 嵌套 key 处理

**问题**:`toolPermissions.search_vault` 与 `promptOverrides.<sectionId>` 不是 `RatelVaultSettings` 的直接字段。`PluginSettingTab` 默认的 `getControlValue` / `setControlValue` 实现 `this.plugin.settings[key]`,会把整个 `"toolPermissions.search_vault"` 当作顶层 key,导致读写都不命中。

**解决**:同时 override `getControlValue` 与 `setControlValue`,检测 `key.startsWith(...)` 前缀,分发到嵌套对象(见上文代码块)。

#### 4. 命令式渲染兜底

**问题**:Prompt Overrides 区(动态多个 section,每个含 toggle + textarea + 校验 + 恢复按钮)与 API Key hint(自定义 DOM)无法用声明式 control 表达。

**解决**:用 `SettingDefinitionRender`(API 定义见 obsidian.d.ts:6265)。render 回调签名:
```typescript
render: (setting: Setting, group: SettingGroup) => void | (() => void)
```
可返回 cleanup 函数(在 row 销毁前调用,用于清理监听器等):

```typescript
{
  name: '...',
  render: (setting: Setting, group: SettingGroup) => {
    // 在 setting.controlEl 上渲染 toggle + textarea + warn + button
    // 复用现有 renderPromptOverrides 内的逻辑
    // return () => { /* cleanup */ };
  },
}
```

#### 5. Diagnostics 子页面

**问题**:诊断测试 Tab(3 个子 tab,纯命令式测试工具)无法声明式表达。

**解决**:用 `SettingDefinitionPage` + 自定义 `SettingPage` 子类(API 定义见 obsidian.d.ts:6202、6461):
```typescript
{
  type: 'page',
  name: 'Diagnostics',
  desc: '调试工具:验证 Embedding、LLM、Rerank 适配器是否正常工作',
  page: () => new DiagnosticsSettingPage(this.app, this.plugin),
},
```

新建 `src/ui/settings/diagnostics-setting-page.ts`。**关键**:`SettingPage` 的抽象方法是 `display()`(obsidian.d.ts:6496),不是 `render()` — 这与 `PluginSettingTab` 的 deprecated `display()` 是不同方法,SettingPage 的 `display()` 不在 deprecated 名单中:

```typescript
export class DiagnosticsSettingPage extends SettingPage {
  plugin: RatelVaultPlugin;
  app: App;

  constructor(app: App, plugin: RatelVaultPlugin) {
    super();
    this.app = app;
    this.plugin = plugin;
  }

  // 关键路径:SettingPage 的 abstract 方法,非 deprecated。
  // 渲染 3 个子 tab,内部走 createTabBar + renderEmbeddingTest/renderLLMTest/renderRerankTest。
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // ... 渲染 3 个子 tab
  }
}
```

### 各区块迁移细则

#### Chat Model group
- Model: `control: { type: 'text', key: 'chatModel' }`
- API base URL: `control: { type: 'text', key: 'chatApiBase' }`

#### Context length group
- Context length dropdown: `control: { type: 'dropdown', key: 'contextLengthPreset', options: CONTEXT_LENGTH_PRESET_OPTIONS }`
- "获取推荐" button: `SettingDefinitionAction`,action 内调用 `probeChatConnection`,成功后 `setControlValue('contextLengthPreset', applied.preset)` + `setControlValue('chatModelMaxTokens', applied.chatModelMaxTokens)` + `this.update()`
- 自定义 token 数: `control: { type: 'number', key: 'chatModelMaxTokens', min: CUSTOM_TOKEN_MIN, max: CUSTOM_TOKEN_MAX }` + `visible: () => settings.contextLengthPreset === 'custom'`

#### Advanced group
- 模型映射表 URL: `control: { type: 'text', key: 'modelRegistryUrl' }`
- "恢复默认" button: `SettingDefinitionAction`,清空 `modelRegistryUrl` 后 `this.update()`
- API Key hint: `SettingDefinitionRender`,调 `renderSecretHint`

#### Embedding model group
- Provider dropdown: `control: { type: 'dropdown', key: 'embedProvider', options: { local: 'Local (built-in)', api: 'API (external)' } }`
- local Model(只读): `control: { type: 'text', key: 'embedLocalModel', disabled: true }` + `visible: () => settings.embedProvider === 'local'`
- api API base URL: `visible: () => settings.embedProvider === 'api'`
- api Secret hint: `SettingDefinitionRender` + `visible: () => settings.embedProvider === 'api'`
- api Model: `visible: () => settings.embedProvider === 'api'`

#### Reranker group
- API base URL / Model: 普通 text control
- Rerank API Key hint: `SettingDefinitionRender`

#### Indexing group
- Chunk size / overlap: `control: { type: 'slider', ... }`
- Auto index: `control: { type: 'toggle', key: 'autoIndex' }`

#### Tool permissions group
- Trust mode: `control: { type: 'toggle', key: 'trustMode' }`
- 9 个工具 dropdown: 循环生成,`key: 'toolPermissions.<toolName>'`

#### Prompt overrides group(最复杂)
- 说明段: `SettingDefinitionEmpty`(只有 name + desc,control/action/render 都是 never,API 定义见 obsidian.d.ts:6053)
- 每个 section:`SettingDefinitionRender`,内部渲染 toggle + textarea + warn + 恢复按钮
- 预览按钮:`SettingDefinitionAction`,弹 Modal

#### Diagnostics page
- `SettingDefinitionPage` + `page: () => new DiagnosticsSettingPage(...)`

#### Developer group
- Debug 日志: `control: { type: 'toggle', key: 'debugLog' }`,setControlValue 内调 `devLogger.setDebugEnabled(value)`
- Agent 最大步数: `control: { type: 'slider', key: 'agentMaxSteps', min: 5, max: 200, step: 5 }`

### Sentence case 修复

迁移过程把英文 UI 文本改成 sentence case:

| 原文 | 修改后 |
|---|---|
| Chat Model | Chat model |
| API Base URL | API base URL |
| Embedding Model | Embedding model |
| Model | Model(单词,保留) |
| Provider | Provider(单词,保留) |
| Auto index | Auto index(已合规) |
| Chunk size (tokens) | Chunk size (tokens)(已合规) |
| Chunk overlap (tokens) | Chunk overlap (tokens)(已合规) |
| Trust mode | Trust mode(已合规) |
| Debug 日志 | Debug 日志(中文,不强制) |
| Agent 最大步数 | Agent 最大步数(中文,不强制) |

中文文本不修改(sentence-case 规则对中文不强制)。

## 影响面

### 文件变更

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/settings.ts` | 重写 | 删除 `display()` / `renderSettings` / `renderDiagnostics` / `renderToolPermissions` / `renderPromptOverrides`,实现 `getSettingDefinitions()` + `setControlValue` / `getControlValue` override |
| `src/ui/settings/diagnostics-setting-page.ts` | 新建 | `DiagnosticsSettingPage extends SettingPage`,渲染 3 个诊断子 tab |
| `src/ui/components/secret-hint.ts` | 微调 | 适配 `SettingDefinitionRender` 接口(参数从 `containerEl: HTMLElement` 改为 `setting: Setting`) |
| `src/ui/diagnostics/tab-bar.ts` | 无变更 | DiagnosticsSettingPage 内部调用,接口不变 |
| `src/ui/diagnostics/embedding-test.ts` | 无变更 | 同上 |
| `src/ui/diagnostics/llm-test.ts` | 无变更 | 同上 |
| `src/ui/diagnostics/rerank-test.ts` | 无变更 | 同上 |
| `eslint.config.mts` | 已修改 | 启用 obsidianmd 推荐规则集(本轮已改) |
| `tsconfig.json` | 已修改 | include tests(本轮已改) |
| `package.json` | 已修改 | eslint-plugin-obsidianmd 升级 0.4.1(本轮已改) |

### 用户可见行为变更

**零变化**。同样的设置项、同样的交互、同样的视觉效果。

### 架构契约变更

- `PluginSettingTab` 子类不再实现 `display()`,改用 `getSettingDefinitions()` — 符合 Obsidian 1.13.0 推荐
- 新增 `DiagnosticsSettingPage`(`SettingPage` 子类)— 这是 Obsidian 官方推荐的"imperative sub-page"用法
- `setControlValue` override 集中处理副作用,取代散落的 onChange 回调

### 测试影响

- `tests/utils/path-safety.test.ts` 等 tests 不受影响(不依赖 settings panel)
- 无需新增 settings 面板的单元测试(声明式结构由 Obsidian 框架接管渲染,不易测)
- 迁移后跑 `npm run build` + 手动验证设置面板各区块正常显示与交互

## 验证

### 本地 lint 验证

```bash
npm run lint
```

预期:
- `src/settings.ts` 0 errors
- `obsidianmd/no-deprecated-display` 规则不再触发(因为 `display` 已删除)
- `obsidianmd/settings-tab/prefer-update-over-display` 警告消失
- `@typescript-eslint/no-deprecated` 警告消失
- `obsidianmd/ui/sentence-case` 警告大幅减少(英文部分修复)

### 构建验证

```bash
npm run build
```

预期:TypeScript 编译 + svelte-check + esbuild 全部通过。

### 手动功能验证

Obsidian 重载插件后:
1. 设置面板能正常打开
2. 各区块(Embedding Provider 切换、Context Length 切换、Prompt Overrides toggle)的动态显示正常
3. "获取推荐" / "测试连接" / "恢复默认" 按钮正常工作
4. 诊断 Tab 的 3 个子 tab(Embedding/LLM/Rerank)能正常切换与测试
5. 设置项修改后能正常保存,触发对应副作用(rebuildLLM 等)

### Plugin checker 验证

迁移完成后:
1. 升版本 0.1.1 → 0.1.2
2. 重建 tag 与 release,上传 main.js / manifest.json / styles.css
3. 在 GitHub release 页面或 community.obsidian.md 确认 Source code 段无 Error
4. 如 0.1.2 仍报错,继续迭代版本号 0.1.x,直到 Source code 段完全无 Error

## 参考

- [Obsidian Plugin Submission Requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [Obsidian Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- `node_modules/obsidian/obsidian.d.ts` — `SettingDefinitionItem` / `SettingControl` / `SettingPage` API 定义(5156-6641 行)
- `node_modules/eslint-plugin-obsidianmd/dist/lib/rules/settingsTab/noDeprecatedDisplay.js` — 规则实现
- 之前的 `display` deprecated workaround:已删除的 `eslint-disable-next-line obsidianmd/no-deprecated-display`

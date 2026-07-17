# Ratel 外观 — 强调色预设 · 亮暗模式 · 设置 Tab(S-UI-APPEARANCE)

> 日期: 2026-07-17  
> 状态: Active  
> 作者: 对话驱动(Chat 与 Obsidian 同色 → 可切换强调色 + 亮暗)  
> 关联: [S-CHAT-UI-V3](2026-07-16-chat-ui-v3-conversation-first.md);现有 token `--ratel-cite` / `--ratel-meter-*`

---

## 1. 背景

Ratel 自绘 UI(Chat / 记忆 / 诊断等)几乎全部消费 Obsidian CSS 变量(`--interactive-accent`、`--background-*`、`--text-*`)。用户改 **设置 → 外观** 的强调色时 Ratel 会一起变,但**无法在插件内单独换色**,侧栏与笔记区「永远一个色」。

已有薄封装:

- `.ratel-chat` 上 `--ratel-cite` / `--ratel-meter-from|to` 默认仍 alias 到 `--interactive-accent`。

用户需要:

1. **强调色可切换**(方案 B:预设,非整套独立皮肤)  
2. **亮暗默认跟随 Obsidian**,支持在 Ratel 内显式浅色/深色  
3. 设置里有独立 **「外观」Tab**,主体以**预览 + 可视化控件**为主,不是两个普通下拉  
4. 切换后**立刻生效**;热更新失败时才提示,且优先「重开侧栏」而非「重启 Obsidian」

---

## 2. 目标

1. 设置顶栏增加 **外观** Tab(五页:对话模型 / 笔记索引 / 记忆与权限 / **外观** / 高级)。  
2. 持久化 `uiColorScheme`、`uiAccent` 至 `data.json`(`RatelVaultSettings`)。  
3. 强调色预设取自 **Material Design** 常用 seed(固定 hex),另加「跟随 Obsidian」。  
4. 亮暗:`auto`(默认,跟 Obsidian)/ `light` / `dark`;显式模式仅作用于 Ratel 视图根。  
5. **即时生效**:改设置后,外观 Tab 预览卡与已打开的 Chat/记忆/诊断根节点同步变色,无需重载插件。  
6. 全部用户可见文案走 i18n。

## 3. 非目标

- 自定义任意 hex / 色轮 / 导入导出主题包  
- 改 Obsidian 全局主题、编辑器、其它插件  
- 依赖 Style Settings / Theme Engine  
- 完整 MD3 tonal 动态配色(secondary / tertiary / surface 全角色)  
- 把顶栏当前 Tab 落盘(继续 UI 态)

---

## 4. 详细设计

### 4.1 持久化

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `uiColorScheme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | `auto` = 不强制浅深,继承 Obsidian;`light`/`dark` = 仅 Ratel 根覆盖 surface/text |
| `uiAccent` | `'follow' \| MaterialPresetId` | `'follow'` | `follow` = 跟 `--interactive-accent`;否则用预设 hex |

- 写入路径:现有 `saveSettings` / `saveData`,**不**另开 localStorage。  
- `loadSettings` 缺字段时归一为默认值(兼容 0.1.9 及更早 `data.json`)。  
- 密钥/钥匙串无关;无敏感数据。

### 4.2 Material 强调色预设

模块:`src/ui/appearance/appearance-presets.ts`(纯数据 + 类型)。

| id | Material 名 | 色值(Material 500) |
|----|-------------|-------------------|
| `follow` | — | 不覆盖,用 Obsidian |
| `red` | Red | `#F44336` |
| `purple` | Purple | `#9C27B0` |
| `indigo` | Indigo | `#3F51B5` |
| `blue` | Blue | `#2196F3` |
| `teal` | Teal | `#009688` |
| `green` | Green | `#4CAF50` |
| `orange` | Orange | `#FF9800` |
| `pink` | Pink | `#E91E63` |

- UI 色块与 CSS 同源:预设表是唯一事实源。  
- 覆盖时至少设置:`--interactive-accent`、`--interactive-accent-hover`(略亮/略暗可用 `color-mix`)、`--text-accent`、`--ratel-cite`;按钮上文字继续用 `--text-on-accent`(Obsidian 语义色,不自造)。  
- v1 不做 per-preset 的 MD3 on-primary 计算;若对比度极端预设后续再补。

### 4.3 亮暗模式

| 值 | 行为 |
|----|------|
| `auto` | 根节点**不**设强制 scheme;完全跟随 Obsidian `theme-light` / `theme-dark` |
| `light` | `data-ratel-scheme="light"`,在 Ratel 根覆盖一组 surface/text token(映射到 Obsidian light 语义或固定 light 基色) |
| `dark` | `data-ratel-scheme="dark"`,同上 dark |

**约束:** 只改带 Ratel 根 class 的容器(`.ratel-chat`、记忆面板根、诊断根等),禁止改 `document.body` 全局变量。

### 4.4 应用函数(即时生效)

模块:`src/ui/appearance/apply-ratel-appearance.ts`

```ts
applyRatelAppearance(root: HTMLElement, settings: Pick<RatelVaultSettings, 'uiColorScheme' | 'uiAccent'>): void
```

- 写 `data-ratel-scheme` / `data-ratel-accent`(或清除 auto/follow 时的强制值)。  
- 按预设写 CSS 变量(inline 或由 CSS `[data-ratel-accent=teal]` 规则表驱动;推荐 **attribute + CSS 规则表**,避免散落 inline)。  
- **纯函数、可单测**;无 Obsidian API。

**热更新链路(硬要求):**

1. 外观 Tab 控件变更 → 更新 `plugin.settings` → `saveSettings()` → `applyRatelAppearance(previewRoot)`。  
2. 同时通知已挂载视图:轻量 `appearanceRevision` store / 现有 settings 变更回调 → Chat / Memory / 诊断 `applyRatelAppearance(root)`。  
3. 验收:**不关闭侧栏**即可看到 cite-chip、发送钮、预览卡同步变色。

**降级文案(仅当某路径经验证无法热更新时启用):**

- Notice 或设置页 muted 一行:`chat`/`settings.appearance.reloadHint` — 「部分界面请关闭并重新打开 Ratel 侧栏后生效」。  
- **禁止**默认文案要求「重启 Obsidian」,除非后续发现无法热更新的硬阻塞并在 STATUS 记录原因。

### 4.5 外观 Tab 主体展示(重要)

顶栏插入 `appearance`(`SettingsUiTab` 扩展为含 `'appearance'`)。

本 Tab **主体不是两个 dropdown**,用声明式 `render:` 自定义块(与 Tab 条同模式):

```
┌─ 预览卡(最醒目)────────────────────────────────┐
│  Ratel.  [chip]                                  │
│  助手预览正文 … 引用 [1]                         │
│  [1 示例笔记.md]  cite-chip                      │
│  ┌ 一体输入壳 ──────────── [发送] ┐              │
│  └────────────────────────────────┘              │
│  当前:浅色 · Teal(或「跟随 Obsidian」)           │
└──────────────────────────────────────────────────┘

颜色模式:  ( 跟随 Obsidian ) ( 浅色 ) ( 深色 )   ← segmented

强调色:    [跟随][红][紫][靛][蓝][青][绿][橙][粉] ← 色块;选中描边

说明:仅影响 Ratel 面板,不改笔记区与其它插件。
```

**展示原则:**

1. **先预览、后控件**;预览根调用同一 `applyRatelAppearance`,禁止第二套样式。  
2. 亮暗用三段控件;强调色用色块(跟随可用当前 Obsidian accent 小样或中性块 + 文案)。  
3. 设置搜索命中外观组时行为与其它 Tab 一致(搜索中 Tab 条隐藏);预览不抢扁平命中列表时可随组 visible。  
4. 所有标签 / 说明 / aria-label 走 i18n(`settings.appearance.*`)。

### 4.6 作用面

必须挂载 `applyRatelAppearance` 的根:

- Chat 侧栏(`.ratel-chat`)  
- 记忆面板根  
- 诊断页根(若独立于设置外壳)  
- 外观 Tab 预览卡根  

Settings 外壳其它 Tab 仍跟 Obsidian;外观 Tab 内预览与控件自身可读当前选择态。

---

## 5. 影响面

| 区域 | 变更 |
|------|------|
| `src/settings.ts` | 字段、DEFAULT、归一、第五 Tab、`render` 外观主体 |
| `src/i18n/{types,zh,en}.ts` | `settings.appearance.*`、Tab 名 |
| `src/ui/appearance/*` | 预设表 + apply + 可选预览子模块 |
| Chat / Memory / 诊断 | onMount + 订阅后 apply |
| `styles.css` 或 appearance CSS | `[data-ratel-accent=…]` / `[data-ratel-scheme=…]` 规则 |
| 测试 | 预设表、apply attribute、loadSettings 归一 |
| 文档 | 发版时 CHANGELOG 用户句;user-guide 补「外观」一节(plan 阶段勾选) |

**不改:** ports、Agent Loop、Worker、工具契约、构建产物清单。

---

## 6. 参考

- [Obsidian CSS Colors](https://docs.obsidian.md/Reference/CSS+variables/Foundations/Colors) — `--accent-h/s/l`、`--interactive-accent`  
- [Material Design Colors](https://m2.material.io/design/color/the-color-system.html#tools-for-picking-colors) — 本 spec 预设取 500 档  
- 现网:`ChatView.svelte` 中 `--ratel-cite` / `--ratel-meter-*` 映射  

---

## 7. 验收清单

- [ ] 外观 Tab 可见;预览在切换亮暗/强调色时立即变  
- [ ] 已打开 Chat 不关侧栏即变色  
- [ ] `uiColorScheme=auto` 时跟随 Obsidian 亮暗切换(改 Obsidian 外观后 Ratel 一致)  
- [ ] `follow` 强调色跟随 Obsidian accent  
- [ ] 旧 `data.json` 无字段时默认 auto + follow  
- [ ] 无「必须重启 Obsidian」的默认文案  
- [ ] i18n 中英齐全;无硬编码用户可见串  

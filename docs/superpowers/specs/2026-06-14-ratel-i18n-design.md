# i18n 设计 — 中英文界面切换

> 日期: 2026-06-14
> 状态: Draft
> 关联: AGENTS.md § 1.1(预留 `plugin.i18n` 约定)

---

## 1. 背景

W1 + W2 已完成,所有用户可见文本目前全部硬编码英文(散落在 `src/settings.ts`、`src/ui/ChatView.svelte`、`src/main.ts` 的 `addCommand` / `Notice` 中)。`AGENTS.md` 早先预留了"面向用户的错误消息由 `plugin.i18n` 决定"的约定,但尚未实现。

仓库贡献者是中文母语者,且 W3+ 写中文用户使用手册 / 教程之前,先把 i18n 基础设施落地,后续加日文 / 越文 / 阿拉伯文也只需多一份翻译表。

## 2. 目标

- 用户在设置面板能切换 `auto` / `中文` / `English`
- 切换瞬时生效,无需重启 Obsidian
- 默认 `auto`,首次安装时根据 `navigator.language` 选 zh / en
- 全 UI 覆盖:设置面板 + Chat 侧栏 + 命令名 + Notice 文本

## 3. 非目标

- 仅支持中 / 英两种语言(其余语言 fallback 到 en)
- 不监听 `navigator.language` 运行时变更 —— 'auto' 只在插件 `onload` 时解析一次
- 不翻译 LLM / 工具 / Worker 抛出的英文错误内容;只本地化错误前缀
- 不做命令名运行时热更新 —— `addCommand` 是 `onload` 一次性注册,改语言后需 toggle 插件或重启 Obsidian 才看到新命令名
- 不做翻译贡献流程(留作未来 PR 模板,本 spec 不涉及)

## 4. 详细设计

### 4.1 模块边界

```
src/i18n/
  types.ts          # Strings interface — 全部 key 形状
  zh.ts             # 中文翻译表:const zh: Strings = {...}
  en.ts             # 英文翻译表:const en: Strings = {...}
  index.ts          # store + t + tNow + detectLang + applyLangPreference
  strings.test.ts   # 翻译表完整性(key 对齐 / 非空)
  index.test.ts     # 运行时行为(detect / setLang / 插值 / store 发射)
```

### 4.2 关键类型

```ts
// types.ts
export interface Strings {
  'settings.title.general': string;
  'settings.field.language': string;
  // ... 约 50 项,key 命名 域.子域.用途
}

export type Lang = 'zh' | 'en';
export type LangPreference = 'auto' | Lang;
export type StringKey = keyof Strings;
```

`zh.ts` / `en.ts` 各 `const x: Strings = {...}` —— TypeScript 编译期强制两表形状一致,新增 key 必须三处同步。

### 4.3 反应式状态

`index.ts` 用 `svelte/store` 暴露:

| 导出 | 类型 | 用途 |
|---|---|---|
| `currentLang` | `Readable<Lang>` | 当前语言 |
| `t` | `Readable<(key, vars?) => string>` | 派生 store,Svelte 模板里 `$t('key')` 自动跟随 |
| `tNow` | `(key, vars?) => string` | 非反应式便利函数,给 main.ts / settings.ts 用 |
| `detectLang()` | `() => Lang` | 读 `navigator.language`,zh 开头判 zh,其余 en |
| `applyLangPreference(pref)` | `(LangPreference) => void` | 把 'auto' 解析后写入 currentLang |

`vars` 替换 `{key}` 占位(非正则,简单 `String.replace`),`{n}` / `{when}` 等命名槽位用于含动态内容的字符串(如 Notice 索引状态)。

### 4.4 消费者集成

| 文件 | 改动点 |
|---|---|
| `src/settings.ts` | `RatelVaultSettings` 加 `language: LangPreference`;DEFAULT 加 `language: 'auto'`;`display()` 顶部新增 "General" 分组含 Language 下拉;所有 `setName / setDesc / createEl / addOptions` 文本走 `tNow(...)`;Language `onChange` 改设置 → saveSettings → `applyLangPreference` → `display()` |
| `src/main.ts` | `onload` 里 `loadSettings` 后立即 `applyLangPreference(this.settings.language)`;`addCommand.name` 走 `tNow('cmd.askVault' / 'cmd.showIndexStatus')`;两条 `new Notice(...)` 走 `tNow('notice.indexNotReady' / 'notice.indexStatus', vars)` |
| `src/ui/ChatView.svelte` | 顶部 `import { currentLang, t } from '../i18n'`;所有硬编码字符串(placeholder / You / Ratel / Thinking / Send / errorPrefix)改为 `{$t('...')}`;catch 块里 `errorPrefix` 走 `$t('chat.errorPrefix')` |

### 4.5 数据流(用户切语言那一刻)

```
设置面板 Language 下拉 onChange(value)
  ↓
this.plugin.settings.language = value
  ↓
await this.plugin.saveSettings()        // 持久化到 .obsidian/plugins/ratel-vault/data.json
  ↓
applyLangPreference(value)              // currentLang store 发出新值
  ↓
this.display()                          // settings 面板 empty() + 重建,所有 tNow(...) 走新 lang
  ↓
ChatView 模板内 $t 自动重求值            // Svelte 反应式
  ↓
命令名 不变(已知限制)
```

### 4.6 测试

`strings.test.ts`:
- zh 与 en key 集合完全一致(`Object.keys(...).sort()` 严格等)
- 所有翻译值都是非空字符串
- 编译期断言(`const _zh: Strings = zh`)自动捕获"只在一侧加 key"

`index.test.ts`:
- `detectLang()` 对 `zh / zh-CN / zh-TW / zh-Hans` 返回 'zh';`en / en-US / ja / fr / ''` 返回 'en';`navigator` 不可用返回 'en'
- `applyLangPreference('auto')` 走 `detectLang()`;显式 'zh' / 'en' 忽略 navigator
- `tNow(key)` 在不同 currentLang 下返回对应翻译
- `tNow(key, vars)` 替换 `{key}` 占位;多余 / 缺失的 vars key 不抛错
- `t` 派生 store 在 `currentLang.set(...)` 时重新发射,新发射的函数读新 lang

### 4.7 边界 / 已知限制

| 场景 | 行为 |
|---|---|
| 首次安装,`data.json` 不存在 | `Object.assign({}, DEFAULT, loaded)` 给 `language: 'auto'`,走 `detectLang()` |
| 升级老用户,`data.json` 无 `language` 键 | 同上,DEFAULT 兜底 |
| 用户显式设 `language: 'zh'`,系统英文 | `applyLangPreference('zh')` 直接用 'zh',不查 navigator |
| 系统 locale 既非 zh 也非 en | `detectLang()` 兜底 'en' |
| 切语言时设置面板 / ChatView 已开 | 两者都即时刷新(详见 4.5) |
| 切语言后命令名 | 不更新,需 toggle 插件 / 重启 Obsidian —— 测试手册 § 4.1 标注 |
| Tool 报错(英文 err.message) | 错误内容保留英文,只本地化 `chat.errorPrefix` —— v2 再说 |
| vars 漏 key | 占位符字面量保留,不抛错(避免翻译表迭代时阻塞) |
| 翻译值含字面量 `{` `}` | 当前无场景;v2 需 escape 时再处理 |

## 5. 影响面

### 5.1 新增文件

- `src/i18n/types.ts`
- `src/i18n/zh.ts`
- `src/i18n/en.ts`
- `src/i18n/index.ts`
- `src/i18n/strings.test.ts`
- `src/i18n/index.test.ts`

### 5.2 修改文件

- `src/settings.ts` —— `RatelVaultSettings` + DEFAULT + `display()`(加 General 分组 + 全部 tNow 化)
- `src/main.ts` —— `onload` 启动 + `addCommand` + `Notice`
- `src/ui/ChatView.svelte` —— 全部硬编码字符串改 `$t(...)`

### 5.3 文档

- `docs/contributing/how-to-test.md` —— § 4.1 增补"切语言 / 命令名限制"段;`docs/ARCHITECTURE.md`(若有相关)同步
- `docs/superpowers/STATUS.md` —— 登记本 spec

### 5.4 依赖

- 无新增;`svelte / svelte/store` 已在 devDependencies,直接复用

### 5.5 测试

- 新增 `src/i18n/strings.test.ts`、`src/i18n/index.test.ts`(L1 单元,纯 vitest,无外部依赖)
- 现有 103 个测试不受影响

## 6. 参考

- `AGENTS.md` § 1.1 错误消息规范:"面向用户的错误消息由 `plugin.i18n` 决定"
- `src/settings.ts`(现)—— `display()` 形态与分组结构参考
- `src/ui/ChatView.svelte`(现)—— Svelte 5 组件内 `{#each}` 表达式写法参考
- Svelte store 文档:https://svelte.dev/docs/svelte-store —— `derived` / `get` / 自动订阅 `$` 语义
- 项目自身 RAG 测试架构设计: [2026-06-14-ratel-test-architecture.md](2026-06-14-ratel-test-architecture.md) —— 测试分层约定(L1 单元 / L2 集成)

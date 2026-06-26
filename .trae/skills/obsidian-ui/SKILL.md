---
name: "obsidian-ui"
description: "Obsidian 插件 UI 开发规范 — Svelte 5 挂载、CSS 变量复用、主题适配约束。当创建或修改 Obsidian 插件的 Svelte 组件、聊天界面、状态栏、弹窗、设置面板等任何 UI 代码时调用。"
---

# Obsidian 插件 UI 开发规范

## 渲染机制

Obsidian 插件 UI **不是 HTML 渲染**，是 Svelte 5 编译为原生 JS 命令式 DOM 操作。

- Svelte 5 编译后输出 `document.createElement` / `appendChild` 等命令式代码，无虚拟 DOM
- 仍需 `svelte/internal` 运行时（effect / signal / reactivity），由 esbuild 打进 `dist/main.js`
- CSS 通过 `css: 'injected'` 编译为 JS 字符串，运行时注入 `<style>` 标签 — 不是外部 CSS 文件
- 没有 shadow DOM，插件 DOM 直接挂在 Obsidian 全局 DOM 树里，**受主题 CSS 影响**

## 挂载点与生命周期

### ItemView 挂载

```
containerEl.children[0] → 视图标题栏（不可动）
containerEl.children[1] → 业务内容区（挂载点）
```

### Svelte 5 mount（必须双参）

```typescript
// 正确 — Svelte 5 双参 API
this.component = mount(ChatViewComponent, {
  target: container,
  props: { plugin: this.plugin },
});

// 错误 — 旧单参调用会让 props 变 undefined，
// Svelte 5 effect 链内部对 undefined 用 `in` 算符找 Symbol($state) 会抛错
this.component = new ChatViewComponent({ target: container, props: {...} });
```

### unmount（必须调用）

`onClose()` 必须调 `unmount(this.component)`，否则 Svelte 5 的 effect/signal 仍持有 DOM 引用，多次开关侧栏会内存泄漏。

## esbuild 配置要点

```javascript
// esbuild.config.mjs 关键字段
conditions: ['browser', 'default'],  // Svelte 5 按 condition 导出 client/server 两套运行时
mainFields: ['browser', 'module', 'main'],
platform: 'node',        // vectra 用 node:fs / node:path
format: 'cjs',           // Obsidian 用 require 加载
target: 'es2021',
external: ['obsidian', 'electron', ...builtinModules],

plugins: [
  esbuildSvelte({
    compilerOptions: { css: 'injected' },  // CSS 编译进 JS，不抽独立文件
    preprocess: sveltePreprocess(),
  }),
],
```

- `conditions` 不加 `'browser'` 会指向 server runtime（无 `mount`，只有 SSR `render`），抛 "is not available on the server"
- `css: 'injected'` 确保所有 Svelte `<style>` 块编译进 `main.js`，符合"单 main.js + 单 worker.js"约束

## CSS 变量复用（强制）

**所有颜色必须复用 Obsidian CSS 变量，禁止硬编码 hex 值。**

### 可用变量映射表

| 类别 | 变量名 | 用途 |
|------|--------|------|
| 文本 | `--text-normal` | 主文本色 |
| | `--text-muted` | 次要文本色 |
| | `--text-faint` | 最弱文本色 |
| | `--text-error` | 错误文本（红） |
| | `--text-warning` | 警告文本（黄） |
| | `--text-success` | 成功文本（绿） |
| | `--text-on-accent` | accent 背景上的文本 |
| | `--text-accent` | 强调文本 |
| 背景 | `--background-primary` | 主背景 |
| | `--background-secondary` | 次背景（面板、侧栏） |
| | `--background-modifier-border` | 边框 |
| | `--background-modifier-border-hover` | 悬停边框 |
| | `--background-modifier-error` | 错误背景 |
| | `--background-modifier-form-field` | 输入框背景 |
| | `--background-modifier-success` | 成功背景 |
| 交互 | `--interactive-accent` | 主交互色（按钮、高亮） |
| | `--interactive-accent-hover` | 悬停交互色 |
| | `--interactive-normal` | 普通交互背景 |
| | `--interactive-hover` | 悬停交互背景 |
| 字体 | `--font-monospace` | 等宽字体 |

### fallback 写法

仅在变量可能未定义时使用，变量优先：

```css
.ratel-stop-btn {
  background: var(--text-error, #e53935) !important;
  color: var(--text-on-accent, #fff) !important;
}
```

### 状态色映射

| 语义 | 必须用 | 禁止硬编码 |
|------|--------|-----------|
| 成功/就绪 | `--text-success` | `#7ee787` / `#4caf50` |
| 警告/处理中 | `--text-warning` | `#facc15` / `#ff9800` |
| 错误/失败 | `--text-error` | `#f87171` / `#e53935` |
| 主色/accent | `--interactive-accent` | 任何品牌色 |
| 静音/禁用 | `--text-muted` | `#a0a0a0` / `#999` |

## 视觉约束

### 圆角（border-radius）

- 消息卡片：8px
- 输入框 / 按钮 / 搜索结果：6px
- 工具调用项 / 小标签：4px
- 状态点：50%
- **不要超过 8px**，与 Obsidian 原生组件保持一致

### 阴影（box-shadow）

**禁止使用 box-shadow。** 原因：
- 暗色主题下黑色阴影完全不可见
- 亮色主题下可能突兀
- Obsidian 主题本身极少用阴影

替代方案 — 用 border + background 表达层次：

```css
/* 正确 */
.ratel-panel {
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}

/* 错误 — 暗色主题下不可见 */
.ratel-panel {
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
```

### 弹窗 / 抽屉

- 用 `max-height` + `transition` 实现展开/收起，不要用 `position: absolute` 悬浮
- 弹窗列表用 `var(--background-secondary)` 背景 + `1px solid var(--background-modifier-border)` 边框

## class 命名规范

**所有 class 必须用 `ratel-` 前缀**，与 Obsidian 及其他插件隔离。

```css
/* 正确 */
.ratel-chat { ... }
.ratel-message-user { ... }
.ratel-status-line { ... }
.ratel-tool-call { ... }

/* 错误 — 会与 Obsidian 或其他插件冲突 */
.chat { ... }
.message { ... }
.status { ... }
```

## CSS 存放位置

- **默认**：放在 Svelte 组件 `<style>` 块内（配合 `css: 'injected'`）
- **例外**：跨组件全局规则才放 `styles.css`（当前几乎为空）
- 不要为单个组件创建独立 CSS 文件

## 禁止事项

| 禁止 | 原因 |
|------|------|
| shadow DOM / attachShadow | 增加复杂度，破坏主题继承 |
| iframe | 破坏主题一致性，通信复杂 |
| customElements / Web Components | 与 Svelte 组件模型冲突 |
| 硬编码 hex 颜色 | 主题切换（亮/暗/第三方）时失配 |
| box-shadow | 暗色主题不可见 |
| 外部 CSS 框架（Tailwind 等） | 与 Obsidian 主题变量体系冲突 |
| `new Component({target})` | Svelte 5 必须用 `mount(Component, {target, props})` |
| 忘记 `unmount()` | Svelte 5 effect/signal 内存泄漏 |

## Svelte 5 特定约束

- 用 `$state` / `$derived` / `$effect` 替代 Svelte 4 的 `let` / `$:` 响应式
- 事件用 `onclick={handler}` 而非 `on:click={handler}`（Svelte 5 新语法）
- 组件 props 用 `$props()` 而非 `export let`
- `mount()` 和 `unmount()` 是 Svelte 5 生命周期 API，不是 `new` / `$destroy`

## 检查清单

编写或修改 UI 代码时，逐项确认：

- [ ] 所有颜色用 Obsidian CSS 变量（`var(--text-normal)` 等），无硬编码 hex
- [ ] class 名用 `ratel-` 前缀
- [ ] CSS 放 Svelte `<style>` 块内
- [ ] 圆角 ≤ 8px
- [ ] 无 box-shadow
- [ ] 无 shadow DOM / iframe / Web Components
- [ ] Svelte 5 用 `mount()` / `unmount()`，不用 `new` / `$destroy`
- [ ] `onClose()` 调用了 `unmount()`
- [ ] `conditions: ['browser']` 在 esbuild 配置中存在

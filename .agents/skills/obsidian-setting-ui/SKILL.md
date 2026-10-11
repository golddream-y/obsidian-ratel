---
name: obsidian-setting-ui
description: >-
  Ratel 设置页 / Modal 的 UI 开发与排障规范（Setting 框架组件、版本差异、样式实测、Sandbox 验证链）。Use when 新增或修改设置面板/二级页/弹窗、Obsidian 设置页样式异常（贴边、错位、间距不对）、按钮/输入框行为与预期不符，或排查 Obsidian 版本兼容问题。不用于 Svelte 聊天侧栏（走 obsidian-ui skill）。
---

# Obsidian 设置页 UI 开发与排障

> 本文件只记录「框架没有文档、但真实发生过的坑」。每条规则都来自一次实际事故，追加新条目时按「现象 → 根因 → 正确做法」写，不写教科书内容。

## 1. 只用框架组件承载内容（最高频坑）

设置容器的内部 CSS **不是稳定契约**，JS API 才是。

- 设置页 / Modal / `SettingPage.containerEl` 里的一切内容，必须用框架组件：`new Setting(el).setName()/setDesc()/addText()/addButton()/addToggle()`、`setHeading`、`SettingTab` 声明式页面。
- **禁止**往 `.setting-items` / `.setting-group` / `containerEl` 里塞裸 `<p>` / `<div>` / `<h4>` 承载文案或布局。分组标题用 `new Setting().setHeading()`。
- 例外：纯自定义交互（如整个检索列表）可自建宿主，但宿主内部的每个可点行仍用 `Setting`。

### 已知版本差异（minAppVersion 1.13.1）

| | `.setting-items` 卡片内边距 | 结果 |
|---|---|---|
| 1.12–1.13 | `padding: var(--setting-items-padding)`（20px），裸元素也跟着缩进 | 裸 `<p>` 碰巧能看 |
| 1.14+ | 卡片自身 `padding: 0`，内边距下沉到每个 `.setting-item`（`--setting-items-padding-x/y`），行分隔线改为 `.setting-item::before` | 裸元素贴卡片顶/左缘 |

教训：**今天「碰巧能看」的裸 DOM，下次框架改版第一个坏。** 1.13→1.14 这次官方没有任何公告。

## 2. 排障第一步：确认运行时真正加载的 Obsidian 版本

不要分析 `/Applications/Obsidian.app`（那是安装时旧版本）。Obsidian 会热更新，运行时优先加载：

```
~/Library/Application Support/obsidian/obsidian-<version>.asar
```

确认方法：

```bash
ls ~/Library/Application\ Support/obsidian/ | grep asar   # 看实际热更新版本
defaults read /Applications/Obsidian.app/Contents/Info.plist CFBundleShortVersionString  # 安装包版本（可能更旧）
```

两者不一致时，**以 asar 版本为准**。曾因拿 1.12.7 的 app.css 推断 1.14.4 的现象，浪费了一个多小时做版本考古。

## 3. 样式问题先实测，不静态推断

按优先级：

1. **Sandbox DevTools 看计算样式**（`getComputedStyle` / Elements 面板）——两分钟出答案，永远首选。
2. 无法开调试端口时的兜底：解包运行时 asar 的真实 `app.css` + 建静态还原页 + Chrome DevTools MCP 量几何：

```bash
npx asar extract ~/Library/Application\ Support/obsidian/obsidian-<version>.asar ./app
# 建 probe.html：<link app.css> + 插件 styles.css + 目标 DOM 片段，用 MCP new_page/evaluate_script 量 getBoundingClientRect
```

3. 截图像素测量要先算 DPR（Retina 2x；用同一截图内已知框架元素的几何反推），别直接拿截图像素当 CSS px。

## 4. 框架行为陷阱案例库

### 4.1 `setIcon()` 会清空按钮内已有文本节点

- 现象：loading 按钮调 `setButtonText(文案)` 再 `setIcon('loader')`，运行时只剩 spinner，文字和无障碍名都消失。
- 正确做法：先 `setDisabled(true)` → `setIcon('loader')` → 给 svg 加自定义旋转 class（如 `ratel-spin`）→ `createSpan({ text })` 补文字 → `setAttribute('aria-label', text)`。spinner 必须在 `@media (prefers-reduced-motion: reduce)` 下禁用动画。

### 4.2 自研输入弹窗要自己绑回车

- `Modal` + `Setting.addText` 不会自动响应 Enter。
- 绑 `keydown`：`event.key === 'Enter'` 且 **`!event.isComposing`**（中文输入法组词中的回车是选词，不能提交），`preventDefault()` 后走与「确定」按钮同一个 submit 函数（避免两份逻辑副本）。

### 4.3 异步 resolve 后重绘会吞用户输入

- 设置页异步拉名单/配置后，若整体 `host.empty()` 重绘，用户在黑洞网络下正在输入的字段会被清空、丢焦点。
- 做法：宿主拆成「状态行宿主 + 字段宿主」，resolve 后只重画状态行；仅当字段形态真的翻转（如手填变下拉）才重建字段宿主，且焦点还在字段内时等 `focusout` + `setTimeout(0)`（保证 change 先同步落值）再重建，并带 `isConnected` / 防重复守卫。

## 5. 验证链（改完必须走）

1. `npm run lint`（0 error，warnings 只接受既有）+ 定向 `vitest run` + `npm run build`。
2. 确认 Sandbox 插件软链指向**当前 worktree** 的 `dist/`：`ls -l "<sandbox>/.obsidian/plugins/ratel-vault/"`（styles.css 也是软链，不是拷贝）。
3. 让用户 **Reload app without saving**；画面没变先排查软链目标，再怀疑代码。
4. 用户可见文案（name/desc/按钮/Notice/aria-label/placeholder/throw）必须 i18n：`src/i18n/zh.ts` + `en.ts` + `types.ts` 三处同步，跑 `src/i18n/strings.test.ts` 校验 key 集合一致。
5. 禁止把 Sandbox / 主库绝对路径写进受版本控制文件。

## 6. 相关文件

- 设置页渲染：`src/ui/settings/*-render.ts`、`src/ui/settings/*-setting-page.ts`
- i18n：`src/i18n/{zh,en,types}.ts`
- 全局样式：`styles.css`（Svelte 侧栏样式规范见 obsidian-ui skill）
- Sandbox 绝对路径：只查 gitignore 的 `.cursor/rules/*.local.mdc`

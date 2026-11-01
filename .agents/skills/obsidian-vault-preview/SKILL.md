---
name: obsidian-vault-preview
description: 把本地构建链接到 Obsidian 开发预览库并验证 UI 改动的流程（只链 Sandbox，禁止动日常主库）。Use when 需要让 Obsidian 加载当前仓库的构建产物、重载插件、排查「改了没生效」、或判断某次操作会不会污染日常库插件。
---

# Obsidian 预览库链接与重载

> 规则来源：仓库根 `AGENTS.md`「全局底线」第一条；本机路径见仓库根 `AGENTS.local.md`（本地层，不进版本库）。
> 本文只记录「规矩与坑」，不重复 `AGENTS.md` 的原则。

## 1. 铁律：只动开发预览库

- 允许链接、覆盖、重载的只有**开发预览库**（Obsidian Sandbox）。
- **日常主库禁止**：`link:vault`、`cp dist`、覆盖 `main.js`、卸载/升级插件都别做。即使用户说「没变化」，也不要改主库——那是商店安装的那份，改它等于破坏用户环境。
- 本机两个库的具体路径写在仓库根 `AGENTS.local.md`，不要复制进本文件或任何受版本控制的内容。

## 2. 标准流程

```bash
# 1) 先确认链接目标，避免把旧工作树当成当前仓库
ls -l "<sandbox>/.obsidian/plugins/ratel-vault/main.js"
# 必须指向当前仓库的 dist/main.js

# 2) 需要最新构建时先构建
npm run build

# 3) 只对开发预览库链接
npm run link:vault -- "<sandbox>"
```

`<sandbox>` 取 `AGENTS.local.md` 里的开发预览路径。

## 3. 重载：只开新对话不够

- 改完代码要**重载应用**（命令面板 **Reload app without saving**），仅开新会话会继续跑 V8 缓存里的旧 `main.js`。
- 先 `npm run build` 再重载；`npm run dev` 是监听构建，只在需要边改边看时用。

## 4. 已知坑（都发生过）

| 现象 | 根因 | 正确做法 |
|---|---|---|
| 改了代码，预览库没变化 | 预览库还链在旧工作树（如 `.worktrees/feat-xxx`）的 `dist/main.js` | 先 `ls -l` 核对链接目标，指向旧工作树就重新 `link:vault` 到当前仓库 |
| 改了 UI，重载后仍是旧样式 | 只重载了插件、没重载应用，V8 仍用旧 `main.js` | 命令面板执行 Reload app without saving |
| 预览库正常、主库却挂了 | 误把 `dist` 拷到了主库 | 主库一律不碰；已被改动时从主库插件目录恢复商店版本 |
| 链接后插件不加载 | `dist/main.js` 缺失或构建失败 | 先 `npm run build` 看是否成功，再看 Obsidian 控制台报错 |

## 5. 收尾确认

- 改动只在开发预览库生效，不产生任何主库副作用。
- 本次操作没有把本机绝对路径写进受版本控制的文件。

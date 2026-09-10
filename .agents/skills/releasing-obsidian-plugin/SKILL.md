---
name: releasing-obsidian-plugin
description: >-
  Prepares and publishes a Ratel Obsidian plugin GitHub Release (manifest version, changelog vs last tag, lint, tag without v prefix, CI three-file assets). Use when the user asks to 发版, 出包, cut a release, bump manifest version, git tag, or create a GitHub Release for this plugin.
---

# 发版 Ratel（Obsidian 插件）

两阶段：**准备 → 硬停等人审 changelog → 口头「发」之后才 git。** 不要和 finishing-a-development-branch 混用；那条管合分支选项。

用户说发版时，文档确认由本 skill 接管，不要再走一遍 AGENTS.md 绑在 finishing 上的勾选。

## 硬闸

阶段 A 结束必须停，摊出：建议版本、CHANGELOG 全文、文档勾选、lint/构建/测试结论、即将执行的 git。

**用户明确说「发」之前：不 commit、不合 `develop`/`main`、不打 tag、不 push。**

禁止本地 `gh release create` 传 `dist/`（会毁掉 CI attestation）。发版只靠推 tag 触发 `.github/workflows/release.yml`。

## 阶段 A — 准备

### A0. 基线

- 上一正式 tag（`git tag --sort=-v:refname` 或最新 SemVer tag）为**已发布产品**。
- 读 `git log <last-tag>..HEAD` 与未提交 diff。脏工作区先说明会不会进发版提交。
- tag 名 = `manifest.json` 的 `version`，**不带 `v`**。

### A1. STATUS / 归档

- 本版已落地的 plan 标 Completed，不要带着 In Progress 发。
- **不自动归档**；问一句要不要归档。
- 未实现 spec 可以进仓库，changelog **不许写成已发能力**。

### A2. Changelog（相对上一 tag，禁止按 commit 类型机械映射）

参照物是**上一 tag 里用户已经拿到的能力**，不是本分支开发时间线。

对每条用户能感知的变化问：上一版用户会不会碰到？

| 相对上一 tag | 写入 |
|---|---|
| 上一版没有的能力 | **Added**。本周期内该能力上的实现 bug、改交互、补文案全部并入这一条，**不进 Fixed** |
| 上一版就有、这次修好 | **Fixed** |
| 上一版就有、行为改了但不是修 bug | **Changed** |

- `feat` ≠ 一定 Added，`fix` ≠ 一定 Fixed。
- 未发布特性上的修 bug **不能**写成 Fixed（用户会以为旧版也有这个坑）。
- 同一新特性多笔提交合并成**一条**用户语言，不按 commit 堆条目。
- 场景语言：做了什么、以前怎样、现在怎样。禁止模块名、路径、commit 哈希、含糊标题。
- 发版当天顶部就是 `[x.y.z] - 日期`。**不要加空的 `[Unreleased]`。**
- 写完用「外行只读标题」试读；说不清就重写。

例（0.7.0 vs 0.6.1）：`/goal` 整包 Added（含创建确认、满轮加轮）；贴图不再要视觉开关 → Changed；绝对路径不当成 `@` → Fixed（0.6.1 就会踩）。

### A3. 其它文档（按触发勾，不是全改）

| 文档 | 何时动 |
|---|---|
| README + README.zh-CN | 新能力 / 新斜杠 / 安装 / 隐私 |
| user-guide | 斜杠、secret ID、状态条 / 设置 / FAQ |
| architecture / adr | 端口、数据模型、Worker 协议、产物、新硬约束。**改前先问** |
| `docs/prd/overview.md` | 只在产品能力发生可见变化时改「现在有什么」那一句，不写版本对照表 |

本版新用户可见字符串必须已有 zh/en。缺了算准备失败。

### A4. 版本

同步：`package.json`、`manifest.json`、`versions.json`（当前 `minAppVersion`）、`package-lock.json` 根 version。

0.x：feat → minor，fix → patch；用户口头覆盖优先。

### A5. 质量

- `npm run lint`：error 必须清零（含 `eslint-plugin-obsidianmd`，如 `prefer-window-timers`）。
- `node esbuild.config.mjs production`。门禁与 CI 相同：产物不能有 `this.display()`；不能是空 stub `getSettingDefinitions(){return[]}`。
- `npm test` 全跑。只卡**能对上本版 diff** 的失败。sandbox / ONNX 等已知 flake 记一笔不挡。对不上 diff 又不是已知 flake → 停下问用户。
- 隐私：`git grep` 本机路径 / 密钥。changelog 里 `/Users/…` 占位可以。
- 预览可选：只链 Obsidian Sandbox，禁止动日常主库。

## 阶段 B — 用户说「发」之后

1. 提交：`release: X.Y.Z — <changelog 那句用户能看懂的话>`
2. fast-forward `develop` 和 `main`
3. `git tag X.Y.Z`
4. `git push origin main develop <feat-branch> X.Y.Z`
5. 等 workflow `Release Obsidian plugin` 绿
6. 核对 Release：非 draft；附件只有 `main.js`、`manifest.json`、`styles.css`

不包含社区商店 PR。CI 绿了 BRAT 就能拉该 tag。

## 红旗 — 停下

| 借口 | 实际 |
|---|---|
| 先打 tag 再补 changelog | 商店/BRAT 已在拉这个 tag |
| 本地上传 dist 更快 | 签名对不上 |
| 加空 Unreleased 比较规范 | 发版顶部就该是本版 |
| 测试有红就不能发 | 只卡本版能对上的失败 |
| 未发布特性的 fix 写成 Fixed | 相对上一 tag 它是 Added 的一部分 |
| 按 conventional commit 填 changelog | 相对已发布产品分桶 |
| 架构文档顺手改 | 先问 |
| 日常库画面没变去 link | 只动 Sandbox |

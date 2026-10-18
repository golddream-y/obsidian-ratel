# 开发收尾的文档影响检查

> 当代码变更落地后,必须主动评估是否需要同步文档。不靠 git hook,靠规则约束 AI 主动确认。

## 触发时机

每次开发收尾，按本次任务基线到当前提交及拟交付改动检查完整 diff；不局限于 finishing-a-development-branch。发版请求由插件发版 Skill 接管，已有授权直接执行，不重复确认。

## 必做动作

AI 读 `git log <plan-start-commit>..HEAD`,判断这些 commit 是否改变用户可见行为或架构契约。
**若有任何 `feat` / `fix` / `perf` / `refactor` 影响下列触发条件,必须主动向用户确认**:

```
本次变更涉及 X 个 feat/fix,是否需要同步:
  [ ] README(功能清单 / 安装步骤 / 隐私说明)
  [ ] user-guide(操作指引 / 斜杠命令 / secret ID / FAQ)
  [ ] CHANGELOG(下次发版记录,通常由 release 工作流处理,此处仅标记待办)
  [ ] docs/architecture/ / adr/(架构文档 — ⚠️ 改前必须确认,通常不需要)
```

用户勾选后,要么加 Task 到当前 plan 补做,要么登记到 `STATUS.md` 待办区。**不允许跳过确认直接 present options。**

## 各文档触发条件

### README
- 功能清单增减(新工具 / 新斜杠命令 / 新模型适配器)
- 安装步骤变更(新增依赖 / 改 minAppVersion)
- 隐私说明变更(新增外发通道 / 改密钥存储)

### user-guide
- 斜杠命令增减或改名(必须与 `src/ui/chat/input/slash-commands.ts` 一致)
- secret ID 增减或改名(必须与 `src/secrets/ratel-secrets.ts` 一致)
- 状态条 / 诊断面板 / 设置面板的用户可见行为变更
- 新增 FAQ 候选(同类 issue 反复出现)

### CHANGELOG

**写给谁:** 使用 Ratel 的人。本文件必须达到「打开就能看懂自己多了什么能力」的标准。

**写什么:**
- 这个版本让你**多了什么能力**、**好了什么体验**(场景语言:做了什么、以前怎样、现在怎样)
- 用 Added / Changed / Fixed / Removed 分类([Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/));SemVer

**不写什么(禁止出现在 CHANGELOG 正文):**
- 写作规范自述、「读者是谁」、内部流程说明(规范只放对应 Skill)
- 文件路径、模块名、commit 哈希、内部重构口号
- 含糊标题(如「多步更稳」「体验优化」)— 必须写清**用户能感知的具体变化**

**发版节奏:**
- 通常在 release 时把 `[Unreleased]` 收成 `[x.y.z] - 日期`
- 例外:BREAKING CHANGE 必须立即在 `[Unreleased]` 补一行,不能等到发版

**自检:** 写完后用「外行用户只读标题」试读 — 若说不清优化了什么,重写该条。

### docs/architecture/ / adr/(⚠️ 谨慎,改前必须确认)
**触发条件(满足任一即需评估):**
- 新增 / 删除 / 重命名核心模块(`ports/` / `adapters/` / `core/` / `worker/` / `ui/` 子系统目录)
- 跨线程通信协议变更(主线程 ↔ Worker 消息类型 / payload)
- 数据模型变更(`MessageSegment` / `Message` / `AgentEvent` / `ChatDelta` 等判别联合或接口)
- 构建产物变更(新增 / 删除 `dist/` 下文件,改 esbuild 配置)
- 端口接口契约变更(`ports/` 下任意接口增减方法)

**不触发(普通 feat 不动架构文档):**
- 加单个工具(`tools/` 下新增文件)
- 加单个 UI 组件(`ui/` 下新增文件,不新增子系统目录)
- 改文案 / 改样式 / 改 i18n 文本
- 内部重构不改变模块边界与接口契约

**adr/ 触发条件:**
- 做了非显然的技术选型决策(如"tag 不带 v 前缀")
- 推翻了之前 ADR 的结论
- 引入了新的硬约束(如本"文档同步规则")

## 执行入口

本参考由开发工作流 Skill 在收尾时读取，不依赖某个特定收尾工具才生效。

发版时 CHANGELOG 的版本范围与条目收集以插件发版 Skill 为准；不创建空的 Unreleased 章节。

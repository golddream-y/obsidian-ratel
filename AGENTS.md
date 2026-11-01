# Ratel Vault — 工程入口

Ratel 是面向 Obsidian 知识库的 Agent Harness，使用 TypeScript、Svelte 5、esbuild 和 npm，桌面端运行。代码入口为 `src/main.ts`。

## 指令发现与跨 Agent 兼容

- 指令事实源是 `AGENTS.md` 家族：仓库根一份，子目录（`src/`、`src/worker/`、`src/ui/`、`docs/`）各一份。子树规则只作用于该目录及其后代，不扩散到兄弟目录；宿主按「项目根 → 当前工作目录」逐层加载，触达更深目录后补齐，未自动注入时显式读取。
- 本机私有路径与库名只写在仓库根 `AGENTS.local.md`（本地层，不进版本库），不得复制进受版本控制的内容。
- `.cursor/rules/*.mdc` 是 Cursor 的兼容副本，仅在 Cursor 中工作时另读；它不是事实源，两处不一致时以 `AGENTS.md` 为准。
- 优先级：用户与系统直接指令 > 项目文件；同目录 `AGENTS.override.md` 优先于 `AGENTS.md`。
- Skill 名称可被发现不代表正文已读取。命中下表触发条件时加载对应 `SKILL.md`，再按它的说明按需读取参考文件；不能只凭名称执行。

## 常用命令

依赖 `npm install`；构建 `npm run build`（监听 `npm run dev`）；检查 `npm run typecheck`、`npm run lint`；测试 `npm test`。跑哪几条、按改动范围怎么取舍见 [开发工作流 Skill 的命令参考](.agents/skills/ratel-development-workflow/references/commands.md)；发版门禁见 [发版 Skill](.agents/skills/releasing-obsidian-plugin/SKILL.md)。

## 全局底线

- 仅对 Obsidian Sandbox 预览、链接和覆盖插件，禁止操作日常库插件；本机位置见 `AGENTS.local.md`，流程见 [obsidian-vault-preview](.agents/skills/obsidian-vault-preview/SKILL.md)。
- 禁止提交本机绝对路径、私人库名、密钥、密码、token、`.env`、`data.json` 或本机文件链接；示例用 `<repo-root>`、`<sandbox>` 等占位。公开身份与项目地址可以记录。
- 不引入原生模块；Obsidian API 访问走端口边界。Worker 的能力与限制见 [src/worker/AGENTS.md](src/worker/AGENTS.md)。
- 无遥测、无数据收集；本地保存不等于远端聊天离线。模型端点、可选 MCP、生态操作、资源下载与目录刷新均须如实说明网络边界，新增外发目的地不得隐瞒。
- `manifest.id` 固定 `ratel-vault`；`minAppVersion` 必须符合实际依赖；发布只交付 `main.js`、`manifest.json`、`styles.css`，tag 与版本号规则见 [发版 Skill](.agents/skills/releasing-obsidian-plugin/SKILL.md)。

## 开发期工具与产品机制的边界

宿主提供的 `/goal`、`/plan`、`todo_write`、`subagent`、`workflow`、`skill` 等是**开发期**工具，与 Ratel 产品内部的 goal 模式、Skill 机制、MCP、子代理不是同一套实现。改产品代码时以 `src/` 内既有契约与测试为准；不要用宿主同名机制替代仓库实现，也不要把宿主语义写进产品文档或用户可见文案。

## Skill 发现入口

执行规则以对应 Skill 为准，本表只说明何时加载，不复制流程。宿主会自动发现 `.agents/skills/` 下的技能目录，表的用途是说明触发语义，不影响发现。第三方 Skill 保留上游语言、许可证与来源元数据，登记见 [.agents/skills/THIRD-PARTY.md](.agents/skills/THIRD-PARTY.md)。

| 触发条件 | Skill |
|---|---|
| 新增/调整需求、阶段确认、需求文档/spec、plan 执行、验证/合并/发布、归档或暂缓重开 | [项目管理](.agents/skills/ratel-project-management/SKILL.md) |
| 开始编码、修复、重构、审查、验证或开发收尾 | [开发工作流](.agents/skills/ratel-development-workflow/SKILL.md) |
| 编写/修改源码、测试、配置代码或代码审查 | [编码约定](.agents/skills/ratel-code-conventions/SKILL.md) |
| 发版、出包、升级版本、打 tag 或 GitHub Release | [插件发版](.agents/skills/releasing-obsidian-plugin/SKILL.md) |
| 修改 Obsidian 设置页、SettingPage 导航或连接测试界面 | [设置界面](.agents/skills/obsidian-setting-ui/SKILL.md) |
| 链接或重载 Obsidian 预览库插件、验证 UI 改动 | [预览库链接](.agents/skills/obsidian-vault-preview/SKILL.md) |
| GitHub CLI 操作与 API 查询 | [官方 gh](.agents/skills/gh/SKILL.md) |

## 目录与知识入口

- 源码通用约束：[src/AGENTS.md](src/AGENTS.md)；Worker：[src/worker/AGENTS.md](src/worker/AGENTS.md)；UI：[src/ui/AGENTS.md](src/ui/AGENTS.md)。
- 文档约束：[docs/AGENTS.md](docs/AGENTS.md)；文件导航：[工程目录](docs/contributing/project-layout.md)。
- 产品与架构：[产品总纲](docs/prd/overview.md)、[2.0 需求草案](docs/prd/2.0/README.md)、[架构总览](docs/architecture/overview.md)。
- spec/plan 活跃项以 [STATUS](docs/superpowers/STATUS.md) 为准，历史入口为 [ARCHIVE](docs/superpowers/ARCHIVE.md)；登记和归档的操作规则在项目管理 Skill 中。

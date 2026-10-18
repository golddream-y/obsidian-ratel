# Ratel Vault — 工程入口

Ratel 是面向 Obsidian 知识库的 Agent Harness，使用 TypeScript、Svelte 5、esbuild 和 npm，桌面端运行。代码入口为 `src/main.ts`。

## 指令发现与跨 Agent 兼容

- 开始任何任务前，读取 `.cursor/rules/*.mdc`，包括被忽略的 `*.local.mdc`；`alwaysApply: true` 始终生效。本地规则中的私人路径和库名不得复制进受版本控制内容。
- **读取、分析或修改某个目录及其文件前，检查并加载从仓库根到目标目录沿途各级 `AGENTS.md`，将其作为当前任务指令上下文；进入新的子目录时重复检查。工具未自动发现或注入时，必须显式读取，不能假定已加载。**
- 子目录规则只作用于该目录及其后代，不扩散到兄弟目录。多目录任务分别加载各自规则；同目录的 `AGENTS.override.md` 存在时优先于 `AGENTS.md`。系统、开发者和用户直接指令优先于项目文件，兼容工具差异不改变此优先级。
- Skill 名称可被发现不代表正文已读取。命中下表触发条件时加载对应 `SKILL.md`，再按它的说明按需读取参考文件；不能只凭名称执行。

## 常用命令

| 工作 | 命令 |
|---|---|
| 安装依赖 | `npm install` |
| 监听构建 | `npm run dev` |
| 生产构建 | `npm run build` |
| 类型检查 | `npm run typecheck` |
| 静态检查 | `npm run lint` |
| 测试 | `npm test`；变更验证按工作流选择定向范围 |

## 全局底线

- 仅对 Obsidian Sandbox 预览、链接和覆盖插件，禁止操作日常库插件；具体本机位置只读 `.cursor/rules/*.local.mdc`。预览流程见已要求读取的 `.cursor/rules/obsidian-vault-link.mdc`。
- 禁止提交本机绝对路径、私人库名、密钥、密码、token、`.env`、`data.json` 或本机文件链接；示例用 `<repo-root>`、`<sandbox>` 等占位。公开身份与项目地址可以记录。
- 保持无原生模块；Obsidian API 访问通过项目外观/端口边界。Worker 不导入 `obsidian`，不同 Worker 的 Node/网络限制见对应目录规则。
- 无遥测、无数据收集；本地保存不等于远端聊天离线。模型端点、可选 MCP、生态操作、模型/运行时资源下载和模型目录刷新均须如实说明网络边界，新增外发目的地不得隐瞒。
- `manifest.id` 固定为 `ratel-vault`；桌面限制和 `minAppVersion` 必须符合实际依赖。发布只交付 `main.js`、`manifest.json`、`styles.css`，tag 与 manifest 版本一致且不带 `v`。
- 项目自写文档、注释与测试描述使用中文，标识符和协议名保持英文；第三方 Skill 保留上游语言、许可证和来源元数据。

## Skill 发现入口

执行规则以对应 Skill 为准，本表只说明何时加载，不复制流程。

| 触发条件 | Skill |
|---|---|
| 新增/调整需求、阶段确认、需求文档/spec、plan 执行、验证/合并/发布、归档或暂缓重开 | [项目管理](.agents/skills/ratel-project-management/SKILL.md) |
| 开始编码、修复、重构、审查、验证或开发收尾 | [开发工作流](.agents/skills/ratel-development-workflow/SKILL.md) |
| 编写/修改源码、测试、配置代码或代码审查 | [编码约定](.agents/skills/ratel-code-conventions/SKILL.md) |
| 发版、出包、升级版本、打 tag 或 GitHub Release | [插件发版](.agents/skills/releasing-obsidian-plugin/SKILL.md) |
| 修改 Obsidian 设置页、SettingPage 导航或连接测试界面 | [设置界面](.agents/skills/obsidian-setting-ui/SKILL.md) |
| GitHub CLI 操作与 API 查询 | [官方 gh](.agents/skills/gh/SKILL.md) |

## 目录与知识入口

- 源码通用约束：[src/AGENTS.md](src/AGENTS.md)；Worker：[src/worker/AGENTS.md](src/worker/AGENTS.md)；UI：[src/ui/AGENTS.md](src/ui/AGENTS.md)。
- 文档约束：[docs/AGENTS.md](docs/AGENTS.md)；文件导航：[工程目录](docs/contributing/project-layout.md)。
- 产品：[产品总纲](docs/prd/overview.md)、[2.0 需求草案](docs/prd/2.0/README.md)；架构：[架构总览](docs/architecture/overview.md)。
- spec/plan 活跃项以 [STATUS](docs/superpowers/STATUS.md) 为准，历史入口为 [ARCHIVE](docs/superpowers/ARCHIVE.md)；登记和归档的操作规则在项目管理 Skill 中。

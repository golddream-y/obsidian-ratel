# 第三方技能来源与许可证登记

本目录同时存放本仓库自写技能与第三方技能。本文件登记第三方技能的**上游来源、上游路径、许可证**以及**本次从 Trae 技能目录迁入 DSH 原生技能目录时所做的适配**，便于审计与后续升级。

- 第三方技能正文保留上游语言（英文）、流程与判断逻辑，本次只做工具名与路径层面的适配。
- 每个上游技能目录内均放置上游许可证全文副本 `LICENSE.txt`。
- 适配的完整对照见 [using-superpowers/references/dsh-tools.md](using-superpowers/references/dsh-tools.md)。

## 上游 obra/superpowers（MIT）

上游仓库：<https://github.com/obra/superpowers>（许可证：MIT，版权归上游作者 Jesse Vincent）
上游许可证全文副本：各技能目录下的 `LICENSE.txt`。

| 技能名称 | 上游路径 | 许可证 | 本次适配 | 迁移来源 |
|---|---|---|---|---|
| `brainstorming` | `skills/brainstorming/SKILL.md` | MIT | 派子代理模板改为 `subagent` 语义；可视化伴随文档中的启动平台段落改为 DSH，命令执行与文件写入改用 `bash` / `write` 工具；同级参考文件路径改为 `.agents/skills/brainstorming/visual-companion.md` | `.trae/skills/brainstorming` |
| `dispatching-parallel-agents` | `skills/dispatching-parallel-agents/SKILL.md` | MIT | 并行派发示例由上游的子代理调用写法改为 `subagent(...)`；示例注释的平台标注改为 DSH | `.trae/skills/dispatching-parallel-agents` |
| `executing-plans` | `skills/executing-plans/SKILL.md` | MIT | 清单跟踪改用 `todo_write`；被引用技能去掉插件命名空间前缀，改为 DSH 直接可用的技能名；平台表述改为 DSH | `.trae/skills/executing-plans` |
| `finishing-a-development-branch` | `skills/finishing-a-development-branch/SKILL.md` | MIT | 仅迁移位置，正文未作工具名改写（本仓库此前已按仓库规范做过本地化） | `.trae/skills/finishing-a-development-branch` |
| `receiving-code-review` | `skills/receiving-code-review/SKILL.md` | MIT | 项目指令文件由上游的 Claude 约定文件改为本仓库的 `AGENTS.md` | `.trae/skills/receiving-code-review` |
| `requesting-code-review` | `skills/requesting-code-review/SKILL.md` | MIT | 派发审查子代理改用 `subagent` 工具；审查者模板头部去掉上游的代理类型参数 | `.trae/skills/requesting-code-review` |
| `subagent-driven-development` | `skills/subagent-driven-development/SKILL.md` | MIT | 清单跟踪改用 `todo_write`（含流程图标签）；三份子代理提示词模板头部改为 `subagent`；被引用技能去掉插件命名空间前缀 | `.trae/skills/subagent-driven-development` |
| `systematic-debugging` | `skills/systematic-debugging/SKILL.md` | MIT | 创建日志中的用户级指令文件路径改为 `~/.dsh/AGENTS.md`；被引用技能去掉插件命名空间前缀 | `.trae/skills/systematic-debugging` |
| `test-driven-development` | `skills/test-driven-development/SKILL.md` | MIT | 仅迁移位置，正文未涉及平台专有工具名 | `.trae/skills/test-driven-development` |
| `using-git-worktrees` | `skills/using-git-worktrees/SKILL.md` | MIT | 仅迁移位置，正文未涉及平台专有工具名 | `.trae/skills/using-git-worktrees` |
| `using-superpowers` | `skills/using-superpowers/SKILL.md` | MIT | 技能调用改用 `skill` 工具、技能文件读取改用 `read` 工具；清单跟踪改用 `todo_write`；进入计划模式改写为 DSH 计划模式（`/plan` 命令，退出用 `exit_plan_mode`）；项目指令文件改为 `AGENTS.md`；三份平台对照参考文件的「技能引用」列改为 DSH 工具名；新增 `references/dsh-tools.md` 作为 DSH 工具对照 | `.trae/skills/using-superpowers` |
| `verification-before-completion` | `skills/verification-before-completion/SKILL.md` | MIT | 仅迁移位置，正文未涉及平台专有工具名 | `.trae/skills/verification-before-completion` |
| `writing-plans` | `skills/writing-plans/SKILL.md` | MIT | 计划审阅模板头部改为 `subagent`；被引用技能去掉插件命名空间前缀 | `.trae/skills/writing-plans` |
| `writing-skills` | `skills/writing-skills/SKILL.md` | MIT | 清单跟踪改用 `todo_write`；个人技能目录由上游的 Claude 约定目录改为 `~/.dsh/skills`；项目约定文件改为 `AGENTS.md`；示例文件重命名为 `examples/AGENTS_MD_TESTING.md` 并同步改写；被引用技能去掉插件命名空间前缀 | `.trae/skills/writing-skills` |

## 本仓库自写技能（非第三方）

以下技能由本仓库维护，**不适用**上游许可证，因此目录内不放上游 `LICENSE.txt`；来源说明写在各自的 `PROVENANCE.md`。

| 技能名称 | 归属 | 本次适配 | 迁移来源 |
|---|---|---|---|
| `obsidian-ui` | 本仓库自写（Obsidian 插件 UI 开发规范，中文正文） | 仅迁移目录位置与相对路径，正文未改写 | `.trae/skills/obsidian-ui` |

## 其他既有第三方技能

`frontend-design` 与 `gh` 保持原状，来源与许可证记录见仓库根的 `skills-lock.json` 及各自目录下的 `LICENSE.txt`；本次迁移未改动其内容。

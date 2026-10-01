# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.1%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**Ratel 是 Obsidian 里的一个 Agent。说一句你要的用法，它把对应的插件、模板和目录装进当前库。**

Obsidian 难的地方不在记笔记，在配置。Templater 的语法、Dataview 的查询、Day Planner 的格式，各学一遍就足够劝退。你在对话里说一句，Ratel 去装插件、写模板、把目录指好。

[使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) · [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md)

## 别人配好的环境，一句话搬进你的库

说「装日记插件」。Ratel 会装上 Templater、Dataview 和 Day Planner，写好日记模板和月报模板，把核心日记指到同一个目录，并记住这些目录在哪。

> 改完 Day Planner 的标题格式后，需要完全退出 Obsidian 再打开，才会生效。

这套配置叫场景技能，就是一个 Markdown 文件夹。你把自己验证过的做法写成技能，发给别人；对方放进自己的库，就得到同一套插件、模板和路径。写法见 [场景技能手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md)。

这里放一段短录屏：从说出「装日记插件」，到模板出现在库里。

## 快速开始

1. Obsidian → **设置** → **社区插件** → **浏览**，搜索 **Ratel**，安装并启用。
2. **设置 → Ratel → 对话模型**。选 DeepSeek 或本机 Ollama，或填写自己的接口地址。
3. 等首次索引完成。点左侧的獾，或按 `Cmd/Ctrl+P` 运行 **Ratel: Ask vault**。

需要 **Obsidian 1.13.1 以上**，仅桌面端。

## 为什么不用现成的

社区里已经有能和笔记库对话的插件。Ratel 的区别是：

> 多数插件帮你问笔记库。Ratel 还能把 Obsidian 配好。

问答是它的能力之一。难复制的是环境本身：装哪些插件、改哪些设置、模板和目录放在哪，并且能把这套已经验证过的环境收成一个文件夹交给别人。

如果只是想和笔记聊天，现成插件已经够用。如果卡在配置上，或想把一套工作方式完整交给别人，Ratel 是为这件事做的。

## 需要什么

| | |
|---|---|
| 对话模型 | 使用云端模型时，需要你自己的 API Key。Ratel 不代填其他插件的密钥，也不把密钥写入插件配置或随库同步。 |
| 不另收费 | 本机 Ollama 可以离线对话。嵌入默认在本机生成。Ratel 本身不收费，也没有付费功能。 |
| 接口费用 | 以你所选模型的官方定价为准。 |

## 隐私与数据边界

- 向量索引默认在本机生成，不上传。
- 检索到的笔记文本只发往你配置的模型端点。外部工具仅在该工具已启用、并且本次真的调用时出站。安装社区插件时，只访问官方插件目录和该插件的 GitHub release。
- 密钥保存在系统钥匙串。不写入插件配置，不随库同步。
- 没有遥测。
- 改笔记和装插件按你设的权限执行。三档是安全、自动、危险。每个工具还可以单独设成允许、询问或拒绝。设成拒绝之后，权限档和本会话的授权都不能绕过。
- 读取库外文件和运行本机命令默认关闭。对话不能代开这个开关。打开之后，读到的内容仍可能发给已配置的模型，每次使用另行确认。

## 库内能力

搜索同时看语义、关键词、链接、反链和属性。回答里的 `[1]`、`[2]` 可以打开原笔记里的标题或块。当前笔记、最近修改和标题大纲会作为上下文。

检索、阅读和归纳之后如果要改笔记，仍受上面的权限约束。

跨会话目标、技能脚本和外部工具见 [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 对话、斜杠命令与常见问题 |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 已发布版本的变更 |
| [产品总纲](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/prd/overview.md) | 产品范围与后续方向 |
| [场景技能手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md) | 把一套环境打包给他人 |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | 模块边界与运行结构 |

问题和建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

## 赞助

可选。赞助不改变插件里的任何功能。

- 爱发电：[afdian.com/a/golddream](https://afdian.com/a/golddream)
- Ko-fi：[ko-fi.com/golddream_y](https://ko-fi.com/golddream_y)

详见 [赞助页](https://github.com/golddream-y/obsidian-ratel/blob/main/SPONSOR.zh-CN.md)。

## 许可

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

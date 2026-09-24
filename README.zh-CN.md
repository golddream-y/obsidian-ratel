# Ratel

[English](https://github.com/golddream-y/obsidian-ratel/blob/main/README.md) | [简体中文](https://github.com/golddream-y/obsidian-ratel/blob/main/README.zh-CN.md)

[![License](https://img.shields.io/github/license/golddream-y/obsidian-ratel?style=flat-square)](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B-7c3aed?style=flat-square)](https://obsidian.md)
[![仅桌面](https://img.shields.io/badge/平台-桌面端-0ea5e9?style=flat-square)](https://obsidian.md)

**Ratel 是 Obsidian 里的 Agent。它让 Obsidian 的使用和配置更加简单。**

一个使用者可以把自己的工作方式放进一个技能：装哪些插件、怎么设置、目录放哪。另一个人说出用法，Ratel 就按这个技能把同样的环境装好，并记住目录。在这个库里，它也能按语义和链接找到写过的内容，并按权限改笔记。

[使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) · [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md)

## 复制一套别人的最佳工作方式

技能里写的是一个使用者已经验证过的做法：装哪些插件、写哪些模板、打开哪些开关、目录放在哪。运行这个技能，就把这套环境复制到当前库。

日记和月度任务是内置的两个例子：

```text
装日记插件
```

这一次会安装 Templater 和 Dataview，写入日记模板和月报模板，并把核心日记指到同一目录。日记目录和月任务目录会写入记忆，之后的新对话直接使用。

开发者可以按 [场景技能手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md) 把自己的工作方式写成技能。技能是 Markdown，可以随库分发。

## 找到写过的东西

按语义、关键词和笔记之间的链接查找。回答中的 `[1]`、`[2]` 可打开原笔记。当前笔记、最近修改和标题大纲会作为上下文。按标题或块打开笔记。

## 让 Agent 在库里做事

- 检索、阅读、归纳，并按权限写入笔记。
- 长期目标跨对话还在。创建前先确认完成标准；底栏会提醒，新对话可以接着做。

## 扩展

- **模型**：对话、嵌入、重排可以分开选。支持 DeepSeek、Claude、Ollama 和兼容端点。索引默认在本机生成。
- **Skill**：用 Markdown 写可复用的做法，可带脚本和参考资料。
- **MCP**：接入网页搜索等外部工具。服务器和工具分别授权。
- **Subagent**：把检索、审查、整理拆开做。
- **图片**：对话可附图片。
- **提示词**：按区段覆盖默认提示词，不必 fork 插件。

## 还没有

- 到点查看日记和目标，并在值得说时提醒。结果进入收件箱，高优先级才弹出 Notice。支持安静时段、每日上限、稍后和忽略。通知不能绕过写入权限。
- 自动列出断链、孤儿笔记、重复和过时内容。
- 从多篇笔记归纳主题、冲突和缺口。
- 黑名单。落地后，被排除的内容不会进入索引、模型上下文、MCP 参数、日志或通知。

## 隐私与安全

- 索引和记忆保存在本机。
- 只有配置的模型端点会收到检索内容。
- MCP 只在调用已启用的工具时出站。安装插件时只访问官方清单和所选插件的 GitHub release。
- 改笔记、装插件按权限档位。密钥不代填。没有遥测。

细节见 [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md)。

## 安装

1. Obsidian → **设置** → **社区插件** → **浏览**，搜索 **Ratel**，安装并启用。
2. **设置 → Ratel → 对话模型**，选择 DeepSeek / Ollama 预设或填写自定义接口。
3. 等待首次索引完成。点击侧栏 🦡，或运行 **Ratel: Ask vault**。

需要 **Obsidian 1.13.0+**，**仅桌面端**。

## 文档

| 文档 | 内容 |
|---|---|
| [产品总纲](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/prd/overview.md) | 产品定位、完整能力与发展方向 |
| [使用手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/user-guide.md) | 上手、斜杠命令、FAQ |
| [更新日志](https://github.com/golddream-y/obsidian-ratel/blob/main/CHANGELOG.md) | 完整发版历史 |
| [架构](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/architecture/overview.md) | 端口、Agent Loop、工具与 Worker |
| [场景技能手册](https://github.com/golddream-y/obsidian-ratel/blob/main/docs/contributing/scene-skill.md) | 开发者如何把自己的工作方式写成一个技能 |

问题与建议：[GitHub Issues](https://github.com/golddream-y/obsidian-ratel/issues)。

## 赞助

自愿，不影响任何功能。

- 爱发电：[afdian.com/a/golddream](https://afdian.com/a/golddream)
- Ko-fi：[ko-fi.com/golddream_y](https://ko-fi.com/golddream_y)

说明见 [赞助页](https://github.com/golddream-y/obsidian-ratel/blob/main/SPONSOR.zh-CN.md)。

## License

[Apache-2.0](https://github.com/golddream-y/obsidian-ratel/blob/main/LICENSE)

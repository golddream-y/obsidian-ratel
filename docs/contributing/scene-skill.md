# 场景安装技能：二开手册

读者：给 Ratel 写「按一个 Obsidian 场景，一次装好并配好」技能的人。本文规定技能包怎么放、模型按什么协议执行、哪些宿主写盘是允许的。日记场景是对照实现，不是唯一场景。

产品需求见 [prd/ecosystem.md](prd/ecosystem.md)。执行层边界见 [architecture/host/ecosystem.md](architecture/host/ecosystem.md)。

## 1. 交付物

一个技能目录，至少包含 `SKILL.md`。

```
<skillDir>/
  SKILL.md          # 流程。注入模型的正文上限 8KB（UTF-8），超出从末尾截断
  <id>.yaml         # 可选。与 SKILL.md 同级，描述要改的 data.json 键。不放进 references/
  references/       # 可选。只有 read_skill_reference 能读。同级 yaml 不在这里
```

`SKILL.md` 前置：

| 字段 | 要求 |
|---|---|
| `name` | 斜杠菜单上的名字，与目录名一致 |
| `description` | 何时启用。写触发说法，不写实现步骤 |
| `activation` | `auto` 才会出现在 `/` 菜单 |
| `tags` | 检索用 |

YAML 与 `SKILL.md` 同级时，构建会把它打进内置包。模型不要为了读它调用 `read_skill_reference`。那个工具只打开 `<skillDir>/references/<path>`。

内层要贴 Markdown 模板时，外层围栏用 `~~~~markdown`，避免和模板里的 ` ``` ` 抢围栏。用法说明、确认清单写在模板前面，截断时先保住流程。

## 2. 安装技能和使用技能分开

| | 安装技能 | 使用技能 |
|---|---|---|
| 触发 | 「装上这个场景」 | 用户当天要办的事 |
| 允许 | `install_plugin`、`configure_plugin`、写模板、点名宿主设置、创建场景必需的目录 | `read_note`、`write_note`，按已存在的路径工作 |
| 禁止 | 替用户写当天的正文 | `get_plugin_status`、`install_plugin`、`configure_plugin` |

使用技能发现模板或开关没生效时，用一句话指向安装技能，不在使用技能里补装。

安装技能结束时用固定的两三句告诉用户怎么开始：使用技能的 `/name`，以及可以直接说的话。不要再打开一轮设置确认。

## 3. 执行协议

1. 同一次确认里列出将要做的事项。路径、是否翻译，放在这一次里问。
2. 用户同意后按清单做完。不要再写「确认执行吗」。
3. 已存在的插件、模板、键跳过。不覆盖已有模板正文。
4. 内置工具默认允许。用户后来把某个工具改成询问或拒绝时，权限卡片仍会出现。这是 harness 门，不是技能里的第二轮确认。

## 4. 工具契约

技能正文写清插件 id、键、值。Ratel 不维护按插件的配置档案，也不要另做匹配器决定补丁。

| 工具 | 契约 |
|---|---|
| `install_plugin` | `pluginId` 必须在官方社区清单内。只装缺的。不装 `ratel-vault`。 |
| `configure_plugin` | `op: "inspect"` 只读。`op: "apply"` 对 `plugins/{id}/data.json` 做点号路径叶子写入。新键列入 `confirmedNewKeys`。单次最多 20 个键，路径最多 6 段，禁止数组下标。键名命中 `token` / `secret` / `password` / `apiKey` / `webhook` / `cookie` 拒绝。不整份覆盖。 |
| `write_note` | 模板不存在才写。 |
| `get_app_config` | `config.language` 为 `auto` \| `zh` \| `en`。`config.dailyNoteFolder` / `dailyNoteFormat` 是 Ratel 自己的设置，只支持 `YYYY` / `MM` / `DD` 替换，不是 Obsidian 核心日记的 moment 格式。 |
| `apply_diary_host` | 仅日记场景。见第 6 节。其它场景不要调用。 |
| `update_app_config` | 只改白名单里的 Ratel 设置。核心日记文件不走这个工具。 |

`configure_plugin` 写完 `data.json` 之后，已经加载的插件内存不会跟着变，之后还可能把旧值写回磁盘。开关若必须立刻生效，要写到该插件正在运行的 settings 并调用它的保存，或使用已经封装好的宿主工具。

## 5. 宿主写盘边界

允许：

- `plugins/{id}/data.json` 的叶子字段，`id` 不是 `ratel-vault`，且在清单内或已安装。
- 点名核心文件。目前只有 `{configDir}/daily-notes.json` 的 `folder`、`template`，以及格式规则见第 6 节。
- 插件自己的 localStorage 键。Templater 的「新建文件时触发」是 `templater-local-settings.trigger_on_file_creation`，不在 `data.json`。

不允许：

- `app.json`、`appearance.json`、`hotkeys.json`、主题。这些只在技能里写操作说明。
- 密钥、`shell_path`、`user_scripts_folder`、用户脚本。
- 模型自选的任意路径。目录由用户在第一次确认里选定。可以给建议值，问要不要换。同意之后再写配置。
- 宿主要求目录先存在时，安装技能创建该目录。不要把「请用户自己去建文件夹」留在确认之后。

## 6. 日记场景的路径契约

核心日记按 `{folder}/{format}.md` 创建文件。`format` 里的 `/` 是子目录。默认 `YYYY-MM-DD` 会把文件放在日记根下，与月份目录并列。这是错误结果。

`apply_diary_host` 在 `format` 缺失或仍为 `YYYY-MM-DD` 时，写成：

```text
YYYY/MM-MMMM/YYYY-MM-DD-dddd
```

Obsidian 按界面语言设置 `moment.locale`（简体中文对应 `zh-cn`）。因此：

- 简体中文：`2026/09-九月/2026-09-24-星期四.md`
- 英文：`2026/09-September/2026-09-24-Thursday.md`

不要把「九月」「星期四」写进 `format` 字符串。`MMMM` / `dddd` 由 moment 渲染。用户已经设置过其它 format 时保留，不覆盖。

月度笔记目录必须使用同一次 `moment` 的 `MMMM`，与上面的 format 落在同一个月份文件夹。模板里写死中文月名，会在英文界面下和日记文件分成两个目录。

日记根下已经存在平铺的 `{YYYY-MM-DD}.md` 时，安装技能把它搬进月份目录后删除原文件。核心日记下次仍按 format 查找；只搬文件、不改 format，第二天会再在根上创建一份。

路径确定后写入全局记忆，避免每个新会话重新找目录。`remember` 的 `type` 为 `global`，`section` 为 `日记 [pinned]`（`[pinned]` 保证每次会话都注入）。一条写清日记目录和月任务台账路径。使用技能先读这条记忆，没有才定位，定位后再写入。相同路径不重复写。

## 7. 语言

只写在技能正文里：

| `config.language` | 行为 |
|---|---|
| `zh` | 按技能中的标题和提示写入，不问翻译 |
| `en` | 同一次确认里询问是否把标题和提示译成英文。Templater、dataviewjs、路径、文件名不译 |
| `auto` | 本条用户消息为中文则按 `zh`，为英文则按 `en` |

不整篇改写已有正文。

## 8. 对照实现

| 文件 | 职责 |
|---|---|
| `src/skills/builtin/install-diary-plugins/SKILL.md` | 安装与宿主设置 |
| `src/skills/builtin/diary-month-ledger/SKILL.md` | 晨间、收尾、月末 |
| `src/adapters/diary-host.ts` | `apply_diary_host` 的写盘 |
| `plugin-profiles/calendar-week-start.yaml` | 只改一个 `data.json` 叶子的档案示例，不是内置技能 |

当前内置技能三份：`ratel-config`、`install-diary-plugins`、`diary-month-ledger`。

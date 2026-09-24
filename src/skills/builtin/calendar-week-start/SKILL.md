---
name: calendar-week-start
description: 把社区插件 Calendar 的一周起始设为周一。用户说「日历从周一开始」时激活。
activation: auto
tags: [calendar]
---

# Calendar 周一开始

本技能的做法已全部写在下面。`weekStart: 1` 就是要写入的改动。不要调用 `read_skill_reference`：同目录的 yaml 不是 `references/` 里的参考文件，那个工具读不到它。

## 流程

对话里只确认一次。先查清现状，把将要做的几件事一次说清；用户同意后连续做完，不要每做完一件再问。

1. 用 `get_plugin_status` 看 `calendar`。这一步只读，不必先问。
2. 用一两句话列出清单，并写出件数。用户没同意就停。
   - 未安装：两件事。安装官方社区插件 Calendar，然后把 `weekStart` 设为 `1`（周一开始）。
   - 已安装但版本低于 YAML 的 `pluginVersionRange`：两件事。先升级，再把 `weekStart` 设为 `1`。
   - 已安装且版本够：一件事。只把 `weekStart` 设为 `1`。已经安装则不要再安装。
3. 用户同意后按清单做完，中间不再写「确认执行吗」。需要时 `install_plugin` 或 `update_plugin`，然后 `configure_plugin`：`pluginId` 为 `calendar`，`patch` 只含该 preset 的 `weekStart: 1`。用户拒绝升级则不要配置。

## 红线

- 不改 `forbid` 里的字段，不代填密钥。
- 不整份覆盖 `data.json`。
- 不用技能脚本写配置目录。

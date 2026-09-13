# 能力接口手册（场景作者）

面向要把一套工作流写成 Ratel **场景 Skill** 的人。不是架构正文，也不替代设置面板。

Ratel 版本以 `manifest.json` 的 `version` 为准。改了工具名必须改本手册。

## 1. 场景 Skill 是什么

场景仍是 `kind=skill` 的 `SKILL.md`，和普通 SOP 同一套发现 / `activate_skill` / 停用。

差别：场景可以带机器可读的 `ecosystem` 依赖（商店插件、档案 preset、库内模板、Ratel 白名单设置）。普通 SOP 可以没有这个块。

三源：内置 < 本机 `~/.ratel/skills/` < 库内 `.ratel/skills/`。草稿写在库内，且 `enabled: false`，不进 Discovery。

## 2. `ecosystem` 字段

写在 YAML frontmatter，键名只能是 `ecosystem`。

```yaml
ecosystem:
  plugins:
    - pluginId: dataview
      required: true
      # profileId / presetId 必须成对;档案尚未内置时不要写,否则预览会 invalid
  ratel:
    - key: dailyNoteFolder
  vaultFiles:
    - dest: Template/Diary/Daily Note Template.md
      source: skill://your-skill-name/templates/daily.md
```

加载时校验失败：**Skill 仍能被发现**，但 `ecosystem.validity=invalid`。`preview_skill_ecosystem` 的 `applyReady` 为 false。不要对用户说已经配好。

常见失败：空 `pluginId`、只写了 `profileId` 没写 `presetId`、档案不存在、`ratel.key` 不在白名单、`skill://` 指到别的 skill 或含 `..`、dest 指向配置目录、插件项里塞了 `keys`/`patch`、`pluginId: ratel-vault`。

没有 `ecosystem` 块的 Skill 与本手册发布前行为相同。

## 3. 可调工具

### 本版本已有

| 工具 | 作用 | 会不会改环境 |
|---|---|---|
| `activate_skill` / `deactivate_skill` | 把 SKILL.md 指令注入/移出对话 | 否 |
| `preview_skill_ecosystem` | 只读展开依赖 | 否 |
| `write_skill_draft` | 写 `.ratel/skills/<name>/SKILL.md`，强制未启用 | 只写库内技能草稿 |
| 笔记工具（`write_note` 等） | 写库内笔记 | 是，走笔记权限 |
| `update_app_config` | 改 Ratel 白名单设置 | 是，逐次确认 |
| `get_app_config` / `open_settings` | 看配置、打开设置页 | 否 / 只打开 UI |

`update_app_config` 白名单见设置实现（日记相关：`dailyNoteFolder`、`dailyNoteFormat`）。密钥、工具权限、MCP、prompt 覆盖不在白名单。

### 尚未落地（不要在场景里当已可调）

寻找/安装/升级/卸载社区插件、按档案写入他人 `data.json`、`apply_skill_ecosystem`、变更日志回滚。未过商店口径前，安装即使以后落地也会降级为打开官方安装页。

## 4. 插件档案

一份 schema，多份实例。场景用 `profileId` + `presetId` 引用，不要在 Skill 里写他人 `data.json` 的裸 key。

档案必须：`pluginId` 对得上商店 id；draft 不进匹配池。本版本还没有内置档案实例；引用不存在的 id 会让 `ecosystem` invalid。

## 5. 确认、备份、回滚、脚本禁区

写环境的动作必须让用户看见并点头。禁止一条「全部同意」吞掉安装+改配置+写模板（执行层落地后仍如此）。

Skill **脚本**绝对不能写他人插件的 `data.json` 或 `configDir`。配置只许走平台工具（以后的 `configure_plugin`）或 Ratel 白名单。

回滚覆盖：由场景写入的模板首写、插件目录与启用清单、档案 patch。用户后来改过的日记正文不假装一键撤回。

## 6. 用 `create-skill` 走一遍

1. 对话说明工作流。
2. 模型 `activate_skill("create-skill")`。
3. `write_skill_draft` 产出 `.ratel/skills/<name>/SKILL.md`。
4. `preview_skill_ecosystem` 看 issues。
5. 人打开技能管理启用该草稿。
6. **不要**在创作当场装插件。

输入：工作流描述、商店插件 id、可选日记目录/文件名。
产物：未启用的库内 Skill。
人审阅：改 description、删掉编造的 profileId、确认没有私人路径。

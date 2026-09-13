---
name: create-skill
description: 把用户描述的工作流写成一份库内 Skill 草稿(含可选 ecosystem 依赖)。只产文件,不安装插件、不改他人配置。用户说「做个场景/写个 skill/把这套流程固化」时激活。
activation: auto
tags: [authoring]
---

# 创建 Skill 的 Skill

你正在帮作者写一份**草稿**。草稿默认未启用,不会进 Discovery,直到用户在技能管理里打开。

## 必须做

1. 问清工作流:人做什么、哪个社区插件做什么、Ratel 做什么。
2. 起 kebab-case 名(`^[a-z][a-z0-9-]{0,63}$`)。
3. 调 `write_skill_draft`(不要用 `write_note` 写 `.ratel/skills`)。
4. `enabled` 由工具强制为 false,不要试图改成 true。
5. 若场景依赖商店插件:在 `ecosystem.plugins` 里写 `pluginId`(商店 id)。有档案再写 `profileId`+`presetId` 成对出现;没有档案就不要编。
6. 模板源只允许 `skill://<本草稿名>/...`。本工具分期 A 还不写 `templates/` 文件;需要模板时在 instructions 里列出将放到该 Skill 目录的相对路径,告诉用户下一期或手补。
7. Ratel 自身只允许白名单 key(如 `dailyNoteFolder` / `dailyNoteFormat`)。
8. 写完后用 `preview_skill_ecosystem` 预览该 name,把 `issues` 原样给作者。

## 禁止

- 调用任何安装/配置/apply 工具(本版本没有 `apply_skill_ecosystem`,也不要假装有)。
- 写插件目录、写他人 `data.json`、在 ecosystem 里塞 `keys`/`patch`。
- 把 `pluginId` 写成 `ratel-vault`。
- 把某台机器的绝对路径或私人库路径写进 SKILL.md。
- 在回复里说「已经装好/已经配好」。

## 写完对作者说什么

- 草稿路径:`.ratel/skills/<name>/SKILL.md`
- 下一步:人打开技能管理启用,再在对话里启用该场景;安装与改环境是以后的执行层,现在不要做。

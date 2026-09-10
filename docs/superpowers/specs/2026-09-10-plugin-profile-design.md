# S-PLUGIN-PROFILE — 社区插件配置档案

> **架构正文:** [docs/architecture/host/plugin-profile.md](../../architecture/host/plugin-profile.md)。改代码前以架构文档为准。

> 日期: 2026-09-10
> 状态: Active
> Spec ID: **S-PLUGIN-PROFILE**
> 关联: [支柱 C](../../prd/ecosystem.md)、[PP-01～09 / EC-05～09](../../prd/requirements.md)、[S-ECOSYSTEM](2026-08-20-ecosystem-management-design.md)（安装与写入的手）、[ADR-009](../../adr/2026-07-06-skill-mechanism.md)、[ADR-012](../../adr/2026-07-23-skill-activation-claude-aligned.md)、ADR-018（生态出站，S-ECOSYSTEM 待立）

---

## 1. 背景

支柱 C 要让 Ratel 替用户装、配社区插件。S-ECOSYSTEM 已规定执行层：商店清单、确认安装、点名 key 改 `data.json`、备份与回滚。其 v1 非目标写明「不做语义级整套配置模板」，是为了防止模型对着未知结构瞎写。

用户要的不是内置一份热门插件名单，而是一套**可生成、可识别、可消费**的机制：

- 按规则产出「规定」（档案），对应某个开源 Obsidian 插件的配置与设置；
- 底座可以是规则模式，也可以是创建/识别方式；
- Ratel 消费档案：安装对应插件，按需应用设置。

这与现有 Skill 不同：Skill 是 SOP（教模型调工具）；档案是**机器可校验的配置契约**。`ratel-config` 的「Skill 教流程 + 工具真读写」可复用，但不能用 `run_skill_script` 写他人 `data.json`。

**一份 schema，多份档案。** 每个插件（或同一插件的不同场景）是实例，不是一套新语法。

---

## 2. 目标

对应 [prd/ecosystem.md](../../prd/ecosystem.md) 阶段 1～2 与阶段 4 的档案侧（装卸是 S-ECOSYSTEM）：

1. **阶段 1 规范：** 全库唯一 Profile schema；插件变多只增加档案文件（PP-01）。档案绑定商店 `pluginId`，对不上则作废（PP-02）。
2. **阶段 2 创建：** 写作规则可产出合法档案（PP-03）；识别器可从已装插件生成草稿，默认不生效（PP-04）。
3. **阶段 4 对话配置：** 按意图或 pluginId 匹配 preset（PP-05）；展开为点名 key 交给生态工具（PP-06 / PP-07）；禁止脚本写他人配置（PP-08）。
4. 第一期底座含 schema、规则、识别草稿、**一份**示例档案（PP-09）。

---

## 3. 非目标

- 每个插件维护一份不同的 schema。
- 运行时直接读目标插件源码生成并写入配置。
- 用 Skill 脚本写 `configDir` / 他人 `data.json`。
- 商店外安装、主题/CSS snippet、代改 Obsidian 核心设置、管理 Ratel 自身目录。
- 第一期做 50+ 插件官方档案或自动「深度调优」整盘覆盖 `data.json`。
- 新开能力 `kind`；档案不是第四种执行面。
- 不替代 S-ECOSYSTEM 的通道 B、确认弹窗、`EcosystemChange`。

**对 S-ECOSYSTEM v1 非目标的收窄：** 禁止模型现编整份 `data.json`；**允许**经唯一 schema 校验的档案 preset 作为写入来源。

---

## 4. 需求（产品）

验收口径写在 [prd/requirements.md](../../prd/requirements.md) PP-01～09。产品行为摘要：

- 用户可以说「帮我把日历配成周一开始」，Ratel 匹配档案，展示将改的 key 与前后值，点头后再装/再写。
- 没有档案时仍可按 EC-01～05 探索、安装、点名改 key，不声称已按最佳实践配好。
- 密钥类 key 只出现在 `forbid`，Agent 只引导打开该插件设置页（对齐 EC-09 精神，对象换成目标插件设置）。
- 档案可开源分发（builtin / 用户 global / 本库 vault），同 id 覆盖顺序与 Skill 一致：vault > global > builtin。

---

## 5. 详细设计

对象、校验、匹配、消费顺序、端口与分期均以 [架构正文](../../architecture/host/plugin-profile.md) 为准。本 spec 只钉产品决策：一份 schema、商店 pluginId、draft 不生效、写入走生态工具。

---

## 6. 影响面

| 区域 | 变化 |
|---|---|
| 新 | `schemas/obsidian-plugin-profile.schema.json`、`src/ports` 档案端口、加载器、识别草稿、builtin 示例 |
| S-ECOSYSTEM | `configure_plugin` 增加「从 preset 展开为点名 key」；不改通道 B |
| Skill | 不改加载协议；可选同名 SOP |
| [prd/ecosystem.md](../../prd/ecosystem.md) | 插件配置从「仅点名 key」扩展为「点名 key + 档案 preset」 |
| README 隐私 | 消费安装时仍走生态出站（ADR-018）；档案文件本身默认本地、可随仓库分发不含密钥 |
| 测试 | schema 校验、清单对不上作废、forbid ∩ patch 非法、draft 不进匹配池 |

---

## 7. 参考

- 架构：[host/plugin-profile.md](../../architecture/host/plugin-profile.md)
- [S-ECOSYSTEM](2026-08-20-ecosystem-management-design.md)
- [prd/ecosystem.md](../../prd/ecosystem.md)
- 社区清单：https://github.com/obsidianmd/obsidian-releases

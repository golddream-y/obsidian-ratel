# S-ECOSYSTEM-CUT1 — 支柱 C 第一刀：对话装卸闭环与 Skill 配置墙

> **状态: Superseded（2026-09-21）**  
> 被 [S-ECOSYSTEM 2026-09-21 修订](../S-ECOSYSTEM/2026-08-20-ecosystem-management-design.md) + [S-PLUGIN-PROFILE 2026-09-21 修订](../S-PLUGIN-PROFILE/2026-09-10-plugin-profile-design.md) 取代。  
> 「装 + 配」一次交付，不再按本文件第二～四刀施工。v9 上 search/install/denylist/ADR-018 仍有效，作为执行层基线并入母 spec。  
> 下文保留为历史范围说明，**新 plan 不得以本文为唯一需求源**。

> 日期: 2026-09-20
> 状态: **Superseded（2026-09-21）**
> Spec ID: **S-ECOSYSTEM-CUT1**
> 基线: 已发版 **0.8.0**（现网无对话找/装/卸其他社区插件）
> 关联: [S-ECOSYSTEM](../S-ECOSYSTEM/2026-08-20-ecosystem-management-design.md)（执行层全量）、[S-PLUGIN-PROFILE](../S-PLUGIN-PROFILE/2026-09-10-plugin-profile-design.md)（档案与 PP-08）、[S-HOST-ACCESS](../S-HOST-ACCESS/2026-09-11-host-access-design.md)（不借道放宽沙箱）、[prd/ecosystem.md](../../prd/ecosystem.md)、[ADR-014](../../adr/2026-08-03-mcp-host-platform.md)、ADR-018（生态出站，**未立本 spec 不得当产品闸已过**）

---

## 1. 背景

支柱 C（社区插件生态）已锁定为下一步产品壁垒。仓库里已有两份 Active spec：

| Spec | 已覆盖 | 本刀不重写 |
|---|---|---|
| **S-ECOSYSTEM** | 对话探索/安装/升级/卸载、点名配置、变更日志、回滚、通道 B、八工具、ADR-018 待立 | 全量执行层仍以此为准 |
| **S-PLUGIN-PROFILE** | 一份 Profile schema、多份实例、识别草稿默认不生效、preset 展开为 `configure_plugin`、禁止脚本写他人配置（PP-08） | 档案产品仍以此为准 |

二者描述的是**整条 C**，不是「0.8.0 之后第一份可演示交付」。S-ECOSYSTEM 文末分期把卸载/回滚放进 Phase 2，§4.7 写「启用失败则回滚」，与 PRD EC-02 / 架构正文「热启用失败须留盘并诚实说明」冲突。S-PLUGIN-PROFILE 把 PP-08 写成档案期约束，没有钉：**第一刀还没有 `configure_plugin` 时，自定义 Skill 已经能写 `configDir`。**

Store 里的切片与技术路线是需求对照，**不能替代本 spec**：它们不是 `docs/superpowers/specs/` 登记项。协调者曾跳过 Superpowers、直接堆 ADR/安装器，顺序错误。本文件补这一步。

自定义 Skill 调 Ratel 工具：现网 Skill 是 SOP + 可选沙箱脚本（ADR-009 / ADR-017）。脚本 fs 白名单是整个 vault 根，因此**今天就能写** `{configDir}/plugins/*/data.json`。S-HOST-ACCESS 明确沙箱不因出库开关放宽，但也没把 configDir denylist 当作生态第一刀的强制项。

## 2. 目标

第一刀完成后，桌面、受限模式已关的当前库里，用户能走完：

1. **说需求 → 仅官方商店清单内推荐**（名称、作者、下载量若可得、功能说明、是否已装）（EC-01）。
2. **确认后安装**：下载该清单条目对应 GitHub release 的三件套，写入 `.obsidian/plugins/<id>/` 与启用清单，**尽力**热启用；失败不得假装已启用（EC-02 / EC-10）。
3. **卸掉刚才那个**：先备份再禁用并删目录；对话能查本次装/卸记了什么、备份在哪；能从本刀产生的备份恢复（EC-04 + EC-06/07 **子集**）。
4. **路径物理墙**：笔记工具仍进不了整棵 `configDir`；只有生态通道能写白名单路径（EC-08）。Skill 脚本同样进不了 `configDir`（PP-08 **作为禁令落地**，不是档案功能）。
5. **自定义 Skill 只能教模型调生态工具**，与对话直调走同一 ToolRegistry / `ask` 确认；脚本与 MCP 默认不接通道 B。
6. **商店审核开关**：完整通道可写盘；保守包只推荐并打开官方安装入口，零写他人插件目录。UI/README 必须与真实能力一致。
7. **诚实口径**：不声称官方授权；仅桌面；未文档 API 可降级（EC-10）。

一句话：**说需求 → 商店内推荐 → 点头装上 → 能卸掉并留痕；Skill 不能偷改别人配置。**

## 3. 非目标

整条 C 仍是壁垒，但第一期不是「环境管家全集」。明确不做：

- **EC-03** 升级保配置（下一刀）。
- **EC-05** / **`configure_plugin`**：点名改他人 `data.json`（第三刀；无档案时瞎写风险高）。
- **EC-06 / EC-07 全量**：不为 enable 细项、configure、升级各开产品面；本刀日志/回滚只服务 install / uninstall / 本刀 restore。
- **EC-09** 代开官方核心设置（失败路径用文字指路即可）。
- **PP-01～04 / PP-09 产品交付**：不交 schema、识别草稿、示例档案。第二刀再交底座。
- **PP-05～07**：按 preset 配好。写入必须走将来同一通道 B，禁止第二套写盘。
- 插件商店浏览 UI、商店外安装、主题 / CSS snippet、管理 `ratel-vault` 自己、代改 `app.json` / 快捷键 / 核心插件。
- 支柱 A 简报 / 收件箱 / Heartbeat。
- 本 spec **不授权**在 STATUS 未登记 plan 之前继续堆安装器或把 store 技术路线当施工清单。
- 不新开与 S-ECOSYSTEM 平行的「第二份全量生态 spec」。

## 4. 方案比较（brainstorming）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A | 另写一份完整 S-ECOSYSTEM v2 | 一张纸读完 | 与现网 Active spec 双真理，违反「不要无故重复造同名 spec」 |
| B | 只改 S-ECOSYSTEM 文末分期，不动 Skill | 改动小 | PP-08 与自定义 Skill 调工具仍无第一刀闸；§4.7 冲突继续藏 |
| **C（采用）** | 新开 **CUT1** 只钉范围、冲突决议与 Skill 契约；S-ECOSYSTEM / S-PLUGIN-PROFILE 各补一节指针，全量设计不搬迁 | 生命周期可登记；无平行真理；第一刀可单独写 plan | 读者须跟指针看母 spec |

## 5. 详细设计

### 5.1 相对 S-ECOSYSTEM：覆盖与缺口

| 主题 | 母 spec | 本刀 | 决议 |
|---|---|---|---|
| 八工具全量 | 4.4 含 update / configure | 只交 `search_plugins`、`install_plugin`、`uninstall_plugin`、`get_plugin_status`、`list_ecosystem_changes`、`restore_backup` | 实现可改名，**语义不得扩**到升级/配置 |
| 变更日志 | 每次环境变更都记，含 enable/configure | 仅 `install` / `uninstall` / `restore` | 字段形状仍用 S-ECOSYSTEM 4.5 |
| 备份 | 每插件最近 3 份；升级/配置也备份 | 只覆盖本刀装/卸产生的备份 | `pluginDir/ecosystem-backups/<changeId>/` |
| 热启用失败 | **§4.7「回滚到变更前」** | 跟架构 §1 / EC-02：**留盘 + 说明 Reload / 官方页** | **以本刀为准**；母 spec §4.7 该条作废 |
| 下载中断 | 清半成品 | 同左 | 不变 |
| 清单 URL | `.../master/community-plugins.json` | 权威源与 BRAT 同为 `obsidian-releases` 的 `community-plugins.json`（HEAD 与 master 通常同内容） | 缓存名不得覆盖**本库启用清单**（二者都叫 `community-plugins.json`） |
| 下载量 | 4.4 要展示，4.3 未单列 stats 文件 | 用同仓库 `community-plugin-stats.json` 的 `downloads`；缺失标「未知」，不得写成 0 | 补进 ADR-018 / 实现 |
| 版本定位 | 4.3 写 api.github.com 查版本 | **禁止**把 GitHub `/releases/latest` 当稳定线（会落到 beta）。对齐官方：仓库 `manifest.json` 的 version → 同名 tag 三件套；`minAppVersion` 高于当前应用则拒绝并说明（第一刀不做 versions.json 兼容回退，除非后续 plan 单开） | 写入前 `manifest.id === pluginId` |
| 商店保守包 | EC-10 审核口径，无开关设计 | 第一刀必须有：`ecosystemWriteEnabled`（名称可改）关则安装 = 打开官方页（优先 `obsidian://show-plugin?id=`），**零写**他人目录；从未代装则本包不提供卸载/回滚 | 一套代码两通道 |
| 出站 | ADR-018 待立 | 编码下载器之前必须先有 ADR-018 + README 隐私（第三条网，不是 MCP opt-in） | Superpowers：spec → plan → 代码；ADR 挂在 plan 任务里，不替代 spec |
| Phase 文末 | Phase 1 = 日志+search/install/status；Phase 2 = update/configure/uninstall/restore | **卸载+恢复进第一刀**；update/configure/open_settings 官方 tab **移出第一刀** | 母 spec 分期被本节取代 |

通道 B、禁区、`ask` 确认弹窗、i18n、desktop-only、不管理 `ratel-vault`：全部继承 S-ECOSYSTEM，不另发明。

生态 IO **不得**缝进 `ObsidianVault` / `validateVaultPath` 再 catch 放行。HTTP 只在主线程（`requestUrl`）；Worker / Skill 脚本不出站拉商店。

### 5.2 相对 S-PLUGIN-PROFILE：配置工具延后

| 刀 | 档案 / 配置 | 与装卸 |
|---|---|---|
| **第一刀（本 spec）** | 零档案产品。Skill 脚本物理禁写 `configDir`（PP-08 精神） | 无档案也能装 |
| 第二刀 | PP-09 底座：唯一 schema + 写作规则 + 草稿默认不生效 + **恰好一份**示例（PP-01～04 随底座） | 仍不写别人配置；对话最多展示「将来会改哪些 key」 |
| 第三刀 | `configure_plugin`（EC-05）+ 日志补全；档案匹配后展开为点名 key（PP-05～07）；密钥只引导设置页 | 写入走同一确认 / 通道 B / 备份，禁止整文件替换 |
| 第四刀 | EC-03 升级；EC-09 引导；回滚覆盖升级与配置 | — |

禁止：第一刀为「看起来完整」写 50 份热门档案，或把 `configure_plugin` 和 `install_plugin` 绑死在同一发版。

`data.json`：第一刀 **可读**（status 可选）；**禁止写**。

### 5.3 自定义 Skill 调 Ratel 工具

这是本刀相对两份母 spec 的主要缺口，此处钉死。

**允许（与对话同一执行面）：**

- 用户或社区编写的 Skill（SOP Markdown）可以写：需要看板时调用 `search_plugins`，用户点头后调用 `install_plugin`，卸掉时调用 `uninstall_plugin` 等。
- Agent Loop 解析工具调用 → ToolRegistry → 现有 `ask` 确认。Skill 激活只注入说明，**不**降低权限、不跳过弹窗。
- 档案期的可选 `sopSkill` 同此：只许教模型调 `configure_plugin`，自身不写盘（S-PLUGIN-PROFILE 已有，第三刀才消费）。

**禁止：**

- `run_skill_script` 写 `configDir` 及以下（含他人 `data.json`、启用清单、任意插件目录）。`allowedDirs` 仍可含 vault 根，但 `resolveAllowed` 必须 denylist 整棵 `configDir`（与通道 A 同一套归一化）。单测：脚本写 `configDir/plugins/x/data.json` 必须抛错。
- Skill 脚本 `require` / 注入 `EcosystemPort` / 直接调 adapter。脚本不是工具运行时。
- 笔记工具、MCP 默认工具接通道 B。用户自建「任意 FS」MCP 仍可能写盘——权限门 + README 一句；不在本刀实现范围。
- Prompt 里写「不要写配置目录」当作唯一控制。PP-08 必须是物理拒绝。

**与 S-HOST-ACCESS：** 出库总闸不得放宽脚本 fs。本刀 denylist 是在「库根可写」之上减去 configDir，不是新开沙箱架构。

第一刀即使没有配置工具，也必须先做 denylist，否则装卸期 PP-08 已经破。

### 5.4 用户可见验收（完整通道）

在桌面 Obsidian、社区插件受限模式已关：

1. 「我想要一个看板」→ 少量商店内推荐，含作者/下载量（或未知）/已装。
2. 确认弹窗含插件 id、名称、作者、下载量（拿得到时）、将改路径摘要。拒绝则零写盘。
3. 同意后写入三件套与启用清单；热启用成功须同时满足：启用清单含 id，且能观察到插件实例（`getPlugin` / `plugins.plugins[id]` 一类，实现时 `typeof === 'function'` 守卫）。否则文案是「文件已安装，请 Reload 或到社区插件页打开」。
4. 「卸掉刚才那个」→ 确认 → 备份 → 禁用并删目录 → 日志可查 → `restore_backup` 能把目录和启用清单恢复回来。
5. 用自定义 Skill 脚本尝试写他人 `data.json` → 失败，且未产生该文件。
6. `ecosystemWriteEnabled=false`：仍可搜索；安装动作打开官方入口；不写他人插件目录。

### 5.5 错误与降级

- 无网 + 过期缓存：搜索可继续但必须标注缓存日期；无缓存则探索失败，本地 status / 卸载仍可用。
- GitHub 429：明确可重试，不得静默当「没有这个插件」。
- `minAppVersion` 高于当前应用：拒绝安装并说明升级 Obsidian。
- 社区插件总开关关闭：不写盘装完假装启用；先解释去设置打开社区插件。
- 半成品 / 断网：删除目标目录或明确残留路径。
- 热启用失败：**不**回滚已成功的下载与启用清单写入（推翻 S-ECOSYSTEM §4.7 旧句）。

### 5.6 ADR-018（本刀编码闸，仍不是本文件的替代）

ADR 正文须回答：出站域名白名单（清单 raw、release 下载、stats、tag 回退是否碰 `api.github.com`）、仅生态工具触发、禁止过期后台刷新、失败文案、与 ADR-014 并列写进 README、永不索要 GitHub PAT、缓存路径与 TTL、完整 vs 保守是设置开关还是两套包、是否允许调用未文档 `enablePluginAndSave`（缺则降级句）、Skill denylist 写本 ADR 还是 ADR-017 补丁。

**本 spec 对尚未写入 ADR 的产品选择先钉：**

- 热启用失败留盘（见 5.5）。
- 完整 vs 保守：**同一 manifest、设置开关**（不要第一刀发两套包）。
- 不要求用户 PAT。
- 清单/stats 缓存在 Ratel `pluginDir`，不进 `loadData()`。

未通过「spec 已登记 + plan 已写 + ADR-018 任务完成」三步，不得把下载写盘当作已批准施工。

## 6. 影响面

| 区域 | 本刀（有合格 plan 之后） | 明确后移 |
|---|---|---|
| `src/utils/path-safety.ts` | `validateEcosystemPath`；Skill denylist 复用归一化 | — |
| `src/adapters/ecosystem-*` | vault / registry / runtime（可选 `app.plugins.*`） | configure 读写 `data.json` 的写路径 |
| `src/core/ecosystem-change-log.ts` / `ecosystem-backup.ts` | install/uninstall/restore | enable 细项、configure、update 条目 |
| `src/tools/` | 5.1 六工具 | `update_plugin`、`configure_plugin` |
| `src/skills/script-vm.ts` / `run-skill-script.ts` | 拒绝 `configDir` | 出库 fs（S-HOST-ACCESS） |
| ADR-018 + README 隐私 + i18n | 第三条网、开关文案、工具显示名 | 档案分发隐私 |
| `docs/architecture/host/ecosystem.md` | plan 阶段评估是否把「ADR-018 待立」改为已立；**改前按 AGENTS 确认** | 档案架构 |
| S-ECOSYSTEM / S-PLUGIN-PROFILE | 指针节（本提交） | 母 spec 其余章节 |

测试：通道 B 越界 / `ratel-vault` / 伪造 id；通道 A 回归；脚本写 configDir 抛错；保守模式零写盘；热启用 API 缺失分支；清单过滤不把 2MB 塞进模型上下文（契约测试即可）。

## 7. 参考

- [S-ECOSYSTEM](../S-ECOSYSTEM/2026-08-20-ecosystem-management-design.md)
- [S-PLUGIN-PROFILE](../S-PLUGIN-PROFILE/2026-09-10-plugin-profile-design.md)
- [S-HOST-ACCESS](../S-HOST-ACCESS/2026-09-11-host-access-design.md)
- 架构：[host/ecosystem.md](../../architecture/host/ecosystem.md)、[host/plugin-profile.md](../../architecture/host/plugin-profile.md)
- PRD：[ecosystem.md](../../prd/ecosystem.md)、[requirements.md](../../prd/requirements.md) EC / PP、[trust.md](../../prd/trust.md)
- [ADR-014](../../adr/2026-08-03-mcp-host-platform.md)、[ADR-017](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md)
- 商店清单：[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
- 代码 PR（**先冻结加功能**，不得当作已完成的 spec）：https://github.com/golddream-y/obsidian-ratel/pull/5

## 8. 自检

- 无 TBD。热启用失败、保守开关、Skill 契约、工具名单均已选边。
- 与 S-ECOSYSTEM 仅有一处故意覆盖：§4.7 启用失败回滚 → 留盘；其余是范围收窄而非第二套模型。
- 范围可单独写一份 writing-plans（本提交**不写** plan，避免未审 spec 就拆 checkbox）。
- 自定义 Skill「调工具」vs「脚本写盘」不会被读成两种实现。

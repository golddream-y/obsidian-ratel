# S-ECOSYSTEM — Obsidian 插件生态管理（执行层）

> **架构正文:** [docs/architecture/host/ecosystem.md](../../architecture/host/ecosystem.md)。改代码前以架构文档为准（无官方安装授权、未文档 API 降级）。出站以 **[ADR-018](../../adr/2026-09-18-ecosystem-outbound.md)** 为准（已 Accepted）。

> 日期: 2026-08-20
> 修订: 2026-09-10 — 产品按阶段对齐 [prd/ecosystem.md](../../prd/ecosystem.md)
> 修订: 2026-09-20 — 热启用失败留盘；CUT1 曾收窄施工范围
> 修订: **2026-09-21 — 社区插件底座一次交付。** [S-ECOSYSTEM-CUT1](../archive/S-ECOSYSTEM-CUT1/2026-09-20-ecosystem-first-cut-design.md) **Superseded**。含探索 / 装 / **升（EC-03）** / 卸 / 点名配 / 日志回滚。官方核心设置引导（EC-09）仍非本交付。作者 SOP 文档钉 `plugin-profiles/SKILL-AUTHORING.md`。
> 状态: Active
> Spec ID: **S-ECOSYSTEM**
> 关联: [支柱 C](../../prd/ecosystem.md)、[EC-01～10](../../prd/requirements.md)、[S-PLUGIN-PROFILE](2026-09-10-plugin-profile-design.md)（档案；写入硬依赖本文 `configure_plugin`）、[ADR-014](../../adr/2026-08-03-mcp-host-platform.md)、[ADR-017](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md)、[ADR-018](../../adr/2026-09-18-ecosystem-outbound.md)、[S-HOST-ACCESS](2026-09-11-host-access-design.md)（不得放宽沙箱）

---

## 1. 背景

支柱 C：对话里完成「需求 → 商店内推荐 → 确认安装 → 已装可更新（保 `data.json`）→ 点名（或按档案 preset）配置 → 能卸、能查、能回滚」。公开 Plugin API 没有 install/uninstall/update；本能力 = 用户确认后写当前库 + 尽力调未文档 `app.plugins.*`。不得声称官方授权。

**相对上一刀：** CUT1 只交 search/install 骨架并冻结加功能。本修订把**社区插件底座**收成同一份执行层：装卸升降 + 点名配置。档案 schema 仍在 S-PLUGIN-PROFILE。安装已有，升级共用同一套版本定位与三件套下载，只是**禁止碰 `data.json`**。

**v9 已落地（本修订视为基线，不再重开 ADR）：** ADR-018、通道 B `validateEcosystemPath`、Skill 脚本 denylist 整棵 `configDir`、`search_plugins` / `install_plugin`、`ecosystemWriteEnabled`（R2 写盘 / R3 开官方页）。

---

## 2. 目标（本交付一次做完）

桌面、社区插件受限模式已关、完整通道（`ecosystemWriteEnabled=true`）下：

1. **探索（EC-01）：** 自然语言只在官方清单内推荐；含名称、作者、下载量或「未知」、说明、是否已装。整份清单不进模型上下文。
2. **安装（EC-02 / EC-10）：** 确认后下载该清单条目 GitHub 同名 tag 三件套，写入 `plugins/<id>/` 与启用清单，尽力热启用；失败不得假装已启用。已完整安装则不覆盖（升级走 `update_plugin`）。
3. **更新（EC-03）：** 已装插件确认后只覆盖三件套，**禁止覆盖或删除 `data.json`**；备份升级前目录；热启用失败留盘并说明 Reload。
4. **卸载（EC-04）：** 确认 → 备份 → 禁用并删目录。
5. **配置（EC-05）：** `configure_plugin` 读结构或按**点名 key** 最小 diff 写他人 `data.json`；写前展示前后值。档案 preset 展开后走**同一工具**，见 S-PLUGIN-PROFILE。
6. **留痕与回滚（EC-06 / EC-07）：** 本交付产生的 install / update / uninstall / configure / restore 均记 append-only 日志；`restore_backup` 能把对应备份恢复。
7. **物理墙（EC-08 + PP-08）：** 笔记工具进不了 `configDir`；仅通道 B 写白名单路径。Skill 脚本同样进不了 `configDir`。
8. **Skill 契约：** 社区 SOP 只许教模型调本文工具；同一 `ask` 闸；脚本与 MCP 默认不接通道 B。
9. **审核开关：** 同一 manifest；关写盘则搜索仍可、安装/更新只开官方页、零写他人目录。UI/README 与旗标一致。

一句话：**说需求 → 商店内推荐 → 点头装上 → 已装可更新且保住配置 → 点名或按档案配上 → 能卸能查能回滚；Skill 不能偷改别人配置。**

对本交付的需求覆盖：

| 需求 | 本交付 |
|---|---|
| EC-01 探索 | `search_plugins` |
| EC-02 / EC-10 安装与诚实启用 | `install_plugin` R2/R3 |
| EC-03 更新保配置 | `update_plugin`：只覆盖三件套 |
| EC-04 卸载 | `uninstall_plugin` |
| EC-05 点名配置 | `configure_plugin` |
| EC-06 / EC-07 | 日志 + `restore_backup`（含 update） |
| EC-08 + PP-08 | 通道 B + 脚本 denylist |
| EC-09 官方设置 tab | **不做**（失败路径文字指路） |

---

## 3. 非目标

- **EC-09** 代开官方核心设置 tab — 失败路径文字指路即可；不扩展 `open_settings` 官方页（可后续）。不是社区插件底座。
- 按 `versions.json` 回退旧 tag（HEAD `minAppVersion` 过高就拒绝，不自动找兼容旧版）。
- 降级：本地 version **高于**商店 HEAD 时不覆盖。
- 商店浏览 UI、店外安装、主题 / CSS snippet、管理 `ratel-vault` 自己、代改 `app.json` / 快捷键 / 核心插件。
- 模型对着未知结构**现编整份** `data.json`。无档案时只许用户/模型点名 key；有档案时只许档案已声明且非 `forbid` 的 key。
- 50 份热门插件官方档案（档案产品见 S-PLUGIN-PROFILE，本交付只要求执行层能消费展开后的 map）。
- 新开能力 `kind`；档案不是第四种执行面。
- 为商店发两套插件 id；向用户要 GitHub PAT；Worker / Skill 脚本出站拉商店。
- 借 S-HOST-ACCESS 出库闸放宽脚本 fs。

---

## 4. 依赖

| 对方 | 关系 |
|---|---|
| 已落地 Skill（ADR-009/012）+ 沙箱（ADR-017） | 本文消费：SOP 激活 + denylist |
| ADR-018 | 出站、缓存、R2/R3、版本定位、热启用留盘 — **已立，本文不再「待立」** |
| S-PLUGIN-PROFILE | **软依赖**：无档案也能装、也能点名配。有档案时 `configure_plugin` 多收一份已展开的 key map |
| S-HOST-ACCESS | 约束：出库不得放宽 denylist |

档案层**硬依赖**本文的 `configure_plugin`（见 S-PLUGIN-PROFILE §4）。禁止为档案再开一套写 `data.json` 的通道。

---

## 5. 详细设计

### 5.1 三域与目录

| 域 | 对象 | 能力 |
|---|---|---|
| Ratel 自身 | 本插件设置、密钥、技能 | 已有 `get/update_app_config`、`open_settings`、`ratel-config` |
| Obsidian 官方 | 核心设置 | 本交付不代改；文字指路 |
| 社区生态 | 其他插件与启用清单 | 本文工具 |

| 路径 | 策略 |
|---|---|
| `plugins/<id>/`（清单或本地已装校验过的 id） | 仅生态工具可写 |
| `plugins/ratel-vault/` | 禁区 |
| `community-plugins.json`（启用清单，字符串数组） | 仅生态工具可写 |
| configDir 其余 | 禁区 |
| Skill 脚本对整棵 configDir | 读/写皆拒（denylist，与通道 A 同一套归一化） |

禁止把路径写死为 `.obsidian`，必须用注入的 `app.vault.configDir`。商店缓存文件名不得覆盖启用清单（ADR-018 §6）。

### 5.2 双通道 + 脚本墙

- **通道 A** `validateVaultPath`：现有笔记工具，整棵 configDir 拒绝。不得 catch 后再放行。
- **通道 B** `validateEcosystemPath`：仅生态 adapter。放行 `{configDir}/plugins/{id}/**`（`id ≠ ratel-vault`，且 id 在商店清单 **或** 本地已装目录）与 `{configDir}/community-plugins.json`。`..` / 绝对路径 / 反斜杠与通道 A 同一归一化。
- 生态 IO **不得**缝进 `ObsidianVault`。HTTP 只在主线程 `requestUrl`。
- `run_skill_script`：`allowedDirs` 仍可含 vault 根，但 resolve 后命中 configDir 必须抛错。单测：写 `configDir/plugins/x/data.json` 失败且不落盘。禁止脚本 `require` 生态 Port / adapter。

下架仍在本地的 id：仍可 status / uninstall / restore，**不得** `update_plugin`（清单已无则无法定位商店 HEAD）。不得因清单消失而无法清理。

### 5.3 出站与版本定位（ADR-018，摘产品钉）

- 仅官方清单 + 所选插件 GitHub release；无后台刷新；无 PAT。
- 版本：**仓库 `HEAD/manifest.json` 的 `version` → 同名 tag 三件套**。禁止 `/releases/latest`。写入前 `manifest.id === pluginId`。`minAppVersion` 高于当前应用则拒绝并说明（本交付不做 `versions.json` 兼容回退）。
- 下载量：同仓库 `community-plugin-stats.json` 的 `downloads`；缺失标「未知」，不得写成 0。
- 缓存：Ratel `pluginDir` 的 `ecosystem-catalog.json` / `ecosystem-stats.json`，TTL 7 天，不进 `loadData()`。过期仍可搜但必须标注缓存日期。

### 5.4 工具面（本交付 8 个）

`install_plugin` 不升级；`update_plugin` 不新装。名称可微调，语义不得漂。

| 工具 | 做什么 | 默认权限 |
|---|---|---|
| `search_plugins` | 清单内本地过滤 top N（id、名称、描述、作者、下载量或未知、是否已装） | allow |
| `get_plugin_status` | 省略 `pluginId`：列出本地已装社区插件摘要（不含 `ratel-vault`）。指定 id：版本 / 启用态；可选 key 名；可选 `checkUpdate` | allow |
| `install_plugin` | 清单 id → 确认 → R2 写盘尽力启用 / R3 开官方页。已完整安装 → already-installed | ask，破坏性 |
| `update_plugin` | 已装 + 仍在清单 → 确认后只覆盖三件套，保 `data.json`。见 §5.5.1 | ask，破坏性 |
| `uninstall_plugin` | 确认列将删目录 → 备份 → 禁用 → 删目录 | ask，破坏性 |
| `configure_plugin` | 见 §5.6 | ask，破坏性 |
| `list_ecosystem_changes` | 最近 N 条或按 pluginId | allow |
| `restore_backup` | 指定 changeId 恢复目录 + 启用清单（若备份含） | ask，破坏性 |

`search_plugins` 的 N **钉为 8**（与现网 `SEARCH_TOP_N` 一致）。实现可改常量名，不得把整份清单塞进工具返回。

确认弹窗（变更类）：动作、pluginId、名称、作者、下载量（拿得到时）、将改路径或 key 摘要。拒绝则零出站（安装）/ 零写盘。MCP 默认工具与笔记工具**不得**接通道 B。

### 5.5 安装 / 更新 / 卸载

**安装 R2：** 确认 → 若已完整安装则 already-installed（§5.13）→ 否则拉 tag 三件套 → 校验 id → 写入插件目录 → 写入启用清单 → `typeof === 'function'` 守卫下尽力 `loadManifest(s)` / `enablePluginAndSave`。热启用成功须：**启用清单含 id** 且能观察到插件实例。否则文案：「文件已安装，请 Reload app without saving 或到社区插件页打开」。**不**回滚已成功写盘（推翻 2026-08-20 旧稿「启用失败整笔回滚」）。

**安装 R3：** 零写他人目录；打开官方入口；失败则文字引导设置 → 社区插件。

**更新 R2（`update_plugin`）：**

1. 未装或不完整（无合法 manifest）→ 失败，建议 `install_plugin`，零覆盖。
2. `pluginId === ratel-vault` 或清单无此 id（含下架）→ 拒绝。
3. 拉商店 HEAD `manifest.json` 的 `version`（禁止 `/releases/latest`）→ 同名 tag 三件套。`minAppVersion` 过高 → 拒绝并说明升级 Obsidian。
4. 版本比较（与现网 `isAppVersionAtLeast` 同类点分段）：
   - 相等 → `already-current`，零写盘、零出站下载三件套（HEAD manifest 已拉过可接受）。
   - 商店 HEAD **低于**本地 → **不降级**，说明本地不低于商店 HEAD。
   - 无法点分段比较且字符串不等 → 确认弹窗写明「无法比较新旧，将把三件套换成商店 HEAD {catalogVersion}」，用户拒绝则零写盘。
   - 商店 HEAD **高于**本地 → 进入确认。
5. 确认弹窗：已装 version → 目标 version、作者、将改文件（`main.js` / `manifest.json` / 若有 `styles.css`）、**明确「不改 data.json」**。
6. 备份**整个插件目录**（含 `data.json` 与其它文件）→ 只写入三件套：有则覆盖 `main.js`、`manifest.json`；release 含 `styles.css` 则覆盖，不含则**不删**旧 `styles.css`。目录内其它文件一律不动。**禁止**写、删、截断 `data.json`。
7. 尽力热启用 / 重载该插件；失败留盘 + Reload 文案。不得假装已加载新代码。
8. 本轮写入失败：**从本次备份整目录恢复**，不得留下半截 `main.js`，也不得用「删目录」当清理（那是卸载）。
9. 记 `update` 日志，`before.version` / `after.version`；备份路径指向升级前快照。`restore_backup` 必须能回到升级前三件套 **且** `data.json` 与升级前一致。

**更新 R3：** 与安装相同，只开官方页，零写他人目录。

**卸载：** 仅针对本地已有目录。备份该目录（及若改启用清单则清单快照）→ 禁用 → 删目录。社区插件总开关关闭时：不假装启用成功；先解释去设置打开。

**半成品 / 断网：** 新装失败只清本轮新建或确认残缺的目录。更新失败走备份恢复，不 `removeRecursive` 用户目录。

### 5.6 `configure_plugin`

这是社区「配置 Skill」的**唯一写盘出口**。

**读（`op: "inspect"` 或省略写时先读）：**

- 入参：`pluginId`（必须已装，否则明确「未安装」，可建议 `install_plugin`，不偷偷装）。
- 出参：顶层（及点号路径约定下的）key 列表；值默认不回完整密钥。实现须对 key 名匹配 `/token|secret|password|apiKey|webhook|cookie/i` 的值打码。无 `data.json` 当空对象。

**写（`op: "apply"`）：**

- 入参：`pluginId` + `patch: Record<string, unknown>`（点号路径叶子）。**禁止**传入整份替换文件、禁止无 patch 的「按我说的随便写」。
- 单次最多 20 个 key（防一次掏空未知 JSON）。超过拒绝并请拆次确认。
- 写前：读原文件 → 只改点名叶子（不覆盖未点名的兄弟）→ 弹窗列出每个 key 的前后值（过长截断 + 哈希）→ 用户确认。
- 任一 key 命中已加载档案 `forbid` **或**启发式 `/token|secret|password|apiKey|webhook|cookie/i`：**整次 apply 失败**，零写盘，列出被拒 key，密钥类引导打开该插件设置页。禁止「跳过坏 key 写其余」。
- 已装 `data.json` 中不存在的 key：标 `needsConfirm`「将新增 key」，不得 silent。
- 成功：原子写（tmp + rename）→ 备份写前文件于该次 changeId → 记 `configure` 日志。对方插件未必热更新设置；允许提示 Reload。不得用 Skill 脚本写盘。
- 写入失败：原文件保持或从本次备份恢复；不得留下半截 JSON。

档案消费：工具**不解析** YAML。调用方（模型或只读匹配工具的下游）传入已经展开的 `patch`。S-PLUGIN-PROFILE 负责展开与 `forbid` 再减。`configure_plugin` 仍独立再跑一遍启发式 forbid（双闸）。

### 5.7 变更日志与备份

**记录动作（本交付）：** `install` / `update` / `uninstall` / `configure` / `restore`。装/卸导致的启用清单变化可并入该条 `before`/`after`，不必强制拆 `enable`/`disable` 独立产品面。

字段形状维持：

```json
{
  "id": "ch_000042",
  "time": "2026-09-21T14:30:00Z",
  "action": "configure",
  "pluginId": "calendar",
  "summary": "weekStart 0 → 1",
  "before": { "weekStart": 0 },
  "after": { "weekStart": 1 },
  "backupPath": "ecosystem-backups/ch_000042/",
  "status": "recorded"
}
```

- 存储：`pluginDir/ecosystem-changes.jsonl`，append-only，不进 vault、不出网。
- 状态：`recorded` → `restored` → `expired`（备份已清）。
- 备份：`pluginDir/ecosystem-backups/<changeId>/`。install / uninstall / **update**：目录快照（update 必须含 `data.json`）。configure：写前 `data.json`。每插件最近 3 份，超出清理最旧并标 `expired`。
- `restore_backup`：确认 → 覆盖/删除目录 + 还原启用清单（若有）+ 还原 data.json（configure）或整目录（install/update/uninstall 快照）→ 再记一条 `restore`。

### 5.8 错误与降级

| 情况 | 行为 |
|---|---|
| 无网 + 过期缓存 | 搜索可继续，标注日期；无缓存则探索失败；本地 status / 卸载 / 配置仍可用；update 需要拉 HEAD manifest 则失败并说明 |
| GitHub 429 | 可重试，不得静默当没有这个插件 |
| `minAppVersion` 过高 | 拒绝安装**或更新**并说明升级 Obsidian |
| 社区插件总开关关 | 不写盘装完假装启用 |
| 清单 id 不存在 | 安装 / 更新拒绝 |
| R3 | 安装 / 更新零写盘 |

### 5.9 社区 Skill 作者契约（执行层）

**允许：** 用户或社区在 vault / global Skill 目录写 `SKILL.md` SOP：需要插件时 `search_plugins` →（可选）`get_plugin_status` → 用户点头后 `install_plugin`；已装要升 `update_plugin`；需要改设置时 `configure_plugin`（有档案则先 `match_plugin_profiles` 再 apply 展开结果）；卸 `uninstall_plugin`。Agent Loop 解析 tool_call → ToolRegistry → 现有 `ask`。激活只注入说明，**不**降权限、不跳过弹窗。

**禁止：** 脚本写 configDir；脚本当工具运行时；笔记工具 / MCP 默认接通道 B；只靠 prompt「不要写配置目录」。

作者文档（实现期落 `plugin-profiles/SKILL-AUTHORING.md`，与档案 `AUTHORING.md` 并列；**不**新开第三份 spec）：列出本交付 **8** 个生态工具 + **3** 个档案工具的名字与权限、禁止脚本写配置、示例 SOP 骨架（寻找 → 安装 → 更新保配置 → 有档案则 match 再 configure；version 不够先 `update_plugin`）。**不**把生态 adapter API 暴露给 Skill。builtin 示例 Skill 必须遵守同一份骨架。

### 5.10 用户可见验收（完整通道）

1. 「我想要一个看板」→ 少量商店内推荐（作者 / 下载量或未知 / 已装）。
2. 确认安装 → 三件套 + 启用清单；热启用失败则留盘 + Reload/官方页文案。已装再调 install → already-installed，配置文件不动。
3. 「把日历更新一下」→ 确认展示旧→新 version 且说明不改 data.json → 三件套变、`data.json` 字节不变 → 日志可回滚到升级前。
4. 「把日历改成周一开始」→ 有档案则预览 preset key；无档案则 inspect 后点名 key → 确认 → 只那些 key 变。密钥类拒绝代填。
5. 「卸掉刚才那个」→ 备份 → 删目录 → 日志可查 → restore 能回来。
6. 自定义 Skill 脚本写他人 `data.json` → 失败且无该文件。
7. `ecosystemWriteEnabled=false`：可搜；安装/更新开官方页；不写他人插件目录。

### 5.11 工具入参 / 出参（实现不得扩语义）

名称可微调；字段语义不可漂。省略的可选字段按表内默认。

| 工具 | 入参 | 出参要点 |
|---|---|---|
| `search_plugins` | `query: string`（必填，trim 后非空） | `{ stale, fetchedAt, note?, results: [{ id, name, author, description, downloads: number\|null, installed, repo }] }`；`downloads === null` 展示「未知」 |
| `get_plugin_status` | `pluginId?: string`；`includeKeys?: boolean`（默认 false）；`checkUpdate?: boolean`（默认 false，仅当指定了 pluginId） | 省略 pluginId：`{ plugins: [{ id, name, version, enabled }] }`，本地扫描，**不出站**。指定 id 未装：`installed: false`。已装：`id, name, version, enabled, directoryExists`。`includeKeys=true` 只回 key 名。`checkUpdate=true`：拉该 repo HEAD/manifest（用户发起），返回 `catalogVersion` 与 `updateAvailable`；失败则二者为 null 并说明，不阻断卸载/配置。禁止 `/releases/latest` |
| `install_plugin` | `pluginId: string` | `{ ok, mode: "write"\|"official-page"\|"already-installed", filesWritten, enabled, version?, message }` |
| `update_plugin` | `pluginId: string` | `{ ok, mode: "write"\|"official-page"\|"already-current"\|"not-installed", fromVersion?, toVersion?, dataJsonUnchanged: boolean, message }` |
| `uninstall_plugin` | `pluginId: string` | `{ ok, backedUp, changeId, message }`。目录不存在 → 失败说明，不造假成功 |
| `configure_plugin` | `pluginId: string`；`op: "inspect"\|"apply"`；apply 时 `patch` 必填 | inspect：`{ keys, values }`（值打码）。apply：`{ changed: [{ key, before, after }], changeId, message }` |
| `list_ecosystem_changes` | `pluginId?: string`；`limit?: number`（默认 20，上限 100） | 数组，新在前 |
| `restore_backup` | `changeId: string` | `{ ok, restoredAction, message }`。未知 id / 备份 `expired` → 失败 |

### 5.12 点号路径（apply 唯一写法）

- 分隔符仅 `.`。禁止 `..`、空段、以 `.` 开头或结尾、含 `/` `\` 空白控制字符。
- 最多 **6** 段。第一期**不支持**数组下标（`items.0` 整次失败）。
- 从根对象沿段下行；中间段必须已是 plain object（或将新建对象）。不得改数组元素内部。
- 叶子值必须 JSON 可序列化：`string` / `number` / `boolean` / `null` / 纯 JSON 对象 / 纯 JSON 数组。叶子若是对象或数组，**整颗替换**该叶子，不深合并兄弟。
- 未点名的兄弟 key 保持原值。禁止传入 `""` 当删 key；本交付不提供 delete-key（需要时用户自己在插件设置页改）。

### 5.13 已装 / 残缺 / 失败清理

| 现状 | `install_plugin` | `update_plugin` |
|---|---|---|
| 目录存在且 `manifest.json` 的 `id` 匹配 | **already-installed**：不覆盖三件套、不碰 `data.json` | 按 §5.5 比较 HEAD version 后覆盖三件套 |
| 目录存在但无合法 manifest（半成品） | 可清该目录后按新装走 | 拒绝，建议 install |
| 未装 | 新装 | 拒绝，建议 install |
| 清单无此 id | 拒绝 | 拒绝 |
| 本轮失败 | 只删本轮新建或确认残缺的目录 | **从本次备份恢复整目录** |

`uninstall_plugin`：只对本地已有目录。下架仍在本地的 id 仍可卸。`pluginId === ratel-vault` 一切写工具拒绝。

并发：同一 `pluginId` 的 install / update / uninstall / configure / restore **排队**（单锁，按 pluginId）；不同 id 可并行。日志 append 全库一把锁。

### 5.14 端口 `src/ports/ecosystem.ts`（零实现）

```typescript
interface EcosystemPort {
  search(query: string): Promise<SearchResult>;
  listInstalled(): Promise<InstalledSummary[]>;
  status(pluginId: string, opts?: { includeKeys?: boolean; checkUpdate?: boolean }): Promise<PluginStatus>;
  install(pluginId: string): Promise<InstallResult>;
  update(pluginId: string): Promise<UpdateResult>;
  uninstall(pluginId: string): Promise<UninstallResult>;
  inspectData(pluginId: string): Promise<InspectResult>;
  applyData(pluginId: string, patch: Record<string, unknown>): Promise<ConfigureResult>;
  listChanges(opts?: { pluginId?: string; limit?: number }): Promise<EcosystemChange[]>;
  restore(changeId: string): Promise<RestoreResult>;
}
```

Engine / `src/core` 不 `import 'obsidian'`。HTTP 只在主线程 adapter。`src/profiles/` 不实现本端口。ADR-018 出站：`update_plugin` 与 `install_plugin` 相同，**仅确认之后**才下三件套；`checkUpdate` 只拉 raw HEAD/manifest，不拉 github.com release。实现期评估是否给 ADR-018 补这一句（**改 ADR 前按 AGENTS 确认**）。

### 5.15 设置、权限、破坏性

- `ecosystemWriteEnabled`：已有，默认 `true`；UI 已在高级设置。本交付**不**改默认值、不拆两套 manifest。`update_app_config` / `ratel-config` **不得**代关/代开此开关（不进设置白名单）——与 S-HOST-ACCESS 总闸同纪律。
- `false` 时：`search_plugins` / `get_plugin_status` / `list_ecosystem_changes` 仍可用；`install_plugin` / `update_plugin` 只开官方页；`uninstall_plugin` / `configure_plugin` apply / `restore_backup` **拒绝写盘**并说明去设置打开写盘。inspect 只读仍可用。
- 破坏性集合须列入：`install_plugin`、`update_plugin`、`uninstall_plugin`、`configure_plugin`、`restore_backup`（auto 档仍确认）。`search_plugins` / `get_plugin_status` / `list_ecosystem_changes` / inspect 只读。
- 桌面 + 社区插件受限模式已关：否则生态写工具开场失败并指路，不写盘。

### 5.16 社区 SOP 示例骨架（实现期落 builtin Skill，内容以此为准）

文件名建议 `install-community-plugin`（可改，语义不许做成脚本写盘）。`SKILL.md` 正文只教调工具：

```markdown
# 安装官方商店插件

当用户要用某个社区能力（看板、日历、任务…）而当前库没有对应插件时：

1. 调用 search_plugins，只推荐返回列表里的项（作者、下载量或未知、是否已装）。
2. 用户点名一个 id 后调用 install_plugin；被拒绝或官方页模式则停止，不要改用脚本或笔记工具写配置目录。
3. 用户要更新已装插件时调用 update_plugin，不要用 install_plugin 覆盖。更新不得改 data.json。
4. 需要改设置时：先 match_plugin_profiles（若该工具存在）；有 hit 则把预览的 patch 交给 configure_plugin op=apply。
   无 hit 则 configure_plugin op=inspect，再按用户点名的 key apply。密钥类不要填。
5. 用户要卸：uninstall_plugin。不要自己删 .obsidian。
```

禁止在 SOP 里贴整份 `data.json`。激活只注入本文，不降 `ask`。

### 5.17 命令面板

本交付**不**新增强制命令。可选（非验收项）：「重载社区插件清单缓存」——清 TTL 后下次 search 再拉。档案重载命令属 S-PLUGIN-PROFILE。

### 5.18 i18n

工具显示名、确认弹窗、错误、R3 官方页说明、热启用失败、already-installed、already-current、forbid 拒绝、stale 缓存、data.json 不变，全部走 `src/i18n`。开发者 `console` 用中文。不在本 spec 锁死 key 字符串。

---

## 6. v9 基线 vs 本修订待补

| 已在 v9 | 本交付仍缺 |
|---|---|
| ADR-018、README 第三条网口径（以当时切片为准，发版时再对） | `uninstall_plugin` / `get_plugin_status`（含已装列表） / `list_ecosystem_changes` / `restore_backup` |
| denylist、通道 B、search、install、R2/R3 | `update_plugin` + `configure_plugin` + 日志/备份模块 |
| | 已装不覆盖；安装失败不得删完整安装；更新失败从备份恢复 |
| | 破坏性集合补 update / uninstall / configure / restore |
| | 确认弹窗补全（作者/下载量/路径/key/version/不改 data.json） |
| | 社区 SOP 作者说明 + 至少一份示例安装（或安装+更新+配置）Skill |
| | 架构正文「ADR-018 待立」改为已立；图中 `update_plugin` 改为已纳入（**改 architecture / ADR 前按 AGENTS 确认**） |

---

## 7. 影响面

| 区域 | 变化 |
|---|---|
| `src/utils/path-safety.ts` | 通道 B（已有则补本地已装 id / 下架清理） |
| `src/adapters/ecosystem-*` | registry / vault / runtime / install；**新增** update（只写三件套）+ data.json 点名读写 |
| `src/adapters/ecosystem-install.ts` | 已装不覆盖；失败清理不得删完整安装 |
| `src/ports/ecosystem.ts` | 新；含 `update` / `listInstalled` |
| `src/core/ecosystem-change-log.ts` / `ecosystem-backup.ts` | 新；含 `update` 快照 |
| `src/core/tool-permissions.ts` | 破坏性集合补 update / uninstall / configure / restore |
| `src/tools/` | 补 6 个 + `configure_plugin`；已有 search/install 对齐本修订 |
| `src/skills/script-vm.ts` / `run-skill-script.ts` | denylist 已有；保持 |
| `src/i18n/` | 工具名、确认、错误 |
| README / user-guide | 隐私第三条网、斜杠无新增、对话能力、作者 SOP 一节 |
| 架构 host/ecosystem.md | 指针与 ADR-018 已立（改前确认）；`update_plugin` 与本文 §5.5 对齐 |
| S-PLUGIN-PROFILE | 消费端；版本不够可建议 `update_plugin`，仍不改通道 B |

---

## 8. 测试矩阵（本交付必须有单测；对话验收见 §5.10）

| ID | 断言 |
|---|---|
| T-A1 | 通道 A：笔记工具写 `configDir/...` 拒绝 |
| T-B1 | 通道 B：白名单 `plugins/<清单或已装 id>/` 与启用清单放行；`ratel-vault` 拒 |
| T-B2 | 通道 B：`..` / 绝对路径 / 反斜杠 拒 |
| T-S1 | `search_plugins` 返回 ≤8；不含整份清单 |
| T-S2 | 无网 + 过期缓存：可搜且带 stale；无缓存失败 |
| T-I1 | R2 新装：三件套 + 启用清单含 id |
| T-I2 | 已有合法 manifest：already-installed，三件套字节不变 |
| T-I3 | 半成品目录：可清后重装 |
| T-I4 | 安装失败不得 `removeRecursive` 已完整安装的目录 |
| T-I5 | R3：零写他人目录，打开 `obsidian://show-plugin?id=` |
| T-I6 | `minAppVersion` 过高拒绝 |
| T-I7 | 热启用 API 缺失：filesWritten 真、enabled 假、Reload 文案 |
| T-P1 | `update_plugin` 覆盖三件套后 `data.json` 字节级不变 |
| T-P2 | 已是 HEAD version：already-current，三件套不变 |
| T-P3 | 本地高于 HEAD：不降级 |
| T-P4 | 更新失败：目录从备份恢复，含原 `data.json` |
| T-P5 | 未装 / 下架：update 拒绝 |
| T-P6 | R3 update 零写盘 |
| T-P7 | 新 release 无 styles.css：旧 styles.css 仍在 |
| T-G1 | 省略 pluginId 的 status：列出本地已装且不含 ratel-vault，不出站 |
| T-U1 | 卸载：备份存在、目录消失、启用清单无 id |
| T-U2 | 下架仍在本地：仍可卸 |
| T-C1 | apply 只改点名叶子；兄弟不变 |
| T-C2 | 20 key 超限拒绝 |
| T-C3 | forbid / 启发式密钥：整次失败零写盘 |
| T-C4 | 新 key 必须 needsConfirm |
| T-C5 | 点号非法 / 数组下标：整次失败 |
| T-C6 | apply 中途失败：原 JSON 完好 |
| T-L1 | jsonl append-only；restore 后再记 restore |
| T-L2 | 每插件备份 >3 份：最旧 expired |
| T-K1 | 脚本写 `configDir/plugins/x/data.json` 抛错且不落盘 |
| T-K2 | 开关 false：uninstall/configure/restore 零写盘；install/update 只开官方页 |

---

## 9. 能力完整度（底座自审）

社区插件这条线，用户要能走完「找 → 看已装 → 装 → 升 → 配 → 卸 → 查日志 → 回滚」。对照后：

| 用户意图 | 工具 | 本修订 |
|---|---|---|
| 找商店插件 | `search_plugins` | 有 |
| 我装了哪些 | `get_plugin_status`（省略 id） | 有 |
| 装 | `install_plugin` | 有（v9 骨架 + 已装不覆盖） |
| 升且保住设置 | `update_plugin` | **纳入** |
| 点名改设置 | `configure_plugin` | 有 |
| 按档案改设置 | Profile 匹配 → 同上 | 见 S-PLUGIN-PROFILE |
| 别人写装/配 Skill | SOP 只调工具；`SKILL-AUTHORING.md` + builtin 示例 | 有（不单开 marketplace spec） |
| 卸 | `uninstall_plugin` | 有 |
| 查/撤 | `list_ecosystem_changes` / `restore_backup` | 有 |
| 脚本偷改配置 | denylist | v9 已有 |
| 改 Obsidian 官方核心设置 | — | **仍不做**（EC-09） |
| 装主题 / 店外 URL | — | 不做 |

档案底座（PP-09）不在本文扩 50 份官方档案；schema + 规则 + 草稿 + 一份示例即闭环。

仍刻意留在底座外的：EC-09、`versions.json` 兼容回退、降级、商店 UI。

---

## 10. 参考

- [prd/ecosystem.md](../../prd/ecosystem.md)
- [prd/requirements.md](../../prd/requirements.md) EC-01～10（本交付不含 EC-09 产品面）
- [ADR-018](../../adr/2026-09-18-ecosystem-outbound.md)
- [S-PLUGIN-PROFILE](2026-09-10-plugin-profile-design.md)
- [S-ECOSYSTEM-CUT1（已取代）](../archive/S-ECOSYSTEM-CUT1/2026-09-20-ecosystem-first-cut-design.md)
- [S-HOST-ACCESS](2026-09-11-host-access-design.md)（不得放宽沙箱）
- 清单：https://github.com/obsidianmd/obsidian-releases

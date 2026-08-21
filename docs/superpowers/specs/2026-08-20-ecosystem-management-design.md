# S-ECOSYSTEM — Obsidian 插件生态管理

> 日期: 2026-08-20
> 状态: Active
> Spec ID: **S-ECOSYSTEM**
> 关联: [PRD §7.3 生态管理](../../PRD.md)、[EC-01 ~ EC-09](../../PRD.md)、[ADR-014](../../adr/2026-08-03-mcp-host-platform.md)(网络出站先例)、新 ADR-018(待立)

## 1. 背景

PRD 已将产品定位升级为「主动智能的知识与环境管理 Agent」，生态管理是支柱 C。Obsidian 2000+ 社区插件的发现、安装、配置、更新是各类用户的持续摩擦，且当前 Obsidian AI 竞品均未覆盖。Ratel 作为生长在 Obsidian 内的 Agent，用对话完成「需求 → 推荐 → 确认安装 → 配置 → 可回滚」闭环。

现有能力边界：`get_app_config` / `update_app_config` / `open_settings` 只管 Ratel 自身；所有文件操作被 `validateVaultPath` 挡在整个 configDir 之外。本 spec 把管理范围扩到**其他插件与启用清单**，同时保持物理安全边界不变。

## 2. 目标

1. 用户用自然语言探索社区插件并得到带作者、下载量、已装标注的推荐（EC-01）
2. 确认流安装商店插件，即装即用免重启（EC-02）
3. 更新保留用户配置、卸载先备份后移除（EC-03 / EC-04）
4. 点名 key 最小 diff 修改其他插件配置（EC-05）
5. **每次环境变更留 append-only 日志，任意变更可回滚**（EC-06 / EC-07 — 本 spec 核心）
6. 路径白名单物理校验，越界不可达（EC-08）
7. Obsidian 官方设置只引导不代改（EC-09）

## 3. 非目标

- 不做插件商店浏览 UI（入口是对话，不复制 Obsidian 原生界面）
- 不代改 Obsidian 核心配置（app.json / hotkeys.json / core-plugins 等，只引导定位）
- 不安装商店清单之外的来源（裸 URL、本地旁路包）
- 不做主题与 CSS snippet 管理
- 不做 Ratel 自身插件目录的管理（防 Agent 改自己，维持禁区）
- 不做插件的语义级「深度调优」（如自动生成整套配置模板）— v1 只做点名 key 修改

## 4. 详细设计

### 4.1 三域模型与目录地图

| 域 | 对象 | 能力 |
|---|---|---|
| Ratel 自身 | 本插件设置、密钥、技能 | 已有工具（get/update_app_config、open_settings） |
| Obsidian 官方 | 核心设置 | 只引导：`open_settings` 扩展支持打开官方设置页（`app.setting.open()` + 官方 tab id，unknown 中转，与 `openPluginSettings` 同模式） |
| 社区生态 | 其他插件与启用清单 | 本 spec 新增 8 工具 |

configDir（名字用户可自定义，启动期已注入）内路径归属：

| 路径 | 策略 |
|---|---|
| `plugins/<id>/`（清单校验过的社区插件） | ✅ 生态工具可写 |
| `plugins/ratel-vault/` | ❌ 禁区（Agent 不得改自己） |
| `community-plugins.json` | ✅ 仅生态工具可写（启用清单） |
| configDir 其余一切（app.json、hotkeys、workspace、themes…） | ❌ 禁区 |
| vault 内 `.trash/` 与 configDir | ❌ 维持现有禁区 |

### 4.2 双通道路径校验（物理禁止）

现有 `validateVaultPath`（[path-safety.ts](../../../src/utils/path-safety.ts)）保持原样——通道 A，所有现有工具继续把整个 configDir 拒之门外。

新增通道 B `validateEcosystemPath`，仅生态 adapter 调用：

- 只放行两种形状：`<configDir>/plugins/<id>/...` 与 `<configDir>/community-plugins.json`
- `<id>` 必须先通过商店清单或本地已装清单校验（不存在的 id 直接拒绝，杜绝拼路径写任意目录）
- `<id>` 为 `ratel-vault` 时拒绝
- `..` 穿越、绝对路径、反斜杠变形沿用通道 A 的归一化与拒绝逻辑

物理拦截在 adapter 层完成，工具参数只做类型校验；不依赖模型自觉或 prompt 约束。

### 4.3 数据源与网络边界

| 数据 | 来源 | 缓存 |
|---|---|---|
| 社区插件清单（json） | `raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json` | pluginDir 缓存，7 天过期 |
| 插件 release 版本与产物 | `api.github.com`（版本）/ `github.com`（下载 main.js / manifest.json / styles.css） | 不缓存 |
| 本地已装/版本/启用态 | 本地 manifest.json + community-plugins.json | 直读 |

- 出站仅发生在用户发起生态操作时；清单 2MB+ 不进模型上下文，本地过滤排序后只返回 top N
- 网络出站扩展需新 ADR-018（要点：出站域名清单、触发时机、失败降级、README 隐私说明同步）
- 下载产物前校验 manifest.json 的 id 与目标插件 id 一致（防错包）

### 4.4 工具面（8 个）

| 工具 | 做什么 | 备注 |
|---|---|---|
| `search_plugins` | 清单内搜索，返回 top N 候选（id、名称、描述、作者、下载量、是否已装） | 本地过滤排序，不把清单喂模型 |
| `install_plugin` | 清单定位 → 确认 → 下载三件套 → 写入 → 运行时启用 | `app.plugins.loadManifests()` 后 `enablePlugin(id)`，免重启 |
| `uninstall_plugin` | 禁用 → 备份 → 删目录 | 确认弹窗列将删除的目录 |
| `update_plugin` | 查最新 release → 备份 → 覆盖三件套 | **跳过 data.json**，配置不丢 |
| `configure_plugin` | 读目标插件 data.json → 返回结构；或按点名 key 写回 | 写前展示前后值，最小 diff |
| `get_plugin_status` | 已装清单：id / 名称 / 版本 / 启用态 / 可更新 | 更新的发现入口 |
| `list_ecosystem_changes` | 查看变更日志（最近 N 条或指定插件） | 支撑「Ratel 对我的环境做过什么」 |
| `restore_backup` | 从指定 changeId 恢复 | 目录与启用清单一起恢复 |

所有变更类工具（install/uninstall/update/configure/restore）默认权限 `ask`，走现有 ToolPermission 确认流；确认弹窗展示动作、目标插件、作者、下载量与前后值摘要。

### 4.5 变更日志 EcosystemChange（核心 — 敏感操作留痕）

**记录范围**：对 Obsidian 环境的每一次修改，无一例外：

- `install` / `update` / `uninstall`（插件目录变动）
- `enable` / `disable`（community-plugins.json 写入，含装/卸附带的启用变更单独记一条）
- `configure`（其他插件 data.json 的每次 key 修改）
- `restore`（回滚本身也记录 — 回滚的回滚）

**记录字段**（append-only，一行一条 JSON）：

```json
{
  "id": "ch_000042",
  "time": "2026-08-20T14:30:00Z",
  "action": "update",
  "pluginId": "calendar",
  "summary": "0.4.1 → 0.5.0",
  "before": { "version": "0.4.1" },
  "after": { "version": "0.5.0" },
  "backupPath": "ecosystem-backups/ch_000042/",
  "status": "recorded"
}
```

- `configure` 的 before/after 记点名 key 的前后值（截断至摘要长度，大值记哈希+长度）
- `community-plugins.json` 变更记启用数组的前后 diff
- **存储**：`pluginDir/ecosystem-changes.jsonl`，append-only，不进 vault、不出网、不复制完整正文
- **状态机**：`recorded`（已记录）→ `restored`（已被回滚）→ `expired`（备份已清理）
- 用户通过 `list_ecosystem_changes` 在对话中随时查询完整历史

### 4.6 备份与恢复

- 位置：`pluginDir/ecosystem-backups/<changeId>/`
- 内容：变动前该插件目录完整快照（目录级复制）+ `community-plugins.json` 快照（若本次涉及）
- 保留：每插件最近 3 份，超出清理最旧（清理时对应日志条目标 `expired`）
- 恢复：`restore_backup(changeId)` → 确认 → 目录覆盖/删除 + 启用清单还原 → 记一条 `restore` 变更
- 恢复后插件需重新启用时走运行时 API，免重启

### 4.7 错误处理

- 下载/安装中断：清理半成品目录；无法清理时明确告知残留位置
- 启用失败：回滚到变更前状态并告知原因
- 清单拉取失败：用缓存并标注数据日期；缓存不可用时明确说明无法探索，本地管理与回滚不受影响
- data.json 写入失败：保证原文件未破坏；已破坏时自动恢复备份并告知
- GitHub 限流（429）：明确错误信息 + 可重试提示

### 4.8 i18n 与 UI

- 全部新字符串走 `src/i18n/zh.ts` / `en.ts`（工具显示名、确认弹窗、错误消息）
- 工具显示名友好化：如「安装插件 calendar」「查看变更历史」
- 工具卡 busy 状态显示目标插件名（复用 0.5.0 的 label 机制）

## 5. 影响面

| 区域 | 变更 |
|---|---|
| `src/utils/path-safety.ts` | 新增 `validateEcosystemPath`（通道 B） |
| `src/adapters/ecosystem-vault.ts`（新） | 生态文件 adapter：白名单校验、目录快照、data.json 读写 |
| `src/adapters/ecosystem-registry.ts`（新） | 商店清单缓存、release 查询、产物下载 |
| `src/core/ecosystem-change-log.ts`（新） | EcosystemChange append-only 日志 |
| `src/core/ecosystem-backup.ts`（新） | 备份与恢复 |
| `src/tools/` | 8 个新工具 |
| `src/adapters/obsidian-workspace.ts` | `open_settings` 扩展官方设置页定位 |
| `src/i18n/` | 新 namespace |
| `adr/2026-08-20-ecosystem-network.md`（新） | ADR-018 网络出站扩展 |
| 文档 | README 隐私说明、user-guide、CHANGELOG |

## 6. 参考

- [PRD §7.3 生态管理](../../PRD.md)
- [ADR-014: MCP Host 平台](../../adr/2026-08-03-mcp-host-platform.md)（opt-in 出站先例）
- [obsidian-releases 社区清单](https://github.com/obsidianmd/obsidian-releases)
- 分期：Phase 1 = 4.5/4.6 日志备份基建 + search/install/status；Phase 2 = update/configure/uninstall/restore + open_settings 官方定位

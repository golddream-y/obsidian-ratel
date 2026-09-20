# ADR-018: 生态出站 — 官方社区清单 + GitHub release（第三条网）

**状态**:Accepted  
**日期**:2026-09-18  
**关联**:
- [ADR-001](2026-06-14-ratel-cors-strategy.md)(`requestUrl` 绕 CORS;生态 HTTP 复用,禁止 Worker 出站)
- [ADR-006](2026-06-28-release-asset-distribution.md)(商店/BRAT 三件套契约:`main.js` + `manifest.json` + 可选 `styles.css`)
- [ADR-014](2026-08-03-mcp-host-platform.md)(第二条网:用户显式配置 MCP 后才出站;本 ADR 是**并列的第三条网**,不是 MCP opt-in)
- [ADR-017](2026-08-19-skill-script-sandbox-worker-vm.md)(Skill 脚本沙箱;本 ADR 补 PP-08:脚本不得写 `configDir`)
- [S-ECOSYSTEM](../superpowers/specs/2026-08-20-ecosystem-management-design.md)
- 架构正文 [host/ecosystem.md](../architecture/host/ecosystem.md)

---

## Context(背景)

支柱 C 要让用户在对话里**只在官方社区商店清单内**找插件,确认后把该插件 GitHub release 的三件套写入**当前库**的 `configDir/plugins/<id>/`,并尽力热启用。

这与已有两条出站通道不同:

| 通道 | 何时出站 | 用户是否单独配 URL |
|---|---|---|
| 模型 API | 对话默认就会走 | 用户配 Base / 密钥 |
| MCP(ADR-014) | 用户在设置里添加 Server 之后 | 是(URL 或 spawn 命令) |
| **生态(本 ADR)** | 用户在对话里调用生态工具之后 | **否** — 域名由插件写死,不是用户填的任意 URL |

公开 Plugin API **没有** install / uninstall。本能力 = 用户确认后在本机写盘 + 尝试调用**未文档** `app.plugins.*`。不能声称官方授权,不能向官方申请「插件管理权」。先例有 BRAT;不保证社区商店过审。

现网缺口:`validateVaultPath`(通道 A)已挡住全部笔记工具进 `configDir`;但 `run_skill_script` 的 fs 白名单是整个 vault 根,脚本今天就能写他人 `data.json`。第一刀必须先物理封死(PP-08 精神),即使还没有 `configure_plugin`。

---

## Decision(决策)

### 1. 出站域名(精确列表)

仅允许下列主机,且仅生态适配器经 `requestUrl`(ADR-001)访问。禁止扫任意 URL、禁止店外 zip / 裸 GitHub URL / 本地路径安装。

| 主机 | 用途 | 第一刀是否实际请求 |
|---|---|---|
| `raw.githubusercontent.com` | 官方 `community-plugins.json`、`community-plugin-stats.json`;目标插件仓库 `HEAD/manifest.json` 与必要时 `HEAD/versions.json` | 是 |
| `github.com` | `/{owner}/{repo}/releases/download/<version>/` 三件套(跟随 302) | 仅 `install_plugin` 且用户已确认 |
| `objects.githubusercontent.com` | release 资源 CDN(下载 302 后的落点,不主动拼 URL) | 被动跟随 |
| `community.obsidian.md` | 可选:同步 stats 的上游 CDN | 第一刀**不**作为主路径;主路径用 raw 上的 stats 文件 |

**明确不做:** 默认路径**不**打 `api.github.com`。版本定位对齐官方算法(仓库 `manifest.json` 的 `version` + 同名 tag),**禁止**跟 `/releases/latest`(Calendar 会落到过期 beta)。不向用户要 GitHub PAT。

### 2. 触发时机(第三条网 ≠ 后台偷偷刷)

- **无后台刷新。** 过期缓存不会在 onload / 定时器里出站。
- **`search_plugins`:** 用户(经 Agent)调用该工具即视为发起探索。若本地缓存在 TTL 内则不出站;过期或缺失才拉清单/stats。这是用户发起,不是 opt-in 填 URL。
- **`install_plugin`:** 仅在权限门放行(默认 `ask`,且视为破坏性)之后才下载 release。拒绝则零出站、零写盘。
- 笔记工具、Skill 脚本、MCP 默认**不**接生态 Port,不能借道出站。

### 3. 失败怎么对用户说

| 情况 | 行为 |
|---|---|
| 有过期缓存 | 仍可搜索;结果标注「过期缓存 + 拉取日期」 |
| 无缓存且拉清单失败(含无网) | 探索失败,明确报错;不得假装「商店里没有这个插件」 |
| GitHub 429 | 可重试错误;不得静默当缺失 |
| 无缓存但插件已在本地 | `get_plugin_status` / 后续卸载仍可用 |
| 下载中断 / 缺 `main.js` / `manifest.id` 不匹配 | 清理半成品目录或报残留路径 |
| 热启用失败 | **安装事务仍算成功**(EC-02):保留目录与启用清单;文案「文件已安装,请 Reload app without saving 或到社区插件页打开」。不假装已启用 |

与 `trust.md`「启用失败就整笔回滚」的差异:**跟 EC-02 留盘**,不跟 trust 全回滚。半成品(下载未完成)才清目录。

### 4. 与 ADR-014 并列的隐私叙事

README「网络 / 隐私」写成**三条通道**,不要把生态写成「一种 MCP」:

1. 模型 API — 对话默认  
2. MCP — 用户显式配置 Server 后  
3. 生态 — 仅当用户确认/调用生态工具时,访问官方清单与所选插件的 GitHub release  

插件自身仍无遥测、无数据收集。清单整份(~1–2MB)**不**进 `data.json`、**不**进模型上下文;只把本地过滤后的 top N 交给模型。

### 5. GitHub 限额与 PAT

永不要求用户提供 GitHub PAT。目录与 stats 走 raw;资产走 `releases/download`。若将来 tag 回退需要 `api.github.com`,另开修订;第一刀不做。

### 6. 缓存

| 文件 | 位置 | TTL |
|---|---|---|
| `ecosystem-catalog.json` | Ratel `pluginDir`(不是 vault 笔记,也不是本库 `community-plugins.json`) | 默认 7 天 |
| `ecosystem-stats.json` | 同上 | 默认 7 天 |

元数据含 `fetchedAt`、源 URL。原子写(tmp + rename)。Obsidian Sync 若同步了插件目录,缓存可能被同步 — 接受;不要为此改成笔记库路径。

**命名碰撞:** 远程商店目录是对象数组;本库 `<configDir>/community-plugins.json` 是已启用 id 的字符串数组。缓存文件不得覆盖启用清单。

### 7. 完整通道 vs 商店保守包

**同一 `manifest`,一项设置:** `ecosystemWriteEnabled`(默认 `true`,服务自用 / BRAT / 过审后完整能力)。

| 旗标 | 探索 | 安装 |
|---|---|---|
| `true`(R2) | 清单检索 | 写三件套 + 写启用清单 + 尽力 `loadManifest` / `enablePluginAndSave` |
| `false`(R3,商店保守) | 清单检索仍可 | **零写**他人插件目录;打开 `obsidian://show-plugin?id=<id>`(失败则文案引导设置 → 社区插件) |

UI / README 必须与旗标一致。禁止商店包对外写「说一声就装好」。不发两套插件 id。

### 8. 未文档 API

允许在 `typeof === 'function'` 守卫下调用 `loadManifest` / `loadManifests` / `enablePluginAndSave`。  
**不**把 `installPlugin` 当稳定合约(可作可选快路径,失败立刻回退 R2 自写盘)。  
缺方法或抛错时的承诺句:**文件已写入当前库;请 Reload 或到官方社区插件页启用。**

### 9. 通道 B 与「本地已装 id」

`validateEcosystemPath` 只放行:

- `{configDir}/plugins/{id}/**`,且 `id ≠ ratel-vault`,且 id 在商店清单 **或** 本地已装目录中已校验
- `{configDir}/community-plugins.json`

禁止写死 `.obsidian`;必须用注入的 `app.vault.configDir`。  
清单已下架但本地仍有目录的 id:**仍可**查状态 / 卸载 / 从本刀备份恢复,不得因下架而无法清理。

生态 IO **不得**缝进 `ObsidianVault`、不得 catch `validateVaultPath` 再放行。

### 10. Skill / MCP 写 configDir

物理强制写在本 ADR + ADR-017 修订:

- Skill 沙箱 `allowedDirs` 仍含 vault 根,但 `deniedDirs` 拒绝 `configDir` 整棵(读/写均拒),与通道 A 同形。
- 只有生态 adapter 能写通道 B;笔记工具与 `run_skill_script` 不接该 port。
- 用户自建任意 FS MCP 仍可能写盘 — 权限门 + 文档一句;不在本 ADR 实现范围。

`configure_plugin` / 点名改 `data.json`:**非本 ADR,第三刀。** 第一刀禁止 Skill 与生态安装器写他人 `data.json`。

### 11. 半成品 vs Sync

下载/写入中断:**优先清理**目标插件目录;清理失败则把残留路径写进工具结果。  
与 Sync 冲突导致 `adapter.write` 失败:明确失败,不假装成功;不覆盖冲突而不说明。

### 12. 配置(标明后置)

- 改他人 `data.json` 是否热生效、点号路径/数组下标:第三刀。第一刀不写他人 `data.json`。

### 13. 明确不做

- 声称 Obsidian 授权 / 「官方插件管理器」
- 商店外安装
- 管理 `ratel-vault` 自己
- 把 2MB 清单塞进 `data.json`
- 主题 / CSS snippet / 代改 `app.json` 与核心插件
- 本刀不实现 `update_plugin`、`configure_plugin`、卸载回滚全集(可后续同一支柱)

---

## Consequences(后果)

### 正面

- 隐私边界可讲清:第三条网有域名白名单、无后台刷新、无 PAT、无遥测。
- 审核可降级:关 `ecosystemWriteEnabled` 后仍能推荐,不代装。
- PP-08 在装卸期就不破:脚本进不了 `configDir`。

### 负面 / 风险

- 未文档 API 随 Obsidian 版本变化;必须诚实降级。
- 商店审核不确定;完整写盘能力可能只能走 BRAT / 自用。
- 用户确认后仍会从 GitHub 拉第三方 `main.js` — 与手动装社区插件同级信任,须在弹窗展示 id / 名称 / 作者 / 下载量(拿得到时)。

### 后续影响

- README 中英隐私表增加「生态出站」行。
- ADR-017 增加 configDir denylist 修订。
- AGENTS.md 网络边界与 ADR-014 并列补第三条。

---

## 参考

- [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) README(清单字段、三件套、tag = `manifest.version`)
- [obsidian-api](https://github.com/obsidianmd/obsidian-api)(无 install/uninstall)
- BRAT(`obsidian42-brat`) adapter 写盘 + `enablePluginAndSave`
- ADR-014 MCP 出站先例(opt-in URL;本通道不是 opt-in URL)

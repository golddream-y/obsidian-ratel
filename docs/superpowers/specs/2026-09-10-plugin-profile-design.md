# S-PLUGIN-PROFILE — 社区插件配置档案

> **架构正文:** [docs/architecture/host/plugin-profile.md](../../architecture/host/plugin-profile.md)。对象字段与校验以本文 §6～§8 与架构一致；冲突时先改其中一份并交叉引用，禁止两套 schema。

> 日期: 2026-09-10
> 修订: 2026-09-20 — PP-08 墙曾随 CUT1 提前；档案产品后置
> 修订: **2026-09-21 — 与 S-ECOSYSTEM 社区插件底座同交付。** 本交付交出 schema、写作规则、识别草稿、恰好一份示例、只读匹配、可选 `sopSkill`。写入仍只走 `configure_plugin`。已装版本不够可**建议** `update_plugin`，档案层自己不写盘。CUT1 分期作废。
> 状态: Active
> Spec ID: **S-PLUGIN-PROFILE**
> 关联: [支柱 C](../../prd/ecosystem.md)、[PP-01～09](../../prd/requirements.md)、[S-ECOSYSTEM](2026-08-20-ecosystem-management-design.md)（**写入硬依赖**）、[ADR-009](../../adr/2026-07-06-skill-mechanism.md)、[ADR-012](../../adr/2026-07-23-skill-activation-claude-aligned.md)、[ADR-018](../../adr/2026-09-18-ecosystem-outbound.md)

---

## 1. 背景

社区插件设置在各自 `data.json`，没有统一 API。若让模型现编整文件，无法审计、无法回滚语义、也无法开源复用。

本子系统把「这个开源插件该怎么配」做成**可校验的档案**，与「怎么装、怎么写盘」拆开：

- **知识层（本文）：** 一份格式契约 + 多份实例 + 识别草稿 + 匹配。
- **执行层（S-ECOSYSTEM）：** 寻找、安装、更新、卸载、点名写入、确认、备份、日志。

Skill 仍只做 SOP（教模型何时调哪套 preset / 哪个工具）。真读写永远走工具。`ratel-config` 的「SOP + 专用工具」可复用到他人插件，白名单来自档案允许 key 减去 `forbid`。

**一份 schema，多份档案。** 插件变多只增加文件，不增加语法。

---

## 2. 目标（与执行层同一交付）

1. **PP-01 / PP-02：** 全库唯一 Profile schema；档案绑定商店 `pluginId`，清单对不上则不能据此安装。
2. **PP-03 / PP-04：** 写作规则可产出合法档案；识别器从已装插件生成草稿，默认不生效。
3. **PP-05～07：** 按意图或 pluginId 匹配 preset；未装则走 `install_plugin`；已装版本不满足 range 则建议 `update_plugin`（用户确认后）；写入只应用选中 key 子集，经 `configure_plugin`。
4. **PP-08：** 禁止脚本写他人配置（执行层 denylist 已在 v9；本文不得再开脚本写盘）。
5. **PP-09：** 底座含 schema、规则、识别草稿、**恰好一份**示例档案（建议 Calendar「周一开始」，若该插件已不在清单则换一个仍在清单内的插件，spec 不锁死 id）。
6. 社区作者可以：手写档案（校验后启用）+ 可选同名 SOP Skill。没有 `configure_plugin` 不得声称配置 Skill 已可执行。

---

## 3. 非目标

- 每个插件一份不同 schema；运行时读目标插件源码生成并写入。
- 第一期 50+ 官方档案或「深度调优」整盘覆盖 `data.json`。
- 新开能力 `kind`。
- 替代通道 B、确认弹窗、`EcosystemChange`。
- 商店外 `install.source`；`pluginId === ratel-vault`。
- 密钥代填。
- 档案层自己执行升级。`pluginVersionRange` 不够时只**建议**执行层 `update_plugin`；用户拒绝则默认不 `configure`，强制写入须 `needsConfirm`。

---

## 4. 依赖（硬 / 软）

| 方向 | 内容 |
|---|---|
| **硬依赖 S-ECOSYSTEM** | 消费写入必须调用已落地的 `configure_plugin`；未装先 `install_plugin`；版本不够可先 `update_plugin`。没有 configure/install，本文只允许加载/匹配/展示预览，**验收不算通过** |
| 软依赖商店缓存 | `pluginId` 校验用 ADR-018 清单；缓存未就绪时档案可加载为 `unverifiedStoreId`，**不得**据此安装 |
| 已有 Skill 机制 | `sopSkill` 只 `activate_skill`；不改加载协议 |
| 不依赖 S-HOST-ACCESS | 出库闸不放宽脚本 |

可并行实现：schema / loader / matcher / 示例文件。不可单独发版声称「能配插件」。

---

## 5. 与 Skill / 能力池

| | Skill | Plugin Profile |
|---|---|---|
| 是什么 | 给模型的 SOP 文本 | 可校验的配置契约 |
| 激活 | `activate_skill` → Session | 匹配后把 preset 交给 `configure_plugin` |
| 写设置 | 只许教模型去调工具 | 自身不写 |
| `kind` | `skill` | 无；经只读工具被发现 |

社区「配置 Skill」= SOP 文本 +（推荐）一份档案。SOP 里写：先 `match_plugin_profiles`，再把 hit 的 patch 交给 `configure_plugin`。禁止在 SOP 里贴整份 `data.json` 让模型 extra 写盘。

---

## 6. 核心对象

落地类型建议 `src/profiles/types.ts`（名称可微调，语义不许漂）。

```typescript
type ProfileKind = 'obsidian-plugin-profile';
/** 点号路径；禁止 '..'、禁止以 '.' 开头或结尾 */
type SettingKey = string;

interface PluginProfile {
  kind: ProfileKind;
  id: string;                     // ^[a-z][a-z0-9-]{0,63}$
  pluginId: string;               // 商店 id
  pluginName: string;
  pluginVersionRange: string;     // semver range，如 ">=1.0.0"
  enabled?: boolean;              // 默认 true；draft 必须 false
  tags?: string[];
  sopSkill?: string;              // 可选已有 Skill 名
  install: { source: 'community-store' };
  forbid: SettingKey[];
  presets: ProfilePreset[];
}

interface ProfilePreset {
  id: string;
  when: string;                   // 用户场景，必填
  patch: Record<SettingKey, unknown>;
}

interface ProfileMatchQuery {
  utterance?: string;
  pluginId?: string;
  tags?: string[];
}

interface ProfileMatchHit {
  profileId: string;
  pluginId: string;
  presetId: string;
  score: number;
  reasons: string[];
}
```

仓库 JSON Schema 与上表一一对应。解析后先 schema，再 §7.3 语义校验。两道都过才进 Registry。

`LoadReport`（`loadAll` 返回）：

```typescript
interface ProfileDiagnostic {
  profileId?: string;
  path: string;
  code:
    | 'schemaInvalid'
    | 'semanticInvalid'
    | 'unknownPluginId'
    | 'unverifiedStoreId'
    | 'versionMismatch'
    | 'draftSkipped'
    | 'idCollision'
    | 'forbidOverlap'
    | 'parseError';
  message: string;
}

interface LoadReport {
  loaded: number;
  skipped: number;
  diagnostics: ProfileDiagnostic[];
}
```

诊断进现有 debug 日志，不进遥测。用户可见文案走 i18n。

### 6.1 存放（与 Skill 三源对齐，同 `id`：vault > global > builtin）

| 源 | 路径 |
|---|---|
| builtin | `<pluginDir>/plugin-profiles/<id>.yaml` |
| global | 用户主目录下 `.ratel/plugin-profiles/<id>.yaml`（文档用 `~/.ratel/...` 描述，实现用 os homedir，**源码与仓库不写本机绝对路径**） |
| vault | `<vaultRoot>/.ratel/plugin-profiles/<id>.yaml` |

接受 `.yml` / `.json`。文件名建议等于 `id`，不一致以文件内 `id` 为准并记诊断。草稿：`<id>.draft.yaml` 或 `enabled: false` — **不进匹配池**。`source`（builtin / global / vault）只在 Registry 内存里，**不写进档案文件**。

---

## 7. 加载与校验

启动与「重载档案」命令同一流水线。单文件失败不得拖垮其它档案。

### 7.1 覆盖

同 `id`：vault > global > builtin。同 id 且同源两份 → 按文件名排序后扫描者丢弃并诊断。

### 7.2 商店清单

`pluginId` 必须能在社区清单查到。清单未就绪：仍加载，状态 `unverifiedStoreId`；匹配可返回，**安装必须等清单校验**。清单就绪后对不上的从匹配池移除（文件可留，诊断 `unknownPluginId`）。

### 7.3 语义校验

| 条件 | 结果 |
|---|---|
| `kind` 不是 `obsidian-plugin-profile` | 拒绝 |
| `install.source` 不是 `community-store` | 拒绝 |
| `presets` 为空 | 拒绝 |
| 任一 `patch` key 与 `forbid` 相交 | 拒绝整份 |
| key 含 `..`、`/`、空白、控制字符 | 拒绝 |
| `patch` 值为 `undefined` 或不可 JSON 序列化 | 拒绝 |
| `pluginId` 为 `ratel-vault` | 拒绝 |
| 同一档案内 `presets[].id` 重复 | 拒绝 |
| `presets.length > 8` | 拒绝 |
| 任一 `patch` 的 key 数 > 20 | 拒绝（与 configure 单次上限对齐） |

`patch` key 在当前 `data.json` 不存在：校验阶段**不拒绝**。消费时标 `needsConfirm`。

---

## 8. 创建与识别

### 8.1 写作规则（与 schema 一起版本化，实现期 `plugin-profiles/AUTHORING.md`）

1. 只写用户常改的 5～15 个 key，不要抄整份 `data.json`。
2. 密钥、token、webhook、cookie 进 `forbid`，不要进 `patch`。
3. `when` 写用户场景，不写模块名。
4. 互斥配置不要塞进同一 patch。
5. 必须通过 schema + §7.3。

人或模型都可当作者；Ratel 运行时不得「自由发挥」补 key。

### 8.2 识别器

输入：已装 `manifest.json` + `data.json`（只读，走通道 B 只读或等效；**禁止写入该插件目录**）。

输出：draft：`pluginId` / `pluginName` / `pluginVersionRange`（如 `>=` 当前版本）；`forbid` 启发式 `/token|secret|password|apiKey|webhook|cookie/i`；`presets` 先空壳 `default` + `when: 待作者填写` + 空 patch。现网值可作注释快照，**不得**当已启用 preset 外发。

工具 `draft_plugin_profile`：默认 ask；只写 global 或 vault 的 draft 路径。识别器**禁止**调用 `configure_plugin` / `install_plugin`。

---

## 9. 匹配

`match` 只在 **enabled 且非 draft 且非 unknownPluginId** 的池上跑。

| 信号 | 权重 |
|---|---|
| `query.pluginId` 精确等于档案 `pluginId` | +100 |
| `query.tags` 与档案 `tags` 交集 | 每个 +20 |
| `utterance` 子串命中 `pluginName` / `pluginId` / `when` / `tags`（大小写不敏感） | 每命中字段 +10 |
| 无任何命中 | 不进结果 |

按 `score` 降序，默认最多 5 条；同分按 `profileId` 字母序。`presetId`：utterance 命中某 preset 的 `when` 则用它，否则档案内第一个 preset。

无命中：空列表。模型应退回 `search_plugins` / 点名 `configure_plugin`，**不得**声称已按档案配好。

---

## 10. 消费顺序

```
意图 → match_plugin_profiles
     → 展示 hit + 展开后 patch 预览
     → 未装且用户确认 → install_plugin（仅 community-store）
     → 已装版本不满足 pluginVersionRange
          → 默认不 configure；向用户展示 range 与已装 version
          → 用户同意升级 → update_plugin（执行层保 data.json）→ 再检查 range
          → 用户拒绝升级且仍要写 → needsConfirm 后才 configure
     → 若 sopSkill 存在且用户未拒绝说明 → activate_skill（只注入，不写盘）
     → configure_plugin({ pluginId, patch: 展开后的 key 子集 })
```

档案层**不得**自己下载三件套或改 `data.json`。`update_plugin` 失败则停止，不得退回用 install 覆盖。

展开规则：

1. 去掉用户没选的 key；
2. 去掉 `forbid`（再减一次）；
3. 已装 `data.json` 中不存在的 key 标 `needsConfirm`；
4. 点号路径只写叶子，不整枝覆盖未点名兄弟。

`configure_plugin` 可以不认识 Profile 类型，只收 `{ pluginId, patch }`。

---

## 11. 端口、文件与工具

### 11.1 端口 `src/ports/plugin-profile.ts`（零实现）

```typescript
interface PluginProfilePort {
  loadAll(): Promise<LoadReport>;
  get(id: string): PluginProfile | undefined;
  match(query: ProfileMatchQuery): ProfileMatchHit[];
  validate(raw: unknown): { ok: true; profile: PluginProfile } | { ok: false; errors: string[] };
}
```

识别写 draft 走单独方法，避免只读消费误写。`src/profiles/` 禁止 `import 'obsidian'`。

### 11.2 建议落点

```
src/profiles/
src/adapters/plugin-profile-fs.ts
src/tools/list-plugin-profiles.ts
src/tools/match-plugin-profiles.ts
src/tools/draft-plugin-profile.ts
schemas/obsidian-plugin-profile.schema.json
plugin-profiles/          # builtin 示例 + AUTHORING.md
```

### 11.3 工具权限与契约

| 工具 | 权限 | 入参 | 出参 |
|---|---|---|---|
| `list_plugin_profiles` | 只读 | 无 | `{ profiles: [{ id, pluginId, pluginName, source, enabled, presets: [{ id, when }] }] }`；不含 draft / unknownPluginId |
| `match_plugin_profiles` | 只读 | `utterance?: string`；`pluginId?: string`；`tags?: string[]`。至少一项非空 | `{ hits: [{ profileId, pluginId, presetId, score, reasons, patchPreview }] }`；`patchPreview` 已按 §10 展开（仍未写盘） |
| `draft_plugin_profile` | ask | `pluginId: string`；`dest?: "vault"\|"global"`（默认 vault） | `{ path, draft: true }`。已装才能扫 |
| `install_plugin` / `update_plugin` / `configure_plugin` | ask | **S-ECOSYSTEM 实现** | 见该 spec §5.11 |

只读工具进同一 ToolRegistry。`match` 不得调用 `configure_plugin`。

### 11.4 命令面板

必须有：「重载插件档案」，与启动同一 `loadAll()`。失败单文件进诊断，不弹崩溃。

### 11.5 解析与 semver 子集

- 接受 `.yaml` / `.yml` / `.json`。YAML 用**无原生模块**的纯 JS 解析（实现期选型，禁止 node 扩展）。JSON 用标准 `JSON.parse`。
- `pluginVersionRange` 本交付只认三种：`*`、精确 `x.y.z`、`>=x.y.z`。其它写法校验拒绝。比较算法与现网 `isAppVersionAtLeast` 同类（点分段数字），**不**为此引入完整 semver 库，除非后续 plan 单开。

---

## 12. 验收（本交付）

1. 非法档案（schema 或 forbid∩patch）不进匹配池，其它档案仍可用。
2. 清单对不上的 `pluginId` 不能触发安装。
3. 示例档案能被「周一开始 / 日历」一类 utterance 命中，预览 key 与示例 `patch` 一致。
4. draft 默认匹配不到；人手改为 enabled 后可命中。
5. 匹配后的 apply 走 `configure_plugin`：确认弹窗、最小 diff、日志可查；脚本写 `data.json` 仍失败。
6. 无档案时点名配置仍可用（执行层），且不得显示「已按档案最佳实践配好」。

---

## 13. 影响面

| 区域 | 变化 |
|---|---|
| 新 | schema、profiles 纯逻辑、fs adapter、三只读/草稿工具、一份 builtin 示例、AUTHORING.md、重载命令 |
| S-ECOSYSTEM | 只增加「收展开后的 patch」；不改通道 B |
| i18n | 工具名、匹配空、versionMismatch、重载命令 |
| 测试 | 见 §16 |
| 架构 plugin-profile.md | 与本文字段对齐（改前确认）；分期表「知识层可先于执行层」对本交付作废——必须同发 |

---

## 14. 示例档案（builtin，恰好一份）

实现期文件建议 `plugin-profiles/calendar-week-start.yaml`。**`pluginId` 以发版时官方清单为准**；若 `calendar` 已不在清单，换一个仍在清单内、有「周起始」类设置的插件，并改 `when` / `patch` 叶子，不改 schema。

```yaml
kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
enabled: true
tags: [calendar, week]
install:
  source: community-store
forbid:
  - token
  - apiKey
presets:
  - id: week-start-monday
    when: 周一开始
    patch:
      weekStart: 1
```

`weekStart: 1` 仅为示例叶子；识别器不得把用户现网值写成 enabled preset。

### 14.1 AUTHORING.md 必含（实现期落文件）

1. 5～15 个常改 key；密钥进 forbid。
2. `when` 写场景。
3. 互斥配置分 preset。
4. 必须过 schema + §7.3。
5. 指向 `configure_plugin`，禁止贴整份 data.json。
6. 存放三源与覆盖顺序。

### 14.2 JSON Schema 要点（实现期 `schemas/obsidian-plugin-profile.schema.json`）

`additionalProperties: false`。必填：`kind`（const）、`id`（pattern）、`pluginId`、`pluginName`、`pluginVersionRange`、`install`、`forbid`（array of string）、`presets`（minItems 1）。`presets[].patch` 的 value 不在 schema 里枚举业务 key。

---

## 15. 失败与诊断

`code` 见 §6 `ProfileDiagnostic`。`forbidOverlap` 与 schema 失败一样跳过该文件。`unverifiedStoreId` 可匹配但**不可**据此 `install_plugin`。`versionMismatch` 只在消费写入时出现，不阻止匹配预览。

---

## 16. 测试矩阵

| ID | 断言 |
|---|---|
| P-S1 | schema 失败 / forbid∩patch / 重复 preset id：不进池，其它档案仍可用 |
| P-S2 | `pluginId === ratel-vault` 拒绝 |
| P-S3 | 非法 `pluginVersionRange` 拒绝；`*` / 精确 / `>=` 通过 |
| P-L1 | 同 id：vault > global > builtin |
| P-L2 | 同源同 id 两文件：按文件名排序后丢后者并 `idCollision` |
| P-L3 | 单文件坏 YAML：`parseError`，不拖垮 loadAll |
| P-M1 | draft / `enabled: false` 不进 match |
| P-M2 | unknownPluginId 不进 match |
| P-M3 | 权重：pluginId +100；tag 交 +20；utterance 字段 +10；无命中空列表 |
| P-M4 | 同分按 profileId 字母序；最多 5 条 |
| P-M5 | utterance「周一开始」命中示例 preset，`patchPreview.weekStart === 1` |
| P-E1 | 展开去掉 forbid 与未选 key |
| P-E2 | 新 key 标 needsConfirm |
| P-D1 | draft 工具只写 `.draft.yaml` 或 `enabled: false`；不调 configure/install |
| P-X1 | 无档案时执行层点名配置仍可用；match 空不得声称已按档案配好 |
| P-X2 | versionMismatch：不自动 update；建议 `update_plugin` 后才 configure |

合流验收（需 S-ECOSYSTEM 工具）：§12 第 5 条。

---

## 17. 参考

- 架构：[host/plugin-profile.md](../../architecture/host/plugin-profile.md)
- [S-ECOSYSTEM](2026-08-20-ecosystem-management-design.md)
- [prd/ecosystem.md](../../prd/ecosystem.md)
- [prd/requirements.md](../../prd/requirements.md) PP-01～09
- [S-ECOSYSTEM-CUT1（已取代）](../archive/S-ECOSYSTEM-CUT1/2026-09-20-ecosystem-first-cut-design.md)

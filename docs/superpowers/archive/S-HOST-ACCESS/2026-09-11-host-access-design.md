# S-HOST-ACCESS — 库外访问与宿主命令

> 日期: 2026-09-11
> 状态: Archived
> Spec ID: **S-HOST-ACCESS**
> 关联: [tool-permissions](../../../src/core/tool-permissions.ts)（安全 / 自动 / 危险）、[config-whitelist](../../../src/settings/config-whitelist.ts)、[ADR-017](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md)（Skill 脚本仍禁止 shell / 出库 fs）

---

## 1. 背景

朋友场景需要读本机 Office 再收进库。现网所有工具路径锁在 Vault：盘符绝对路径直接拒，Skill 脚本 fs 只有「当前库 + 该 skill 目录」。

这不是再加一层确认钩子。产品只要两件事拆开：

1. **出库能力**（读本机文件、跑宿主命令）：设置里一把总闸 + 现有三档权限。
2. **文档解析**：库内 Skill 脚本抽正文。本 spec **不管**解析器。

## 2. 目标

1. 设置增加「允许访问 Obsidian 以外」，默认关；旁注写明打开后 Agent 可读库外路径、可把文件拷进当前库、可跑宿主命令，读到的内容仍可能发给已配置的模型 API。
2. 关闭时：库外文件工具与宿主命令工具不可用（不出现在模型可调清单，或调用立即失败且说明须在设置打开），Vault 内现有工具行为不变。
3. 打开后：这些工具走现有 `resolveToolPermission`，并一律视为破坏性（与 MCP / `delete_note` 相同）：安全档、自动档都要确认；危险档不再问；单工具「拒绝」优先。
4. `update_app_config` / `ratel-config` **不能**代开此开关（不进设置白名单）。
5. Skill 脚本沙箱不因本开关放宽：仍无 `child_process`、无网、fs 仍只有库根 + skill 目录。出库与命令只走本 spec 的内置工具。

## 3. 非目标

- 导入向导、目录长期授权、系统级文件钩子、额外确认栈（不再叠一层 Modal 专门拦「进库」）。
- 改写或删除库外原文件的专用工具（宿主命令若被用户允许，副作用由命令本身产生，不另做 `write_host_file`）。
- 本 spec 实现 docx / xlsx / pptx / pdf 解析，或把解析器打进 `main.js`。
- 放宽 Skill 脚本跑 shell、读盘符、访问网。
- 改「安全 / 自动 / 危险」三档语义本身。
- 代开开关、默认打开、或在 README 里把出库能力写成默认隐私模型。

**文档解析**另开 spec（暂名 S-DOC-PARSE）：库内已有文件用 Skill 抽成 Markdown，走现有 `run_skill_script` 信任门，不依赖本开关。

## 4. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| HA-01 | 总闸默认关 | 新安装与升级后未改过设置时，库外工具与宿主命令不可用 |
| HA-02 | 设置有开关与风险说明 | 文案含：库外路径、宿主命令、内容可能发往模型 API |
| HA-03 | 对话配置不能代开 | 白名单无此 key；`update_app_config` 改它失败 |
| HA-04 | 开闸后跟三档 | 安全/自动：破坏性确认；危险：不确认；单工具 deny 仍拒 |
| HA-05 | 关闸不影响库内 | `read_note` / `write_note` / 索引 / Skill 脚本（库内）行为与现网一致 |
| HA-06 | 沙箱不借道 | 开关开着时 `run_skill_script` 仍不能读 `C:\` 或 `exec` |

## 5. 详细设计

### 5.1 总闸

设置字段建议 `hostAccessEnabled: boolean`，默认 `false`，放在记忆与权限 Tab，紧挨工具权限档位。

关：相关工具不注册进给模型的清单（优先），避免模型空调。若实现上仍注册，`execute` 开头硬失败并提示去设置打开。

### 5.2 工具两类，同一权限桶

开闸后才存在的内置工具，全部 `isDestructiveTool === true`：

- **库外文件：** 列出目录、读文件、拷进当前库（Vault 相对路径仍走 `validateVaultPath`）。不提供改写/删除本机原文件的工具；不提供「选一次目录永久放行」。
- **宿主命令：** 用户机器上执行命令（具体 argv 契约在 plan 里钉）。不是 Skill 脚本、不是 MCP。

单工具仍可在设置里设 ask / allow / deny。默认 ask。

### 5.3 与现有门的关系

```
hostAccessEnabled?
  否 → 无此类工具
  是 → resolveToolPermission（deny → 档位 → 破坏性确认）
```

不新增 Hook 阶段。写进库的 `write_note` 仍只受原权限，不因来源是「刚从桌面拷来」再弹一次。

### 5.4 出站与隐私

库外读到的正文若进入对话，按现有模型/MCP 披露规则走，不另做通道。开关说明必须让用户知道这一点。README 隐私段在实现落地时补一句（本 spec 不改 README）。

## 6. 影响面

| 区域 | 变化 |
|---|---|
| `src/settings.ts` / i18n | 新开关 + 说明 |
| `config-whitelist.ts` | 该 key 列入永不白名单（测试守卫） |
| `tool-permissions.ts` | 新工具名加入破坏性集合 |
| `src/tools/` | 库外文件 + 宿主命令（plan 拆文件） |
| `src/main.ts` | 按开关注册工具 |
| Skill / ADR-017 | 不改沙箱白名单 |
| 文档解析 | 不在本 spec |

## 7. 参考

- [prd/trust.md](../../prd/trust.md)
- [ADR-017](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md)
- 现网档位：`settings.toolPermissionLevel` 安全 / 自动 / 危险

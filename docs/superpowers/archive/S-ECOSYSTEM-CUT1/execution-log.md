# S-ECOSYSTEM-CUT1 — 执行日志(按时间倒序)

> 该 spec **已被取代**（2026-09-21）：施工需求源改为 S-ECOSYSTEM + S-PLUGIN-PROFILE 的「装 + 配」修订。最新在前。

---

## 2026-09-21 — Superseded

| 项 | 说明 |
|---|---|
| 取代者 | [S-ECOSYSTEM](../../specs/2026-08-20-ecosystem-management-design.md) 2026-09-21 修订；档案侧 [S-PLUGIN-PROFILE](../../specs/2026-09-10-plugin-profile-design.md) |
| 原因 | 要一次交付装+配与社区 Skill 出口；CUT 分期会把 `configure_plugin` 永远推后 |
| 仍有效的代码 | `v9` 上 ADR-018、denylist、通道 B、`search_plugins` / `install_plugin`、R2/R3 — 并入母 spec 基线 |
| P-ECOSYSTEM-1 | 切片已合 `v9`；后续任务按母 spec 补卸/配/日志，不再以本文冻结加功能 |

---

## 2026-09-20 — P-ECOSYSTEM-1（第一刀骨架）

| Task / Group | 文件 | 状态 | 备注 |
|---|---|---|---|
| ADR-018 + 隐私 | `docs/adr/2026-09-18-ecosystem-outbound.md` | ✅ | 合入 v9 |
| Skill configDir denylist | script-vm / run-skill-script | ✅ | PP-08 精神提前 |
| 通道 B | `validateEcosystemPath` | ✅ | |
| search + install 骨架 | ecosystem-* adapters + 两工具 | ✅ | 对照 CUT1 仍缺卸载/配置 |

**分支:** `v9`（PR #5 / #6）
**Plan 偏差:** 未向 main 合入；卸载未做（CUT1 曾要求第一刀含卸载，切片只交安装）

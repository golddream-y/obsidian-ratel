# S-GOAL — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。内核随 0.7.0 发版(`d42550c`)。

---

## 2026-09-09 — P-GOAL-CONFIRM(创建改为对话确认)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 斜杠只转发 + 对话确认后 create | `manage_goal` / ChatView / 提示词 | ✅ | `0e260cf` | 不再弹 GoalCreateModal |
| ratel-config 代改 `goalMaxRounds` | 白名单 | ✅ | `a21ca39` | |
| 文档 | S-GOAL v1.8 | ✅ | `60ef9e4` | |

**测试:** 当时 goal 相关单测绿
**分支:** 合入 develop,随 0.7.0 发版
**Plan 偏差:** 创建确认走对话,不经独立表单 Modal

---

## 2026-09-07 — P-GOAL-CHROME(指示条常显 + Beam/Orb)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| pickGoalStrip + chrome 契约 | `src/ui/goal/pick-goal-strip.ts` | ✅ | `f592ed1` | 进行中 Beam;执行中才 Orb |
| ChatView 接线 | StatusStrip / GlareHover | ✅ | `f592ed1` | 不装 libraries.dev React 包 |

**测试:** goal chrome 单测绿
**分支:** 当时 `feat/p-goal-1`(已合入 develop,本地分支已删)
**Plan 偏差:** 回合执行中 Strip 不叠思考球,球只留消息流(spec v1.5.2)

---

## 2026-08-22 — P-GOAL-1(Goal 内核 + 五面 UI)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| GoalStore 落盘 / 单活 / 归档 | `goal-store.ts` | ✅ | `a5e195a` | 损坏隔离 |
| 无进展守卫与三层预算 | `goal-guard.ts` | ✅ | `547f709` | 纯函数 |
| grant 白名单 | `goal-grant.ts` | ✅ | `18182ce` | deny 之后插入 |
| 锚定注入源 `goal` | injector | ✅ | `1c74390` | provider 热读 |
| manage_goal | 工具 + 设置 + i18n | ✅ | `cdb34b0` | 工具级 allow + 动作内 Modal |
| finalizeRound | `plugin.ask` 尾部 | ✅ | `971db72` | 外审 C1;中断仍记账 `83f5653` |
| 五面 UI | 底栏 / Strip / chip / Modal | ✅ | `9384322` | 列表后迁独立 Modal(v1.7) |

**测试:** 随 0.7.0 发版前全量回归
**分支:** `feat/p-goal-1` → develop
**Plan 偏差:** 见 plan 文内偏差表(记账挂 ask 尾部、协商不用 chat 卡片、token 软上限默认关)

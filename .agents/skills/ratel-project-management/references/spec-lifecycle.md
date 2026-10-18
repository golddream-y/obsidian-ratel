# Spec / Plan 登记与归档

## 登记

每次 brainstorming、spec、plan 都要登记。这是硬规矩 — 不登记就找不到。

**唯一注册表:** [`docs/superpowers/STATUS.md`](../../../../docs/superpowers/STATUS.md) 是本项目所有 spec 与 plan 的唯一登记入口(活跃项);归档记录在 [`docs/superpowers/ARCHIVE.md`](../../../../docs/superpowers/ARCHIVE.md)(含统计图与按月索引)。

**更新规则:**

1. **brainstorming** 技能结束 → 在 `docs/superpowers/specs/` 下新建 spec **并** 在 `STATUS.md` 登记(状态:Active)。
2. **writing-plans** 技能结束 → 在 `docs/superpowers/plans/` 下新建 plan **并** 在 `STATUS.md` 登记(状态:Pending),关联到它实现的 spec。
3. **executing-plans** 或 **subagent-driven-development** 启动 → 在 `STATUS.md` 更新为状态:In Progress,记录分支名。
4. plan 执行完成 → 在 `STATUS.md` 更新为状态:Completed,记录合并 commit / 分支。
5. spec/plan 废弃或被取代 → 移到 "Superseded / Archived" 区,并写明原因。

**提交规范:** STATUS.md 永远与被追踪的文件在同一次提交中更新。绝不让注册表落后于现实。

**Spec vs Plan 区分:**

- **Spec** = 要建什么(设计、架构、需求)。放在 `specs/`。
- **Plan** = 怎么建(任务、文件、测试)。放在 `plans/`。
- 一个 spec 可以有多个 plan(例如:一个实现 plan,一个独立的测试 plan)。

## 归档

实施完成的 spec / plan 不再留在 `specs/` / `plans/` 根目录,统一移到 `docs/superpowers/archive/<spec-id>/`,作为历史档案保留。

**触发条件(全部满足):**

1. 对应 plan 状态变为 `Completed`(所有任务完成、测试通过、分支按本次任务已批准的方式合并到约定目标分支)
2. worktree / 分支已清理
3. 状态记录已写入执行日志

**询问机制:** plan 完成后,**执行者主动询问**「是否归档?」(不是自动归档)。归档是**手动操作**,不是 npm 脚本。

**归档结构(按 spec 分文件夹):**

```
docs/superpowers/archive/
├── S-XXX-001/
│   ├── <日期-slug>-<spec 文件原名>.md        # spec 本身
│   ├── <日期-slug>-<plan 文件原名>.md         # 该 spec 关联的所有 plan
│   ├── ...                                    # 多个 plan 文件可放一起
│   └── execution-log.md                       # 该 spec 的所有 plan 执行日志(按时间倒序)
├── S-YYY-002/
│   └── ...
└── P-DOCS-CN/                                 # 无 spec 的杂项 plan,直接用 plan-id
    └── execution-log.md
```

- **文件夹名** = `spec-id`(例:`S-ARCH-001`、`S-TEST-ARCH`)
- **无 spec 的 plan**(杂项) = 用 `plan-id` 命名(例:`P-DOCS-CN`)
- **execution-log.md** = 该文件夹下所有 plan 的执行日志**合并**,按时间倒序(最新在前)
- **保留原文件名**,不重命名(便于 git 历史追溯)

**归档操作(完整流程):**

```bash
# 1. 建文件夹
mkdir -p docs/superpowers/archive/<spec-id>   # 或 P-XXX-YY 杂项

# 2. git mv spec 文件(若有)
git mv docs/superpowers/specs/<spec>.md docs/superpowers/archive/<spec-id>/

# 3. git mv plan 文件
git mv docs/superpowers/plans/<plan>.md docs/superpowers/archive/<spec-id>/

# 4. 写 execution-log.md(必做,即使无详细日志也建空文件,记录"归档时未写日志,详见 git log")
#    - 多个 plan 的日志合并到一份
#    - 按时间倒序(最新在前)
#    - 标题格式: ## YYYY-MM-DD — <PLAN-ID>(<简短描述>)

# 5. 更新 ARCHIVE.md(归档索引,极简)
#    - 对应月份表加 1 行:<id> | archive/<id>/ | MM-DD | 备注(一句话,写 squash commit/发版版本/废弃原因)
#    - 顶部统计数字同步(按月柱状 / 形态分布 pie / 总数)
# 6. 主表(STATUS.md)**移除**该 spec / plan 行(归档的不再列在主表)
```

**STATUS.md 主表移除原则:**

- 归档的 spec / plan **不**保留在主表
- 主表显示尚未归档的项，包括草案、活跃、待执行、执行中和已完成待归档；归档后移出主表
- 历史归档通过 [ARCHIVE.md](../../../../docs/superpowers/ARCHIVE.md) 的按月索引 + `archive/` 文件夹追溯
- 原因:主表要简洁,完成细节(包括执行日志)都下沉到 `archive/<id>/execution-log.md`

**execution-log.md 形态:**

```markdown
# <SPEC-ID> — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## YYYY-MM-DD — <PLAN-ID>(<简短描述>)

| Task / Group | 文件 | 状态 | Commit | 备注 |
| ... |

**测试总数:** ...
**分支:** ...
**Plan 偏差:** ...

---

## YYYY-MM-DD — <上一条 PLAN-ID>

...
```

**与 `Superseded` 的区别:**

- `Superseded` = 被新版本取代(如 S-RAG-ROADMAP → S-RAG-ARCH),登记到 ARCHIVE.md,链接替代者
- `Archived` = 实施完成、不是被取代,而是「开发指导已落地,转历史档案」

**归档后:**

- 主表不再出现该 spec / plan
- ARCHIVE.md 有对应月份表行指向 `archive/<id>/`
- `archive/<id>/execution-log.md` 包含完整执行历史(commit SHA / 偏差 / 测试数据)
- 后续若该 spec 衍生了 v2(例:新决策),开新 spec `S-XXX-XXX-v2`,旧 spec 保持 Archived 状态,新 spec 状态 `Active`

登记与归档完成后按主 Skill 同步 Project 的阶段、关联和新路径；文档归档不等于用户已获得该特性。未关联产品需求的工程维护不为同步而虚构需求卡片。

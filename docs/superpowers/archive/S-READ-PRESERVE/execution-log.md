# S-READ-PRESERVE — 执行日志(按时间倒序)

> 该 spec 的实施记录。最新在前。
> 分支 `feat/p-read-preserve-1` fast-forward 合入 `main`;随 0.6.1 发版。
> spec 与 plan 原文件名相同,plan 按惯例改存为 `*.plan.md`。

---

## 2026-09-05 — P-READ-PRESERVE-1(不折 read_note / 图切片)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1 microcompact 集合 + 恢复路径文案 | `src/core/compact-project.ts` `tests/core/compact-project.test.ts` | ✅ | `af003d3` | `FOLDABLE` 去掉 `read_note`;图四件套保持不折;发现类仍按条数占位 |
| Task 2 RAG prompt + CHANGELOG | `src/prompts/defaults/zh.ts` `CHANGELOG.md` | ✅ | `e04802e` | 已有全文禁止再读;图查询默认一跳;不编造 `[n]` |

**测试:** `tests/core/compact-project.test.ts` + `context-manager.test.ts` 50/50。全量套件 skill sandbox 既有失败与本 hotfix 无关。
**分支:** `feat/p-read-preserve-1`
**Plan 偏差:** 无。评审由父代理亲审,未再派 task reviewer。prompt 中 `[truncated、` 缺右括号来自 plan 原文,未改。
**发版:** `0.6.1`(tag 不带 `v` 前缀)

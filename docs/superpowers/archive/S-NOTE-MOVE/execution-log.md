# S-NOTE-MOVE — 执行日志(按时间倒序)

> 归档时汇总;详细逐日记录见 git log。

---

## 2026-10-03 — P-NOTE-MOVE(笔记移动与复制)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 移动 / 复制工具 | 笔记工具 | ✅ | `08c4a78` | 与 P-APPLY-PATCH 同一 feat 提交「增加原子补丁编辑与笔记移动复制」 |

**发版:** 随 1.0.0(2026-10-04)。
**要点:** 移动走 `FileManager.renameFile`,复制走 `adapter.copy`;残缺工具参数不执行。
**Plan 偏差:** 无登记。
**测试:** 具体数字未登记,归档时全套见当时 develop CI。

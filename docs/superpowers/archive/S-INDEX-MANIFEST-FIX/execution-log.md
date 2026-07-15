# S-INDEX-MANIFEST-FIX — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-15 — 清单迁入 `.index/` + 缺清单不全量 embed

| Task / Group | 文件 | 状态 | 备注 |
|---|---|---|---|
| 路径 / 迁移 | `src/core/index-manifest.ts` | ✅ | `ratel-manifest.json` + legacy migrate |
| smartReindex | `src/main.ts` | ✅ | 有索引无清单 → 只写 hash |
| 全量后写清单 | `writeManifestAfterFullReindex` | ✅ | 真实 mtime,非空 entries |
| gitignore | `gitignore-writer.ts` | ✅ | 忽略旧根目录清单 |

**分支:** main  
**Plan 偏差:** 无独立 plan 文件

---

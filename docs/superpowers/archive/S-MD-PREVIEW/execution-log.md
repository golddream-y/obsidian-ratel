# S-MD-PREVIEW — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。spec 仍 Active：P-MD-PREVIEW-2（overlay / 灯箱）未做。

---

## 2026-08-14 — P-MD-PREVIEW-1（统一富块 + 复制 + 表格）

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1 i18n `chat.md.*` | `src/i18n/types.ts` `zh.ts` `en.ts` | ✅ | 待 squash | 去掉 `chat.code.copy/copied` |
| Task 2 统一壳 | `markdown-renderer.ts` | ✅ | 待 squash | 围栏 + mermaid + 表格横滚；`data-ratel-src` |
| Task 3 mermaid 只换 body | `mermaid-renderer.ts` | ✅ | 待 squash | 保留外壳与源码 |
| Task 4 enhanceMdBlocks | `md-block-enhance.ts` | ✅ | 待 squash | 无 `onExpand` 不画放大；删 `code-block-enhance.ts` |
| Task 5 样式 + 打字机 | `styles.css` `MarkdownView.svelte` | ✅ | 待 squash | 叶子选择器压过 Obsidian `pre` |
| 跟进修复 | `mermaid-renderer.ts` | ✅ | 未入 commit | 主题跟 body 明暗；`htmlLabels: false` 保住节点字 |

**测试总数:** 1026 passed（`npm test`）  
**分支:** `feat/p-md-preview-1` → squash 合入 `develop`，发版 `0.2.3`  
**Plan 偏差:**
1. mermaid 源码用 `encodeURIComponent` 写入 `data-ratel-src`，读取走 `decodeFenceSrcAttr`（字面 `&lt;` 不再被二次解码）。
2. mermaid 主题按 `body.theme-dark` / `theme-light` 同步（spec 未强制，浅色库发黑故落地）。
3. `htmlLabels: false`：DOMPurify 会剥掉 `foreignObject` 里的 HTML，图框在、节点字没了。

---

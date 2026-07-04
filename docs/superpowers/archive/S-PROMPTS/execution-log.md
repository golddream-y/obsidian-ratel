# S-PROMPTS — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-04 — P-PROMPTS(提示词 registry + 全中文迁移)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1: 类型与 section 元数据注册表 | src/prompts/types.ts, sections.ts | ✅ | fb7c710 | 24 个 PromptSectionId |
| Task 2: 默认中文 section 模板 | src/prompts/defaults/zh.ts | ✅ | e0e757f | 全中文默认值 |
| Task 3: interpolate 占位符引擎 | src/prompts/interpolate.ts | ✅ | deb4e2a | {{var}} + 校验 |
| Task 4: Composer 组装 API + 工具 schema | src/prompts/composer.ts, tool-schemas.ts | ✅ | 1564834 | 4 出口函数 |
| Task 5: ContextManager 迁移 | src/core/context-manager.ts | ✅ | 7f88320 | ContextManagerDeps |
| Task 6: intent-classifier + query-rewriter | src/core/intent-classifier.ts, query-rewriter.ts | ✅ | 413f89a | composeInternalMessages |
| Task 7: 9 个工具 description 注入 | src/tools/*.ts × 9, src/core/tool-registry.ts | ✅ | d71088c | updateDefinition 热替换 |
| Task 8: 设置面板提示词覆盖 UI | src/settings.ts, styles.css | ✅ | eb3ea0f + 352c191 | toggle/textarea/恢复/预览 Modal |
| Task 9: main.ts 接线 | src/main.ts | ✅ | fa36d2d | 5 处接线 |
| Task 10: 清扫验证 + STATUS 更新 | docs/superpowers/STATUS.md | ✅ | 80af241 | 无英文 prompt 残留 |
| 文档同步 | docs/ARCHITECTURE.md, user-guide.md, adr/2026-07-04-prompt-registry.md | ✅ | 5d865f3 | ADR-008 新增 |
| 合并到 main | (squash merge) | ✅ | 310d4ca | 12 commits → 1 squash commit |

**测试总数:** 522 tests passed(73 test files,10.20s)
**分支:** feat/s-prompts(已删除,squash 合并到 main)
**Plan 偏差:** Task 7 实施时发现需同步更新 main.ts 9 处 `createXxxTool(vault)` 调用为 `createXxxTool(vault, toolDefMap.get('xxx')!)`,在原 commit 中一并完成。Task 8 实施时发现 CSS 缺失 + 预览未用 Modal,补 fix commit `352c191`。Task 9 完成后做了一次代码质量审查,3 个 Minor(`?? {}` 冗余、注释措辞、settings.ts 重复调用 syncToolDefinitions)在 commit `80af241` 中清理。

**代码质量审查 deferred 项(未在本次 plan 中处理):**
- `makeToolDef` helper 在 7 个 test 文件中重复,可提取到 `tests/helpers/make-tool-def.ts`
- 7 个 tool 函数(grep/glob/list-files/write-note/append-note/delete-note/edit-note)缺方法级 JSDoc
- `read-note.test.ts` 测试描述仍为英文,需中文化为「行为 - 条件 - 期望结果」格式
- `read-note.ts` 用 `args.path as string` 可改为 `requireString(args, 'path', 'path')`

---

## 参考

- Spec: [2026-06-26-ratel-prompts-design.md](./2026-06-26-ratel-prompts-design.md)
- Plan: [2026-06-26-ratel-prompts-implementation.md](./2026-06-26-ratel-prompts-implementation.md)
- Squash commit on main: `310d4ca`
- ADR-008: [../../adr/2026-07-04-prompt-registry.md](../../adr/2026-07-04-prompt-registry.md)

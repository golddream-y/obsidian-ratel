# S-I18N-V2 — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-06 — P-I18N-V2-IMPL(i18n V2 全量实现)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 基础设施 | src/i18n/{types,zh,en,index}.ts + 2 测试 | ✅ | 371afa3 | 12 namespace ~340 key;langStore + t(derived) + tNow(sync);14 测试 |
| index.ts 类型 re-export + vitest 纳入 | src/i18n/index.ts / vitest.config.ts | ✅ | 8ed3c17 | 修复 LangPreference 等类型 re-export 缺失;`src/i18n/**/*.test.ts` 纳入 vitest |
| Settings + Modals 迁移 | src/settings.ts / model-info-modal.ts | ✅ | 845baf8 | General 分组 Language 下拉;setControlValue 触发 applyLangPreference |
| Diagnostics + Chat + Status 迁移 | src/ui/{chat,status,diagnostics}/* | ✅ | 3082f2f | $t 响应式;format-tool-display.ts 友好名(查看 xxx.md) |
| StatusDrawer currentFile 判断修复 | src/ui/status/StatusDrawer.svelte | ✅ | 6d9b80d | `includes('待')` → `^\d+\s` 正则,语言无关 |
| Core + Tools + Adapters + Prompts 迁移 | src/{core,tools,adapters,prompts}/* + 5 测试 | ✅ | e0ee377 | SECTIONS→buildSections();SEARCH_RESULTS_WRAPPER→get*() 函数 |
| 残留硬编码清理 + user-guide FAQ | model-info-modal.ts / compact-session.ts / user-guide.md | ✅ | b988ec4 | 5 setName + 2 throw + FAQ 命令名限制 + minAppVersion 1.13.0 |
| STATUS 标记 Completed | docs/superpowers/STATUS.md | ✅ | c063513 | P-I18N-V2-IMPL Completed,执行队列更新 |
| 文档同步 | CHANGELOG / README / ARCHITECTURE / user-guide | ✅ | bbfbfc5 | i18n V2 + tool.name 待办;Bilingual 功能块;src/i18n/ 目录;1.3 界面语言 |
| 代码审查修复 | model-downloader / ort-runtime-assets / diag-utils / slash-commands | ✅ | a90b6d9 | 4 处残留硬编码清理;SLASH_COMMANDS→getSlashCommands() 响应式 |
| Squash 合并 | — | ✅ | ad9456e + 56b875a | 12 commit → 2 feature-based commit(i18n 实现 + docs 同步) |

**测试总数:** 575 通过 / 7 pre-existing 失败(非 i18n 引起:llm-deepseek API 401、path-safety configDirName、grep count、list-files configDirName、main-rag-loop mock、incremental-manifest-update source module)

**分支:** main(无 feature branch,直接在 main 上 subagent-driven 执行)

**Plan 偏差:**
- 实际 namespace 数量为 14(spec §4.2 列 12 个,实现多 `CmdStrings` + `ToolPermStrings` 覆盖 `addCommand` name 与 `summarizeToolCall` 文案 — 合理扩展)
- 实际 key 数量 ~340(spec 估算 ~320,偏差源于审查阶段新增的 `error.model.downloadFailed` / `error.ort.*` 等 key)
- Subagent 切分:用户反馈"别切太碎",将 10 task 合并为 5 subagent(A 基础设施 / B settings+modals / C diagnostics+chat+status / D core+tools+adapters+prompts / E 验证)
- Commit 切分:用户反馈"commit 别太碎了",12 commit squash 为 2 feature-based commit

**审查问题(全部已修复):**
- Critical: 0
- Important: 4(model-downloader.ts / ort-runtime-assets.ts / diag-utils.ts 残留硬编码;slash-commands.ts 模块级常量未转函数)

**推送:** 已 push origin/main(commit 56b875a)

# S-CFG — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-16 — P-CFG-IMPL(open_note + 配置 3 工具 + ratel-config 内置 Skill + settings-apply)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1 抽取 settings-apply 共享模块 | `src/settings/settings-apply.ts` 等 | ✅ | f4ce2a4 | 设置写入副作用收敛;SettingTab 与工具同一 `applySettingValue` 路径 |
| Task 2 WorkspacePort 扩展 | `src/ports/workspace.ts`, `src/adapters/obsidian-workspace.ts` | ✅ | 70bd2e5, 483936d, 0a12063 | `openNote`(不抛错即成功)+ `openPluginSettings`(focusTab 契约测试) |
| Task 3 open_note 工具 | `src/tools/open-note.ts` | ✅ | c958261, ccd7996, a21fa9d | path 内嵌锚点拆分、anchor 归一化、缩进修复 |
| Task 4 get_app_config 工具 | `src/tools/get-app-config.ts` | ✅ | 366bec1 | 脱敏配置快照 + 密钥配置状态 |
| Task 5 update_app_config 工具 | `src/tools/update-app-config.ts` | ✅ | b41447d, d2a131b | 30 key 白名单代改;单 key 应用隔离与安全回归测试 |
| Task 6 open_settings 工具 | `src/tools/open-settings.ts` | ✅ | 411baa6, ea32726 | 定位设置 tab;VALID_TABS 漂移防线 |
| Task 7 builtin Skill 内联分发 | `esbuild.config.mjs`, `src/skills/builtin-writer.ts`, `src/skills/builtin/ratel-config/SKILL.md` | ✅ | fba5fee, e1bb285 | `inlineBuiltinSkillsPlugin` 虚拟模块内联;启动幂等落盘 `pluginDir/skills/<name>/`,版本随应用;红线清单补全 |
| Task 8 用户文档更新 | `docs/user-guide.md`, `README.md`, `README.zh-CN.md` | ✅ | 9d1969f | open_note 与配置 Skill 操作说明 |
| 终审修复 | — | ✅ | eeef088 | 代改配置列入破坏性工具,auto 档仍逐次确认;设置面板打开时同步刷新 |

**测试总数:** 1168(183 文件)
**分支:** feat/p-cfg(合并回 main,见 git log)
**Plan 偏差:** gray-matter 实例 `stringify` 调用有两处 bug,改用顶层 API;SecretProbe 签名按真实模块调整;白名单实收 30 key(plan 文本笔误写 31)

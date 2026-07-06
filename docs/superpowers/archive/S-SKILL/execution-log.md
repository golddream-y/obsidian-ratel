# S-SKILL — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-06 — P-SKILL-1-CORE(Skill 机制基础层)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1 | src/skills/types.ts、src/prompts/types.ts、src/i18n/types.ts | ✅ | 7da8d96 | Skill 核心类型 + PromptSectionId 扩展 + SkillStrings namespace(27 key) |
| Task 2 | src/ports/skill-port.ts、src/adapters/skill-{fs,vault}.ts、src/skills/skill-loader.ts、package.json | ✅ | 15973c1 | SkillPort 接口 + 双适配器 + 三源合并 loader;新依赖 gray-matter 4.0.3 |
| Task 3 | src/skills/skill-registry.ts | ✅ | 3b8c53e | enabled/disabled/active 三态管理;reload 时 always 自动激活 |
| Task 4 | src/skills/skill-activator.ts、src/prompts/{sections,composer,defaults/zh}.ts、src/core/context-manager.ts | ✅ | 0bc868d | SkillActivator + agent.skills section + ContextManager skills 段注入;5 Minor 审查问题 |
| Task 5 | src/tools/{activate,deactivate}-skill.ts、src/prompts/tool-schemas.ts、src/core/agent-loop.ts | ✅ | 35cac24 | 2 个 LLM 工具 + agent-loop 重组 skills 段;修复 Task 4 M1-M4 |
| Task 6 | src/main.ts、src/settings.ts、src/ui/chat/input/slash-commands.ts、src/i18n/{zh,en}.ts、src/logging/dev-logger.ts、tests/ui/slash-commands.test.ts | ✅ | c03bf71 | onload 装配 + reload-skills 命令 + enableSkills 设置 + 3 个斜杠命令;修复 M1 tab 缩进 |
| Task 7 | src/skills/{loader,registry,activator}.test.ts、src/tools/{activate,deactivate}-skill.test.ts、vitest.config.ts | ✅ | 4c3f5ef | 31 单元测试;4 文件加 beforeEach setLang('zh') 防 i18n store 串扰 |

**最终 squash 合并:** `d9dc98d feat(skill): Skill 机制基础层 — 三源加载 + 激活/反激活 + Discovery/Active 段注入`(38 files, +2131/-17)

**测试总数:** 635 passed / 7 pre-existing failed(与 skill 无关,path-safety/list-files/grep 预存问题)

**分支:** main

**Plan 偏差(合理):**
1. Task 2 — `@types/gray-matter` 未安装:gray-matter 4.0.3 自带 TS 定义,无需额外 types
2. Task 2 — `SkillVaultAdapter` 依赖 `VaultPort` 接口而非 `ObsidianVault` 具体类:便于单测 mock,符合六边形架构
3. Task 4 — `composer.ts#resolveSection` 从 private 改 export:让 SkillActivator 复用 override + ZH_DEFAULTS 解析链,避免重复实现
4. Task 6 — `dev-logger.ts#LogModule` 加 `'skill'`:reloadSkills 用 `devLogger.warn('skill', ...)`,union 类型需扩展
5. Task 6 — `slash-commands.test.ts` 断言 4 → 7:新增 3 个命令
6. Task 7 — `vitest.config.ts` include 扩展:加 `src/skills/**/*.test.ts` + `src/tools/**/*.test.ts`
7. Task 7 — i18n store 串扰修复:`langStore` 是模块级 svelte writable,4 文件加 `beforeEach setLang('zh')`

**关键设计决策:** 见 [ADR-009](../../../adr/2026-07-06-skill-mechanism.md)

- 三源合并优先级:vault > global > builtin(Map by name,后者覆盖前者)
- SkillPort 端口 + 双适配器(fs + VaultPort)
- Discovery + Active 双段注入(在 memory 与 searchResults 之间)
- enabled/active/always 三态管理(持久态 + 会话态分离)
- v1 简化:identity wrapper + ZH 默认值(v2 扩展 i18n fallback)

**未来工作:** S-SKILL spec 仍有 2 个 Pending plan:
- P-SKILL-2-EXECUTION — references/scripts 子目录 + 沙箱 + 2 个新工具
- P-SKILL-3-UI — settings 面板 + chat 状态显示 + 预置示例 skills

spec 文件已随本次归档移到 `archive/S-SKILL/`,后续两个 plan 实施时引用本日志和 spec 即可。

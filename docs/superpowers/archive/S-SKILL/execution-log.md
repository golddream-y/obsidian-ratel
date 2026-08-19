# S-SKILL — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-19 — P-SKILL-2-TIMEOUT(超时语义 v1.1:心跳分类 + LLM 决策)

| Task / Group | 文件 | 状态 | Commit(波次分支) | 备注 |
|---|---|---|---|---|
| T1 沙箱状态机 | src/skills/skill-script-sandbox.{ts,test.ts} | ✅ | `0c3719b`(p2t/sandbox) | outcome 扩展 stillRunning/timeout{kind}/killed/noRunning;continueRun/killRun;stalled 1s 巡检;MAX_RUN_MS=10min;10 用例 |
| T3 设置控件(与 T1 并行) | src/settings.ts、src/i18n/{types,zh,en}.ts、tests/settings.declarative.test.ts | ✅ | `c39dc86`(p2t/settings) | skillScriptTimeout slider(5-120s),displayFormat 换算秒;进 update_app_config 可代改面;补 P-SKILL-2 漏项 |
| T2 工具接线 | src/tools/run-skill-script.{ts,test.ts}、src/prompts/tool-schemas.ts、src/i18n/{types,zh,en}.ts | ✅ | `2bbb676`(p2t/sandbox) | killRun/continueRun 分流(不过信任门/熔断);熔断口径=stalled/maxDuration/crashed;文案收敛 renderScriptOutcome;i18n +6/-2 |

**最终 squash 合并:** `377d842 feat: 脚本超时按心跳分类 — 长任务不再一刀切杀,交 AI 决策(ADR-017 v1.1)`(13 files,+566/-63);前置文档 commit `c4d50eb`(ADR-017 v1.1 + spec 4.6 + plan)

**测试总数:** 1288 passed / 196 files(基线 1269 + T1 10 + T2 8 + T3 1);build 通过;tsc 零新增

**Plan 偏差(合理):**
1. T1 — `ScriptRunRequest` 加可选 `maxRunMs`(测试注入口,plan 未定义通道)
2. T1 — `Promise.withResolvers` 用局部 helper(tsconfig lib ES2021 无类型,不改全局配置)
3. T3 — i18n 多加 `.unit` key(displayFormat 单位是用户可见字符串,i18n 硬约束)
4. T2 — 多加 `skill.script.noProgressDesc` key(防字面量硬编码)
5. T2 — 旧「超时计熔断」用例拆为 stalled/maxDuration 两条(等价扩展)

**关键决策:** ADR-017 v1.1 — 慢(有心跳超时)→ still-running 交 LLM continueRun/killRun;死(零心跳)→ 自动杀;赖(10min)→ 兜底杀。动机:初版「30s 无条件杀」误杀健康长任务(60s 批量脚本 30s 被杀)。

---

## 2026-08-19 — P-SKILL-2-EXECUTION(references + scripts 沙箱执行层)

| Task / Group | 文件 | 状态 | Commit(波次分支) | 备注 |
|---|---|---|---|---|
| T1 熔断计数 | src/core/usage-stats.{ts,test.ts} | ✅ | `0abd224` | scriptFailures 命名空间(get/bump/clear) |
| T2 vm 核心 | src/skills/script-vm.{ts,test.ts} | ✅ | `2820036` | 能力面裁剪/受限 fs 白名单/reportProgress/结果序列化 |
| T3 Worker 沙箱 | src/skills/skill-script-sandbox.{ts,test.ts}、src/worker/skill-script-worker.ts、src/adapters/skill-script-worker-code.ts、esbuild.config.mjs | ✅ | `2ea89d9` | Worker 一次性 + 双层超时 + 并发=1 串行链;esbuild 内联接线 |
| T4 信任门 | src/skills/skill-script-permission.{ts,test.ts}、src/ui/skills/ScriptTrustModal.ts | ✅ | `12d3c3a` | 首次授权 Modal + trustedScripts 白名单 |
| T5 read 工具 | src/tools/read-skill-reference.{ts,test.ts} | ✅ | `e908ca7` | references 只读 + traversal 防护 + 100KB 上限 |
| T6 run 工具 | src/tools/run-skill-script.{ts,test.ts} | ✅ | `4755eff` | 熔断/信任门/语言边界(JS-only)编排 |
| T7 prompt 注册 | src/prompts/{tool-schemas,sections}.ts、src/core/tool-permissions.ts | ✅ | `327d8d5` | 2 工具 schema + 权限文案 |
| T8 main 接线 | src/main.ts、src/settings.ts、src/adapters/obsidian-vault.ts、vitest.config.ts、tests/helpers/skill-script-worker-code-stub.ts | ✅ | `24e22ef` | 沙箱生命周期/unload 终止/getRootDir/vitest stub |

**波次:** W1(T1∥T2∥T4)→ W2(T3∥T5∥T7)→ W3(T6)→ W4(T8);两阶段审查修复 9 项(`d056579`/`af68668`)+ 测试加固(`b43a6ca`)

**最终 squash 合并:** `fb871f5 feat: 技能脚本落地 — AI 可运行技能自带 JS 脚本(沙箱+授权+熔断)(S-P2)`(28 files,+1766/-13);文档同步 `c7ca41c`

**测试总数:** 1269 passed(基线 1221 + 48 新增)

**Plan 偏差(合理):** 语言边界检查置于信任门之前(永不可执行的脚本不该让用户授权);vitest include 扩 src/core;i18n key 结构按 namespace interface 开放式设计

**关键决策:** ADR-017 — Worker Thread + vm 双层(启动 ~50ms,terminate 毫秒杀,UI 零阻塞);威胁模型=防手滑不防黑客;JS-only(.py/.sh 工具层拒绝引导 MCP);已知漏项 skillScriptTimeout 无设置控件(由 P-SKILL-2-TIMEOUT T3 补齐)

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

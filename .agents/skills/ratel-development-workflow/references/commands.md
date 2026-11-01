# 命令与验证范围

> 本页是开发期命令的**唯一归属**：命令清单、按改动范围怎么取舍、基线注意事项。发版门禁命令归[发版 Skill](../../releasing-obsidian-plugin/SKILL.md)，不在这里重复。

## 命令清单

| 工作 | 命令 | 说明 |
|---|---|---|
| 安装依赖 | `npm install` | 首次拉依赖或 `package.json` 变动后 |
| 监听构建 | `npm run dev` | 边改边看产物；只在需要实时重建时开 |
| 生产构建 | `npm run build` | `esbuild.config.mjs production`，产出 `dist/main.js` 等商店产物 |
| 类型检查 | `npm run typecheck` | `tsc -noEmit` + `svelte-check` |
| 静态检查 | `npm run lint` | ESLint（含 `eslint-plugin-obsidianmd`），error 必须为 0 |
| 测试 | `npm test` | Vitest 全量；定向范围用 `npx vitest run <文件>` |

## 按改动范围取舍

| 档位 | 最低验证 |
|---|---|
| 小档 | 定向测试（`npx vitest run <受影响文件>`）；有类型改动时补 `npm run typecheck` 的定向自检 |
| 中档 | `npm run typecheck` + `npm run lint` + 受影响测试 |
| 大档 / 跨子系统 | `npm run typecheck` + `npm run lint` + `npm test` 全量 |

- 验证范围以**变更风险**为准：只改文档或技能文件不需要跑测试；改 `src/ui/` 要看 `svelte-check` 输出；改 `src/worker/` 要确认线程与消息协议相关测试。
- 不重复跑已经通过的检查；不要把未执行的检查写成通过（见 `verification-before-completion`）。

## 基线注意事项

- **`npm run typecheck` 当前不是绿的**：仓库基线存在既有类型报错（集中在 `src/ui/orbs/`、`src/ui/mascot/`、`src/prompts/`、`tests/`，共 200+ 条）。先取基线再对比，**只对自己这次改动引入的错误负责**，不要顺手改别人的既有报错。
- **lint 范围**：`dist/`、`.agents/skills/`（含第三方上游脚本）、`scripts/`、`.worktrees/`、`tests/` 不在 lint 范围内；`tests/` 与 `.agents/skills/` 的既有告警不挡发版。
- **构建产物**：`dist/` 不入库，商店附件只由 CI 打 tag 后产出；本地 `npm run build` 只为本地预览与自检。

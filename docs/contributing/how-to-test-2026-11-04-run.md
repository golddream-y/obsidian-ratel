# 2026-11-04 真机验证执行记录

> 承接 [how-to-test.md](how-to-test.md) 第 4–5 节。本轮在工作区 53 个未提交文件（上轮 tsc 类型修复）之上执行；未提交、未回退、未修改 `src/` 业务逻辑。
> 执行环境：macOS，Node.js `v24.11.0`，npm `11.6.1`，Obsidian 运行版本 `1.15.0`（insider asar 热更新；应用外壳 Info.plist 显示 1.12.7，非运行版本），满足 `minAppVersion: 1.13.1`。

## 1. 基线复跑

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run build` | 0 | 生产 bundle 生成；18 条既有 Svelte 警告（状态捕获、a11y、未使用 CSS），无构建错误 |
| `npm test` | 0 | 325 个测试文件通过、4 个跳过；3019 项测试通过、24 个跳过；耗时 67.98 秒 |
| `npm run typecheck` | **1** | `tsc -noEmit` 干净（上轮 237→0 修复成立）；`svelte-check` 报 **12 errors / 21 warnings / 17 files**，组合脚本因此在第二阶段失败 |
| `npm run lint` | 0 | 0 errors / 30 warnings（`obsidianmd/prefer-window-timers` 等风格项） |

`svelte-check` 的 12 个错误（均为既有 UI 代码，本轮按规矩未修复、未回退）：

- `src/ui/chat/input/AttachmentStrip.svelte:34` — i18n key `chat.attachments.tokenEstimate` 不在 `keyof Strings`
- `src/ui/components/MarkdownView.svelte:77,100` — `NodeListOf<HTMLButtonElement>` 缺 `[Symbol.iterator]`（对 `querySelectorAll` 结果直接 `for..of`）
- `src/ui/chat/ChatView.svelte:906` — `m` possibly `undefined`；`:1836` — `string | undefined` 赋给 `string | number`；`:2079` — `"connecting"` 不在 `RatelOrbBusyKind`；`:2235` — `(opts?: SendMessageOpts) => Promise<void>` 赋给 `MouseEventHandler<HTMLButtonElement>`
- `src/ui/memory-panel/MemoryPanel.svelte:89,222,284,350` — 从 Svelte 侧访问 `RatelVaultPlugin` 私有属性 `memoryStore`
- `src/ui/motion/empty/AuroraBackdrop.svelte:69` — `[number, number, number] | undefined` 缺 iterator

说明：`tsc -noEmit` 不检查 `.svelte` 文件，与「tsc 0 errors」并存不矛盾；但仓库 `typecheck` 组合门禁当前实际为红，上轮「类型修复完成」的结论只覆盖 tsc 阶段。

## 2. 三文件安装包与 SHA-256 对照

| 文件 | 字节数 | SHA-256 | 对照 2026-11-03 |
|---|---:|---|---|
| `dist/ratel-vault/main.js` | 15515304 | `64e71eeb70c9c9e3216eb8d007e81f375db288be669a00940ea60c8bf7668891` | **变化**（上轮类型修复改了源码，预期内；原 `a564512…`） |
| `dist/ratel-vault/manifest.json` | 458 | `69ef121565d93b3c353b11c477e6b35e1dafb9af2451d3bf7e6e5e9aaff69123` | 不变 |
| `dist/ratel-vault/styles.css` | 30542 | `692f52426ccaed0adc2c4519da2c5fd116fe74c3718f52d12dc1741d8284cef7` | 不变 |

## 3. Sandbox 安装

- 本机已存在开发预览 Sandbox（路径见仓库根 `AGENTS.local.md` 本地层，本文以 `<sandbox>` 代称），无需新建临时 vault。
- `<sandbox>/.obsidian/plugins/ratel-vault/` 中的 `main.js`、`manifest.json`、`styles.css` 是 `npm run link:vault` 流程建立的符号链接，指向当前仓库对应源文件；解析后三文件 SHA-256 与本次构建逐字节一致（`main.js` = `64e71eeb…`），等效完成 how-to-test.md 第 3 节的手动安装。为不破坏既有开发链路，未以实体文件覆盖符号链接。
- `<sandbox>/.obsidian/community-plugins.json` 已包含 `ratel-vault`（此前已启用），Restricted mode 为关闭状态。

## 4. 真机执行与自动化边界

Obsidian 正在运行。通过 `open "obsidian://open?vault=<name>"` 无人值守打开 Sandbox（`obsidian.json` 中该库随后标记 `open: true`）；日常库保持原状、全程未触碰。

插件真机加载证据（均为 2026-11-04 02:53–02:54 本地时间新产生）：

- `<sandbox>/.obsidian/plugins/ratel-vault/diag/breadcrumbs.log` 新增 `plugin.load`（02:53:12）与 `worker.create` 心跳（02:53:13），随后保持每 30 秒心跳；
- `diag/last-alive.json`：`{"lastPhase":"plugin.load","uptimeMs":90004,"heapMB":55,…}`（`plugin.load` 标记位于 `src/main.ts` onload 关键路径中段，到达即说明设置加载、适配器装配、索引代际解析均已通过）；
- `data.json` 于 02:53:12 被重写（onload 后的 `saveData`）；
- 系统崩溃报告目录无 Obsidian 新崩溃记录。

自动化硬边界（如实记录，不冒充结论）：

- **屏幕锁定**（`IOConsoleLocked=true`，凌晨执行）：`screencapture` 截图全黑。证据文件在仓库外 `/tmp/ratel-verify-2026-11-04/01-sandbox-open.png`（黑帧，仅佐证环境状态，不作为 UI 结论）；
- **无辅助访问权限**（`osascript` 报错 -1719）：无法经 System Events 驱动 UI（点击 ribbon、打开设置页、读取控制台均不可达）。

## 5. 真机测试清单状态（11 项）

| # | 场景 | 状态 | 证据 / 原因 |
|---|---|---|---|
| 1 | 文件完整性 | **passed** | 三文件就位、ID `ratel-vault`、版本 `1.3.0`；Obsidian 实际识别并加载（第 4 节证据） |
| 2 | 插件发现与启用 | **passed（附注）** | 插件在启用列表，真机 onload 到达 `plugin.load`、Worker 创建、心跳持续 90 秒、无崩溃；附注：控制台无红字未经视觉确认（锁屏） |
| 3 | 正常界面 | not-run | 锁屏 + 无辅助访问，无法视觉验证 |
| 4 | 空态 | not-run | 同上 |
| 5 | 加载与禁用 | not-run | 需模型端点（本机 arkcli Coding Plan SSO 失效，无可用端点）+ UI 交互 |
| 6 | 身份/权限失败 | not-run | 需模型端点与 UI 交互 |
| 7 | 网络失败 | not-run | 需 UI 交互（断网操作与界面观察） |
| 8 | 真实 vault 读取与解码 | not-run | 需模型端点（同上） |
| 9 | 真实 ONNX 重建 | not-run | 需 UI 交互（锁屏无法驱动）；索引重建动作无法经界面触发 |
| 10 | 真实检索与引用 | not-run | 依赖第 9 项且需模型端点 |
| 11 | 重载与卸载 | not-run | 需 UI 交互（禁用/启用开关与重载后观察） |

统计：**passed 2 / failed 0 / not-run 9**。未用任何单元测试结果替代真机项。

## 6. 缺口与建议

- `npm run typecheck` 门禁当前为红（svelte-check 12 errors，全部位于 `src/ui/`），建议单独立项修复；不要与 tsc 阶段混为一谈。
- 远程聊天相关项（5、6、8、10）统一阻塞于无可用模型端点；端点恢复前无法推进。
- UI 视觉项（3、4、7、9、11）需用户在场解锁屏幕后执行；本轮已把「打开 Sandbox 并真机加载插件」推进到可证程度，剩余为人工操作窗口。
- 本次 `main.js` 哈希变化属预期；how-to-test.md 第 2 节的 2026-11-03 摘要保留为历史对照，不回改。

## 7. svelte-check 修复复跑记录（线 H，2026-11-04）

承接第 1 节基线：`npm run typecheck` 第二阶段 svelte-check 报 12 errors / 21 warnings / 17 files（退出码 1）。原始错误清单见第 1 节末列表，此处不重复。本轮 12 个错误全部修复，无跳过项；修复仅限类型/声明层面，未删断言、未改运行时业务行为。

### 修法摘要

- `AttachmentStrip.svelte:34` — 补登缺失的 i18n key `chat.attachments.tokenEstimate`（`src/i18n/types.ts` ChatStrings + `zh.ts`「约 {n} tokens」+ `en.ts`「~{n} tokens」）。原运行时走 key 回退、上屏为原始 key 字符串；补登后按翻译表正常显示。
- `MarkdownView.svelte:77,100` — `querySelectorAll` 结果外层包 `Array.from(...)` 再 `for..of`（对齐 `md-block-enhance.ts` 既有写法；迭代语义不变）。
- `ChatView.svelte:906` — `noUncheckedIndexedAccess` 下 `messages[i]` 为 `T | undefined`，改 `if (m?.role === 'assistant') return m` 收窄（索引恒在界内，运行时不存在 undefined 分支）。
- `ChatView.svelte:1836` — `ValidateResult` 由 `{ ok: boolean; reason?: string }` 改为判别联合 `{ ok: true; reason?: undefined } | { ok: false; reason: string }`（`attachment-utils.ts`），`!vr.ok` 分支下 `reason` 收窄为 `string`；运行时可取值集合不变，既有单测（`result.reason` 直接断言）不受影响。
- `ChatView.svelte:2079` — `busyOrbKind` 派生会产出 `'connecting'`（workBar `preparing`/`downloading`），将 `'connecting'` 补入 `RatelOrbBusyKind` union（`map-orb-state.ts`）；`mapOrbState` switch 未动，`'connecting'` 仍走 default → `'breathing'`，运行时视觉与修复前逐帧一致。
- `ChatView.svelte:2235` — `onclick={sendMessage}` 改 `onclick={() => sendMessage()}`；原写法运行时 MouseEvent 被当 `opts` 传入，其 `text`/`bypassSlashGoal` 均 undefined，行为与无参调用等价。
- `MemoryPanel.svelte:89,222,284,350` — `src/main.ts` 中 `memoryStore` 去掉 `private` 并加注（对齐 `usageStats`、`skillRegistry` 的「UI 面板直接读写，故公开」既有先例）；TS `private` 仅编译期约束，运行时无变化。
- `AuroraBackdrop.svelte:69` — `stops.map(hexToRgb01)` 解构在 `noUncheckedIndexedAccess` 下带 `| undefined`，改 `new Float32Array(stops.flatMap((hex) => hexToRgb01(hex)))`，产出数组逐元素相同。

### 复跑结果（修复后，同一工作区）

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run typecheck` | 0 | tsc 干净；svelte-check **0 errors** / 21 warnings / 13 files（warning 为既有项，不在本轮范围） |
| `npm test` | 0 | 325 个测试文件通过、4 个跳过；3019 项测试通过、24 个跳过 |
| `npm run build` | 0 | 生产 bundle 生成，18 条既有 Svelte 警告，无构建错误 |
| `npm run lint` | 0 | 0 errors / 30 warnings（既有风格项） |

结论：第 1 节第 6 条「typecheck 门禁为红」缺口已闭合，组合门禁（tsc + svelte-check）恢复全绿。

## 8. 夜间基线复跑（2026-11-04 04:56–05:05 CST）

> 环境：macOS `27.2`（build `26B123`）；Node.js `v24.11.0`；npm `11.6.1`；Obsidian 进程运行中（应用外壳 Info.plist `1.12.7`，insider asar 目录已有 `1.15.0`/`1.15.1`，其中 `1.15.1` 于 03:57 下载；锁屏下未能视觉确认当前运行版本）。工作区沿用第 3 节的 53 个未提交文件，另加本轮 1 个测试文件修复。
> 证据目录：`/tmp/ratel-verify-2026-11-04-night/`（本轮所有命令原始输出、SHA 与心跳快照）。

### 8.1 命令与退出码

| 命令 | 退出码 | 时间 | 原始结果 | 日志 |
|---|---:|---|---|---|
| `npm run typecheck`（含 svelte-check） | **0** | 04:56:30 起 | tsc 干净；svelte-check **0 errors / 21 warnings / 13 files** | `ratel-verify-typecheck-final.log` |
| `npm test`（首次） | **1** | 04:57:07 起，78.23 s | 325 文件通过 / 4 跳过；3019 用例通过 / 24 跳过；**0 failed**，但 Vitest 捕获 1 个未处理拒绝 | `ratel-verify-test.log` |
| `npm test`（修复后复跑） | **0** | 05:02:13 起，72.97 s | 同上；0 failed，无未处理拒绝 | `ratel-verify-test-rerun.log` |
| `npm run lint` | **0** | 05:00 起 | 0 errors / 30 warnings | `ratel-verify-lint-final.log` |
| `npm run build` | **0** | 05:01 完成 | 生产 bundle 生成，18 条既有 Svelte 警告，无构建错误 | `ratel-verify-build.log` |

首次 `npm test` 的唯一失败不是用例断言失败，而是未处理拒绝：

```text
Unhandled Rejection
Error: Error creating document catalog: AtomicStorageError: 原子替换失败(rename 前):catalog.json
 ❯ LocalDocumentIndex.<anonymous> node_modules/vectra/lib/LocalDocumentIndex.js:431:27
```

定位：`tests/core/index-runtime-identity-wiring.test.ts` 装配后未等待 `VectraStore` 的 `autoInit` 预热 promise 落地；`afterEach` 删除临时目录时，vectra 的 catalog 创建仍在进行，`upsertFile` 失败后无人消费，遂成为未处理拒绝。属既有测试卫生问题（高负载套件下才显现），非本轮源码改动引入。修复只在测试内补 `await first.pipeline.store.init()`（两处），未删除或放宽任何断言，未改生产代码；单独复跑该文件 3 次均通过。

### 8.2 构建产物与三文件安装一致性

重新构建后（构建包含第 7 节的 svelte-check 源码修复，这些文件 mtime 晚于第 1 节 02:52 的旧构建，故 `main.js` 哈希变化属预期）：

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `dist/main.js` | 15515637 | `bca8f752c9672bd58d04a316e4da1044f90057c64183747a5adf7a0a29f2bc52` |
| `dist/ratel-vault/main.js` | 15515637 | `bca8f752…`（与 `dist/main.js` 一致） |
| `dist/ratel-vault/manifest.json` | 458 | `69ef1215…`（与 2026-11-03 相同） |
| `dist/ratel-vault/styles.css` | 30542 | `692f5242…`（与 2026-11-03 相同） |
| `<sandbox>/.obsidian/plugins/ratel-vault/main.js`（解引用符号链接） | 15515637 | `bca8f752…`（与仓库产物一致） |
| 同上 `manifest.json` / `styles.css` | — | `69ef1215…` / `692f5242…` |

- `<sandbox>` 三文件与 `dist/ratel-vault/` 三文件逐字节一致，符号链接目标分别为仓库 `dist/main.js`、`manifest.json`、`styles.css`；`worker.js` 亦指向 `dist/worker.js`。
- `node scripts/link-vault.mjs`（`RATEL_VAULT=<sandbox>`）退出码 **0**，输出「新建 0 · 已存在 4 · 替换 0」，脚本幂等且未改日常主库。
- 生产包不包含实验命令：`运行索引线程实验` 仅存在于 `src/i18n/zh.ts`，在 `dist/main.js` 中未命中；运行时 Worker 以字符串内联（`dist/main.js` 含 `"session.search"` 两处）。
- **运行实例与磁盘产物的时间差（如实标注）**：Obsidian 于 02:53 加载的是 02:52 构建（旧 `main.js` 为 `64e71eeb…`）；本轮 05:01 重构建后**未重载插件**。因此 8.3 的 onload/心跳证据属于旧 bundle，磁盘三文件虽已与 `bca8f752…` 一致，但运行中的实例要等人工重载后才会加载新产物。不得把「磁盘一致」说成「新产物已真机运行」。

### 8.3 URL scheme、插件启用与心跳（可自动复现部分）

| 项 | 状态 | 证据 |
|---|---|---|
| URL scheme 注册 | **passed** | `plutil -p /Applications/Obsidian.app/Contents/Info.plist` 含 `CFBundleURLSchemes = ["obsidian"]`；`open "obsidian://open?vault=Obsidian%20Sandbox"` 退出码 0，`obsidian.json` 中 Sandbox `open: true`（日常库条目未被修改） |
| 插件在启用列表 | **passed** | `<sandbox>/.obsidian/community-plugins.json` 含 `ratel-vault` |
| 真机 onload | **passed** | `diag/breadcrumbs.log` 于 `2026-11-03T18:53:12.427Z`（CST 02:53:12）记录 `plugin.load`；`18:53:13.213Z` 记录 `worker.create` |
| 心跳连续 | **passed** | 05:04:42 CST 最新 `heartbeat`，间隔 30 s；`last-alive.json` 显示 `lastPhase=plugin.load`、`uptimeMs=7890059`（约 2 h 11 m），`rssMB=307`、`heapMB=59` |
| 无 Obsidian 崩溃 | **passed（附注）** | `~/Library/Logs/DiagnosticReports` 本轮无 Obsidian 新报告；仅有 23:54–23:56 的旧 `node-*.ips`，早于本轮 |

### 8.4 可复现的隔离/对照脚本

`RATEL_ISOLATION=1 RATEL_ISOLATION_FILES=8 npx vitest run tests/core/index-isolation-proxy.test.ts` 退出码 **0**，1 文件 / 1 用例通过，耗时 3.40 s（`ratel-verify-isolation.log`）。该脚本按 T9 协议只是趋势观察工具，**不作为「线程更快」的结论**，本轮不引用其读数。

### 8.5 真机 11 项状态（本轮）

| # | 场景 | 状态 | 证据 / 外部条件 |
|---|---|---|---|
| 1 | 文件完整性 | **passed** | 三文件就位，ID `ratel-vault`、版本 `1.3.0`；`dist/ratel-vault` 与 Sandbox 解引用后 SHA-256 逐字节一致（8.2） |
| 2 | 插件发现与启用 | **passed（附注）** | 启用列表 + `plugin.load` + `worker.create` + 持续 2 h 心跳；附注：控制台无红字与插件列表视觉仍未确认（锁屏） |
| 3 | 正常界面 | **blocked** | 本轮实测 `IOConsoleLocked=true`；上轮已证锁屏下整窗截图只能得到黑帧，且辅助访问权限缺失。不得用渲染层截图冒充整窗视觉证据 |
| 4 | 空态 | **blocked** | 同 3，需解锁后人工观察 |
| 5 | 加载与禁用 | **blocked** | 需真实模型端点（本机无可用端点）+ UI 交互 |
| 6 | 身份/权限失败 | **blocked** | 需真实模型端点与 UI 交互 |
| 7 | 网络失败 | **blocked** | 需 UI 断网操作与界面观察 |
| 8 | 真实 vault 读取与解码 | **blocked** | 需真实模型端点 |
| 9 | 真实 ONNX 重建 | **blocked** | 需 UI 触发重建；锁屏 + 无辅助访问不可达 |
| 10 | 真实检索与引用 | **blocked** | 依赖 9，且需真实模型端点 |
| 11 | 重载与卸载 | **blocked** | 需 UI 禁用/启用开关与重载观察 |

统计：**passed 2 / failed 0 / blocked 9**。未用单元测试或渲染层截图替代任何真机视觉/模型项。

### 8.6 未覆盖项

- 未执行 `npm run test:index-reliability`（本轮交付只要求四条基线命令；上轮 770.68 s 读数仍有效，但未复跑）。
- 未执行效率基准、实验构建（`RATEL_INDEX_EXPERIMENT=1`）与任何真实宿主采集。
- 未设置 `RATEL_ONNX`，无真实 ONNX 推理；无真实模型端点，未做任何远程聊天/检索端到端。
- 锁屏（本轮实测）与上轮记录的辅助访问权限缺失，使所有整窗视觉、设置页、控制台与交互项均保持 `blocked`。

### 8.7 本轮改动文件

- `tests/core/index-runtime-identity-wiring.test.ts`：两处补 `await first.pipeline.store.init()`，消除高负载下 vectra catalog 创建的未处理拒绝；未改断言语义。
- `docs/contributing/how-to-test-2026-11-04-run.md`：本记录。
- `dist/main.js`、`dist/ratel-vault/*`：重新构建产物（未纳入版本控制）。

## 9. 夜间基线复跑与新 bundle 真机重载（2026-11-04 05:47–05:58 CST）

> 工作区沿用第 8 节的 63 个未提交文件，另加本轮 1 个测试文件新增（9.5）。全程未 commit / push；日常主库未触碰。

### 9.1 四门基线退出码

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run build` | **0** | 生产 bundle 生成，18 条既有 Svelte 警告，无构建错误 |
| `npm test` | **0** | 325 文件通过 / 4 跳过；3019 用例通过 / 24 跳过；70.32 s；无未处理拒绝（8.1 的测试卫生修复持续有效） |
| `npm run typecheck`（含 svelte-check） | **0** | tsc 干净；svelte-check 0 errors / 21 warnings / 13 files |
| `npm run lint` | **0** | 0 errors / 30 warnings（既有风格项） |

昨夜三个 perf 提交（`bc33a5c` 等）与未提交改动组合**未产生新红**，无需修复。

### 9.2 新构建 SHA-256 与链接一致性

重新构建（05:47 完成）：

| 文件 | SHA-256 |
|---|---|
| `dist/main.js` | `bca8f752c9672bd58d04a316e4da1044f90057c64183747a5adf7a0a29f2bc52` |
| `<sandbox>/.obsidian/plugins/ratel-vault/main.js`（解引用符号链接） | `bca8f752…`（逐字节一致） |

- 本次构建 SHA 与第 8 节 05:01 构建**逐字节相同**——期间无源码改动，构建可复现；符号链接目标不变，无需重跑 `link:vault`。
- 对照：`dist/.backup-prod-20261103-230307/main.js` 为 `39b48f80…`，证明昨夜 perf 提交确实改变过 bundle 内容，当前产物不是 23:03 那份。

### 9.3 无人值守重载与新 bundle 真机加载证据

第 8 节遗留「运行实例仍是 02:52 旧 bundle」的缺口，本轮以**全进程重启**闭合（`pkill -x Obsidian` 确认退出后 `open "obsidian://open?vault=Obsidian%20Sandbox"`，不依赖辅助访问权限）：

- `diag/breadcrumbs.log`：`2026-11-03T21:49:57.423Z`（CST 05:49:57）记录 `crash.suspect`——这是**上一轮会话被 pkill 非正常退出**的预期标记（引用旧会话 `lastPhase=plugin.load`），不是新会话崩溃；紧随 `21:49:57.424Z plugin.load`、`21:49:58.516Z heartbeat|worker.create`，随后每 30 s 心跳持续至本记录写入时（21:57:57 仍在线）。
- `diag/last-alive.json`：`uptimeMs=36413`（新进程）、`lastPhase=plugin.load`；`data.json` 于 05:49:58 被重写（onload 后 `saveData`）。
- **新 bundle 证明链**：`dist/main.js` mtime 05:47 < 新进程 plugin.load 05:49:57；新进程必然从磁盘读取，彼时彼刻 symlink 解析 SHA = `bca8f752…`（重载前后各验一次，一致）——运行实例加载的即新产物。8.2 的「未重载」保留标注作废。
- 判读注意：`sessionShort=207656` 是持久化的聊天会话 ID，跨进程重启不变，**不能**用于区分进程；区分依据是时间线、`uptimeMs` 与 `crash.suspect` 标记。
- `~/Library/Logs/DiagnosticReports` 无 Obsidian 新崩溃报告；新会话自身无 crash 类相位。

### 9.4 真机 11 项状态（本轮）

| # | 场景 | 状态 | 证据 / 外部条件 |
|---|---|---|---|
| 1 | 文件完整性 | **passed** | 同 8.5；SHA 一致性 9.2 复验 |
| 2 | 插件发现与启用 | **passed（附注）** | 证据升级为**新 bundle**（`bca8f752…`）：`plugin.load` + `worker.create` + 持续心跳（9.3）；附注不变：控制台无红字未经视觉确认（锁屏） |
| 3 | 正常界面 | **blocked** | 锁屏 + 无辅助访问，同 8.5 |
| 4 | 空态 | **blocked** | 同 3 |
| 5 | 加载与禁用 | **blocked** | 需真实模型端点 + UI 交互 |
| 6 | 身份/权限失败 | **blocked** | 需真实模型端点与 UI 交互 |
| 7 | 网络失败 | **blocked** | 需 UI 断网操作与界面观察 |
| 8 | 真实 vault 读取与解码 | **blocked** | 需真实模型端点 |
| 9 | 真实 ONNX 重建 | **blocked** | 需 UI 触发重建；锁屏 + 无辅助访问不可达 |
| 10 | 真实检索与引用 | **blocked** | 依赖 9，且需真实模型端点 |
| 11 | 重载与卸载 | **blocked** | 本轮做的是应用级重启，非「禁用/启用开关」的 UI 操作；保持 blocked |

统计：**passed 2 / failed 0 / blocked 9**。未解锁任何 blocked 项。

### 9.5 T-REL 推进：切回旧配置不重嵌（独立测试切片）

按 `docs/superpowers/plans/2026-11-02-adaptive-indexing-progress.md`「下一步」第 2 条，补上 cutover 文档 §1 挂账的待验证要求：

- `tests/core/index-runtime-config-switch.test.ts` 新增**场景 E**（期望行为验收，区别于该文件 A–D 的缺口复现）：A 建库 → 切 B（重嵌一次、指针切走、A 降级 migrated）→ **切回 A**。断言：`resolveIndexGeneration` 按指纹**取回**旧代际（`generationId` 相同、指针仍停在 B、取回后降级 `verifying` 且 `verifiedAt` 清空）；逐文件核对命中旧完成记录（hash + 配置指纹双匹配），`FakeEmbeddingPort.callCount` 保持 2 **不重嵌**；核对完成后指针可切回 A，双方代际目录均保留。
- 复跑：该文件 7/7 通过（7.36 s）；全量 `npm test` 0（3020 通过 / 24 跳过，72.02 s）；`npm run typecheck` 0。
- 「派生清单恢复接线」按计划文档 T-REL 行已是「已接入后端（26+58 用例）」，本轮未重复。

### 9.6 本轮改动文件

- `tests/core/index-runtime-config-switch.test.ts`：新增场景 E 及文件头对应行；未改既有断言语义。
- `docs/contributing/how-to-test-2026-11-04-run.md`：本记录。
- `dist/*`：重新构建产物（未纳入版本控制；SHA 与第 8 节相同）。

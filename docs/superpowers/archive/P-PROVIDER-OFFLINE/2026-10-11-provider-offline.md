# P-PROVIDER-OFFLINE — 断网态模型配置:新增默认自定义,已配项供应商选择锁定不阻塞其他字段

> **类型:** 无 spec 杂项 plan(用户 2026-10-11 Sandbox 实测断网配置 glm-5.3 时提出)。
> **For agentic workers:** REQUIRED SUB-SKILL: test-driven-development(RED-GREEN-REFACTOR)。

**目标:** 断网(含无缓存)时模型配置流程可用、不误导:
1. **新增配置**:默认就是「自定义」(现状 `createChatProfile` 已默认 `providerId: 'custom'`,零改动,测试锁住),断网下地址/密钥/模型名/窗口全部可手填。
2. **已配好的配置**:断网时供应商「选择」按钮为锁定态(loading/offline,不可点),但地址、密钥、模型名、窗口数字等其他值照常可编辑;联网重开设置自动恢复可选。
3. 顺带修正断网相关文案:去掉「名单没装上」「不要沿用上一个模型的上限」等报错腔/防呆腔与半角逗号;窗口行区分「断网」与「名单中无此模型」两态。中英 i18n 同步。

**背景事实(已核实):**
- 供应商区在 `renderProfileDetail`(chat-profiles-render.ts:364-370)异步等 `ensureCatalog()`,pending 时整块空白;catalog=null 时渲染 catalogMissing 文案且「选择」按钮仍可点(进 picker 只见本机两项)。
- `ensureCatalog()` 语义:新鲜缓存→名单;失败但有过期缓存→**返回过期名单(非 null,等同 ready)**;无缓存且失败→null(真离线)。
- 断网时 `renderProviderAndModel` 已走 handOnly 路径:地址可编辑、模型手填、密钥可填、窗口有数字框——「不影响其他字段」现状已满足,只需别让供应商选择可点。
- `renderProfileWindow` 内部自己 await catalog,断网(catalog=null)与「名单无此模型」(catalog 有但 lookup miss)共用 unknown 文案。
- 旧文案 key `catalogMissing`、`window.unknownHint` 无测试锁定。

## Global Constraints

- i18n 强制:所有新文案 zh.ts + en.ts + types.ts 三处;不硬编码中文字面量。
- TypeScript strict;禁止 enum;三态用 `as const` 元组/字符串字面量联合。
- 不改数据模型、不改 `createChatProfile` 默认值逻辑、不改联网行为、不改 picker 的有网形态。
- 中文注释;spinner 样式只加一小段兜底 CSS。

## 任务清单

### Task 1:供应商选择三态纯函数(TDD)

**Files:** 新建 `src/ui/settings/provider-control.ts`、`tests/ui/settings/provider-control.test.ts`

- 类型:`export type ProviderListState = 'loading' | 'offline' | 'ready';`
- `export function resolveProviderControl(state: ProviderListState): { disabled: boolean; spinning: boolean; buttonTextKey: string }`
  - loading → `{ disabled: true, spinning: true, buttonTextKey: 'settings.chatProfiles.provider.listLoading' }`
  - offline → `{ disabled: true, spinning: false, buttonTextKey: 'settings.chatProfiles.provider.offline' }`
  - ready → `{ disabled: false, spinning: false, buttonTextKey: 'settings.chatProfiles.provider.choose' }`
- 先写三态断言(RED)再实现(GREEN)。

### Task 2:render 接入三态 + 文案

**Files:** `src/ui/settings/chat-profiles-render.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/i18n/types.ts`、`styles.css`

1. `renderProfileAndModel` 的 `catalog` 参数类型改为 `ModelsDevCatalog | null | undefined`(undefined=loading,null=offline,对象=ready);函数内调 `resolveProviderControl` 设置按钮:
   - `btn.setDisabled(control.disabled)`;spinning 时 `btn.setIcon('loader')` 并给 svg 加 `ratel-spin` class(styles.css 加 `@keyframes ratel-spin` 旋转兜底),ready 时不设 icon。
   - 供应商行 desc 重写为:未配置(apiBase/model 均空)→ `provider.empty`;loading→ 未配置显示 empty,已配置显示本地推断名不加错误句;offline 且已配置 → 推断名 + 换行 `provider.offlineHint`;ready → 名单名(现状)。删除 catalogMissing 在本行的使用。
   - 其余渲染(地址/密钥/模型手填)逻辑不动:loading/offline 均走现有 falsy-catalog 路径。
2. `renderProfileDetail`(364-370):providerHost **立即**渲染 loading 态(消除空白);ensureCatalog 回来后 `providerHost.empty()` 重绘,catalog===null→offline,否则 ready。注意 isConnected 守卫保留。
3. picker(`renderProviderPicker` 的 null 分支):`catalogMissing` 文案换为 `provider.offlinePicker`(「当前没联网,只显示本机项…联网后重开此页会显示完整名单」)。
4. 窗口行两态:
   - `renderProfileWindow`(约 790-797):catalog===null → desc 用新 key `window.offline`(保留数字框);catalog 有但 tokens miss → `window.unknown` 改后的文案(名单中没有此模型,按供应商文档填写),删掉 `unknownHint` 拼接。
   - `paintStoredWindow`(非当前套,catalog===null 分支若有同样文案)同样区分;先读代码确认,没有就不动。
5. i18n:
   - 新增 zh/en/types:`provider.listLoading`(获取名单中… / Loading model list…)、`provider.offline`(离线中 / Offline)、`provider.offlineHint`(联网后重新打开此页即可更换厂商,其余设置可照常修改。/ …)、`provider.offlinePicker`(当前没联网,只显示本机项(Ollama / 自定义);联网后重开此页会显示完整名单。/ …)、`window.offline`(暂时没获取到模型名单。可先填上下文长度(如 128000);联网后打开本页会自动按名单校正,手动改小的值不会被覆盖。/ …)。
   - 改 `window.unknown`:「名单中没有 {model},请按供应商文档填写上下文长度。」/ "{model} is not in the model list; enter its context length per the provider's docs."
   - 删除 key:`catalogMissing`(中英 + types,两处引用已在本任务替换)、`window.unknownHint`(中英 + types)。
   - 全部中文标点全角;英文用正常排版。
6. styles.css 末尾加:`svg.ratel-spin { animation: ratel-spin 1s linear infinite; } @keyframes ratel-spin { to { transform: rotate(360deg); } }`(若文件已有动画变量/风格则对齐)。

### Task 3:默认自定义守护 + 全量验证

- 在 `tests/ui/settings/provider-control.test.ts` 或合适的既有 chat-profiles 测试中补一条:`createChatProfile` 产出的新配置 `providerId` 为 `LOCAL_PROVIDER_CUSTOM` 且 `contextLengthPreset='custom'`(锁住「新增默认自定义」,防止回归)。
- 依次:`npx vitest run tests/ui/settings/provider-control.test.ts` → `npm run typecheck`(全仓 tsc 基线 241 错误为 develop 既有,用 `npx tsc -noEmit -skipLibCheck 2>&1 | grep -E "provider-control|chat-profiles-render"` 确认零新增;另跑 svelte-check 对比改前/改后总数)→ `npm run lint` → `npm test`(skill-script-sandbox flake 可重跑)→ `npm run build`。
- `git diff --check` + 隐私 grep。

### Task 4:提交与记录

- 提交:`feat: 断网时锁定供应商选择并引导自定义配置`
- plan 末尾执行记录与代码同一提交(SHA 写「见 git log -1」,禁止 amend)。

## 自审与验收依据

| 要求 | 证据 |
|---|---|
| 新增断网默认可用 | createChatProfile 默认 custom 守护用例;loading/offline 态地址/模型/窗口输入框仍渲染(DOM 结构人工核对 + Sandbox) |
| 已配项断网锁供应商 | resolveProviderControl 三态单测;按钮 disabled/spinner 渲染 |
| 不阻塞其他字段 | renderProviderAndModel 地址/密钥/手填模型路径在 null/undefined 下不新增门槛 |
| 两态窗口文案 | catalog 判空分支;旧防呆句删除 |
| i18n 合规 | 无硬编码字面量;zh/en/types 一致;旧 key 无残留引用 |

**Sandbox 手验(主代理安排,非 subagent):** 断网→新建配置直接填四项可用;已配 DeepSeek 的配置→按钮离线态不可点、其他字段可改;恢复网络重开→按钮恢复、窗口自动校正。

---

## 执行记录 / 偏差说明

### 2026-10-11 执行

| Task | 文件 | 状态 | 备注 |
|---|---|---|---|
| Task 1 | 新建 `src/ui/settings/provider-control.ts`、`tests/ui/settings/provider-control.test.ts` | ✅ | TDD:先写 5 条用例(三态 × 断言 + 全覆盖 + createChatProfile 默认 custom 守护) |
| Task 2 | `src/ui/settings/chat-profiles-render.ts`、`styles.css` | ✅ | catalog 改三态类型;providerHost 立即渲染 loading 后 empty() 重绘;按钮 disabled/loader+ratel-spin;picker 换 offlinePicker;窗口行 null/miss 分文案;paintStoredWindow 同样区分 |
| Task 3 | `src/i18n/zh.ts`、`en.ts`、`types.ts` | ✅ | 新增 5 key、改 1 key、删 2 key(见下) |
| Task 4 | 提交与记录 | ✅ | 见 git log -1 |

**i18n key 增删:**
- 新增:`provider.listLoading`、`provider.offline`、`provider.offlineHint`、`provider.offlinePicker`、`window.offline`(zh/en/types 三处)
- 改文案:`window.unknown`(中文「名单中没有 {model},请按供应商文档填写上下文长度。」)
- 删除:`catalogMissing`、`window.unknownHint`(zh/en/types;删除前 grep 确认 src/tests 仅 plan 与归档文档提及)

**TDD 红绿证据:**
- RED:首次 `npx vitest run tests/ui/settings/provider-control.test.ts` → Failed Suites 1,`Cannot find module '../../../src/ui/settings/provider-control'`,Tests no tests。
- GREEN:实现纯函数后同命令 → 1 file / 5 tests passed。

**验证(真实输出):**
- `npx vitest run tests/ui/settings/provider-control.test.ts` → exit 0,5 passed。
- `npx tsc -noEmit -skipLibCheck` → exit 2(既有基线),`error TS` 计数 241 = develop 基线 241;grep `provider-control|chat-profiles-render|src/i18n/` 仅剩 3 条 chat-profiles-render 既有 `settingTab` private 报错(250/259/274,均在未改动的 hide/list watch 代码)。
- `npx svelte-check --tsconfig tsconfig.json` → 253 errors / 21 warnings in 71 files = 基线 253/21;新文件零命中。
- `npm run lint` → exit 0,0 errors / 17 warnings(全部既有)。
- `npm test` → exit 0,Test Files 273 passed / Tests 2043 passed(较基线 272 文件/2038 测试,+1 文件 +5 用例);skill-script-sandbox 19 tests 一次通过无 flake。
- `npm run build` → exit 0(18 既有 svelte warning)。
- `git diff --check` → exit 0。
- 隐私 grep(`/Users/`、本机用户名、`file://`)diff 与新文件均零命中。

**偏差:**
1. `ProviderControl.buttonTextKey` 未按 plan 字面写 `string`,收紧为 `Extract<StringKey, 三个 key 的字面量联合>`(type-only import `StringKey`),否则 `tNow(control.buttonTextKey)` 在 strict 下新增 1 条 tsc 报错(实测 242);收紧后回到基线 241。运行时值与 plan 规定完全一致,测试不变。
2. `paintStoredWindow` 读代码确认存在与活跃套相同的 null/miss 共用文案问题,已按 plan 第 4 点同样区分(catalog===null→`window.offline`,有名单 miss→`window.unknown`),数字框均保留。

**Commit:** 见 git log -1(禁止 amend,记录与代码在同一提交)。

---

### 2026-10-11 两阶段审查阶段二修复(0 Critical / 2 Major / 若干 Minor)

审查结论 FAIL,本轮修复不更换审查给定方案。

| 项 | 文件 | 状态 | 修复说明 |
|---|---|---|---|
| Major-1 | `src/ui/settings/chat-profiles-render.ts`、`src/ui/settings/provider-control.ts` | ✅ | providerHost 拆 `rowHost`＋`fieldsHost`;原 `renderProviderAndModel` 拆为 `renderProviderRow`(只画供应商行)与 `renderProviderFields`(只画地址/密钥/模型)。loading 立即画两部分;resolve 后三段判定:断网(null)只重画 rowHost、fieldsHost 零改动;本机项(custom/ollama)或 rows 无 listed 同样不重画;名单厂商(listed 存在,形态真翻转)才重建 fieldsHost——焦点在字段内时挂一次 focusout 并 setTimeout(0) 等 change 先落值,复查 isConnected/焦点已离开,`fieldsRebuilt` 守卫防重复重建。`refreshProfileWindow` 因多一层宿主改走 `closest('.ratel-chat-profile-detail')` |
| Major-2 | `src/ui/settings/chat-profiles-render.ts` | ✅ | loading 按钮改为先 `setIcon('loader')`→svg 加 `ratel-spin`→`createSpan` 补文字(子节点 [svg, span])→`aria-label` 补无障碍名;offline/ready 维持 `setButtonText` 纯文本,全新按钮不残留图标。「图标+文字共存」列入 Sandbox 必验,不引入 DOM 测试框架 |
| Minor-a/c | `src/i18n/zh.ts`、`en.ts` | ✅ | `window.offline` 中英文案改为如实表述:手填值保留,联网后改一次供应商或模型即按名单校正 |
| Minor-d | `src/ui/settings/chat-profiles-render.ts`、`styles.css` | ✅ | 本轮新增中文注释统一全角逗号/句号/括号(移动的旧注释行不动) |
| Minor-e | `styles.css` | ✅ | 加 `@media (prefers-reduced-motion: reduce) { svg.ratel-spin { animation: none; } }` |
| Minor(状态回退) | `docs/superpowers/STATUS.md` | ✅ | P-PROVIDER-OFFLINE 由 Completed 改回 In Progress,由 finishing 阶段主代理统一标 Completed |

**新增纯判定与 TDD 证据:**
- 在 `provider-control.ts` 新增 `fieldsShapeFlips(catalog, providerId)`:null→false、custom/ollama→false、名单查无→false、listed 存在(含 api=null)→true。
- RED:`npx vitest run tests/ui/settings/provider-control.test.ts` → 4 failed | 5 passed,`TypeError: fieldsShapeFlips is not a function`(4 条新用例全红)。
- GREEN:实现后同命令 → 1 file / 9 tests passed。

**验证(真实输出):**
- `npx vitest run tests/ui/settings/provider-control.test.ts` → 1 file / 9 tests passed。
- `npx tsc -noEmit -skipLibCheck` → `error TS` 计数 241 = 基线 241;grep 改动文件仅剩 3 条既有 `settingTab` private 报错(行号随插入下移为 251/260/275);修复中曾因 `closest` 返回 Element 出现 242,已用 `closest<HTMLElement>` 收回基线。
- `npx svelte-check --tsconfig tsconfig.json` → 253 errors / 21 warnings in 71 files = 基线 253/21,零新增。
- `npm run lint` → 0 errors / 17 warnings(全部既有)。
- `npm test` → exit 0,Test Files 273 passed / Tests 2047 passed(较上轮 2043,+4 为 fieldsShapeFlips 用例);skill-script-sandbox 一次通过无 flake。
- `npm run build` → exit 0(18 条既有 svelte warning)。
- `git diff --check` → exit 0;隐私 grep(`/Users/`、本机用户名、`file://`)diff 零命中。

**Sandbox 手验清单(更新版,主代理安排):**
1. 断网→新建配置直接填四项可用(默认自定义)。
2. **【头号场景】断网黑洞**:打开已配项详情后立刻在地址/密钥/模型框连续输入,等待名单请求超时(可达数十秒)——resolve 为离线后正在填的文本、密钥与焦点零干扰,仅供应商行按钮变「离线中」并出现离线说明。
3. 已配 DeepSeek 的配置→离线按钮不可点、其他字段可改;恢复网络重开→按钮恢复「选择」、窗口按新文案与名单校正。
4. **【Major-2 必验】loading 期间按钮内旋转 loader 图标与「获取名单中…」文字同时可见**(不能只剩图标),开发者工具检查子节点顺序为 [svg, span],且按钮有 aria-label。
5. 名单厂商 resolve 翻转:焦点不在字段内→立即变只读地址＋模型下拉;焦点正在地址/密钥框内输入后点向区外→change 先落值,随后才翻转,刚提交的值不丢;焦点在字段之间转移不会触发重建。
6. 系统开启「减弱动态效果」→loader 图标静止不旋转。
7. 断网窗口行新文案:手填值保留,联网后改一次供应商或模型即按名单校正。

**Commit:** 见 git log(本轮 fix 提交与 docs 提交分开,禁止 amend)。

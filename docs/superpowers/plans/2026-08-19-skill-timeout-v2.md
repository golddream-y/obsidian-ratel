# P-SKILL-2-TIMEOUT — Skill 脚本超时语义 v1.1(心跳分类 + LLM 决策)

> 实现 [ADR-017 v1.1](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md) 修订:硬超时从「无条件击杀」改为「按心跳分类处置」。spec 已同步([S-SKILL 4.6](../specs/2026-07-06-skill-mechanism-design.md))。

## 目标

1. **有心跳超时不误杀**:持续 `reportProgress` 的脚本到 `skillScriptTimeout` 不终止,工具返回 `still-running`(附时长+最近进度),LLM 决定 `continueRun`(再等一轮,可多轮)或 `killRun`(终止)
2. **无心跳超时仍自动杀**:整个窗口零心跳 = 卡死(vm 单线程死循环发不出消息),`terminate()` 不变
3. **绝对上限**:累计 10min(硬编码 `MAX_RUN_MS`)兜底 forever-progress
4. **熔断口径修正**:`still-running` 与主动 `killRun` 不计数;只数 无心跳超时 / 绝对上限击杀 / 崩溃
5. **补设置面板控件**:`skillScriptTimeout` slider(P-SKILL-2 漏项;加 declarative control 后自动进入 `update_app_config` 可代改面)

## 非目标

- 不做后台多脚本并行(pending 仍是全局单个)
- 不做完整 Skills 设置管理页(spec 4.9 完整组,另行排期)
- 不改软超时(10s 警告)行为

## 架构与状态机(sandbox 核心)

```
run() ──→ window 超时到点
            ├─ 无心跳(stalled)──→ terminate → {status:'timeout', kind:'stalled'}   [计熔断]
            └─ 有心跳 ──→ 不杀,resolve {status:'stillRunning', elapsedMs, lastProgress}
                          worker + deferred 存入 this.pending(串行链已放行)
                ├─ continueRun() ──→ 重置 window 定时器,await deferred(可多轮)
                │     ├─ 完成 → ok/scriptError/crashed
                │     ├─ window 又到 & 有心跳 → 再 stillRunning
                │     └─ stalled / maxDuration → terminate
                ├─ killRun() ──→ terminate → deferred resolve {status:'killed'}     [不计熔断]
                ├─ 新 run() 进来 ──→ 隐含 killPending(terminate 旧,resolve killed)再跑新
                └─ MAX_RUN_MS(10min,自启动累计,不随 continue 重置)→ terminate →
                   {status:'timeout', kind:'maxDuration'}                            [计熔断]
```

- **stalled 判定**:巡检间隔 1s(复用现有 beatTimer),`Date.now() - lastBeat >= timeoutMs` 立即杀(不等 window 到点 — 中途停跳的脚本也能及时判死)
- **串行链**:run() resolve stillRunning 后 chain 放行;新 run 先 `killPending()` 再执行

## 文件结构

| 文件 | 变更 |
|---|---|
| `src/skills/skill-script-sandbox.ts` | 状态机重构:outcome 类型、pending/deferred、continueRun/killRun、stalled 巡检、MAX_RUN_MS |
| `src/skills/skill-script-sandbox.test.ts` | 新增 ~10 用例(见 T1) |
| `src/tools/run-skill-script.ts` | continueRun/killRun 参数分支、stillRunning/killed/maxDuration 文案、熔断口径 |
| `src/tools/run-skill-script.test.ts` | 新增用例(见 T2) |
| `src/i18n/{types,zh,en}.ts` | 改 timeout 文案、删 timeoutProgressHint、加 stillRunning/killed/noRunning/maxDuration、设置项 name/desc |
| `src/prompts/tool-schemas.ts` | run_skill_script 加 continueRun/killRun 参数 |
| `src/settings.ts` | advanced 组加 skillScriptTimeout slider;字段注释语义更新 |

## 任务清单

### T1 — sandbox 状态机重构(TDD;无外部依赖)

**RED 先行**:在 `skill-script-sandbox.test.ts` 加用例(沿用现有 fake worker 工厂模式):
1. 有心跳 + window 超时 → `stillRunning`(含 elapsedMs/lastProgress),worker **未** terminate
2. stillRunning 后脚本完成 → `continueRun()` resolve `ok`
3. stillRunning 后 `killRun()` → `killed`,worker 已 terminate
4. 零心跳 + window 超时 → `timeout/killed`… 即 `{status:'timeout', kind:'stalled'}`,worker 已 terminate
5. 中途停跳(先打点后死循环)→ stalled 巡检在停跳满 timeoutMs 时杀(不等 window)
6. continueRun 多轮:第一轮仍超时 → 再 stillRunning;第二轮完成 → ok
7. 累计超 `MAX_RUN_MS`(测试注入小值)→ `{status:'timeout', kind:'maxDuration'}`;continue 不重置该计时
8. pending 存在时新 `run()` → 旧 worker terminate(killed),新脚本正常执行
9. `continueRun()`/`killRun()` 无 pending → `{status:'noRunning'}`(不 throw)
10. unload `terminateAll()` 时 pending deferred 也 resolve(不悬空)

**实现要点**(`skill-script-sandbox.ts`):
```ts
export type ScriptRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'scriptError'; error: string; stack?: string }
  | { status: 'stillRunning'; elapsedMs: number; lastProgress?: string; hadProgress: boolean }
  | { status: 'timeout'; kind: 'stalled' | 'maxDuration'; hadProgress: boolean }
  | { status: 'killed' }
  | { status: 'crashed'; detail?: string }
  | { status: 'noRunning' };

export const MAX_RUN_MS = 10 * 60_000; // 绝对上限,自启动累计(ADR-017 v1.1 §3「赖」)

// 类内新增:
// private pending: { worker; deferred: Promise.withResolvers<ScriptRunOutcome>;
//                    startMs: number; lastProgress?: string; hadProgress: boolean; cleanup(): void } | null
continueRun(): Promise<ScriptRunOutcome>;  // 重置 window 定时器后 await deferred
killRun(): Promise<ScriptRunOutcome>;      // terminate + resolve killed
```
- window 到点:`hadProgress && Date.now() - lastBeat < timeoutMs` → still-running 分支(resolve 调用方 + 挂 pending);否则 terminate(防御性,正常该被 stalled 巡检先杀)
- **验证**:`npx vitest run src/skills/skill-script-sandbox.test.ts` 全绿 + 全量回归

### T2 — 工具层接线 + i18n + schema(依赖 T1 接口)

`run-skill-script.ts`:
- `ScriptSandboxLike` 加 `continueRun(): Promise<ScriptRunOutcome>` / `killRun(): Promise<ScriptRunOutcome>`
- execute 入口在参数校验后先分流:`args.killRun === true` → `deps.sandbox.killRun()`(结果映射文案,无 pending → noRunning 文案);`args.continueRun === true` → 同理 `continueRun()`;两者同真 → killRun 优先。**continue/kill 分支不走信任门/熔断检查**(脚本已在跑,授权与计数在启动时已过)
- 新增 run 分支结果:
  - `stillRunning` → `tNow('skill.script.stillRunning', { seconds, progress })`,**不计熔断、不 bump**
  - `killed` → `tNow('skill.script.killed')`,不计熔断
  - `timeout/kind=stalled` → 改用新文案 `skill.script.stalled`,bump 熔断
  - `timeout/kind=maxDuration` → `skill.script.maxDuration`,bump 熔断
  - `noRunning` → `skill.script.noRunning`
- **删** `timeoutProgressHint` 引用与 i18n key(still-running 机制取代)

i18n(zh 为准,en 同步;types.ts 加 key):
- `'skill.script.stillRunning'`: `'脚本仍在运行(已 {seconds} 秒,最近进度: {progress})。它持续上报进度,未终止。传 continueRun: true 继续等待下一轮,或 killRun: true 终止它。'`
- `'skill.script.killed'`: `'脚本已按指示终止。'`
- `'skill.script.noRunning'`: `'当前没有正在运行的脚本,无需 {action}。'`(action = continueRun/killRun)
- `'skill.script.stalled'`: `'脚本 {id} 超过 {seconds} 秒无任何进度心跳,判定卡死,已终止。'`
- `'skill.script.maxDuration'`: `'脚本 {id} 运行超过绝对上限 10 分钟,已终止。'`
- `'skill.script.timeout'` 文案改为 maxDuration 场景兜底或直接删除(由 stalled/maxDuration 取代;删则同步清 types)
- 设置项:`'settings.skill.scriptTimeout.name'`: `'脚本无响应超时(秒)'` / `desc`: `'脚本超过该时长无进度心跳即判定卡死终止;持续报进度的脚本不受此限,超时会交由 AI 判断继续等待或终止'`

`tool-schemas.ts` run_skill_script properties 加 `continueRun: { type: 'boolean' }`、`killRun: { type: 'boolean' }`。

**测试**(`run-skill-script.test.ts` 新增):still-running 不 bump 熔断、killRun 走 killRun 不过信任门、continue+kill 同真 kill 优先、stalled bump、maxDuration bump、文案含 continueRun 引导。**验证**:vitest 该文件 + 全量。

### T3 — 设置面板 skillScriptTimeout 控件(独立,可与 T1 并行)

`src/settings.ts`:
- `developer`(advanced,~934 行)组加 slider。**注意存储单位是 ms(30_000)而 slider 显示秒不友好**:先读现有 slider control 实现(`setControlValue`/settings-apply)确认是否支持格式化;若不支持,slider 直接绑 ms 值(min 5000, max 120000, step 5000)且 name 写「脚本无响应超时(毫秒)」**不可接受** — 则改为 i18n name 用秒、slider 用 ms 裸值的替代方案:选其一落地并在提交信息注明理由。推荐优先尝试 declarative control 是否已有 `format`/单位能力(查 `chunkSize` 等先例)
- 字段注释(154 行)改为 v1.1 语义:「无心跳判定窗口(ms;ADR-017 v1.1)— 零心跳超此值判卡死;持续报进度超此值返回 still-running 交 LLM 决策」
- **验证**:面板渲染测试(仿 `appearance-settings-render` 模式,若 settings 测试结构不同则跑 settings 相关现有测试回归)+ 全量

## 自审

- 依赖顺序:T1(沙箱)→ T2(工具);T3 独立。Wave1 = T1 ∥ T3,Wave2 = T2
- 熔断口径与 ADR-017 §5 逐条对齐(still-running/killed 不数,stalled/maxDuration/crashed 数)
- 旧 outcome 消费方:run-skill-script.ts 是唯一 switch 消费点(T2 全覆盖);无其他 import ScriptRunOutcome 的调用方(已 grep 确认 main.ts 只透传)
- i18n 三件套(types/zh/en)同步,删 key 需三处同删
- 用户可见新文案全部走 i18n(AGENTS.md 硬约束)

# ADR-017:Skill 脚本沙箱 — Worker Thread + vm 双层运行时

**状态**:Accepted
**日期**:2026-08-19
**关联**:
- [S-SKILL](../superpowers/specs/2026-07-06-skill-mechanism-design.md)(4.7 沙箱设计 / 6.6 未决问题由本 ADR 关闭)
- P-SKILL-2-EXECUTION(实施 plan)
- [ADR-006](2026-07-04-worker-architecture.md)(Embedding Web Worker 先例:重活不进主线程)

---

## Context(背景)

S-SKILL 的 P-SKILL-2-EXECUTION 要让技能携带可执行脚本(`scripts/` 目录),用于数据清洗、格式转换等指令文本干不了的活。spec 6.6 留了未决问题:**沙箱跑在哪**。候选:

| 方案 | 启动开销 | 防死循环 | 隔离强度 |
|---|---|---|---|
| 主线程 Node `vm` | ~0ms | ❌ 同步阻塞 UI | 弱(官方声明非安全边界) |
| Worker Thread + `vm` | ~50ms | ✅ `terminate()` 毫秒杀 | 中(双层限制) |
| child_process | ~100ms | ✅ kill 进程 | 强(真进程边界) |
| WASM 解释器(QuickJS) | 低 | ✅ | 最强,但慢 10-50 倍 |

同时必须回答运行期状态问题:脚本**阻塞/卡死如何发现**(死循环的 Worker 自己不会报告)、**多次失败如何处理**(脚本有写文件副作用,盲目重跑有风险)。

---

## Decision(决策)

### 1. 运行时 = Worker Thread + vm 双层

- **Worker Thread**(Node `worker_threads`):每次执行新起一个,跑完即弃。死循环只卡 worker,`terminate()` 毫秒级击杀,Obsidian UI 零影响
- **vm context**(Worker 内):砍 `require` / `fetch` / `child_process` / `process`;fs 白名单只开 vault 根 + 该 skill 目录;注入 `reportProgress()` 心跳 API
- 复用 ADR-006 的先例逻辑:重活不进主线程(Embedding 推理如此,脚本执行亦然)

### 2. 威胁模型:防手滑,不防黑客

skill 是**用户自己装的**,威胁是误操作与能力面失控(脚本手滑删库、死循环、意外发网络),不是防沙箱逃逸专家。此定位下:

- **不做** child_process 进程隔离——进程管理、跨平台 kill、结果回传管道全是成本,防的对手不存在
- **不做** WASM 解释器——慢 10-50 倍,秒级脚本变几十秒,本末倒置
- 生态参照:Templater 直接 `eval` 用户 JS 零沙箱跑了多年;「Worker + vm 限能力」已是超配严谨

**语言边界 = JavaScript only**:vm 运行时天然只懂 JS。`.py` / `.sh` 等非 JS 脚本在工具层按扩展名白名单(`.js` / `.mjs` / `.cjs`)直接拒绝,返回「不支持 + 引导 MCP(ADR-014)」的工具结果 — LLM 可换路告知用户,不弹授权、不执行。child_process 跑解释器(跨平台碎片化 + 沙箱承诺全丢)与 Pyodide(WASM Python,10MB+ 级)的成本账同上,不做;需要任意语言能力的用户走 MCP server,进程归用户自己管。

### 3. 检测:双层超时区分「慢」与「死」

| 层 | 机制 | 判定与动作 |
|---|---|---|
| 软超时(心跳) | 注入 `reportProgress()`,脚本主动报进度;默认 10s 无心跳 → UI 警告 | **慢**:可能在大数据处理,用户可继续等 |
| 硬超时(wall clock) | 30s 无条件到期(settings `skillScriptTimeout` 可调) | **死**:判定卡死,立即击杀 |

有心跳但到硬超时照样杀(上限即上限),错误信息注明「脚本持续报进度,建议作者优化或调大超时」。

### 4. 卡死处理:击杀 → 清理 → 错误上抛

```
判定卡死 → worker.terminate()(死循环也能杀)
        → pending Promise reject(工具返回错误结果)
        → Worker 一次性,杀完即弃无残留
```

错误作为**工具结果**返回而非抛异常——LLM 看到「脚本超时被终止」可自行换路(改用别的方法、告知用户),不崩回合。

### 5. 多次失败:熔断,不自动重试

- **不自动重试**——脚本有写文件副作用,盲目重跑可能重复写入
- LLM 再次调用工具视为「重试」,允许;但**同一脚本连续 3 次异常终止(被杀/超时/崩溃)→ 熔断标记**
- 熔断后再被调用 → 不执行,返回「已连续失败 3 次,需用户在面板重新确认」+ Notice 提醒用户
- 成功一次即清零计数;计数存 usage-stats 基础设施(现成)

### 6. 兜底三件套

1. **并发 = 1**:信号量串行,防 LLM 连环调用起一堆 Worker
2. **插件 unload → terminateAll**:不留孤儿线程
3. **Worker 启动即注册 exit 监听**:即使 terminate 异常,exit 事件也保证 Promise 不悬空

---

## Consequences(后果)

**正面:**
- 主线程永不阻塞,卡死脚本毫秒级可杀,Obsidian 稳定性不受 skill 脚本影响
- 误操作防护达到「删不掉库外文件、发不了网络、跑不死循环」的实用水位
- 熔断机制防 LLM 无脑循环消耗资源
- 关闭 spec 6.6 未决问题,P-SKILL-2 可开工

**负面:**
- 每次执行 ~50ms Worker 启动开销(对手动触发的秒级脚本无感知)
- `vm` 非安全边界,理论上可逃逸——接受(威胁模型内无此对手)
- Worker 内不能访问 Obsidian API,脚本只能走注入的受限 fs 白名单(功能上有意为之)

**首次落地范围(P-SKILL-2):** `run_skill_script` 工具 + Worker/vm 沙箱 + 双层超时 + 熔断 + `trustedScripts` 白名单 + `read_skill_reference`(读 references/,防 traversal,不涉沙箱)。

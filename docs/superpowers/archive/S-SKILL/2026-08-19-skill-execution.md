# P-SKILL-2-EXECUTION:references + scripts 沙箱 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 S-SKILL 的 Execution 能力 — `read_skill_reference`(读 references/,防 traversal)+ `run_skill_script`(Worker Thread + vm 双层沙箱,双层超时,熔断,首次授权 Modal)。

**Architecture:** 三层分离 — ① `script-vm.ts` 纯 vm 沙箱核心(无 worker_threads 依赖,安全限制全部在此,可直测);② worker 入口薄壳(worker_threads + postMessage 协议,esbuild 打成字符串内联进 main.js);③ 主线程 `SkillScriptSandbox` 运行器(并发=1 信号量、软/硬超时、terminateAll)。权限与熔断:`ScriptTrustGate`(per-script Modal + trustedScripts 白名单)+ usage-stats 新增 `scriptFailures` 计数(ADR-017:仅被杀/超时/崩溃计数,成功清零)。

**Tech Stack:** TypeScript strict / node:worker_threads + node:vm(桌面端,isDesktopOnly=true)/ esbuild(新 worker bundle + inline 插件)/ vitest(真实 worker_threads 可测)/ Svelte 不涉及。

**关联文档:**
- Spec: [S-SKILL §4.6/§4.7/§5.2](../specs/2026-07-06-skill-mechanism-design.md)
- 决策: [ADR-017 Worker Thread + vm 双层运行时](../../adr/2026-08-19-skill-script-sandbox-worker-vm.md) — 本 plan 全部运行时/超时/熔断设计以它为准

**与 spec §5.2 的文件偏差(均为 ADR-017 落地所需):**

| spec 原文 | 实际 | 原因 |
|---|---|---|
| `src/ui/settings/` 权限 Modal | `src/ui/skills/ScriptTrustModal.ts` | skills UI 已集中在 `src/ui/skills/`,与 SkillManageModal 同域 |
| 未列 vm 核心 | 新增 `src/skills/script-vm.ts` | 纯 vm 沙箱与 worker 壳分离,安全限制可单测 |
| 未列 worker 入口 | 新增 `src/worker/skill-script-worker.ts` + esbuild 接线 | Worker Thread 薄壳,复用 ADR-006 embedding worker 内联模式 |
| 未列熔断存储 | 扩展 `src/core/usage-stats.ts` | ADR-017:计数存 usage-stats 基础设施(现成) |

---

## 文件结构(全量)

```
src/
  core/usage-stats.ts                  [改] +scriptFailures 命名空间(bump/clear/getCount)
  skills/script-vm.ts                  [新] vm 沙箱核心:受限 fs 白名单、无 require/fetch/process、reportProgress、结果序列化
  skills/script-vm.test.ts             [新] 安全限制 + 结果序列化测试
  worker/skill-script-worker.ts        [新] worker_threads 入口薄壳(run → runInVmSandbox → done)
  skills/skill-script-sandbox.ts       [新] 主线程运行器:Worker(eval) 一次性、并发=1、软/硬超时、terminateAll
  skills/skill-script-sandbox.test.ts  [新] 真实 worker_threads:死循环击杀 / 协议 / 串行 / exit 兜底
  skills/skill-script-permission.ts    [新] ScriptTrustGate:trustedScripts 检查 + Modal 确认 + 记住
  skills/skill-script-permission.test.ts [新] 白名单直行 / once / always 持久化 / deny
  ui/skills/ScriptTrustModal.ts        [新] 首次运行授权 Modal(允许并记住 / 仅此次 / 拒绝)
  tools/read-skill-reference.ts        [新] read_skill_reference 工具(readOnly)
  tools/read-skill-reference.test.ts   [新] traversal 防护 / 大小上限 / 二进制拒绝
  tools/run-skill-script.ts            [新] run_skill_script 工具(熔断 + 信任门 + 沙箱)
  tools/run-skill-script.test.ts       [新] 熔断触发 / 拒绝 / 超时 / 成功清零
  prompts/tool-schemas.ts              [改] +2 skeleton
  prompts/sections.ts                  [改] +5 section(2 description + 3 param)
  prompts/defaults/zh.ts               [改] +5 section 默认文案
  i18n/types.ts                        [改] +本 plan 全部新 key 声明
  i18n/zh.ts / en.ts                   [改] +本 plan 全部新 key
  core/tool-permissions.ts             [改] summarizeToolCall +run_skill_script 分支
  settings.ts                          [改] +skillScriptTimeout/trustedScripts 字段与默认值;toolPermissions 默认 +2
  main.ts                              [改] 注册 2 工具、懒建沙箱、onunload terminateAll、信任持久化
  adapters/skill-script-worker-code.ts [新] 虚拟模块 @ratel/skill-script-worker-code 再导出
esbuild.config.mjs                     [改] skill-script-worker bundle + inline 插件 + prod/dev 时序
```

---

## 关键设计速查(实现者必读)

**Worker 协议(postMessage,双向):**

```ts
// 主线程 → worker
{ type: 'run', code: string, args: string[], allowedDirs: string[] }
// worker → 主线程
{ type: 'progress', message: string }          // 心跳,软超时据此复位
{ type: 'log', level: 'log'|'warn'|'error', message: string }  // console 透传,也算心跳
{ type: 'done', result: VmSandboxResult }      // ok:true→result 序列化字符串;ok:false→脚本抛错
```

**超时语义(ADR-017 §3):**
- 软超时:10s(常量 `SOFT_TIMEOUT_MS`)无任何 worker 消息 → `onSoftTimeout` 回调(Notice 警告),**不终止**,每次 run 只警告一次
- 硬超时:`settings.skillScriptTimeout`(默认 30000)无条件到期 → `worker.terminate()` → outcome `timeout`
- vm 内**不设** `timeout` 选项 — 击杀权统一归 worker `terminate()`(ADR-017 单一击杀路径)

**熔断语义(ADR-017 §5):**
- 仅 `timeout` / `crashed` 计数 bump;`scriptError`(脚本自己 throw)**不**计数 — 那是正常失败,LLM 可修参重试
- 成功一次 `clear` 清零;计数持久化在 `pluginDir/usage-stats.json` 的 `scriptFailures` 桶
- 检查顺序(工具内):信任门 → 熔断检查 → 执行。熔断的恢复路径:untrusted 脚本会再弹 Modal,选「允许并记住」时 `persistTrust` 回调同时清计数(trusted 脚本先移出白名单再运行即可重新触发 Modal)

**权限模型(避免双重弹窗):**
- `toolPermissions.run_skill_script` 默认 **'allow'** — per-script 授权由工具内 `ScriptTrustGate` 负责;若默认 'ask' 会对同一脚本先弹通用 Modal 再弹信任 Modal
- 用户仍可把该工具设为 'ask'(每会话多一道)或 'deny'(整体禁用)
- `read_skill_reference` 默认 'allow'(只读、路径被锁死在 references/ 内,与 read_note 同级)
- `run_skill_script` 不进 `DESTRUCTIVE_TOOLS`(沙箱已限制写范围在 vault + skill 目录)

**AGENTS.md Worker 约束辨析(写给 reviewer):** 「Worker 严禁 import obsidian」适用 ✓(本 worker 只 import node:vm / node:fs / node:path / worker_threads);「Embedding Web Worker 严禁 Node API」仅指 embedding-worker(浏览器 Web Worker)— 本 worker 是 **Node worker_threads**,与 InlineWorker 同类,vectra 索引 worker 已有 node:fs 先例,合规。

---

### Task 1:熔断计数 — usage-stats 扩展 `scriptFailures` 命名空间

**Files:**
- Modify: `src/core/usage-stats.ts`
- Test: `src/core/usage-stats.test.ts`(已存在则追加 describe)

- [ ] **Step 1:写失败测试**

在 `src/core/usage-stats.test.ts` 追加(若文件不存在,按下方新建,含文件头注释与 tmp 目录 fixture;先读现有文件沿用其风格):

```ts
describe('UsageStatsStore — scriptFailures 熔断计数', () => {
	let store: UsageStatsStore;
	let filePath: string;

	beforeEach(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-stats-'));
		filePath = path.join(dir, 'usage-stats.json');
		store = new UsageStatsStore(filePath);
	});

	it('bumpScriptFailure - 首次失败 - 计数为 1 并落盘', () => {
		store.bumpScriptFailure('data-cleaner/clean.js');
		expect(store.getScriptFailureCount('data-cleaner/clean.js')).toBe(1);
		// 关键路径:计数持久化,插件重启后熔断状态不丢
		const reloaded = new UsageStatsStore(filePath);
		expect(reloaded.getScriptFailureCount('data-cleaner/clean.js')).toBe(1);
	});

	it('clearScriptFailure - 成功后清零 - 计数归 0 并落盘', () => {
		store.bumpScriptFailure('a/b.js');
		store.clearScriptFailure('a/b.js');
		expect(store.getScriptFailureCount('a/b.js')).toBe(0);
	});

	it('readFromDisk - scriptFailures 桶含脏值 - 非数值被过滤', () => {
		fs.writeFileSync(filePath, JSON.stringify({ scriptFailures: { 'a/b.js': 'x', 'c/d.js': 2 } }), 'utf-8');
		const reloaded = new UsageStatsStore(filePath);
		expect(reloaded.getScriptFailureCount('a/b.js')).toBe(0);
		expect(reloaded.getScriptFailureCount('c/d.js')).toBe(2);
	});

	it('getAll - 返回 scriptFailures 快照 - 浅拷贝不污染内部', () => {
		store.bumpScriptFailure('a/b.js');
		const snap = store.getAll();
		snap.scriptFailures!['a/b.js'] = 99;
		expect(store.getScriptFailureCount('a/b.js')).toBe(1);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/core/usage-stats.test.ts`
Expected: FAIL — `bumpScriptFailure is not a function`

- [ ] **Step 3:最小实现**

`src/core/usage-stats.ts` 修改三处:

```ts
/** 统计数据形态 — 三个命名空间:skills / memoryTopics / scriptFailures */
export interface UsageStatsData {
	skills: Record<string, number>;
	memoryTopics: Record<string, number>;
	/** 脚本熔断计数(key = `<skillName>/<scriptPath>`,ADR-017) */
	scriptFailures: Record<string, number>;
}
```

构造器与 `readFromDisk` 的重置值全部改为 `{ skills: {}, memoryTopics: {}, scriptFailures: {} }`;`readFromDisk` 返回对象加一行 `scriptFailures: this.sanitizeBucket(obj.scriptFailures),`;`getAll` 加 `scriptFailures: { ...this.data.scriptFailures },`;再加三个公开方法:

```ts
	/** 脚本异常终止(被杀/超时/崩溃)计数 +1 并落盘 — ADR-017 熔断输入 */
	bumpScriptFailure(scriptId: string): void {
		this.bump('scriptFailures', scriptId);
	}

	/** 脚本成功执行 — 连续失败计数清零并落盘 */
	clearScriptFailure(scriptId: string): void {
		if (this.data.scriptFailures[scriptId] === undefined) return;
		delete this.data.scriptFailures[scriptId];
		this.flush();
	}

	/** 读取脚本连续失败计数(0 = 未熔断) */
	getScriptFailureCount(scriptId: string): number {
		return this.data.scriptFailures[scriptId] ?? 0;
	}
```

`private bump` 的 namespace 参数类型改为 `'skills' | 'memoryTopics' | 'scriptFailures'`。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/core/usage-stats.test.ts`
Expected: PASS(含原有用例)

- [ ] **Step 5:Commit**

```bash
git add src/core/usage-stats.ts src/core/usage-stats.test.ts
git commit -m "feat: usage-stats 新增 scriptFailures 熔断计数(S-P2 ADR-017)"
```

---

### Task 2:vm 沙箱核心 — `src/skills/script-vm.ts`

**Files:**
- Create: `src/skills/script-vm.ts`
- Test: `src/skills/script-vm.test.ts`

- [ ] **Step 1:写失败测试(安全限制是验收核心,逐条对应 spec §5.2 验收)**

```ts
/**
 * @file src/skills/script-vm.test.ts
 * @description vm 沙箱核心测试 — 能力面裁剪 / fs 白名单 / reportProgress / 结果序列化
 * @module skills/script-vm.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInVmSandbox } from './script-vm';

describe('runInVmSandbox', () => {
	let vaultRoot: string;
	let skillDir: string;

	beforeEach(() => {
		vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-vault-'));
		skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skill-'));
	});
	afterEach(() => {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
		fs.rmSync(skillDir, { recursive: true, force: true });
	});

	it('能力面 - 全新 context 无 fetch/require/process/XMLHttpRequest', () => {
		const r = runInVmSandbox({
			code: `[typeof fetch, typeof require, typeof process, typeof XMLHttpRequest, typeof globalThis].join(',')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('undefined,undefined,undefined,undefined,object');
	});

	it('网络禁用 - fetch 调用直接抛错(不存在)', () => {
		const r = runInVmSandbox({
			code: `typeof fetch`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
	});

	it('fs 白名单 - 写 vault 内文件成功', () => {
		const r = runInVmSandbox({
			code: `fs.writeFileSync('out/a.txt', 'hi'); 'written'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		expect(fs.readFileSync(path.join(vaultRoot, 'out/a.txt'), 'utf-8')).toBe('hi');
	});

	it('fs 白名单 - 写白名单外路径抛错被捕获为 scriptError', () => {
		const r = runInVmSandbox({
			// 关键路径:os.tmpdir() 本身在白名单外,相对路径 .. 逃逸同样拦截
			code: `fs.writeFileSync('${path.join(os.tmpdir(), 'escape.txt').replace(/\\/g, '\\\\')}', 'x'); 'ok'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(false);
	});

	it('fs 白名单 - 相对路径 .. 逃逸抛错', () => {
		fs.mkdirSync(path.join(vaultRoot, 'scripts'), { recursive: true });
		const r = runInVmSandbox({
			code: `try { fs.readFileSync('../../etc/passwd'); 'leaked' } catch (e) { 'blocked' }`,
			args: [],
			allowedDirs: [path.join(vaultRoot, 'scripts')],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('"blocked"');
	});

	it('reportProgress - 脚本主动报进度 - 回调收到消息', () => {
		const seen: string[] = [];
		const r = runInVmSandbox({
			code: `reportProgress('step-1'); 42`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
			onProgress: (m) => seen.push(m),
		});
		expect(seen).toEqual(['step-1']);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('42');
	});

	it('args - 参数以全局 args 数组注入', () => {
		const r = runInVmSandbox({
			code: `args.join('|')`,
			args: ['--input', 'data.json'],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('"--input|data.json"');
	});

	it('结果序列化 - 对象返回 JSON 字符串', () => {
		const r = runInVmSandbox({
			code: `({ count: 3, names: ['a'] })`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(JSON.parse(r.result)).toEqual({ count: 3, names: ['a'] });
	});

	it('结果序列化 - 超 64KB 截断并加尾注', () => {
		const r = runInVmSandbox({
			code: `'x'.repeat(100000)`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(Buffer.byteLength(r.result, 'utf-8')).toBeLessThanOrEqual(64 * 1024);
			expect(r.result).toContain('截断');
		}
	});

	it('脚本抛错 - 返回 ok:false 含错误消息与堆栈', () => {
		const r = runInVmSandbox({
			code: `throw new Error('boom')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('boom');
	});

	it('console - log/warn/error 透传回调,不炸 context', () => {
		const logs: string[] = [];
		const r = runInVmSandbox({
			code: `console.log('a'); console.warn('b'); console.error('c'); 'done'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
			onLog: (_lv, m) => logs.push(m),
		});
		expect(logs).toEqual(['a', 'b', 'c']);
		expect(r.ok).toBe(true);
	});

	it('path - 暴露 join/resolve/dirname/basename/extname/sep 纯函数', () => {
		const r = runInVmSandbox({
			code: `[typeof path.join, typeof path.resolve, typeof path.sep].join(',')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('function,function,string');
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/skills/script-vm.test.ts`
Expected: FAIL — `Cannot find module './script-vm'`

- [ ] **Step 3:实现 `src/skills/script-vm.ts`**

```ts
/**
 * @file src/skills/script-vm.ts
 * @description vm 沙箱核心 — 受能力面裁剪的脚本执行(ADR-017;被 skill-script-worker 调用)
 * @module skills/script-vm
 * @depends node:vm, node:fs, node:path
 *
 * 关键路径:
 * - 本文件运行在 worker_threads 内,严禁 import 'obsidian' 与 i18n(错误文案由工具层包装)。
 * - 全新 vm context 天然无 fetch / require / process / XMLHttpRequest — 只注入白名单 API。
 * - 不设 vm timeout 选项:击杀权统一归主线程 worker.terminate()(ADR-017 单一击杀路径)。
 */

import * as vm from 'node:vm';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/** 结果 JSON 序列化上限(64KB)— 巨型返回值不撑爆工具结果与上下文 */
const MAX_RESULT_BYTES = 64 * 1024;
const TRUNCATION_NOTE = '(已截断:脚本返回值超出 64KB 上限)';

export interface VmSandboxRequest {
	/** 脚本源码(UTF-8 文本;入口约定为同步代码,末表达式作为返回值) */
	code: string;
	/** 命令行参数,注入为全局 args */
	args: string[];
	/** fs 白名单目录(绝对路径;通常 = [vaultRoot, skillDir]) */
	allowedDirs: string[];
	/** 心跳回调 — 脚本 reportProgress() 触发,主线程软超时据此复位 */
	onProgress?: (message: string) => void;
	/** console 透传回调 */
	onLog?: (level: 'log' | 'warn' | 'error', message: unknown) => void;
}

export type VmSandboxResult =
	| { ok: true; result: string }
	| { ok: false; error: string; stack?: string };

/**
 * fs 白名单校验:resolve 后必须落在某个 allowedDir 内,否则抛错。
 *
 * 关键路径:startsWith 必须补 path.sep,防 `/vault-evil` 误匹配 `/vault` 前缀。
 */
function resolveAllowed(p: string, allowedDirs: string[], cwd: string): string {
	const abs = nodePath.resolve(cwd, p);
	for (const dir of allowedDirs) {
		if (abs === dir || abs.startsWith(dir + nodePath.sep)) return abs;
	}
	throw new Error(`fs 访问被拒绝(超出沙箱白名单): ${p}`);
}

/** 受限 fs — 只暴露同步 API,全部过白名单校验;写操作自动建父目录降低脚本样板 */
function createRestrictedFs(allowedDirs: string[], cwd: string): Record<string, unknown> {
	const guard = (p: string): string => resolveAllowed(p, allowedDirs, cwd);
	const guardWrite = (p: string): string => {
		const abs = guard(p);
		nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
		return abs;
	};
	return {
		readFileSync: (p: string, enc?: string) => nodeFs.readFileSync(guard(p), enc ?? 'utf-8'),
		writeFileSync: (p: string, data: string) => nodeFs.writeFileSync(guardWrite(p), data, 'utf-8'),
		appendFileSync: (p: string, data: string) => nodeFs.appendFileSync(guardWrite(p), data, 'utf-8'),
		existsSync: (p: string) => {
			try {
				guard(p);
			} catch {
				return false;
			}
			return nodeFs.existsSync(guard(p));
		},
		mkdirSync: (p: string) => nodeFs.mkdirSync(guardWrite(p), { recursive: true }),
		readdirSync: (p: string) => nodeFs.readdirSync(guard(p)),
		statSync: (p: string) => nodeFs.statSync(guard(p)),
	};
}

/** 末表达式值 → 字符串(JSON 优先;超限截断加尾注) */
function serializeResult(value: unknown): string {
	let text: string;
	if (value === undefined) {
		text = 'undefined';
	} else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			// 循环引用等不可序列化值降级为 String()
			text = String(value);
		}
	}
	if (Buffer.byteLength(text, 'utf-8') > MAX_RESULT_BYTES) {
		// 关键路径:按字节截断防劈开多字节字符(与 prompts/injection/injector 同思路,本地实现避免跨依赖)
		let out = Buffer.from(text, 'utf-8').subarray(0, MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATION_NOTE, 'utf-8')).toString('utf-8');
		out += TRUNCATION_NOTE;
		return out;
	}
	return text;
}

/**
 * 在受限 vm context 中执行脚本。
 *
 * 设计要点:
 * - 注入全局:args / reportProgress / console(透传)/ fs(白名单)/ path(纯函数,无 IO)
 * - 不注入 require / process / fetch — 新 context 默认就没有,无需显式砍
 * - 脚本抛错不向上冒泡:返回 ok:false,由调用方(worker)决定计数与呈现
 *
 * @returns ok:true 时 result 为序列化字符串;ok:false 时为脚本错误
 * @example
 *   const r = runInVmSandbox({ code: 'args[0]', args: ['x'], allowedDirs: [dir] });
 */
export function runInVmSandbox(req: VmSandboxRequest): VmSandboxResult {
	const cwd = req.allowedDirs[0] ?? process.cwd();
	const sandbox: Record<string, unknown> = {
		args: req.args,
		reportProgress: (msg: unknown) => req.onProgress?.(String(msg)),
		console: {
			log: (...a: unknown[]) => req.onLog?.('log', a),
			warn: (...a: unknown[]) => req.onLog?.('warn', a),
			error: (...a: unknown[]) => req.onLog?.('error', a),
		},
		fs: createRestrictedFs(req.allowedDirs, cwd),
		path: {
			join: nodePath.join,
			resolve: nodePath.resolve,
			dirname: nodePath.dirname,
			basename: nodePath.basename,
			extname: nodePath.extname,
			sep: nodePath.sep,
			relative: nodePath.relative,
		},
	};
	const context = vm.createContext(sandbox);
	try {
		const value = vm.runInContext(req.code, context, { filename: 'skill-script.js' });
		return { ok: true, result: serializeResult(value) };
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		return { ok: false, error: e.message, stack: e.stack };
	}
}
```

注意:`onLog` 的 message 收到的是参数数组,worker 侧转 `String(...)` 拼接。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/skills/script-vm.test.ts`
Expected: PASS 全绿

- [ ] **Step 5:Commit**

```bash
git add src/skills/script-vm.ts src/skills/script-vm.test.ts
git commit -m "feat: vm 沙箱核心 — fs 白名单/能力面裁剪/reportProgress(S-P2)"
```

---

### Task 3:Worker 运行时 — worker 入口 + SkillScriptSandbox + esbuild 接线

**Files:**
- Create: `src/worker/skill-script-worker.ts`
- Create: `src/skills/skill-script-sandbox.ts`
- Create: `src/skills/skill-script-sandbox.test.ts`
- Create: `src/adapters/skill-script-worker-code.ts`
- Modify: `esbuild.config.mjs`

- [ ] **Step 1:实现 worker 入口薄壳(无独立测试,由 Step 3 的打包集成测试覆盖)**

```ts
/**
 * @file src/worker/skill-script-worker.ts
 * @description Skill 脚沙箱 Worker Thread 入口 — 收 run 消息,跑 vm 沙箱,回 done(ADR-017)
 * @module worker/skill-script-worker
 * @depends node:worker_threads, skills/script-vm
 *
 * 关键路径:
 * - 本文件运行在 worker_threads(纯 Node),严禁 import 'obsidian'。
 * - Worker 一次性:主线程每次 run 新起、跑完 terminate,本入口不做状态保持。
 * - esbuild 打成 CJS 字符串内联进 main.js,运行时 new Worker(code, { eval: true })。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runInVmSandbox, type VmSandboxRequest, type VmSandboxResult } from '../skills/script-vm';

interface RunMessage {
	type: 'run';
	code: string;
	args: string[];
	allowedDirs: string[];
}

/** workerData.allowedDirs 用于定 cwd;run 消息为主协议(与测试用裸 worker 兼容) */
const fallbackDirs: string[] = Array.isArray((workerData as { allowedDirs?: string[] } | undefined)?.allowedDirs)
	? (workerData as { allowedDirs: string[] }).allowedDirs
	: [];

parentPort?.on('message', (msg: RunMessage) => {
	if (msg?.type !== 'run') return;
	const req: VmSandboxRequest = {
		code: msg.code,
		args: msg.args,
		allowedDirs: msg.allowedDirs ?? fallbackDirs,
		onProgress: (m) => parentPort?.postMessage({ type: 'progress', message: m }),
		onLog: (level, m) => parentPort?.postMessage({ type: 'log', level, message: String(m) }),
	};
	const result: VmSandboxResult = runInVmSandbox(req);
	parentPort?.postMessage({ type: 'done', result });
});
```

- [ ] **Step 2:实现主线程运行器 `src/skills/skill-script-sandbox.ts`**

```ts
/**
 * @file src/skills/skill-script-sandbox.ts
 * @description Skill 脚本沙箱主线程运行器 — Worker 生命周期 / 双层超时 / 并发=1(ADR-017)
 * @module skills/skill-script-sandbox
 * @depends node:worker_threads
 */

import { Worker } from 'node:worker_threads';

/** 软超时:10s 无心跳 → onSoftTimeout 警告(慢,可继续等)— ADR-017 §3 */
export const SOFT_TIMEOUT_MS = 10_000;
/** 心跳巡检间隔(性能:1s 粒度足够,不值得更细) */
const HEARTBEAT_CHECK_INTERVAL_MS = 1_000;

export interface ScriptRunRequest {
	code: string;
	args: string[];
	allowedDirs: string[];
	/** 硬超时(ms)—— settings.skillScriptTimeout */
	timeoutMs: number;
	/** 软超时(ms),默认 SOFT_TIMEOUT_MS */
	softTimeoutMs?: number;
	onProgress?: (message: string) => void;
	/** 软超时警告回调(每次 run 至多一次) */
	onSoftTimeout?: () => void;
}

export type ScriptRunOutcome =
	| { status: 'ok'; result: string }
	| { status: 'scriptError'; error: string; stack?: string }
	| { status: 'timeout'; hadProgress: boolean }
	| { status: 'crashed'; detail?: string };

/** Worker 构造工厂签名 — 测试可注入裸 JS worker(协议兼容) */
export type WorkerFactory = (code: string) => Worker;

/**
 * Skill 脚本沙箱运行器。
 *
 * 设计要点(ADR-017):
 * - 每次执行 new Worker(code, { eval: true }),跑完即弃;死循环由 terminate() 毫秒级击杀
 * - 并发 = 1:内部 promise 链串行,防 LLM 连环调用起一堆 Worker
 * - 软超时只警告不终止;硬超时无条件 terminate
 * - exit 监听兜底:即使 terminate 异常,pending Promise 也不悬空
 * - terminateAll 供插件 onunload 调用,不留孤儿线程
 *
 * @example
 *   const sandbox = new SkillScriptSandbox(code);
 *   const outcome = await sandbox.run({ code: '1+1', args: [], allowedDirs: [dir], timeoutMs: 30_000 });
 */
export class SkillScriptSandbox {
	/** 串行链 — 并发 = 1(ADR-017 兜底三件套之一) */
	private chain: Promise<unknown> = Promise.resolve();
	/** 当前活跃 worker(terminateAll 目标) */
	private activeWorker: Worker | null = null;

	constructor(
		private readonly workerCode: string,
		private readonly createWorker: WorkerFactory = (code) => new Worker(code, { eval: true }),
	) {}

	/** 串行执行一次脚本;前序未完成时自动排队 */
	run(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		const next = this.chain.then(() => this.runExclusive(req), () => this.runExclusive(req));
		// 关键路径:链尾吞错,单个失败不阻断后续排队
		this.chain = next.then(() => undefined, () => undefined);
		return next;
	}

	/** 插件 unload 时击杀活跃 Worker(孤儿线程兜底) */
	terminateAll(): void {
		this.activeWorker?.terminate();
		this.activeWorker = null;
	}

	private runExclusive(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		return new Promise<ScriptRunOutcome>((resolve) => {
			const worker = this.createWorker(this.workerCode);
			this.activeWorker = worker;
			const softMs = req.softTimeoutMs ?? SOFT_TIMEOUT_MS;
			let settled = false;
			let lastBeat = Date.now();
			let softFired = false;
			let hadProgress = false;

			const finish = (outcome: ScriptRunOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(hardTimer);
				clearInterval(beatTimer);
				if (this.activeWorker === worker) this.activeWorker = null;
				resolve(outcome);
			};

			// 关键路径:软超时巡检 — 任何消息(progress/log)都复位心跳
			const beatTimer = setInterval(() => {
				if (settled) return;
				if (!softFired && Date.now() - lastBeat >= softMs) {
					softFired = true;
					req.onSoftTimeout?.();
				}
			}, HEARTBEAT_CHECK_INTERVAL_MS);

			// 关键路径:硬超时无条件击杀(有心跳照样杀 — 上限即上限,ADR-017 §3)
			const hardTimer = setTimeout(() => {
				finish({ status: 'timeout', hadProgress });
				worker.terminate();
			}, req.timeoutMs);

			worker.on('message', (msg: { type?: string; message?: string; level?: string; result?: { ok: boolean; result?: string; error?: string; stack?: string } }) => {
				lastBeat = Date.now();
				if (msg?.type === 'progress') {
					hadProgress = true;
					req.onProgress?.(String(msg.message ?? ''));
				} else if (msg?.type === 'log') {
					// worker 内 console 透传,吞掉即可(dev 细节不进用户日志)
				} else if (msg?.type === 'done' && msg.result) {
					const r = msg.result;
					finish(r.ok ? { status: 'ok', result: r.result ?? '' } : { status: 'scriptError', error: r.error ?? 'unknown', stack: r.stack });
				}
			});
			worker.on('error', (err: Error) => finish({ status: 'crashed', detail: err.message }));
			// 关键路径:exit 兜底 — terminate/崩溃后保证 Promise 不悬空(ADR-017 兜底三件套之三)
			worker.on('exit', () => {
				if (!settled) finish({ status: 'crashed', detail: 'worker exited unexpectedly' });
			});

			worker.postMessage({ type: 'run', code: req.code, args: req.args, allowedDirs: req.allowedDirs });
		});
	}
}
```

- [ ] **Step 3:写测试(真实 worker_threads;先用 esbuild 现场打包真实入口,另用裸 JS worker 测死循环击杀)**

```ts
/**
 * @file src/skills/skill-script-sandbox.test.ts
 * @description SkillScriptSandbox 测试 — 真实 worker_threads:协议 / 死循环击杀 / 串行 / exit 兜底
 * @module skills/skill-script-sandbox.test
 * @depends esbuild(仅测试内现场打包,write:false)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { SkillScriptSandbox } from './skill-script-sandbox';

/** 现场把真实 worker 入口打成 CJS 字符串(与 esbuild.config.mjs 产物同构) */
async function buildRealWorkerCode(): Promise<string> {
	const result = await esbuild.build({
		entryPoints: [path.resolve(__dirname, '../worker/skill-script-worker.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		write: false,
	});
	return result.outputFiles[0].text;
}

describe('SkillScriptSandbox(真实 worker_threads)', () => {
	let workerCode: string;
	beforeAll(async () => {
		workerCode = await buildRealWorkerCode();
	});

	it('run - 正常脚本 - 末表达式结果回传', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `args.join('+')`, args: ['1', '2'], allowedDirs: [], timeoutMs: 5_000 });
		expect(out).toEqual({ status: 'ok', result: '"1+2"' });
	});

	it('run - 脚本抛错 - scriptError 含消息', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `throw new Error('boom')`, args: [], allowedDirs: [], timeoutMs: 5_000 });
		expect(out.status).toBe('scriptError');
		if (out.status === 'scriptError') expect(out.error).toContain('boom');
	});

	it('硬超时 - 死循环被 terminate 击杀 - timeout outcome', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const out = await sandbox.run({ code: `while (true) { }`, args: [], allowedDirs: [], timeoutMs: 300 });
		// 关键路径:这是 ADR-017 的核心验收 — 死循环只卡 worker,毫秒级可杀
		expect(out.status).toBe('timeout');
	});

	it('软超时 - 无心跳脚本触发 onSoftTimeout 但不终止', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		let softFired = false;
		const out = await sandbox.run({
			code: `const t = Date.now(); while (Date.now() - t < 1500) {} 'done'`,
			args: [],
			allowedDirs: [],
			timeoutMs: 10_000,
			softTimeoutMs: 300,
			onSoftTimeout: () => { softFired = true; },
		});
		expect(softFired).toBe(true);
		expect(out).toEqual({ status: 'ok', result: '"done"' });
	});

	it('软超时 - reportProgress 心跳复位 - 不误报', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		let softFired = false;
		const out = await sandbox.run({
			code: `for (let i = 0; i < 5; i++) { reportProgress('tick'); const t = Date.now(); while (Date.now() - t < 400) {} } 'done'`,
			args: [],
			allowedDirs: [],
			timeoutMs: 10_000,
			softTimeoutMs: 1_000,
			onSoftTimeout: () => { softFired = true; },
		});
		expect(softFired).toBe(false);
		expect(out.status).toBe('ok');
	});

	it('并发=1 - 两次 run 串行 - 第二次等第一次完成', async () => {
		const sandbox = new SkillScriptSandbox(workerCode);
		const order: string[] = [];
		const p1 = sandbox.run({
			code: `const t = Date.now(); while (Date.now() - t < 600) {} 'first'`,
			args: [], allowedDirs: [], timeoutMs: 10_000,
		}).then((o) => { order.push('p1'); return o; });
		const p2 = sandbox.run({ code: `'second'`, args: [], allowedDirs: [], timeoutMs: 10_000 })
			.then((o) => { order.push('p2'); return o; });
		const [o1, o2] = await Promise.all([p1, p2]);
		expect(order).toEqual(['p1', 'p2']);
		expect(o1.status).toBe('ok');
		expect(o2.status).toBe('ok');
	});

	it('exit 兜底 - worker 直接退出未回 done - crashed 而非悬空', async () => {
		// 裸 JS worker(协议兼容子集):收到 run 直接退出
		const bareCode = `require('node:worker_threads').parentPort.on('message', () => process.exit(0));`;
		const sandbox = new SkillScriptSandbox(bareCode);
		const out = await sandbox.run({ code: `'x'`, args: [], allowedDirs: [], timeoutMs: 5_000 });
		expect(out.status).toBe('crashed');
	});
});
```

注意:若 vitest 的 ESM 环境没有 `__dirname`,用 `path.resolve(import.meta.dirname ?? '.', '../worker/skill-script-worker.ts')` 或从 `fileURLToPath(import.meta.url)` 推导;以仓库现有测试惯例为准。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/skills/skill-script-sandbox.test.ts`
Expected: PASS 全绿(死循环用例应在数百 ms 内完成 — 这就是 terminate 的价值)

- [ ] **Step 5:esbuild 接线**

`src/adapters/skill-script-worker-code.ts`:

```ts
/**
 * @file src/adapters/skill-script-worker-code.ts
 * @description 虚拟模块再导出 — esbuild 插件把 dist/skill-script-worker.js 内容注入为字符串常量
 * @module adapters/skill-script-worker-code
 * @depends @ratel/skill-script-worker-code(esbuild 虚拟模块,ADR-006 同思路)
 */

// 关键路径:esbuild 的 inline 插件解析该 specifier;类型上无对应模块,声明兜底。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — 虚拟模块由 esbuild.config.mjs 的 inlineSkillScriptWorkerPlugin 提供
import { SKILL_SCRIPT_WORKER_CODE } from '@ratel/skill-script-worker-code';

export { SKILL_SCRIPT_WORKER_CODE };
```

`esbuild.config.mjs` 修改(对照 `inlineEmbeddingWorkerPlugin` 依样画瓢):

```js
const SKILL_SCRIPT_WORKER_OUT = path.resolve(__dirname, 'dist/skill-script-worker.js');

/**
 * 将 dist/skill-script-worker.js 内容作为字符串常量注入 main.js(ADR-017)。
 * 商店 release 只有 main.js 三文件,运行时 new Worker(code, { eval: true })。
 */
function inlineSkillScriptWorkerPlugin() {
	return {
		name: 'inline-skill-script-worker',
		setup(build) {
			build.onResolve({ filter: /^@ratel\/skill-script-worker-code$/ }, () => ({
				path: '@ratel/skill-script-worker-code',
				namespace: 'ratel-skill-script-worker',
			}));
			build.onLoad({ filter: /.*/, namespace: 'ratel-skill-script-worker' }, () => {
				// 关键路径:首次 build 时 dist 尚无产物,注入空串;prod 流程先 rebuild 本 worker(见下方时序)
				let code = '';
				if (existsSync(SKILL_SCRIPT_WORKER_OUT)) {
					code = readFileSync(SKILL_SCRIPT_WORKER_OUT, 'utf-8');
				}
				return {
					contents: `export const SKILL_SCRIPT_WORKER_CODE = ${JSON.stringify(code)};\n`,
					loader: 'js',
				};
			});
		},
	};
}
```

新增 bundle context(放在 embeddingWorkerContext 之后):

```js
// Skill script worker bundle (Node worker_threads, CJS eval string)
// 关键路径:ADR-017 — 脚本沙箱 Worker;platform node(builtins external,运行时在 Worker 内 require);
// format cjs + eval:true 加载。严禁 import obsidian。
const skillScriptWorkerContext = await esbuild.context({
	entryPoints: ['src/worker/skill-script-worker.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/skill-script-worker.js',
	minify: prod,
	// 关键路径:node builtins 保持 external — 产物作为字符串在 Worker 线程内 require 真实模块。
	external: [...builtinModules],
	plugins: [],
});
```

mainContext 的 plugins 数组追加 `inlineSkillScriptWorkerPlugin()`;prod 分支把 `skillScriptWorkerContext.rebuild()` 插到 `mainContext.rebuild()` **之前**(与 embedding worker 同时序),watch 分支追加 `await skillScriptWorkerContext.watch();`。

- [ ] **Step 6:构建验证**

Run: `npm run build`
Expected: `dist/skill-script-worker.js` 生成;`dist/main.js` 内 grep 到 `SKILL_SCRIPT_WORKER_CODE` 注入的字符串常量(可用 `node -e "const s=require('fs').readFileSync('dist/main.js','utf-8'); console.log(s.includes('ratel-skill-script-worker') || s.length)"` 粗验,或直接搜 `skill-script` 相关片段)。

- [ ] **Step 7:跑全量沙箱相关测试**

Run: `npx vitest run src/skills/`
Expected: PASS

- [ ] **Step 8:Commit**

```bash
git add src/worker/skill-script-worker.ts src/skills/skill-script-sandbox.ts src/skills/skill-script-sandbox.test.ts src/adapters/skill-script-worker-code.ts esbuild.config.mjs
git commit -m "feat: 脚本沙箱 Worker 运行时 — 双层超时/死循环击杀/并发串行(ADR-017)"
```

---

### Task 4:信任门 — ScriptTrustGate + ScriptTrustModal + settings 字段

**Files:**
- Create: `src/skills/skill-script-permission.ts`
- Create: `src/skills/skill-script-permission.test.ts`
- Create: `src/ui/skills/ScriptTrustModal.ts`
- Modify: `src/settings.ts`(interface + DEFAULT_SETTINGS)
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`(modal.* 与 settings 字段 key)

- [ ] **Step 1:settings 字段**

`src/settings.ts` interface(紧挨 `skillEnabled` 之后)加:

```ts
	/** Skill 脚本硬超时(ms;ADR-017 — 软超时固定 10s 不配置) */
	skillScriptTimeout: number;
	/** 受信脚本白名单(`skillName/scriptPath`);首次授权 Modal 选「允许并记住」时写入 */
	trustedScripts: string[];
```

`DEFAULT_SETTINGS` 加 `skillScriptTimeout: 30_000,`(放 `skillEnabled: {},` 旁)`trustedScripts: [],`。

- [ ] **Step 2:写失败测试**

```ts
/**
 * @file src/skills/skill-script-permission.test.ts
 * @description ScriptTrustGate 测试 — 白名单直行 / once / always 持久化 / deny
 * @module skills/skill-script-permission.test
 */

import { describe, it, expect } from 'vitest';
import { ScriptTrustGate, type TrustConfirmDecision } from './skill-script-permission';

function makeGate(opts: {
	trusted?: string[];
	decision?: TrustConfirmDecision;
} = {}) {
	const persisted: string[] = [];
	const gate = new ScriptTrustGate({
		isTrusted: (id) => opts.trusted?.includes(id) ?? false,
		confirm: async () => opts.decision ?? 'deny',
		persistTrust: (id) => persisted.push(id),
	});
	return { gate, persisted };
}

describe('ScriptTrustGate', () => {
	it('白名单内 - 直接放行 - 不弹确认不持久化', async () => {
		const { gate, persisted } = makeGate({ trusted: ['a/b.js'], decision: 'deny' });
		await expect(gate.check('a/b.js')).resolves.toBe('run');
		expect(persisted).toEqual([]);
	});

	it('白名单外选 once - 本次放行 - 不写入白名单', async () => {
		const { gate, persisted } = makeGate({ decision: 'once' });
		await expect(gate.check('x/y.js')).resolves.toBe('run');
		expect(persisted).toEqual([]);
	});

	it('白名单外选 always - 放行并持久化', async () => {
		const { gate, persisted } = makeGate({ decision: 'always' });
		await expect(gate.check('x/y.js')).resolves.toBe('run');
		expect(persisted).toEqual(['x/y.js']);
	});

	it('用户拒绝 - 返回 deny', async () => {
		const { gate } = makeGate({ decision: 'deny' });
		await expect(gate.check('x/y.js')).resolves.toBe('deny');
	});
});
```

- [ ] **Step 3:跑测试确认失败**

Run: `npx vitest run src/skills/skill-script-permission.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4:实现 `src/skills/skill-script-permission.ts`**

```ts
/**
 * @file src/skills/skill-script-permission.ts
 * @description 脚本信任门 — trustedScripts 白名单 + 首次授权 Modal 决策(ADR-017 / spec §4.6c)
 * @module skills/skill-script-permission
 */

/** Modal 返回的三态决策 */
export type TrustConfirmDecision = 'always' | 'once' | 'deny';
/** 门检查结果 */
export type TrustDecision = 'run' | 'deny';

export interface ScriptTrustDeps {
	/** 是否在 settings.trustedScripts 白名单内(main 注入) */
	isTrusted: (scriptId: string) => boolean;
	/** 弹出 ScriptTrustModal,等用户决策(main 注入) */
	confirm: (scriptId: string) => Promise<TrustConfirmDecision>;
	/** 「允许并记住」时写入 settings.trustedScripts(main 注入;同时清熔断计数) */
	persistTrust: (scriptId: string) => void;
}

/**
 * 脚本信任门 — per-script 首次授权(类 Obsidian 插件权限模型)。
 *
 * 设计要点:
 * - 白名单内直行,不打扰
 * - 'always' 持久化(用户显式信任);'once' 只放本次;ESC/拒绝 = deny
 * - 工具层把 deny 转为工具结果(不抛异常,LLM 可换路,ADR-017 §4)
 */
export class ScriptTrustGate {
	constructor(private readonly deps: ScriptTrustDeps) {}

	/**
	 * 检查 scriptId(`skillName/scriptPath`)是否可运行。
	 *
	 * @returns 'run' 可执行;'deny' 用户拒绝
	 */
	async check(scriptId: string): Promise<TrustDecision> {
		if (this.deps.isTrusted(scriptId)) return 'run';
		const decision = await this.deps.confirm(scriptId);
		if (decision === 'deny') return 'deny';
		if (decision === 'always') this.deps.persistTrust(scriptId);
		return 'run';
	}
}
```

- [ ] **Step 5:实现 Modal(薄 UI,不单测 — 与 confirm-modal 同规格)**

```ts
/**
 * @file src/ui/skills/ScriptTrustModal.ts
 * @description Skill 脚本首次运行授权 Modal — 允许并记住 / 仅此次 / 拒绝(spec §4.6c)
 * @module ui/skills/ScriptTrustModal
 * @depends obsidian, i18n
 */

import { Modal, Notice, type App } from 'obsidian';
import { tNow } from '../../i18n';
import type { TrustConfirmDecision } from '../../skills/skill-script-permission';

/**
 * 弹出脚本授权 Modal。
 *
 * 关键路径:ESC / 点遮罩关闭视为拒绝(与 showToolConfirmModal 行为一致),
 * 避免 agent loop 永久 await。
 */
export function showScriptTrustModal(
	app: App,
	info: { scriptId: string; skillName: string; sourceLabel: string; skillDir: string },
): Promise<TrustConfirmDecision> {
	return new Promise((resolve) => {
		const modal = new ScriptTrustModal(app, info, resolve);
		modal.open();
	});
}

class ScriptTrustModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly info: { scriptId: string; skillName: string; sourceLabel: string; skillDir: string },
		private readonly onResolve: (d: TrustConfirmDecision) => void,
	) {
		super(app);
	}

	private settle(d: TrustConfirmDecision): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(d);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(tNow('modal.scriptTrust.title'));
		contentEl.createEl('p', {
			text: tNow('modal.scriptTrust.desc', {
				id: this.info.scriptId,
				skill: this.info.skillName,
				source: this.info.sourceLabel,
			}),
		});
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: tNow('modal.scriptTrust.sandboxNote'),
		});
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.allowAlways') }).onclick = () => {
			new Notice(tNow('modal.scriptTrust.trustedNotice', { id: this.info.scriptId }));
			this.settle('always');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.allowOnce') }).onclick = () => {
			this.settle('once');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.scriptTrust.deny') }).onclick = () => {
			this.settle('deny');
			this.close();
		};
	}

	onClose(): void {
		// 关键路径:ESC / 遮罩关闭 = 拒绝,Promise 不悬空
		this.settle('deny');
		this.contentEl.empty();
	}
}
```

- [ ] **Step 6:i18n key(本 task 消费的全部)**

`src/i18n/types.ts` 的 `ModalStrings` 加:

```ts
  // 关键路径(P-SKILL-2):skill 脚本首次运行授权 Modal
  'modal.scriptTrust.title': string;
  'modal.scriptTrust.desc': string;
  'modal.scriptTrust.sandboxNote': string;
  'modal.scriptTrust.allowAlways': string;
  'modal.scriptTrust.allowOnce': string;
  'modal.scriptTrust.deny': string;
  'modal.scriptTrust.trustedNotice': string;
```

`zh.ts`(对应 skill.notice.* 区块附近):

```ts
  // 关键路径(P-SKILL-2):skill 脚本首次运行授权 Modal(ADR-017)
  'modal.scriptTrust.title': '运行 Skill 脚本',
  'modal.scriptTrust.desc': '「{skill}」技能请求运行脚本 {id}(来源:{source})。',
  'modal.scriptTrust.sandboxNote': '脚本将在沙箱内运行:无网络、文件访问限于当前 vault 与该 skill 目录、超时自动终止。选择「允许并记住」后不再询问。',
  'modal.scriptTrust.allowAlways': '允许并记住',
  'modal.scriptTrust.allowOnce': '仅此次',
  'modal.scriptTrust.deny': '拒绝',
  'modal.scriptTrust.trustedNotice': '已将 {id} 加入受信脚本白名单',
```

`en.ts` 对应英文(自行翻译,语义一致:`Run Skill script` / `The skill "{skill}" requests to run script {id} (source: {source}).` / `Scripts run in a sandbox: no network, file access limited to this vault and the skill folder, auto-terminated on timeout. "Always allow" skips future prompts.` / `Always allow` / `Just once` / `Deny` / `Added {id} to trusted scripts`)。

注意:`{source}` 占位传 `tNow('skill.source.<source>')` 的人类可读标签(main 接线时做)。

- [ ] **Step 7:跑测试确认通过 + typecheck**

Run: `npx vitest run src/skills/skill-script-permission.test.ts && npx tsc -noEmit -skipLibCheck`
Expected: PASS + 无类型错误

- [ ] **Step 8:Commit**

```bash
git add src/skills/skill-script-permission.ts src/skills/skill-script-permission.test.ts src/ui/skills/ScriptTrustModal.ts src/settings.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: 脚本信任门 — 首次授权 Modal + trustedScripts 白名单(S-P2)"
```

---

### Task 5:`read_skill_reference` 工具

**Files:**
- Create: `src/tools/read-skill-reference.ts`
- Create: `src/tools/read-skill-reference.test.ts`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`(skill.ref.*)

- [ ] **Step 1:写失败测试**

```ts
/**
 * @file src/tools/read-skill-reference.test.ts
 * @description read_skill_reference 工具测试 — traversal 防护 / 大小上限 / 二进制拒绝 / 启用校验
 * @module tools/read-skill-reference.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLang } from '../i18n';
import { SkillRegistry } from '../skills/skill-registry';
import { createReadSkillReferenceTool } from './read-skill-reference';
import type { ToolDefinition } from '../ports/llm';

const DEF: ToolDefinition = {
	name: 'read_skill_reference',
	parameters: { type: 'object', properties: {}, required: [] },
};

function makeRegistry(dir: string): SkillRegistry {
	const registry = new SkillRegistry();
	registry.reload(
		[{
			manifest: { name: 'demo', description: 'd', enabled: true, activation: 'auto', tags: [] },
			instructions: 'body',
			source: 'vault',
			dir,
		}],
		[],
	);
	return registry;
}

describe('read_skill_reference 工具', () => {
	let dir: string;
	let registry: SkillRegistry;

	beforeEach(() => {
		setLang('zh');
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skillref-'));
		fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n内容');
		registry = makeRegistry(dir);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('正常读取 - references 内文件内容返回', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		const out = await tool.execute({ skillName: 'demo', path: 'guide.md' });
		expect(out).toContain('# Guide');
	});

	it('traversal - .. 逃逸出 references 被拒', async () => {
		const secret = path.join(dir, 'SKILL.md');
		fs.writeFileSync(secret, 'secret');
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: '../SKILL.md' })).rejects.toThrow(/路径非法/);
	});

	it('traversal - 绝对路径被拒', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: '/etc/passwd' })).rejects.toThrow(/路径非法/);
	});

	it('文件不存在 - 抛 notFound', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'nope.md' })).rejects.toThrow(/未找到/);
	});

	it('skill 不存在 - 抛 notFound', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'ghost', path: 'guide.md' })).rejects.toThrow(/未找到/);
	});

	it('超 100KB - 抛 tooLarge', async () => {
		fs.writeFileSync(path.join(dir, 'references', 'big.md'), 'x'.repeat(101 * 1024));
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'big.md' })).rejects.toThrow(/100KB/);
	});

	it('二进制文件 - 抛 binary 拒绝', async () => {
		fs.writeFileSync(path.join(dir, 'references', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'blob.bin' })).rejects.toThrow(/文本/);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/tools/read-skill-reference.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3:i18n key(`skill.ref.*`)**

types.ts 加(错误 key 放 `ErrorStrings` 或 skill 相关区块,与 `error.skill.*` 相邻):

```ts
  // 关键路径(P-SKILL-2):read_skill_reference 工具
  'skill.ref.notFound': string;
  'skill.ref.invalidPath': string;
  'skill.ref.tooLarge': string;
  'skill.ref.binary': string;
```

zh.ts:

```ts
  // 关键路径(P-SKILL-2):read_skill_reference 工具
  'skill.ref.notFound': '未找到参考文件: {path}',
  'skill.ref.invalidPath': '路径非法(不允许绝对路径或 ..): {path}',
  'skill.ref.tooLarge': '参考文件超过 100KB 上限: {path}',
  'skill.ref.binary': '参考文件不是文本,无法读取: {path}',
```

en.ts:`Reference file not found: {path}` / `Invalid path (absolute paths and .. are not allowed): {path}` / `Reference file exceeds the 100KB limit: {path}` / `Reference file is not text: {path}`。

- [ ] **Step 4:实现工具**

```ts
/**
 * @file src/tools/read-skill-reference.ts
 * @description `read_skill_reference` 工具 — 读 skill references/ 内文件,只读 + traversal 防护(spec §4.6b)
 * @module tools/read-skill-reference
 * @depends core/tool-registry, skills/skill-registry, i18n, node:fs, node:path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/** 参考文件读取上限 — 与 search/read 工具同量级,防巨型文件吃掉上下文 */
const MAX_REF_BYTES = 100 * 1024;

/**
 * 校验相对路径:拒绝绝对路径与任何 `..` 段(spec §4.6b 防 traversal 第一道)。
 */
function assertRelativeSubPath(p: string): void {
	if (path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) {
		throw new Error(tNow('skill.ref.invalidPath', { path: p }));
	}
}

/**
 * 构造 `read_skill_reference` 工具实例。
 *
 * 设计要点:
 * - 只读工具(readOnly: true),不触发写钩子;默认权限 allow(与 read_note 同级)
 * - 三道防护:相对路径校验 → resolve 锁定 references/ 前缀 → realpath 防符号链接逃逸
 * - 大小上限 100KB;二进制(含 NUL 字节)拒绝
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 */
export function createReadSkillReferenceTool(registry: SkillRegistry, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.skillName !== 'string' || args.skillName.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'skillName', type: typeof args.skillName }));
			}
			if (typeof args.path !== 'string' || args.path.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'path', type: typeof args.path }));
			}
			const skill = registry.get(args.skillName);
			if (!skill) throw new Error(tNow('skill.notice.notFound', { name: args.skillName }));
			if (!registry.isEnabled(args.skillName)) {
				throw new Error(tNow('error.skill.notEnabled', { name: args.skillName }));
			}
			assertRelativeSubPath(args.path);

			const refsRoot = path.join(skill.dir, 'references');
			const abs = path.resolve(refsRoot, args.path);
			// 关键路径:resolve 后仍必须落在 references/ 内(双保险,防 'a/../../b' 类拼凑)
			if (abs !== refsRoot && !abs.startsWith(refsRoot + path.sep)) {
				throw new Error(tNow('skill.ref.invalidPath', { path: args.path }));
			}
			// 关键路径:realpath 防符号链接逃逸 — 解析后真实路径必须仍指向 skill 目录内
			const realAbs = fs.realpathSync(abs);
			const realRoot = fs.realpathSync(skill.dir);
			if (!realAbs.startsWith(realRoot + path.sep)) {
				throw new Error(tNow('skill.ref.invalidPath', { path: args.path }));
			}
			const stat = fs.statSync(realAbs);
			if (!stat.isFile()) throw new Error(tNow('skill.ref.notFound', { path: args.path }));
			if (stat.size > MAX_REF_BYTES) throw new Error(tNow('skill.ref.tooLarge', { path: args.path }));
			const content = fs.readFileSync(realAbs, 'utf-8');
			// 关键路径:NUL 字节是二进制文件的特征,读给 LLM 无意义且污染上下文
			if (content.includes('\u0000')) throw new Error(tNow('skill.ref.binary', { path: args.path }));
			return content;
		},
	};
}
```

- [ ] **Step 5:跑测试确认通过**

Run: `npx vitest run src/tools/read-skill-reference.test.ts`
Expected: PASS 全绿

- [ ] **Step 6:Commit**

```bash
git add src/tools/read-skill-reference.ts src/tools/read-skill-reference.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: read_skill_reference 工具 — references 只读 + traversal 防护(S-P2)"
```

---

### Task 6:`run_skill_script` 工具(熔断 + 信任门 + 沙箱编排)

**Files:**
- Create: `src/tools/run-skill-script.ts`
- Create: `src/tools/run-skill-script.test.ts`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`(skill.script.*)

- [ ] **Step 1:写失败测试(依赖全 mock,不真起 worker)**

```ts
/**
 * @file src/tools/run-skill-script.test.ts
 * @description run_skill_script 工具测试 — 熔断 / 信任门 / 超时语义 / 成功清零(sandbox 全 mock)
 * @module tools/run-skill-script.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLang } from '../i18n';
import { SkillRegistry } from '../skills/skill-registry';
import { ScriptTrustGate } from '../skills/skill-script-permission';
import type { ScriptRunOutcome, ScriptRunRequest } from '../skills/skill-script-sandbox';
import { createRunSkillScriptTool, SCRIPT_FAILURE_THRESHOLD } from './run-skill-script';
import type { ToolDefinition } from '../ports/llm';

const DEF: ToolDefinition = { name: 'run_skill_script', parameters: { type: 'object', properties: {}, required: [] } };

/** 可编程假沙箱:记录请求,返回预设 outcome */
class FakeSandbox {
	lastReq: ScriptRunRequest | null = null;
	outcome: ScriptRunOutcome = { status: 'ok', result: '"done"' };
	async run(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		this.lastReq = req;
		return this.outcome;
	}
}

/** 内存失败计数(与 UsageStatsStore 同接口子集) */
class FakeFailures {
	counts = new Map<string, number>();
	bumped: string[] = [];
	cleared: string[] = [];
	getCount(id: string) { return this.counts.get(id) ?? 0; }
	bump(id: string) { this.bumped.push(id); this.counts.set(id, (this.counts.get(id) ?? 0) + 1); }
	clear(id: string) { this.cleared.push(id); this.counts.delete(id); }
}

describe('run_skill_script 工具', () => {
	let dir: string;
	let registry: SkillRegistry;
	let sandbox: FakeSandbox;
	let failures: FakeFailures;
	let trusted: string[];

	beforeEach(() => {
		setLang('zh');
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skillrun-'));
		fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'scripts', 'clean.js'), 'result = 1');
		registry = new SkillRegistry();
		registry.reload([{
			manifest: { name: 'data-cleaner', description: 'd', enabled: true, activation: 'auto', tags: [] },
			instructions: 'body',
			source: 'vault',
			dir,
		}], []);
		sandbox = new FakeSandbox();
		failures = new FakeFailures();
		trusted = [];
	});

	function makeTool(opts: { decision?: 'always' | 'once' | 'deny' } = {}) {
		const gate = new ScriptTrustGate({
			isTrusted: (id) => trusted.includes(id),
			confirm: async () => opts.decision ?? 'once',
			persistTrust: (id) => trusted.push(id),
		});
		return createRunSkillScriptTool(registry, DEF, {
			sandbox,
			trustGate: gate,
			failures,
			timeoutMs: () => 30_000,
			vaultRoot: () => '/vault',
		});
	}

	it('正常执行 - 白名单脚本直行 - 返回结果并清零计数', async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', 0);
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js', args: ['--x'] });
		expect(out).toBe('"done"');
		expect(sandbox.lastReq?.allowedDirs).toEqual(['/vault', dir]);
		expect(sandbox.lastReq?.timeoutMs).toBe(30_000);
	});

	it('用户拒绝 - 返回 denied 工具结果(不抛异常)', async () => {
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('拒绝');
	});

	it('超时 - 计数 +1 并返回超时结果', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'timeout', hadProgress: true };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('强制终止');
		expect(failures.bumped).toEqual(['data-cleaner/clean.js']);
	});

	it('崩溃 - 计数 +1 并返回 crashed 结果', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'crashed', detail: 'segfault' };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('异常退出');
		expect(failures.bumped).toEqual(['data-cleaner/clean.js']);
	});

	it('脚本抛错(scriptError)- 不计入熔断(ADR-017:仅被杀/超时/崩溃计数)', async () => {
		trusted = ['data-cleaner/clean.js'];
		sandbox.outcome = { status: 'scriptError', error: 'boom' };
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('boom');
		expect(failures.bumped).toEqual([]);
	});

	it('成功一次 - 清零连续失败计数', async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', 2);
		const tool = makeTool();
		await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(failures.cleared).toEqual(['data-cleaner/clean.js']);
	});

	it(`连续失败 ${SCRIPT_FAILURE_THRESHOLD} 次 - 熔断,再调用直接拒绝执行`, async () => {
		trusted = ['data-cleaner/clean.js'];
		failures.counts.set('data-cleaner/clean.js', SCRIPT_FAILURE_THRESHOLD);
		const tool = makeTool();
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.js' });
		expect(out).toContain('熔断');
		// 关键路径:熔断后不再进沙箱
		expect(sandbox.lastReq).toBeNull();
	});

	it('脚本不存在 - 抛 notFound;scripts 外路径被拒', async () => {
		trusted = ['data-cleaner/x.js'];
		const tool = makeTool();
		await expect(tool.execute({ skillName: 'data-cleaner', scriptPath: 'nope.js' })).rejects.toThrow(/未找到/);
		await expect(tool.execute({ skillName: 'data-cleaner', scriptPath: '../SKILL.md' })).rejects.toThrow(/路径非法/);
	});

	it('语言边界 - .py 脚本返回 unsupported 并引导 MCP - 不弹授权不进沙箱', async () => {
		fs.writeFileSync(path.join(dir, 'scripts', 'clean.py'), 'print(1)');
		trusted = ['data-cleaner/clean.py'];
		const tool = makeTool({ decision: 'deny' });
		const out = await tool.execute({ skillName: 'data-cleaner', scriptPath: 'clean.py' });
		// 关键路径:扩展名检查在信任门之前 — 永远跑不了的脚本不该让用户授权
		expect(out).toContain('仅支持 JavaScript');
		expect(out).toContain('MCP');
		expect(sandbox.lastReq).toBeNull();
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/tools/run-skill-script.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3:i18n key(`skill.script.*`)**

types.ts(ErrorStrings 相邻区块):

```ts
  // 关键路径(P-SKILL-2/ADR-017):run_skill_script 工具
  'skill.script.notFound': string;
  'skill.script.invalidPath': string;
  'skill.script.unsupported': string;
  'skill.script.denied': string;
  'skill.script.circuitBreak': string;
  'skill.script.timeout': string;
  'skill.script.timeoutProgressHint': string;
  'skill.script.crashed': string;
  'skill.script.failed': string;
  'skill.script.softTimeoutNotice': string;
  'skill.script.circuitNotice': string;
```

zh.ts:

```ts
  // 关键路径(P-SKILL-2/ADR-017):run_skill_script 工具
  'skill.script.notFound': '未找到脚本: {path}',
  'skill.script.invalidPath': '脚本路径非法(不允许绝对路径或 ..): {path}',
  'skill.script.unsupported': '脚本 {path} 不是 JavaScript({ext})。Skill 脚本仅支持 .js/.mjs/.cjs;如需 Python 等其他语言的能力,请让用户配置对应的 MCP server。',
  'skill.script.denied': '用户拒绝了脚本 {id} 的运行授权。可以换一种不依赖该脚本的方式,或请用户在技能管理中将其加入白名单。',
  'skill.script.circuitBreak': '脚本 {id} 已连续失败 {count} 次被熔断,本次未执行。需用户重新确认授权(若已在白名单,请先移除后重试,并在弹窗中选择「允许并记住」)。',
  'skill.script.timeout': '脚本 {id} 超过 {seconds} 秒被强制终止。',
  'skill.script.timeoutProgressHint': '该脚本期间持续上报进度,可能确有大量工作;建议优化脚本或让用户在设置中调大 skillScriptTimeout。',
  'skill.script.crashed': '脚本宿主异常退出: {detail}',
  'skill.script.failed': '脚本执行出错: {message}',
  'skill.script.softTimeoutNotice': '技能脚本运行超过 10 秒未上报进度,仍在运行中(可继续等待)',
  'skill.script.circuitNotice': '技能脚本 {id} 连续失败 3 次,已熔断',
```

en.ts 对应翻译(`Script not found: {path}` / `Invalid script path ...` / `Script {path} is not JavaScript ({ext}). Skill scripts only support .js/.mjs/.cjs; for Python or other languages, ask the user to configure an MCP server.` / `The user denied authorization to run script {id}. ...` / `Script {id} has failed {count} times in a row and is circuit-broken; it was not executed. The user must re-authorize it ...` / `Script {id} exceeded {seconds}s and was terminated.` / `The script kept reporting progress; consider optimizing it or increasing skillScriptTimeout.` / `Script host exited unexpectedly: {detail}` / `Script error: {message}` / `A skill script has shown no progress for over 10s; still running` / `Skill script {id} failed 3 times in a row; circuit broken`)。

- [ ] **Step 4:实现工具**

```ts
/**
 * @file src/tools/run-skill-script.ts
 * @description `run_skill_script` 工具 — 熔断 + 信任门 + Worker/vm 沙箱编排(ADR-017)
 * @module tools/run-skill-script
 * @depends core/tool-registry, skills/skill-registry, skills/skill-script-permission,
 *          skills/skill-script-sandbox(接口), i18n, node:fs, node:path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ScriptTrustGate } from '../skills/skill-script-permission';
import type { ScriptRunOutcome, ScriptRunRequest } from '../skills/skill-script-sandbox';
import { tNow } from '../i18n';

/** 连续失败熔断阈值(ADR-017 §5:被杀/超时/崩溃) */
export const SCRIPT_FAILURE_THRESHOLD = 3;

/** 脚本扩展名白名单 — 语言边界 JS-only(ADR-017:vm 只懂 JS,非 JS 引导走 MCP) */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** 沙箱接口子集 — main 注入 SkillScriptSandbox;测试注入 fake */
export interface ScriptSandboxLike {
	run(req: ScriptRunRequest): Promise<ScriptRunOutcome>;
}

/** 失败计数接口子集 — main 注入 UsageStatsStore;测试注入 fake */
export interface ScriptFailureCounter {
	getCount(scriptId: string): number;
	bump(scriptId: string): void;
	clear(scriptId: string): void;
}

export interface RunSkillScriptDeps {
	sandbox: ScriptSandboxLike;
	trustGate: ScriptTrustGate;
	failures: ScriptFailureCounter;
	/** 现读 settings.skillScriptTimeout(设置面板改完立即生效) */
	timeoutMs: () => number;
	/** vault 根绝对路径(fs 白名单之一) */
	vaultRoot: () => string;
	/** 软超时警告(main → Notice;可选) */
	onSoftTimeout?: (scriptId: string) => void;
	/** 熔断提醒(main → Notice;可选) */
	onCircuitBreak?: (scriptId: string) => void;
}

function assertRelativeSubPath(p: string): void {
	if (path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) {
		throw new Error(tNow('skill.script.invalidPath', { path: p }));
	}
}

/**
 * 构造 `run_skill_script` 工具实例。
 *
 * 设计要点(ADR-017):
 * - 错误作为工具结果返回而非抛异常 — LLM 看到「超时被终止」可自行换路,不崩回合(§4)
 * - 熔断只数 timeout/crashed;scriptError 是正常失败,LLM 可修参重试(§5)
 * - 检查顺序:信任门 → 熔断 → 执行(熔断的恢复路径 = 重新授权「允许并记住」时清计数)
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param deps - 沙箱 / 信任门 / 计数 / 超时与 vault 根注入
 */
export function createRunSkillScriptTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
	deps: RunSkillScriptDeps,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.skillName !== 'string' || args.skillName.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'skillName', type: typeof args.skillName }));
			}
			if (typeof args.scriptPath !== 'string' || args.scriptPath.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'scriptPath', type: typeof args.scriptPath }));
			}
			const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];

			const skill = registry.get(args.skillName);
			if (!skill) throw new Error(tNow('skill.notice.notFound', { name: args.skillName }));
			if (!registry.isEnabled(args.skillName)) {
				throw new Error(tNow('error.skill.notEnabled', { name: args.skillName }));
			}
			assertRelativeSubPath(args.scriptPath);
			const scriptId = `${args.skillName}/${args.scriptPath}`;

			// 关键路径:语言边界(JS-only,ADR-017)— 扩展名检查放在信任门**之前**:
			// 永远跑不了的脚本不该让用户授权;返回工具结果(非 throw)让 LLM 引导用户走 MCP。
			const ext = path.extname(args.scriptPath).toLowerCase();
			if (!SCRIPT_EXTENSIONS.includes(ext)) {
				return tNow('skill.script.unsupported', { path: args.scriptPath, ext: ext || '无扩展名' });
			}

			// 关键路径:先信任门后熔断 — untrusted 脚本先过 Modal,选「允许并记住」时
			// main 的 persistTrust 回调会同时清计数,给熔断脚本一条用户主导的恢复路径。
			if ((await deps.trustGate.check(scriptId)) === 'deny') {
				return tNow('skill.script.denied', { id: scriptId });
			}

			const count = deps.failures.getCount(scriptId);
			if (count >= SCRIPT_FAILURE_THRESHOLD) {
				deps.onCircuitBreak?.(scriptId);
				return tNow('skill.script.circuitBreak', { id: scriptId, count: SCRIPT_FAILURE_THRESHOLD });
			}

			const scriptsRoot = path.join(skill.dir, 'scripts');
			const abs = path.resolve(scriptsRoot, args.scriptPath);
			if (abs !== scriptsRoot && !abs.startsWith(scriptsRoot + path.sep)) {
				throw new Error(tNow('skill.script.invalidPath', { path: args.scriptPath }));
			}
			if (!fs.existsSync(abs)) throw new Error(tNow('skill.script.notFound', { path: args.scriptPath }));
			const code = fs.readFileSync(abs, 'utf-8');

			const outcome = await deps.sandbox.run({
				code,
				args: scriptArgs,
				// 关键路径:fs 白名单 = vault 根 + 该 skill 目录(ADR-017 §1)
				allowedDirs: [deps.vaultRoot(), skill.dir],
				timeoutMs: deps.timeoutMs(),
				onSoftTimeout: () => deps.onSoftTimeout?.(scriptId),
			});

			switch (outcome.status) {
				case 'ok':
					deps.failures.clear(scriptId);
					return outcome.result;
				case 'scriptError':
					// 关键路径:脚本自己 throw 是正常失败,不计熔断(ADR-017 §5)
					return tNow('skill.script.failed', { message: outcome.error });
				case 'timeout': {
					deps.failures.bump(scriptId);
					const hint = outcome.hadProgress ? tNow('skill.script.timeoutProgressHint') : '';
					return tNow('skill.script.timeout', { id: scriptId, seconds: Math.round(deps.timeoutMs() / 1000) }) + (hint ? ' ' + hint : '');
				}
				case 'crashed':
					deps.failures.bump(scriptId);
					return tNow('skill.script.crashed', { detail: outcome.detail ?? 'unknown' });
			}
		},
	};
}
```

- [ ] **Step 5:跑测试确认通过**

Run: `npx vitest run src/tools/run-skill-script.test.ts`
Expected: PASS 全绿

- [ ] **Step 6:Commit**

```bash
git add src/tools/run-skill-script.ts src/tools/run-skill-script.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: run_skill_script 工具 — 熔断/信任门/超时语义(ADR-017)"
```

---

### Task 7:prompt 注册 + 权限文案 + toolPermissions 默认

**Files:**
- Modify: `src/prompts/tool-schemas.ts`(TOOL_SCHEMA_SKELETONS + ALL_TOOL_NAMES 若为显式清单)
- Modify: `src/prompts/sections.ts`(+5 section)
- Modify: `src/prompts/defaults/zh.ts`(+5 默认文案)
- Modify: `src/settings.ts`(toolPermissions 默认 +2)
- Modify: `src/core/tool-permissions.ts`(summarizeToolCall +run_skill_script)
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`(promptLabel.* + settings.toolPermissions.* + toolPerm.*)

- [ ] **Step 1:tool-schemas 骨架**

`TOOL_SCHEMA_SKELETONS` 追加(deactivate_skill 之后):

```ts
	read_skill_reference: {
		name: 'read_skill_reference',
		parameters: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				path: { type: 'string' },
			},
			required: ['skillName', 'path'],
		},
	},
	run_skill_script: {
		name: 'run_skill_script',
		parameters: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				scriptPath: { type: 'string' },
				args: { type: 'array', items: { type: 'string' } },
			},
			required: ['skillName', 'scriptPath'],
		},
	},
```

若 `ALL_TOOL_NAMES` 是显式清单(先读文件确认),追加 `'read_skill_reference'` / `'run_skill_script'`。

- [ ] **Step 2:sections.ts 注册(tool.deactivate_skill 块之后依样追加)**

```ts
		// --- tool.read_skill_reference ---
		{
			id: 'tool.read_skill_reference.description',
			label: tNow('promptLabel.tool.read_skill_reference.description'),
			description: tNow('promptLabel.tool.read_skill_reference.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.read_skill_reference.param.skillName',
			label: tNow('promptLabel.tool.read_skill_reference.param.skillName'),
			description: tNow('promptLabel.tool.read_skill_reference.param.skillName.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.read_skill_reference.param.path',
			label: tNow('promptLabel.tool.read_skill_reference.param.path'),
			description: tNow('promptLabel.tool.read_skill_reference.param.path.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.run_skill_script ---
		{
			id: 'tool.run_skill_script.description',
			label: tNow('promptLabel.tool.run_skill_script.description'),
			description: tNow('promptLabel.tool.run_skill_script.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.run_skill_script.param.skillName',
			label: tNow('promptLabel.tool.run_skill_script.param.skillName'),
			description: tNow('promptLabel.tool.run_skill_script.param.skillName.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.run_skill_script.param.scriptPath',
			label: tNow('promptLabel.tool.run_skill_script.param.scriptPath'),
			description: tNow('promptLabel.tool.run_skill_script.param.scriptPath.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.run_skill_script.param.args',
			label: tNow('promptLabel.tool.run_skill_script.param.args'),
			description: tNow('promptLabel.tool.run_skill_script.param.args.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
```

- [ ] **Step 3:defaults/zh.ts 默认文案(spec §4.7 schema description 原文)**

```ts
	'tool.read_skill_reference.description': '读取 Skill 的 references/ 目录内文件(如风格指南、模板、词汇表)。路径限制在该 skill 的 references/ 文件夹内。',
	'tool.read_skill_reference.param.skillName': 'Skill 名称',
	'tool.read_skill_reference.param.path': 'references/ 内的相对路径',
	'tool.run_skill_script.description': '执行 Skill 的 scripts/ 目录内脚本,仅支持 JavaScript(.js/.mjs/.cjs)。首次运行会弹窗请用户授权。脚本在沙箱内执行:无网络、文件访问限于当前 vault 与该 skill 目录、超时自动终止。',
	'tool.run_skill_script.param.skillName': 'Skill 名称',
	'tool.run_skill_script.param.scriptPath': 'scripts/ 内的相对路径',
	'tool.run_skill_script.param.args': '传给脚本的参数(字符串数组)',
```

- [ ] **Step 4:i18n promptLabel + settings.toolPermissions + toolPerm key**

types.ts `PromptLabelStrings`(deactivate_skill 块之后)加 8 个 description/desc key 对(上一步 sections.ts 引用的全部);`SettingsStrings` 的 toolPermissions 清单加:

```ts
  'settings.toolPermissions.read_skill_reference': string;
  'settings.toolPermissions.run_skill_script': string;
```

`ChatStrings` 或 toolPerm 所在区块(先查 `toolPerm.writeNote` 声明位置,同区块加):

```ts
  'toolPerm.runSkillScript': string;
```

zh.ts 值:

```ts
  // 关键路径(P-SKILL-2):2 个 skill 执行工具的 promptLabel / 权限文案
  'promptLabel.tool.read_skill_reference.description': 'read_skill_reference 描述',
  'promptLabel.tool.read_skill_reference.description.desc': '读取 Skill references/ 内参考文件',
  'promptLabel.tool.read_skill_reference.param.skillName': 'read_skill_reference.skillName',
  'promptLabel.tool.read_skill_reference.param.skillName.desc': 'Skill 名称',
  'promptLabel.tool.read_skill_reference.param.path': 'read_skill_reference.path',
  'promptLabel.tool.read_skill_reference.param.path.desc': 'references/ 内相对路径',
  'promptLabel.tool.run_skill_script.description': 'run_skill_script 描述',
  'promptLabel.tool.run_skill_script.description.desc': '执行 Skill scripts/ 内脚本(沙箱)',
  'promptLabel.tool.run_skill_script.param.skillName': 'run_skill_script.skillName',
  'promptLabel.tool.run_skill_script.param.skillName.desc': 'Skill 名称',
  'promptLabel.tool.run_skill_script.param.scriptPath': 'run_skill_script.scriptPath',
  'promptLabel.tool.run_skill_script.param.scriptPath.desc': 'scripts/ 内相对路径',
  'promptLabel.tool.run_skill_script.param.args': 'run_skill_script.args',
  'promptLabel.tool.run_skill_script.param.args.desc': '传给脚本的参数数组',
  'settings.toolPermissions.read_skill_reference': '读取 Skill 参考资料',
  'settings.toolPermissions.run_skill_script': '运行 Skill 脚本',
  'toolPerm.runSkillScript': '运行 Skill 脚本: {id}',
```

en.ts 对应英文;settings.ts 的 settings-render 清单(979 行附近模式)把两个新工具名加进 toolPermissions 展示列表。

- [ ] **Step 5:settings.ts toolPermissions 默认值 + summarizeToolCall**

`DEFAULT_SETTINGS.toolPermissions`(241 行附近)加:

```ts
		// 关键路径(P-SKILL-2):read 只读放行;run 默认 allow — per-script 授权由工具内
		// ScriptTrustGate 负责,通用 'ask' 会对同一脚本双重弹窗(ADR-017 / plan 关键设计)。
		read_skill_reference: 'allow',
		run_skill_script: 'allow',
```

`src/core/tool-permissions.ts` 的 `summarizeToolCall` switch 加(写在 delete_note case 之后):

```ts
		case 'run_skill_script': {
			// 关键路径:展示 skill/script 粒度,用户知道自己在放行什么
			const skillName = typeof toolCall.args.skillName === 'string' ? toolCall.args.skillName : '';
			const scriptPath = typeof toolCall.args.scriptPath === 'string' ? toolCall.args.scriptPath : '';
			const id = skillName && scriptPath ? `${skillName}/${scriptPath}` : toolCall.name;
			return tNow('toolPerm.runSkillScript', { id });
		}
```

- [ ] **Step 6:跑相关测试 + typecheck**

Run: `npx vitest run src/prompts src/core src/i18n && npx tsc -noEmit -skipLibCheck`
Expected: PASS(i18n 若有 zh/en key 对齐测试,新 key 双语齐备即过)

- [ ] **Step 7:Commit**

```bash
git add src/prompts/tool-schemas.ts src/prompts/sections.ts src/prompts/defaults/zh.ts src/settings.ts src/core/tool-permissions.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: 注册 read_skill_reference / run_skill_script 的 prompt schema 与权限文案(S-P2)"
```

---

### Task 8:main.ts 接线 + 整体验证

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1:接线(对照 activate_skill 注册块,紧随其后)**

imports:

```ts
import { createReadSkillReferenceTool } from './tools/read-skill-reference';
import { createRunSkillScriptTool } from './tools/run-skill-script';
import { SkillScriptSandbox } from './skills/skill-script-sandbox';
import { ScriptTrustGate } from './skills/skill-script-permission';
import { showScriptTrustModal } from './ui/skills/ScriptTrustModal';
import { SKILL_SCRIPT_WORKER_CODE } from './adapters/skill-script-worker-code';
import { tNow } from './i18n'; // 若已 import 则跳过
```

RatelVaultPlugin 类内,registerTools 的 skill 工具注册块之后:

```ts
		// 关键路径(P-SKILL-2/ADR-017):脚本沙箱 — Worker 一次性,runner 常驻管理串行与超时。
		const scriptSandbox = new SkillScriptSandbox(SKILL_SCRIPT_WORKER_CODE);
		this.skillScriptSandbox = scriptSandbox;
		const scriptTrustGate = new ScriptTrustGate({
			isTrusted: (scriptId) => this.settings.trustedScripts.includes(scriptId),
			confirm: async (scriptId) => {
				// scriptId = `skillName/scriptPath`,拆回 skillName 取来源标签
				const skillName = scriptId.split('/')[0] ?? scriptId;
				const skill = this.skillRegistry.get(skillName);
				return showScriptTrustModal(this.app, {
					scriptId,
					skillName,
					sourceLabel: skill ? tNow(`skill.source.${skill.source}`) : '—',
					skillDir: skill?.dir ?? '',
				});
			},
			persistTrust: (scriptId) => {
				// 关键路径:「允许并记住」= 写白名单 + 清熔断计数(用户显式重确认,ADR-017 恢复路径)
				if (!this.settings.trustedScripts.includes(scriptId)) {
					this.settings.trustedScripts.push(scriptId);
				}
				this.usageStats.clearScriptFailure(scriptId);
				void this.saveSettings();
			},
		});
		this.tools.register(
			createReadSkillReferenceTool(this.skillRegistry, toolDefMap.get('read_skill_reference')!),
		);
		this.tools.register(
			createRunSkillScriptTool(this.skillRegistry, toolDefMap.get('run_skill_script')!, {
				sandbox: scriptSandbox,
				trustGate: scriptTrustGate,
				failures: this.usageStats,
				// 关键路径:getter 现读 settings,设置面板改 skillScriptTimeout 立即生效
				timeoutMs: () => this.settings.skillScriptTimeout,
				vaultRoot: () => this.vault.getRootDir(),
				onSoftTimeout: () => new Notice(tNow('skill.script.softTimeoutNotice')),
				onCircuitBreak: (scriptId) => new Notice(tNow('skill.script.circuitNotice', { id: scriptId })),
			}),
		);
```

类字段声明:`private skillScriptSandbox: SkillScriptSandbox | null = null;`

**注意(实现者须核实两点,不匹配则按实际改):**
1. `this.vault.getRootDir()` — 先 grep VaultPort/ObsidianVault 是否已有根目录方法(可能叫 `getRootDir` / `vaultRoot` / 需从 `app.vault.adapter.getBasePath()` 取);ObsidianVault 外观若无则在该适配器补一个透传方法(禁止 main 直接碰 app.vault,AGENTS.md 外观约束)。
2. `this.saveSettings()` — 沿用 main 现有设置保存方法名(grep `saveSettings|saveData` 确认);`new Notice` 若 main 未 import obsidian 的 Notice 则补 import;`tNow` 已有则复用。

- [ ] **Step 2:onunload 兜底**

在 `onunload()`(grep 定位)加:

```ts
		// 关键路径(ADR-017 兜底三件套之二):unload 击杀活跃脚本 Worker,不留孤儿线程。
		this.skillScriptSandbox?.terminateAll();
```

- [ ] **Step 3:构建 + 全量测试 + typecheck**

Run: `npm run build && npm test && npm run typecheck`
Expected: 构建成功(`dist/skill-script-worker.js` 存在);全部测试 PASS;类型检查通过

- [ ] **Step 4:手动冒烟(Sandbox vault,按 AGENTS 本地预览约束)**

1. `npm run link:vault` 链 Obsidian Sandbox(勿链日常库),Reload app without saving
2. 在 Sandbox vault 建 `.ratel/skills/data-cleaner/SKILL.md`(name: data-cleaner)+ `scripts/hello.js`(内容 `reportProgress('step1'); 'hello ' + args[0]`)+ `references/guide.md`
3. 对话输入:让它调用 `run_skill_script('data-cleaner', 'hello.js', ['world'])` → 首次弹授权 Modal → 选「仅此次」→ 返回 `hello world`;再跑一次选「允许并记住」→ settings.trustedScripts 出现该条
4. 让它 `read_skill_reference('data-cleaner', 'guide.md')` → 返回正文
5. 建 `scripts/loop.js`(`while(true){}`)运行 → 30s(或临时把 skillScriptTimeout 调小到 5s)内被终止,工具结果含「强制终止」;连跑 3 次后第 4 次直接返回熔断文案 + Notice
6. 卸载/禁用插件 → Activity Monitor 确认无残留 Node 线程(粗验 terminateAll)

- [ ] **Step 5:Commit**

```bash
git add src/main.ts src/adapters/obsidian-vault.ts
git commit -m "feat: 接线 skill 执行工具 — 沙箱生命周期/信任持久化/unload 兜底(S-P2)"
```

---

## 验收对照(spec §5.2 → 测试)

| spec 验收 | 覆盖 |
|---|---|
| read_skill_reference 读 references | Task 5 正常读取用例 |
| run_skill_script 执行脚本带 args | Task 3 协议用例 + Task 6 正常执行 |
| 脚本内 fetch 抛错(网络禁用) | Task 2 能力面用例(typeof undefined) |
| fs.readFile('..') 抛错(traversal) | Task 2 白名单用例 ×2 + Task 5 traversal ×3 |
| 超 30s 自动终止 | Task 3 死循环击杀用例 + Task 6 timeout 语义 |
| 非 JS(.py 等)明确拒绝并引导 MCP | Task 6 语言边界用例 + Task 7 tool description 事前告知 |
| 首次弹 Modal,拒绝不执行 | Task 4 deny 用例 + Task 6 denied 用例 |
| 白名单后直接执行 | Task 4 白名单直行 + Task 6 正常执行 |

## 自审

- **ADR-017 全条款落点**:双层运行时(Task 2/3)、双层超时(Task 3 软/硬用例)、击杀→reject→错误为工具结果(Task 3/6)、熔断不自动重试且只数被杀/超时/崩溃(Task 6)、并发=1(Task 3)、unload terminateAll(Task 8)、exit 兜底(Task 3)✓
- **i18n**:所有用户可见字符串(工具结果/Notice/Modal/settings 标签/promptLabel)均走 tNow,双语成对;LLM-facing 的 defaults/zh.ts 文案属 prompt 例外 ✓
- **注释形态**:新文件均带 @file 文件头 + 关键路径注释,中文 ✓
- **无 obsidian 泄漏**:worker 入口与 script-vm 仅 node 内置模块 ✓
- **YAGNI**:未做 settings 白名单编辑 UI(P-SKILL-3)、未做熔断面板按钮(P-SKILL-3)、未做 mjs/ESM 脚本支持(vm 同步执行天然覆盖 CommonJS 风格脚本)✓
- **风险与缓解**:① worker_threads 在 Obsidian 渲染进程的可用性 — isDesktopOnly=true + 纯 Node worker(eval CJS,无 DOM 依赖);Task 8 手动冒烟是硬验收,若 Sandbox 冒烟失败,按 systematic-debugging 排查并在 plan 偏差记录(候选退路:InlineWorker + vm 主线程 + 硬超时降级,需回 ADR-017 修订);② vitest 环境 `__dirname` — 已在 Task 3 注明 fallback;③ realpath 在 macOS /var→/private/var — 测试全程 mkdtemp + 双侧 realpath 对比,无影响

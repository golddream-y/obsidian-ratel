# 社区插件底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `v9` 已有 search/install 上交出社区插件底座：卸 / 升（保 `data.json`）/ 点名配 / 日志回滚 + 一份可校验档案（schema、匹配、草稿、Calendar 示例）。

**Architecture:** 笔记工具继续走通道 A。生态 IO 只走通道 B + 独立 adapter。变更日志与备份写在 Ratel `pluginDir`（node:fs），不进 vault、不出网。档案纯逻辑在 `src/profiles/`（禁止 `import 'obsidian'`），写入永远调用已有/本 plan 落地的 `configure_plugin`，禁止第二套写盘。

**Tech Stack:** TypeScript / vitest / 现有 i18n 与工具权限门 / `yaml`（纯 JS，无原生模块）解析档案 / Obsidian `requestUrl` + `DataAdapter`。

**Spec:** [S-ECOSYSTEM](../specs/2026-08-20-ecosystem-management-design.md) + [S-PLUGIN-PROFILE](../specs/2026-09-10-plugin-profile-design.md)。基线切片 [P-ECOSYSTEM-1](2026-09-18-ecosystem-first-slice.md) 已合 `v9`，本 plan **不再冻结加功能**。

**范围：底座只此一份 plan。** 不另开 `P-PLUGIN-PROFILE`（档案硬依赖 `configure_plugin`，拆开无法单独验收）。不覆盖 S-HOST-ACCESS / S-LLM-RETRY（已有或另排）。

## Global Constraints

- 基线 0.8.0；`id` 永为 `ratel-vault`；`isDesktopOnly: true`
- 中文文档与注释；用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`）
- 禁止声称官方授权、店外安装、管理自己、2MB 清单进 `data.json`、`/releases/latest`
- `install_plugin` 不升级；`update_plugin` 不新装；更新只覆盖三件套，禁止写/删 `data.json`
- 不做 EC-09、`versions.json` 回退、降级
- TDD：每个 Task 先失败测试再实现
- 本机路径不进仓库；测试用临时目录
- **派发（别太碎）：** Wave 1: T1 ∥ T2；Wave 2: T3 ∥ T4；Wave 3: T5 ∥ T6；Wave 4: T7。同一波两个 Task 互不改同一文件

## 文件结构

| 路径 | 职责 |
|---|---|
| `src/ports/ecosystem.ts` | 执行层零实现端口 |
| `src/ports/plugin-profile.ts` | 档案层零实现端口 |
| `src/utils/setting-path.ts` | 点号路径解析 / patch 叶子写入 |
| `src/core/ecosystem-lock.ts` | 按 pluginId 串行锁 |
| `src/core/ecosystem-change-log.ts` | jsonl append-only |
| `src/core/ecosystem-backup.ts` | `pluginDir/ecosystem-backups/<changeId>/` |
| `src/adapters/ecosystem-install.ts` | 已装不覆盖；失败不删完整安装 |
| `src/adapters/ecosystem-update.ts` | 只覆盖三件套 |
| `src/adapters/ecosystem-uninstall.ts` | 备份后禁用删目录 |
| `src/adapters/ecosystem-configure.ts` | inspect / apply |
| `src/adapters/ecosystem-status.ts` | 已装列表 + 单插件 status |
| `src/adapters/ecosystem-vault.ts` | 增 `listPluginIds` / `copyTree` |
| `src/profiles/*` | 类型、校验、匹配、展开（纯逻辑） |
| `src/adapters/plugin-profile-fs.ts` | 三源加载 |
| `src/tools/{update,uninstall,get-plugin-status,configure,list-ecosystem-changes,restore-backup}-plugin.ts` 等 | 薄包装 |
| `src/tools/{list,match,draft}-plugin-profile*.ts` | 档案工具 |
| `plugin-profiles/` | 示例 YAML + AUTHORING.md |
| `schemas/obsidian-plugin-profile.schema.json` | 作者契约 |
| `src/skills/builtin/install-community-plugin/SKILL.md` | SOP（现有 esbuild 内联会自动捡到） |

---

### Task 1: 点号路径、锁、日志、备份、端口

**Files:**
- Create: `src/utils/setting-path.ts`, `src/core/ecosystem-lock.ts`, `src/core/ecosystem-change-log.ts`, `src/core/ecosystem-backup.ts`, `src/ports/ecosystem.ts`
- Modify: `src/adapters/ecosystem-vault.ts`（`listPluginIds` / `copyTree` / `readBinary`）
- Test: `tests/utils/setting-path.test.ts`, `tests/core/ecosystem-change-log.test.ts`, `tests/core/ecosystem-backup.test.ts`, `tests/core/ecosystem-lock.test.ts`

**Interfaces:**
- Produces: `parseSettingKey`, `applyLeafPatch`, `FORBID_KEY_RE`, `MAX_PATCH_KEYS`, `withPluginLock`, `appendEcosystemChange`, `listEcosystemChanges`, `snapshotPluginDir`, `restoreSnapshot`, `EcosystemPort` 类型, `EcosystemIo.listPluginIds` / `copyTree`

- [ ] **Step 1: 写失败测试 — 点号路径**

```typescript
/**
 * @file tests/utils/setting-path.test.ts
 * @description 点号路径叶子 patch（S-ECOSYSTEM §5.12）
 * @module utils/setting-path.test
 */
import { describe, it, expect } from 'vitest';
import { applyLeafPatch, parseSettingKey, FORBID_KEY_RE } from '../../src/utils/setting-path';

describe('parseSettingKey', () => {
	it('parseSettingKey - 合法 a.b.c - 三段', () => {
		expect(parseSettingKey('a.b.c')).toEqual(['a', 'b', 'c']);
	});
	it('parseSettingKey - 含 .. 或数组下标 - 抛错', () => {
		expect(() => parseSettingKey('a..b')).toThrow();
		expect(() => parseSettingKey('items.0')).toThrow();
		expect(() => parseSettingKey('.a')).toThrow();
	});
});

describe('applyLeafPatch', () => {
	it('applyLeafPatch - 只改点名叶子 - 兄弟不变', () => {
		const next = applyLeafPatch({ weekStart: 0, locale: 'zh' }, { weekStart: 1 });
		expect(next).toEqual({ weekStart: 1, locale: 'zh' });
	});
	it('applyLeafPatch - 嵌套叶子 - 不整枝覆盖', () => {
		const next = applyLeafPatch({ cal: { a: 1, b: 2 } }, { 'cal.a': 9 });
		expect(next).toEqual({ cal: { a: 9, b: 2 } });
	});
	it('applyLeafPatch - 超过 20 key - 抛错', () => {
		const patch: Record<string, unknown> = {};
		for (let i = 0; i < 21; i++) patch[`k${i}`] = i;
		expect(() => applyLeafPatch({}, patch)).toThrow();
	});
	it('FORBID_KEY_RE - apiKey 命中', () => {
		expect(FORBID_KEY_RE.test('apiKey')).toBe(true);
		expect(FORBID_KEY_RE.test('weekStart')).toBe(false);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/utils/setting-path.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `setting-path.ts`**

```typescript
/**
 * @file src/utils/setting-path.ts
 * @description data.json 点号路径叶子写入 — configure_plugin 唯一写法
 * @module utils/setting-path
 */
import { tNow } from '../i18n';

export const FORBID_KEY_RE = /token|secret|password|apiKey|webhook|cookie/i;
export const MAX_PATCH_KEYS = 20;
export const MAX_DOT_SEGMENTS = 6;

export function parseSettingKey(key: string): string[] {
	if (typeof key !== 'string' || !key || key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
		throw new Error(tNow('error.ecosystem.badKey', { key: String(key) }));
	}
	if (/[/\\\s\x00-\x1f]/.test(key)) {
		throw new Error(tNow('error.ecosystem.badKey', { key }));
	}
	const segs = key.split('.');
	if (segs.length > MAX_DOT_SEGMENTS || segs.some((s) => s === '' || /^\d+$/.test(s))) {
		throw new Error(tNow('error.ecosystem.badKey', { key }));
	}
	return segs;
}

function cloneJson<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

export function applyLeafPatch(
	root: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const keys = Object.keys(patch);
	if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) {
		throw new Error(tNow('error.ecosystem.patchSize', { n: String(keys.length) }));
	}
	const next = cloneJson(root);
	for (const key of keys) {
		if (patch[key] === undefined) throw new Error(tNow('error.ecosystem.badKey', { key }));
		JSON.stringify(patch[key]);
		const segs = parseSettingKey(key);
		let cur: Record<string, unknown> = next;
		for (let i = 0; i < segs.length - 1; i++) {
			const s = segs[i]!;
			const child = cur[s];
			if (child === undefined || child === null || Array.isArray(child) || typeof child !== 'object') {
				cur[s] = {};
			}
			cur = cur[s] as Record<string, unknown>;
		}
		cur[segs[segs.length - 1]!] = cloneJson(patch[key]);
	}
	return next;
}
```

先在 `src/i18n/types.ts` 的 `ErrorStrings` + `zh.ts`/`en.ts` 的 error 对象加：

```
'error.ecosystem.badKey': '非法设置路径: {key}'
'error.ecosystem.patchSize': '单次最多 20 个 key,收到 {n}'
```

英文：`'Invalid setting path: {key}'` / `'At most 20 keys per apply, got {n}'`。

- [ ] **Step 4: 写失败测试 — 锁 / 日志 / 备份**

```typescript
/**
 * @file tests/core/ecosystem-lock.test.ts
 * @description 同 pluginId 串行、不同 id 可并行
 * @module core/ecosystem-lock.test
 */
import { describe, it, expect } from 'vitest';
import { withPluginLock } from '../../src/core/ecosystem-lock';

describe('withPluginLock', () => {
	it('withPluginLock - 同 id 两次 - 第二次等第一次结束', async () => {
		const order: number[] = [];
		let release!: () => void;
		const first = withPluginLock('calendar', () => new Promise<void>((r) => { release = r; order.push(1); }));
		const secondP = withPluginLock('calendar', async () => { order.push(2); });
		await Promise.resolve();
		expect(order).toEqual([1]);
		release();
		await first;
		await secondP;
		expect(order).toEqual([1, 2]);
	});
});
```

```typescript
/**
 * @file tests/core/ecosystem-change-log.test.ts
 * @description jsonl 新在前、按 pluginId 过滤
 * @module core/ecosystem-change-log.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEcosystemChange, listEcosystemChanges } from '../../src/core/ecosystem-change-log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'ratel-elog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ecosystem-change-log', () => {
	it('appendEcosystemChange - 两条后 list limit 1 - 只要最新', async () => {
		const a = await appendEcosystemChange(dir, { action: 'install', pluginId: 'calendar', summary: 'a' });
		const b = await appendEcosystemChange(dir, { action: 'configure', pluginId: 'calendar', summary: 'b' });
		expect(a.id).toBe('ch_000001');
		expect(b.id).toBe('ch_000002');
		const rows = await listEcosystemChanges(dir, { limit: 1 });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe('ch_000002');
	});
	it('listEcosystemChanges - pluginId 过滤', async () => {
		await appendEcosystemChange(dir, { action: 'install', pluginId: 'calendar', summary: 'a' });
		await appendEcosystemChange(dir, { action: 'install', pluginId: 'dataview', summary: 'b' });
		const rows = await listEcosystemChanges(dir, { pluginId: 'dataview' });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pluginId).toBe('dataview');
	});
});
```

```typescript
/**
 * @file tests/core/ecosystem-backup.test.ts
 * @description 快照恢复与每插件保留 3 份
 * @module core/ecosystem-backup.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { snapshotPluginDir, restoreSnapshot } from '../../src/core/ecosystem-backup';
import { appendEcosystemChange, listEcosystemChanges } from '../../src/core/ecosystem-change-log';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-ebak-'));
});
afterEach(() => { rmSync(pluginDir, { recursive: true, force: true }); });

describe('ecosystem-backup', () => {
	it('snapshotPluginDir / restoreSnapshot - data.json 回到快照', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'snap' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":1}');
		await restoreSnapshot({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0}');
		expect(readFileSync(path.join(pluginDir, 'ecosystem-backups', change.id, 'data.json'), 'utf-8')).toBe('{"weekStart":0}');
	});
	it('同一 pluginId 第 4 份 - 最旧 status expired', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			const c = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: String(i) });
			ids.push(c.id);
			await snapshotPluginDir({ pluginDir, changeId: c.id, io, pluginRel: '.obsidian/plugins/calendar' });
		}
		const rows = await listEcosystemChanges(pluginDir, { pluginId: 'calendar', limit: 100 });
		expect(rows.find((r) => r.id === ids[0])!.status).toBe('expired');
		expect(rows.filter((r) => r.status === 'recorded')).toHaveLength(3);
	});
});
```

- [ ] **Step 5: 实现锁、日志、备份、扩展 MemoryEcosystemIo**

```typescript
/**
 * @file src/core/ecosystem-lock.ts
 * @description 同一 pluginId 的生态写操作串行
 * @module core/ecosystem-lock
 */
const tails = new Map<string, Promise<unknown>>();

export async function withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
	const prev = tails.get(pluginId) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	tails.set(pluginId, prev.then(() => gate));
	await prev.catch(() => undefined);
	try {
		return await fn();
	} finally {
		release();
	}
}
```

```typescript
/**
 * @file src/core/ecosystem-change-log.ts
 * @description pluginDir/ecosystem-changes.jsonl
 * @module core/ecosystem-change-log
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type EcosystemAction = 'install' | 'update' | 'uninstall' | 'configure' | 'restore';
export type ChangeStatus = 'recorded' | 'restored' | 'expired';

export interface EcosystemChange {
	id: string;
	time: string;
	action: EcosystemAction;
	pluginId: string;
	summary: string;
	before?: unknown;
	after?: unknown;
	backupPath?: string;
	status: ChangeStatus;
}

function fileOf(pluginDir: string): string {
	return path.join(pluginDir, 'ecosystem-changes.jsonl');
}

export async function readAllChanges(pluginDir: string): Promise<EcosystemChange[]> {
	try {
		const text = await readFile(fileOf(pluginDir), 'utf-8');
		return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EcosystemChange);
	} catch {
		return [];
	}
}

export async function appendEcosystemChange(
	pluginDir: string,
	entry: { action: EcosystemAction; pluginId: string; summary: string; before?: unknown; after?: unknown; backupPath?: string; status?: ChangeStatus },
): Promise<EcosystemChange> {
	await mkdir(pluginDir, { recursive: true });
	const existing = await readAllChanges(pluginDir);
	const nextN = existing.length + 1;
	const row: EcosystemChange = {
		id: `ch_${String(nextN).padStart(6, '0')}`,
		time: new Date().toISOString(),
		status: entry.status ?? 'recorded',
		action: entry.action,
		pluginId: entry.pluginId,
		summary: entry.summary,
		before: entry.before,
		after: entry.after,
		backupPath: entry.backupPath,
	};
	await appendFile(fileOf(pluginDir), `${JSON.stringify(row)}\n`, 'utf-8');
	return row;
}

export async function listEcosystemChanges(
	pluginDir: string,
	opts?: { pluginId?: string; limit?: number },
): Promise<EcosystemChange[]> {
	const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
	let rows = (await readAllChanges(pluginDir)).slice().reverse();
	if (opts?.pluginId) rows = rows.filter((r) => r.pluginId === opts.pluginId);
	return rows.slice(0, limit);
}

/** 过期改 status：不是业务 append。读入全部行，改匹配 id，整文件写回。 */
export async function markChangeStatus(pluginDir: string, id: string, status: ChangeStatus): Promise<void> {
	const rows = await readAllChanges(pluginDir);
	const next = rows.map((r) => (r.id === id ? { ...r, status } : r));
	await writeFile(fileOf(pluginDir), next.map((r) => JSON.stringify(r)).join('\n') + (next.length ? '\n' : ''), 'utf-8');
}
```

```typescript
/**
 * @file src/core/ecosystem-backup.ts
 * @description pluginDir/ecosystem-backups/<changeId>/
 * @module core/ecosystem-backup
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { EcosystemIo } from '../adapters/ecosystem-vault';
import { markChangeStatus, readAllChanges } from './ecosystem-change-log';

const KEEP = 3;

export async function snapshotPluginDir(opts: {
	pluginDir: string;
	changeId: string;
	io: EcosystemIo;
	pluginRel: string;
}): Promise<string> {
	const dstAbs = path.join(opts.pluginDir, 'ecosystem-backups', opts.changeId);
	await mkdir(dstAbs, { recursive: true });
	await opts.io.copyTree(opts.pluginRel, dstAbs);
	await expireOld(opts.pluginDir, opts.pluginRel);
	return dstAbs;
}

async function expireOld(pluginDir: string, pluginRel: string): Promise<void> {
	const pluginId = pluginRel.split('/').filter(Boolean).pop() ?? '';
	const recorded = (await readAllChanges(pluginDir)).filter((r) => r.pluginId === pluginId && r.status === 'recorded');
	const extra = recorded.length - KEEP;
	if (extra <= 0) return;
	for (const row of recorded.slice(0, extra)) {
		await rm(path.join(pluginDir, 'ecosystem-backups', row.id), { recursive: true, force: true });
		await markChangeStatus(pluginDir, row.id, 'expired');
	}
}

export async function restoreSnapshot(opts: {
	pluginDir: string;
	changeId: string;
	io: EcosystemIo;
	pluginRel: string;
}): Promise<void> {
	const srcAbs = path.join(opts.pluginDir, 'ecosystem-backups', opts.changeId);
	await opts.io.restoreTree(srcAbs, opts.pluginRel);
}
```

`EcosystemIo` 增加（`src/adapters/ecosystem-vault.ts`）：

```typescript
listPluginIds(configDir: string): Promise<string[]>;
copyTree(srcRel: string, dstAbs: string): Promise<void>;
restoreTree(srcAbs: string, dstRel: string): Promise<void>;
rename(fromRel: string, toRel: string): Promise<void>;
```

`MemoryEcosystemIo` 在类里追加（文件头 `import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises'` 与 `import path from 'node:path'`）：

```typescript
	async listPluginIds(configDir: string): Promise<string[]> {
		this.gate(`${configDir}/plugins`);
		const ids = new Set<string>();
		const prefix = `${configDir}/plugins/`;
		for (const k of this.files.keys()) {
			if (!k.startsWith(prefix)) continue;
			const id = k.slice(prefix.length).split('/')[0];
			if (id && id !== 'ratel-vault') ids.add(id);
		}
		return [...ids];
	}
	async copyTree(srcRel: string, dstAbs: string): Promise<void> {
		const src = this.gate(srcRel);
		await mkdir(dstAbs, { recursive: true });
		for (const [k, v] of this.files) {
			if (k !== src && !k.startsWith(`${src}/`)) continue;
			const rel = k === src ? '_root' : k.slice(src.length + 1);
			const dest = path.join(dstAbs, rel);
			await mkdir(path.dirname(dest), { recursive: true });
			await writeFile(dest, v, 'utf-8');
		}
	}
	async restoreTree(srcAbs: string, dstRel: string): Promise<void> {
		const dst = this.gate(dstRel);
		await this.removeRecursive(dstRel);
		const walk = async (dir: string, rel: string): Promise<void> => {
			for (const name of await readdir(dir)) {
				const p = path.join(dir, name);
				const r = rel ? `${rel}/${name}` : name;
				if ((await stat(p)).isDirectory()) await walk(p, r);
				else this.files.set(`${dst}/${r}`, await readFile(p, 'utf-8'));
			}
		};
		await walk(srcAbs, '');
	}
	async rename(fromRel: string, toRel: string): Promise<void> {
		const from = this.gate(fromRel);
		const to = this.gate(toRel);
		const v = this.files.get(from);
		if (v === undefined) throw new Error(`missing ${from}`);
		this.files.set(to, v);
		this.files.delete(from);
	}
```

`AdapterEcosystemIo` 同步实现：`listPluginIds` 调 `adapter.list(`${configDir}/plugins`)` 过滤目录名 ≠ `ratel-vault`；`copyTree` 递归 `adapter.list`/`read` 写到 `dstAbs`（node:fs）；`restoreTree` 反向；`rename` 调 `adapter.rename`（若无则 read+write+remove）。

`expireOld` 必须在 snapshot **写入 jsonl 之后**调用，这样 `recorded` 含本条。测试「第 4 份」先 append 再 snapshot，顺序与上一致。

- [ ] **Step 6: 端口文件**

```typescript
/**
 * @file src/ports/ecosystem.ts
 * @description 社区插件执行层端口 — 零实现
 * @module ports/ecosystem
 */
export interface EcosystemPort {
	search(query: string): Promise<unknown>;
	listInstalled(): Promise<Array<{ id: string; name: string; version: string; enabled: boolean }>>;
	status(pluginId: string, opts?: { includeKeys?: boolean; checkUpdate?: boolean }): Promise<unknown>;
	install(pluginId: string): Promise<unknown>;
	update(pluginId: string): Promise<unknown>;
	uninstall(pluginId: string): Promise<unknown>;
	inspectData(pluginId: string): Promise<{ keys: string[]; values: Record<string, unknown> }>;
	applyData(pluginId: string, patch: Record<string, unknown>): Promise<unknown>;
	listChanges(opts?: { pluginId?: string; limit?: number }): Promise<unknown[]>;
	restore(changeId: string): Promise<unknown>;
}
```

- [ ] **Step 7: 跑测试通过并提交**

Run: `npx vitest run tests/utils/setting-path.test.ts tests/core/ecosystem-lock.test.ts tests/core/ecosystem-change-log.test.ts tests/core/ecosystem-backup.test.ts`
Expected: PASS

```bash
git add src/utils/setting-path.ts src/core/ecosystem-lock.ts src/core/ecosystem-change-log.ts src/core/ecosystem-backup.ts src/ports/ecosystem.ts src/adapters/ecosystem-vault.ts src/i18n/zh.ts src/i18n/en.ts src/i18n/types.ts tests/utils/setting-path.test.ts tests/core/ecosystem-*.test.ts
git commit -m "$(cat <<'EOF'
feat: 生态点号路径、变更日志与按插件串行锁

给 configure/装卸回滚提供最小共享内核，通道 B 仍只写白名单路径。
EOF
)"
```

---

### Task 2: 档案纯逻辑（schema / 校验 / 匹配 / 展开）

**Files:**
- Create: `src/ports/plugin-profile.ts`, `src/profiles/types.ts`, `src/profiles/validate.ts`, `src/profiles/match.ts`, `src/profiles/expand.ts`, `schemas/obsidian-plugin-profile.schema.json`, `plugin-profiles/calendar-week-start.yaml`, `plugin-profiles/AUTHORING.md`
- Test: `tests/profiles/validate.test.ts`, `tests/profiles/match.test.ts`, `tests/profiles/expand.test.ts`
- Modify: `package.json`（加依赖 `yaml`）

**Interfaces:**
- Consumes: 无（不依赖 T1）
- Produces: `validateProfile`, `matchProfiles`, `expandPresetPatch`, `PluginProfile` 类型

- [ ] **Step 1: `npm install yaml`**（纯 JS，无原生）。`package.json` / lock 进同一提交。

- [ ] **Step 2: 写失败测试**

```typescript
/**
 * @file tests/profiles/validate.test.ts
 * @description 档案 schema + 语义校验
 * @module profiles/validate.test
 */
import { describe, it, expect } from 'vitest';
import { validateProfile } from '../../src/profiles/validate';

const base = {
	kind: 'obsidian-plugin-profile',
	id: 'calendar-week-start',
	pluginId: 'calendar',
	pluginName: 'Calendar',
	pluginVersionRange: '>=1.0.0',
	install: { source: 'community-store' },
	forbid: ['apiKey'],
	presets: [{ id: 'week-start-monday', when: '周一开始', patch: { weekStart: 1 } }],
};

describe('validateProfile', () => {
	it('validateProfile - 合法档案 - ok', () => {
		const r = validateProfile(base);
		expect(r.ok).toBe(true);
	});
	it('validateProfile - forbid 与 patch 相交 - 拒绝', () => {
		const r = validateProfile({ ...base, presets: [{ id: 'x', when: 'a', patch: { apiKey: 'no' } }] });
		expect(r.ok).toBe(false);
	});
	it('validateProfile - pluginId ratel-vault - 拒绝', () => {
		expect(validateProfile({ ...base, pluginId: 'ratel-vault' }).ok).toBe(false);
	});
	it('validateProfile - 非法 range caret - 拒绝', () => {
		expect(validateProfile({ ...base, pluginVersionRange: '^1.0.0' }).ok).toBe(false);
	});
	it('validateProfile - 重复 preset id - 拒绝', () => {
		const r = validateProfile({
			...base,
			presets: [
				{ id: 'a', when: 'x', patch: { n: 1 } },
				{ id: 'a', when: 'y', patch: { n: 2 } },
			],
		});
		expect(r.ok).toBe(false);
	});
});
```

```typescript
/**
 * @file tests/profiles/match.test.ts
 * @description 匹配权重与 draft 不进池
 * @module profiles/match.test
 */
import { describe, it, expect } from 'vitest';
import { matchProfiles } from '../../src/profiles/match';
import type { PluginProfile } from '../../src/profiles/types';

function p(over: Partial<PluginProfile> & Pick<PluginProfile, 'id'>): PluginProfile {
	return {
		kind: 'obsidian-plugin-profile',
		pluginId: 'calendar',
		pluginName: 'Calendar',
		pluginVersionRange: '*',
		install: { source: 'community-store' },
		forbid: [],
		presets: [{ id: 'week-start-monday', when: '周一开始', patch: { weekStart: 1 } }],
		enabled: true,
		...over,
	};
}

describe('matchProfiles', () => {
	it('matchProfiles - enabled false 或 draft 标记 - 不进结果', () => {
		const hits = matchProfiles([p({ id: 'a', enabled: false })], { utterance: '周一开始' });
		expect(hits).toEqual([]);
	});
	it('matchProfiles - utterance 周一开始 - presetId week-start-monday', () => {
		const hits = matchProfiles([p({ id: 'calendar-week-start' })], { utterance: '周一开始' });
		expect(hits[0]!.presetId).toBe('week-start-monday');
		expect(hits[0]!.score).toBeGreaterThanOrEqual(10);
	});
	it('matchProfiles - pluginId 精确 - +100', () => {
		const hits = matchProfiles([p({ id: 'x' })], { pluginId: 'calendar' });
		expect(hits[0]!.score).toBe(100);
	});
	it('matchProfiles - 无命中 - 空数组', () => {
		expect(matchProfiles([p({ id: 'x' })], { utterance: '看板' })).toEqual([]);
	});
	it('matchProfiles - 同分 - 按 profileId 字母序 最多 5', () => {
		const pool = ['e', 'c', 'a', 'd', 'b', 'f'].map((id) => p({ id, pluginId: 'cal' }));
		const hits = matchProfiles(pool, { pluginId: 'cal' });
		expect(hits).toHaveLength(5);
		expect(hits.map((h) => h.profileId)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});
```

```typescript
/**
 * @file tests/profiles/expand.test.ts
 * @description preset 展开去掉 forbid 与未选 key
 * @module profiles/expand.test
 */
import { describe, it, expect } from 'vitest';
import { expandPresetPatch } from '../../src/profiles/expand';

describe('expandPresetPatch', () => {
	it('expandPresetPatch - 去掉 forbid 与未选 - 新 key needsConfirm', () => {
		const r = expandPresetPatch({
			preset: { id: 'p', when: 'x', patch: { weekStart: 1, apiKey: 'no', extra: true } },
			forbid: ['apiKey'],
			existingKeys: ['weekStart'],
			selectedKeys: ['weekStart', 'extra'],
		});
		expect(r.patch).toEqual({ weekStart: 1, extra: true });
		expect(r.needsConfirm).toEqual(['extra']);
	});
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/profiles/`
Expected: FAIL

- [ ] **Step 4: 实现校验 / 匹配 / 展开**

`src/profiles/types.ts`：

```typescript
/**
 * @file src/profiles/types.ts
 * @description 插件档案对象（S-PLUGIN-PROFILE §6）
 * @module profiles/types
 */
export type ProfileKind = 'obsidian-plugin-profile';

export interface PluginProfile {
	kind: ProfileKind;
	id: string;
	pluginId: string;
	pluginName: string;
	pluginVersionRange: string;
	enabled?: boolean;
	tags?: string[];
	sopSkill?: string;
	install: { source: 'community-store' };
	forbid: string[];
	presets: ProfilePreset[];
}

export interface ProfilePreset {
	id: string;
	when: string;
	patch: Record<string, unknown>;
}

export interface ProfileMatchQuery {
	utterance?: string;
	pluginId?: string;
	tags?: string[];
}

export interface ProfileMatchHit {
	profileId: string;
	pluginId: string;
	presetId: string;
	score: number;
	reasons: string[];
}

export interface ProfileDiagnostic {
	profileId?: string;
	path: string;
	code:
		| 'schemaInvalid'
		| 'semanticInvalid'
		| 'unknownPluginId'
		| 'unverifiedStoreId'
		| 'versionMismatch'
		| 'draftSkipped'
		| 'idCollision'
		| 'forbidOverlap'
		| 'parseError';
	message: string;
}

export interface LoadReport {
	loaded: number;
	skipped: number;
	diagnostics: ProfileDiagnostic[];
}
```

```typescript
/**
 * @file src/profiles/validate.ts
 * @description 档案手写校验，不引入 ajv
 * @module profiles/validate
 */
import type { PluginProfile } from './types';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const RANGE = /^(\*|\d+\.\d+\.\d+|>=\d+\.\d+\.\d+)$/;

export function validateProfile(raw: unknown): { ok: true; profile: PluginProfile } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not-object'] };
	const o = raw as Record<string, unknown>;
	if (o.kind !== 'obsidian-plugin-profile') errors.push('kind');
	if (typeof o.id !== 'string' || !ID.test(o.id)) errors.push('id');
	if (typeof o.pluginId !== 'string' || o.pluginId === 'ratel-vault') errors.push('pluginId');
	if (typeof o.pluginName !== 'string') errors.push('pluginName');
	if (typeof o.pluginVersionRange !== 'string' || !RANGE.test(o.pluginVersionRange)) errors.push('pluginVersionRange');
	const inst = o.install as { source?: string } | undefined;
	if (inst?.source !== 'community-store') errors.push('install.source');
	const forbid = Array.isArray(o.forbid) ? o.forbid.map(String) : [];
	const presets = o.presets;
	if (!Array.isArray(presets) || presets.length === 0 || presets.length > 8) errors.push('presets');
	const ids = new Set<string>();
	if (Array.isArray(presets)) {
		for (const pr of presets) {
			const p = pr as { id?: string; when?: string; patch?: Record<string, unknown> };
			if (!p.id || ids.has(p.id) || !p.when || !p.patch) errors.push('preset');
			ids.add(p.id ?? '');
			const keys = Object.keys(p.patch ?? {});
			if (keys.length > 20) errors.push('patch-size');
			for (const k of keys) {
				if (forbid.includes(k)) errors.push('forbidOverlap');
				if (k.includes('..') || k.startsWith('.') || k.includes('/')) errors.push('key');
			}
		}
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, profile: o as unknown as PluginProfile };
}
```

```typescript
/**
 * @file src/profiles/match.ts
 * @description 池内打分，调用方已排除 draft/unknown
 * @module profiles/match
 */
import type { PluginProfile, ProfileMatchHit, ProfileMatchQuery } from './types';

export function matchProfiles(pool: PluginProfile[], query: ProfileMatchQuery): ProfileMatchHit[] {
	const hits: ProfileMatchHit[] = [];
	for (const profile of pool) {
		if (profile.enabled === false) continue;
		let score = 0;
		const reasons: string[] = [];
		if (query.pluginId && query.pluginId === profile.pluginId) { score += 100; reasons.push('pluginId'); }
		if (query.tags?.length && profile.tags) {
			for (const t of query.tags) {
				if (profile.tags.includes(t)) { score += 20; reasons.push(`tag:${t}`); }
			}
		}
		const u = query.utterance?.toLowerCase() ?? '';
		if (u) {
			const fields = [profile.pluginName, profile.pluginId, ...(profile.tags ?? []), ...profile.presets.map((p) => p.when)];
			for (const f of fields) {
				if (f.toLowerCase().includes(u) || u.includes(f.toLowerCase())) { score += 10; reasons.push('utterance'); break; }
			}
		}
		if (score <= 0) continue;
		const preset = profile.presets.find((p) => u && p.when.toLowerCase().includes(u)) ?? profile.presets[0]!;
		hits.push({ profileId: profile.id, pluginId: profile.pluginId, presetId: preset.id, score, reasons });
	}
	hits.sort((a, b) => b.score - a.score || a.profileId.localeCompare(b.profileId));
	return hits.slice(0, 5);
}
```

utterance 子串：对「周一开始」必须命中 `when`（`u.includes(when)` 或 `when.includes(u)`）。上面循环用 `u.includes(f.toLowerCase())` 覆盖。

```typescript
/**
 * @file src/profiles/expand.ts
 * @description 展开 preset 为 configure_plugin 的 patch
 * @module profiles/expand
 */
import type { ProfilePreset } from './types';

export function expandPresetPatch(opts: {
	preset: ProfilePreset;
	forbid: string[];
	existingKeys: string[];
	selectedKeys?: string[];
}): { patch: Record<string, unknown>; needsConfirm: string[] } {
	const forbid = new Set(opts.forbid);
	const selected = opts.selectedKeys ? new Set(opts.selectedKeys) : null;
	const patch: Record<string, unknown> = {};
	const needsConfirm: string[] = [];
	for (const [k, v] of Object.entries(opts.preset.patch)) {
		if (forbid.has(k)) continue;
		if (selected && !selected.has(k)) continue;
		patch[k] = v;
		if (!opts.existingKeys.includes(k)) needsConfirm.push(k);
	}
	return { patch, needsConfirm };
}
```

`schemas/obsidian-plugin-profile.schema.json`（运行时不读此文件，给作者与 CI 用）：

```json
{
	"$schema": "https://json-schema.org/draft/07/schema#",
	"title": "obsidian-plugin-profile",
	"type": "object",
	"additionalProperties": false,
	"required": ["kind", "id", "pluginId", "pluginName", "pluginVersionRange", "install", "forbid", "presets"],
	"properties": {
		"kind": { "const": "obsidian-plugin-profile" },
		"id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },
		"pluginId": { "type": "string", "minLength": 1 },
		"pluginName": { "type": "string", "minLength": 1 },
		"pluginVersionRange": { "type": "string", "pattern": "^(\\*|\\d+\\.\\d+\\.\\d+|>=\\d+\\.\\d+\\.\\d+)$" },
		"enabled": { "type": "boolean" },
		"tags": { "type": "array", "items": { "type": "string" } },
		"sopSkill": { "type": "string" },
		"install": {
			"type": "object",
			"additionalProperties": false,
			"required": ["source"],
			"properties": { "source": { "const": "community-store" } }
		},
		"forbid": { "type": "array", "items": { "type": "string" } },
		"presets": {
			"type": "array",
			"minItems": 1,
			"maxItems": 8,
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": ["id", "when", "patch"],
				"properties": {
					"id": { "type": "string" },
					"when": { "type": "string" },
					"patch": { "type": "object" }
				}
			}
		}
	}
}
```

- [ ] **Step 5: 示例 YAML + AUTHORING.md**

`plugin-profiles/calendar-week-start.yaml`：

```yaml
kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
enabled: true
tags: [calendar, week]
install:
  source: community-store
forbid:
  - token
  - apiKey
presets:
  - id: week-start-monday
    when: 周一开始
    patch:
      weekStart: 1
```

`plugin-profiles/AUTHORING.md`：

```markdown
# 写一份插件档案

1. 只列 5～15 个常改 key；密钥、token、password 进 forbid，不要写进 preset.patch。
2. `when` 写用户场景（如「周一开始」），不要写实现细节。
3. 互斥配置拆成多个 preset，不要挤在同一 patch。
4. 必须过 schema 与语义校验（forbid 与 patch 不相交、range 只认 `*` / `x.y.z` / `>=x.y.z`）。
5. 写入只指向 `configure_plugin`；禁止在 SOP 或档案里贴整份 data.json。
6. 三源覆盖：vault > global > builtin。draft 默认 enabled: false，不进匹配。
```

`tests/profiles/calendar-yaml.test.ts`：

```typescript
/**
 * @file tests/profiles/calendar-yaml.test.ts
 * @description 仓库示例 YAML 必须能通过校验
 * @module profiles/calendar-yaml.test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateProfile } from '../../src/profiles/validate';

describe('calendar-week-start.yaml', () => {
	it('validateProfile - 仓库示例 YAML - ok', () => {
		const raw = readFileSync('plugin-profiles/calendar-week-start.yaml', 'utf-8');
		const r = validateProfile(parse(raw));
		expect(r.ok).toBe(true);
	});
});
```

- [ ] **Step 6: 端口 `src/ports/plugin-profile.ts`**

```typescript
export interface PluginProfilePort {
	loadAll(): Promise<{ loaded: number; skipped: number; diagnostics: unknown[] }>;
	get(id: string): import('../profiles/types').PluginProfile | undefined;
	match(query: import('../profiles/types').ProfileMatchQuery): import('../profiles/types').ProfileMatchHit[];
	validate(raw: unknown): { ok: true; profile: import('../profiles/types').PluginProfile } | { ok: false; errors: string[] };
}
```

- [ ] **Step 7: 提交**

Run: `npx vitest run tests/profiles/`
Expected: PASS

```bash
git commit -m "$(cat <<'EOF'
feat: 插件档案 schema、校验与匹配纯逻辑

先交可单测的知识层，写入仍留给 configure_plugin。
EOF
)"
```

---

### Task 3: 安装硬化 + `update_plugin`

**Files:**
- Modify: `src/adapters/ecosystem-install.ts`, `src/adapters/ecosystem-registry.ts`（导出 `compareDottedVersion`）
- Create: `src/adapters/ecosystem-update.ts`, `src/tools/update-plugin.ts`
- Test: `tests/adapters/ecosystem-install.test.ts`（追加）, `tests/adapters/ecosystem-update.test.ts`

**Interfaces:**
- Consumes: T1 `snapshotPluginDir` / `appendEcosystemChange` / `withPluginLock` / `EcosystemIo.copyTree`；现有 `installCommunityPlugin` / `EcosystemRegistry`
- Produces: `updateCommunityPlugin`, `isCompleteInstall`, `compareDottedVersion`

- [ ] **Step 1: 写失败测试**

在 `tests/adapters/ecosystem-install.test.ts` 追加（沿用现有 `http()` / `MemoryEcosystemIo` / CAL）：

```typescript
it('已有合法 manifest - already-installed 且不覆盖 main.js', async () => {
	const fetch = http();
	const reg = new EcosystemRegistry(pluginDir, fetch);
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	const deps = { registry: reg, io, configDir: '.obsidian', writeEnabled: true, apiVersion: '1.13.0', openOfficialPage: async () => undefined, appLike: {}, pluginDir };
	await installCommunityPlugin('calendar', deps);
	io.files.set('.obsidian/plugins/calendar/main.js', 'MARKER');
	const second = await installCommunityPlugin('calendar', deps);
	expect(second.mode).toBe('already-installed');
	expect(io.files.get('.obsidian/plugins/calendar/main.js')).toBe('MARKER');
});

it('安装失败不得删除已完整安装的目录', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', version: '1.0.0' }));
	await io.writeText('.obsidian/plugins/calendar/main.js', 'KEEP');
	const fetch = http({
		[`https://github.com/${CAL.repo}/releases/download/1.5.10/main.js`]: { status: 500, text: '' },
	});
	const reg = new EcosystemRegistry(pluginDir, fetch);
	await expect(installCommunityPlugin('calendar', {
		registry: reg, io, configDir: '.obsidian', writeEnabled: true, apiVersion: '1.13.0',
		openOfficialPage: async () => undefined, appLike: {},
	})).rejects.toThrow();
	expect(io.files.get('.obsidian/plugins/calendar/main.js')).toBe('KEEP');
});
```

`tests/adapters/ecosystem-update.test.ts` 共用 CAL/`http()`（从 install 测试抽 `tests/helpers/ecosystem-http.ts`，若抽取会改 install 测试文件——**禁止**，本 Task 在 update 测试里复制 `http()` 与 CAL 常量）。文件头与 `http()` 从 `tests/adapters/ecosystem-install.test.ts` 原样复制（含 `CAL`、`COMMUNITY_PLUGINS_CATALOG_URL`、`setConfigDir`、`mkdtempSync`）。再加：

```typescript
import { updateCommunityPlugin } from '../../src/adapters/ecosystem-update';
import type { HttpGet } from '../../src/adapters/ecosystem-registry';

function makeDeps(
	pluginDir: string,
	fetch: HttpGet,
	io: MemoryEcosystemIo,
	writeEnabled: boolean,
) {
	return {
		registry: new EcosystemRegistry(pluginDir, fetch),
		io,
		configDir: '.obsidian',
		writeEnabled,
		apiVersion: '1.13.0',
		openOfficialPage: async () => undefined,
		appLike: {},
		pluginDir,
	};
}

async function seedComplete(io: MemoryEcosystemIo, version = '1.0.0') {
	await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', version }));
	await io.writeText('.obsidian/plugins/calendar/main.js', 'OLDJS');
	await io.writeText('.obsidian/plugins/calendar/styles.css', 'OLDCSS');
	await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0,"token":"keep"}');
}

it('update - 覆盖三件套后 data.json 字节不变', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '1.0.0');
	const fetch = http(); // HEAD 1.5.10
	const result = await updateCommunityPlugin('calendar', makeDeps(pluginDir, fetch, io, true));
	expect(result.mode).toBe('write');
	expect(result.dataJsonUnchanged).toBe(true);
	expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0,"token":"keep"}');
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('js-body');
});

it('update - 已是 HEAD version - already-current 零写 main.js', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '1.5.10');
	const r = await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true));
	expect(r.mode).toBe('already-current');
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
});

it('update - 本地 2.0.0 高于商店 1.5.10 - 不降级', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '2.0.0');
	await expect(updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true))).rejects.toThrow();
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
});

it('update - 未装 - not-installed', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
	const r = await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true));
	expect(r.mode).toBe('not-installed');
});

it('update - R3 零写盘开官方页', async () => {
	const opened: string[] = [];
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io);
	const r = await updateCommunityPlugin('calendar', { ...makeDeps(pluginDir, http(), io, false), openOfficialPage: async (u) => { opened.push(u); } });
	expect(r.mode).toBe('official-page');
	expect(opened[0]).toContain('obsidian://show-plugin');
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
});

it('update - 新 release 无 styles.css - 旧 styles.css 仍在', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '1.0.0');
	await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true)); // http() 已 404 styles
	expect(await io.readText('.obsidian/plugins/calendar/styles.css')).toBe('OLDCSS');
});

it('update - writeBinary 抛错 - 整目录从备份恢复且 data.json 仍是 seed', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '1.0.0');
	const orig = io.writeBinary.bind(io);
	io.writeBinary = async () => { throw new Error('boom'); };
	await expect(updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true))).rejects.toThrow();
	io.writeBinary = orig;
	expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0,"token":"keep"}');
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
});

it('update - 无法点分段比较且 confirmIncomparable 拒绝 - 零写', async () => {
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await seedComplete(io, '1.0.0-beta');
	const deps = { ...makeDeps(pluginDir, http(), io, true), confirmIncomparable: async () => false };
	await expect(updateCommunityPlugin('calendar', deps)).rejects.toThrow();
	expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
});
```

`makeDeps` 与 install 测试 deps 同形，外加 `pluginDir` 供备份。写入失败恢复用例：包装 `io.writeBinary` 第一次抛错，断言 `data.json` 仍是 seed 值。

`tests/adapters/ecosystem-registry.test.ts` 追加：

```typescript
it('compareDottedVersion - 1.10.0 大于 1.9.0', () => {
	expect(compareDottedVersion('1.10.0', '1.9.0')).toBe(1);
});
it('compareDottedVersion - beta 无法比较 - null', () => {
	expect(compareDottedVersion('1.0.0-beta', '1.0.0')).toBeNull();
});
```

`compareDottedVersion` 单测可放 registry 测试文件：`'1.10.0' > '1.9.0'`；`'1.0.0-beta'` 无法比较返回 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-install.test.ts tests/adapters/ecosystem-update.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: `compareDottedVersion` + `isCompleteInstall`**

放进 `src/adapters/ecosystem-registry.ts`（与现有 `isAppVersionAtLeast` 同文件；T3 改 registry 只加函数，不改 HTTP）：

```typescript
/**
 * 比较点分段版本。任一侧含非数字段（如 beta）则返回 null。
 */
export function compareDottedVersion(a: string, b: string): number | null {
	const pa = a.split('.').map((n) => parseInt(n, 10));
	const pb = b.split('.').map((n) => parseInt(n, 10));
	if (pa.some((n) => Number.isNaN(n)) || pb.some((n) => Number.isNaN(n))) return null;
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}
```

放进 `src/adapters/ecosystem-install.ts` 并 **export**：

```typescript
export async function isCompleteInstall(io: EcosystemIo, pluginDirRel: string, pluginId: string): Promise<boolean> {
	try {
		const man = JSON.parse(await io.readText(`${pluginDirRel}/manifest.json`)) as { id?: string };
		return man.id === pluginId;
	} catch {
		return false;
	}
}
```

`InstallResult.mode` 联合加上 `'already-installed'`。`InstallDeps` 增加 `pluginDir: string`（给日志/备份）。

- [ ] **Step 4: 改安装失败清理**

把 `installCommunityPlugin` **整函数**换成：

```typescript
export async function installCommunityPlugin(pluginId: string, deps: InstallDeps): Promise<InstallResult> {
	if (pluginId === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.ecosystem.self'));
	}
	return withPluginLock(pluginId, async () => {
		const catalog = await deps.registry.ensureCatalog();
		const entry = catalog.plugins.find((p) => p.id === pluginId);
		if (!entry) {
			throw new Error(tNow('error.ecosystem.notInCatalog', { id: pluginId }));
		}

		if (!deps.writeEnabled) {
			const uri = OFFICIAL_SHOW_PLUGIN(pluginId);
			await deps.openOfficialPage(uri);
			return {
				ok: true,
				mode: 'official-page',
				pluginId,
				officialUri: uri,
				filesWritten: false,
				enabled: false,
				message: tNow('ecosystem.install.officialPage', { id: pluginId, uri }),
			};
		}

		const pluginDirRel = `${deps.configDir}/plugins/${pluginId}`;
		const enableListRel = `${deps.configDir}/community-plugins.json`;
		if (await isCompleteInstall(deps.io, pluginDirRel, pluginId)) {
			return {
				ok: true,
				mode: 'already-installed',
				pluginId,
				filesWritten: false,
				message: tNow('ecosystem.install.already', { id: pluginId }),
			};
		}

		const existed = await deps.io.exists(pluginDirRel);
		const complete = await isCompleteInstall(deps.io, pluginDirRel, pluginId);
		const created = !existed;
		if (existed && !complete) {
			await deps.io.removeRecursive(pluginDirRel);
		}

		try {
			const resolved = await deps.registry.resolveReleaseVersion(entry.repo, deps.apiVersion);
			if (resolved.manifestId !== pluginId) {
				throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
			}
			const triple = await deps.registry.downloadTriple(entry.repo, resolved.version);
			const man = JSON.parse(triple.manifestText) as { id?: string };
			if (man.id !== pluginId) {
				throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
			}
			await deps.io.mkdir(pluginDirRel);
			await deps.io.writeText(`${pluginDirRel}/manifest.json`, triple.manifestText);
			await deps.io.writeBinary(`${pluginDirRel}/main.js`, triple.mainJs);
			if (triple.stylesCss != null) {
				await deps.io.writeText(`${pluginDirRel}/styles.css`, triple.stylesCss);
			}

			let enabledIds: string[] = [];
			try {
				enabledIds = JSON.parse(await deps.io.readText(enableListRel)) as string[];
				if (!Array.isArray(enabledIds)) enabledIds = [];
			} catch {
				enabledIds = [];
			}
			if (!enabledIds.includes(pluginId)) enabledIds.push(pluginId);
			await deps.io.writeText(enableListRel, JSON.stringify(enabledIds, null, 2));

			const enable = await tryEnableCommunityPlugin(
				deps.appLike as { plugins?: Parameters<typeof tryEnableCommunityPlugin>[0]['plugins'] },
				pluginId,
				pluginDirRel,
			);
			const change = await appendEcosystemChange(deps.pluginDir, {
				action: 'install',
				pluginId,
				summary: `${pluginId}@${resolved.version}`,
			});
			await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel: pluginDirRel });
			return {
				ok: true,
				mode: 'write',
				pluginId,
				filesWritten: true,
				enabled: enable.enabled,
				version: resolved.version,
				message: enable.enabled
					? tNow('ecosystem.install.enabled', { id: pluginId, version: resolved.version })
					: tNow('ecosystem.install.filesOnly', { id: pluginId, version: resolved.version }),
			};
		} catch (err) {
			if (created || (existed && !complete)) {
				try { await deps.io.removeRecursive(pluginDirRel); } catch { /* 半成品清理失败仍抛原错 */ }
			}
			throw err;
		}
	});
}
```

文件头增加 import：`withPluginLock`、`appendEcosystemChange`、`snapshotPluginDir`。

i18n 本 Task 加：`ecosystem.install.already`（zh: `已安装 {id}，未覆盖文件` / en: `{id} is already installed; files were not overwritten`）。

- [ ] **Step 5: 实现 `updateCommunityPlugin`**

`src/adapters/ecosystem-update.ts`：

```typescript
/**
 * @file src/adapters/ecosystem-update.ts
 * @description 只覆盖三件套的社区插件升级，保 data.json
 * @module adapters/ecosystem-update
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { restoreSnapshot, snapshotPluginDir } from '../core/ecosystem-backup';
import { compareDottedVersion, type EcosystemRegistry } from './ecosystem-registry';
import type { EcosystemIo } from './ecosystem-vault';
import { isCompleteInstall, OFFICIAL_SHOW_PLUGIN, type InstallDeps } from './ecosystem-install';
import { tryEnableCommunityPlugin } from './ecosystem-runtime';

export interface UpdateResult {
	ok: boolean;
	mode: 'write' | 'official-page' | 'already-current' | 'not-installed';
	pluginId: string;
	fromVersion?: string;
	toVersion?: string;
	dataJsonUnchanged: boolean;
	officialUri?: string;
	message: string;
}

export type UpdateDeps = InstallDeps & {
	confirmIncomparable?: (vers: { local: string; catalog: string }) => Promise<boolean>;
};

export async function updateCommunityPlugin(pluginId: string, deps: UpdateDeps): Promise<UpdateResult> {
	if (pluginId === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.ecosystem.self'));
	}
	return withPluginLock(pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
		if (!deps.writeEnabled) {
			const uri = OFFICIAL_SHOW_PLUGIN(pluginId);
			await deps.openOfficialPage(uri);
			return {
				ok: true,
				mode: 'official-page',
				pluginId,
				dataJsonUnchanged: true,
				officialUri: uri,
				message: tNow('ecosystem.install.officialPage', { id: pluginId, uri }),
			};
		}
		if (!(await isCompleteInstall(deps.io, pluginRel, pluginId))) {
			return {
				ok: false,
				mode: 'not-installed',
				pluginId,
				dataJsonUnchanged: true,
				message: tNow('error.ecosystem.notInstalled', { id: pluginId }),
			};
		}
		const catalog = await deps.registry.ensureCatalog();
		const entry = catalog.plugins.find((p) => p.id === pluginId);
		if (!entry) {
			throw new Error(tNow('error.ecosystem.notInCatalog', { id: pluginId }));
		}
		const localMan = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as { version?: string };
		const resolved = await deps.registry.resolveReleaseVersion(entry.repo, deps.apiVersion);
		if (resolved.manifestId !== pluginId) {
			throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
		}
		const cmp = compareDottedVersion(resolved.version, localMan.version ?? '0');
		if (cmp === 0) {
			return {
				ok: true,
				mode: 'already-current',
				pluginId,
				fromVersion: localMan.version,
				toVersion: resolved.version,
				dataJsonUnchanged: true,
				message: tNow('ecosystem.update.current', { id: pluginId, version: resolved.version }),
			};
		}
		if (cmp !== null && cmp < 0) {
			throw new Error(tNow('error.ecosystem.noDowngrade', { local: localMan.version ?? '', catalog: resolved.version }));
		}
		if (cmp === null && (localMan.version ?? '') !== resolved.version) {
			const ok = deps.confirmIncomparable ? await deps.confirmIncomparable({ local: localMan.version ?? '', catalog: resolved.version }) : true;
			if (!ok) throw new Error(tNow('error.ecosystem.updateCancelled'));
		}
		let dataBefore = '';
		try { dataBefore = await deps.io.readText(`${pluginRel}/data.json`); } catch { dataBefore = ''; }
		const change = await appendEcosystemChange(deps.pluginDir, {
			action: 'update',
			pluginId,
			summary: `${localMan.version ?? '?'}→${resolved.version}`,
			before: { version: localMan.version },
			after: { version: resolved.version },
		});
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		try {
			const triple = await deps.registry.downloadTriple(entry.repo, resolved.version);
			await deps.io.writeText(`${pluginRel}/manifest.json`, triple.manifestText);
			await deps.io.writeBinary(`${pluginRel}/main.js`, triple.mainJs);
			if (triple.stylesCss != null) {
				await deps.io.writeText(`${pluginRel}/styles.css`, triple.stylesCss);
			}
			let dataAfter = '';
			try { dataAfter = await deps.io.readText(`${pluginRel}/data.json`); } catch { dataAfter = ''; }
			if (dataAfter !== dataBefore) {
				throw new Error(tNow('error.ecosystem.dataJsonTouched'));
			}
			const enable = await tryEnableCommunityPlugin(
				deps.appLike as { plugins?: Parameters<typeof tryEnableCommunityPlugin>[0]['plugins'] },
				pluginId,
				pluginRel,
			);
			return {
				ok: true,
				mode: 'write',
				pluginId,
				fromVersion: localMan.version,
				toVersion: resolved.version,
				dataJsonUnchanged: true,
				message: enable.enabled
					? tNow('ecosystem.update.enabled', { id: pluginId, from: localMan.version ?? '', to: resolved.version })
					: tNow('ecosystem.update.filesOnly', { id: pluginId, from: localMan.version ?? '', to: resolved.version }),
			};
		} catch (e) {
			await restoreSnapshot({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
			throw e;
		}
	});
}
```

`src/tools/update-plugin.ts`：

```typescript
/**
 * @file src/tools/update-plugin.ts
 * @description update_plugin — 确认后只覆盖三件套
 * @module tools/update-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createUpdatePluginTool(
	definition: ToolDefinition,
	deps: { run: (pluginId: string) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			return deps.run(args.pluginId.trim());
		},
	};
}
```

i18n 本 Task 最少（zh / en / types 三处）：

| key | zh | en |
|---|---|---|
| `error.ecosystem.notInstalled` | 未安装插件 {id}，请先 install_plugin | Plugin {id} is not installed; use install_plugin first |
| `error.ecosystem.noDowngrade` | 本地 {local} 高于商店 {catalog}，拒绝降级 | Local {local} is newer than catalog {catalog}; downgrade refused |
| `error.ecosystem.dataJsonTouched` | 更新不得改动 data.json，已从备份恢复 | Update must not touch data.json; restored from backup |
| `ecosystem.update.current` | {id} 已是 {version}，无需更新 | {id} is already {version} |
| `ecosystem.update.filesOnly` | 已将 {id} 从 {from} 升到 {to}（未改 data.json），但尚未热启用 | Updated {id} {from}→{to} without touching data.json; not hot-enabled |
| `ecosystem.update.enabled` | 已将 {id} 从 {from} 升到 {to}（未改 data.json）并尝试启用 | Updated {id} {from}→{to} without touching data.json and tried to enable |

- [ ] **Step 6: 跑测试通过并提交**

Run: `npx vitest run tests/adapters/ecosystem-install.test.ts tests/adapters/ecosystem-update.test.ts tests/adapters/ecosystem-registry.test.ts`
Expected: PASS

```bash
git add src/adapters/ecosystem-install.ts src/adapters/ecosystem-registry.ts src/adapters/ecosystem-update.ts src/tools/update-plugin.ts src/i18n/zh.ts src/i18n/en.ts src/i18n/types.ts tests/adapters/ecosystem-install.test.ts tests/adapters/ecosystem-update.test.ts tests/adapters/ecosystem-registry.test.ts
git commit -m "$(cat <<'EOF'
feat: 已装不覆盖，并增加保配置的 update_plugin

安装失败不再误删完整目录；升级只换三件套，data.json 字节级不变。
EOF
)"
```

---

### Task 4: `configure_plugin`

**Files:**
- Create: `src/adapters/ecosystem-configure.ts`, `src/tools/configure-plugin.ts`
- Test: `tests/adapters/ecosystem-configure.test.ts`
- Modify: 无 T3 文件（本波并行）。已装判断用下面 `installed()` 三行，**禁止** `import { isCompleteInstall }`。

**Interfaces:**
- Consumes: T1 `applyLeafPatch` / `FORBID_KEY_RE` / `appendEcosystemChange` / `snapshotPluginDir` / `withPluginLock`
- Produces: `inspectPluginData`, `applyPluginData`, `createConfigurePluginTool`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/adapters/ecosystem-configure.test.ts
 * @description inspect / apply 点名 diff
 * @module adapters/ecosystem-configure.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { inspectPluginData, applyPluginData } from '../../src/adapters/ecosystem-configure';
import { createConfigurePluginTool } from '../../src/tools/configure-plugin';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-cfg-'));
});

function ioCal() {
	return new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
}

describe('configure', () => {
	it('inspect - 无 data.json 当空对象', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const r = await inspectPluginData('calendar', { io, configDir: '.obsidian' });
		expect(r.keys).toEqual([]);
	});
	it('inspect - apiKey 值打码', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ apiKey: 'secret', weekStart: 0 }));
		const r = await inspectPluginData('calendar', { io, configDir: '.obsidian' });
		expect(r.values.apiKey).not.toBe('secret');
		expect(r.values.weekStart).toBe(0);
	});
	it('apply - 只改点名叶子兄弟不变', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0, locale: 'zh' }));
		await applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['weekStart'] });
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json'))).toEqual({ weekStart: 1, locale: 'zh' });
	});
	it('apply - 命中启发式 - 整次失败零写盘', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ apiKey: 'a', weekStart: 0 }));
		await expect(applyPluginData('calendar', { apiKey: 'x' }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['apiKey'] })).rejects.toThrow();
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json')).apiKey).toBe('a');
	});
	it('apply - 新 key 未确认 - 失败', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{}');
		await expect(applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: [] })).rejects.toThrow();
	});
	it('apply - rename 失败 - 原 JSON 完好', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0 }));
		const orig = io.rename.bind(io);
		io.rename = async () => { throw new Error('rename-fail'); };
		await expect(applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['weekStart'] })).rejects.toThrow();
		io.rename = orig;
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json'))).toEqual({ weekStart: 0 });
	});
	it('configure 工具 - 缺省 op 走 inspect', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const tool = createConfigurePluginTool(
			{ name: 'configure_plugin', parameters: { type: 'object', properties: {} } },
			{ inspect: (id) => inspectPluginData(id, { io, configDir: '.obsidian' }), apply: async () => { throw new Error('should not apply'); } },
		);
		const r = await tool.execute({ pluginId: 'calendar' }) as { keys: string[] };
		expect(r.keys).toEqual([]);
	});
	it('configure 工具 - apply 无 patch 抛 invalidArg', async () => {
		const tool = createConfigurePluginTool(
			{ name: 'configure_plugin', parameters: { type: 'object', properties: {} } },
			{ inspect: async () => ({ keys: [], values: {} }), apply: async () => ({}) },
		);
		await expect(tool.execute({ pluginId: 'calendar', op: 'apply' })).rejects.toThrow();
	});
});
```

「只改点名」用例里 `weekStart` 已在文件中，但仍列入 `confirmedNewKeys` 无害；新 key 用例故意不列入。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-configure.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
/**
 * @file src/adapters/ecosystem-configure.ts
 * @description 点名读写他人 data.json
 * @module adapters/ecosystem-configure
 */
import { tNow } from '../i18n';
import { applyLeafPatch, FORBID_KEY_RE, parseSettingKey } from '../utils/setting-path';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { snapshotPluginDir } from '../core/ecosystem-backup';
import type { EcosystemIo } from './ecosystem-vault';

function rel(configDir: string, id: string): string {
	return `${configDir}/plugins/${id}`;
}

async function installed(io: EcosystemIo, pluginRel: string, pluginId: string): Promise<boolean> {
	try {
		const man = JSON.parse(await io.readText(`${pluginRel}/manifest.json`)) as { id?: string };
		return man.id === pluginId;
	} catch {
		return false;
	}
}

function flattenKeys(obj: Record<string, unknown>, prefix = '', depth = 0): string[] {
	if (depth >= 6) return prefix ? [prefix] : [];
	const keys: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v as Record<string, unknown>, path, depth + 1));
		else keys.push(path);
	}
	return keys;
}

export async function inspectPluginData(pluginId: string, deps: { io: EcosystemIo; configDir: string }) {
	if (!(await installed(deps.io, rel(deps.configDir, pluginId), pluginId))) {
		throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
	}
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(await deps.io.readText(`${rel(deps.configDir, pluginId)}/data.json`)) as Record<string, unknown>; } catch { data = {}; }
	const keys = flattenKeys(data);
	const values: Record<string, unknown> = {};
	for (const k of keys) {
		const segs = parseSettingKey(k);
		let cur: unknown = data;
		for (const s of segs) cur = (cur as Record<string, unknown>)?.[s];
		values[k] = FORBID_KEY_RE.test(k.split('.').pop() ?? k) ? '***' : cur;
	}
	return { keys, values };
}

export async function applyPluginData(
	pluginId: string,
	patch: Record<string, unknown>,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean; confirmedNewKeys: string[]; forbidKeys?: string[] },
) {
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	return withPluginLock(pluginId, async () => {
		const pluginRel = rel(deps.configDir, pluginId);
		if (!(await installed(deps.io, pluginRel, pluginId))) throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
		for (const k of Object.keys(patch)) {
			if (FORBID_KEY_RE.test(k) || deps.forbidKeys?.includes(k)) throw new Error(tNow('error.ecosystem.badKey', { key: k }));
		}
		let data: Record<string, unknown> = {};
		try { data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>; } catch { data = {}; }
		const existing = new Set(flattenKeys(data));
		for (const k of Object.keys(patch)) {
			if (!existing.has(k) && !deps.confirmedNewKeys.includes(k)) {
				throw new Error(tNow('error.ecosystem.newKey', { key: k }));
			}
		}
		const next = applyLeafPatch(data, patch);
		const change = await appendEcosystemChange(deps.pluginDir, { action: 'configure', pluginId, summary: Object.keys(patch).join(','), before: data, after: next });
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		const tmp = `${pluginRel}/data.json.tmp`;
		await deps.io.writeText(tmp, JSON.stringify(next, null, 2));
		JSON.parse(await deps.io.readText(tmp));
		await deps.io.rename(tmp, `${pluginRel}/data.json`);
		return { changed: Object.keys(patch).map((key) => ({ key, before: (data as Record<string, unknown>)[key], after: patch[key] })), changeId: change.id };
	});
}
```

T4 需要的 i18n（T7 会再补工具展示名）：`error.ecosystem.writeDisabled`、`error.ecosystem.newKey`、`error.ecosystem.badKey`、`error.ecosystem.notInstalled`（若 T3 未合，本 Task 也写同一 key，后合入不冲突）。

`src/tools/configure-plugin.ts`：

```typescript
/**
 * @file src/tools/configure-plugin.ts
 * @description configure_plugin — inspect 只读，apply 点名写
 * @module tools/configure-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createConfigurePluginTool(
	definition: ToolDefinition,
	deps: {
		inspect: (pluginId: string) => Promise<unknown>;
		apply: (pluginId: string, patch: Record<string, unknown>, confirmedNewKeys: string[]) => Promise<unknown>;
	},
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			const id = args.pluginId.trim();
			const op = args.op === 'apply' ? 'apply' : 'inspect';
			if (op !== 'apply') return deps.inspect(id);
			if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'patch', type: typeof args.patch }));
			}
			const confirmed = Array.isArray(args.confirmedNewKeys) ? args.confirmedNewKeys.map(String) : [];
			return deps.apply(id, args.patch as Record<string, unknown>, confirmed);
		},
	};
}
```

- [ ] **Step 4: 提交**

Run: `npx vitest run tests/adapters/ecosystem-configure.test.ts tests/utils/setting-path.test.ts`
Expected: PASS

```bash
git add src/adapters/ecosystem-configure.ts src/tools/configure-plugin.ts tests/adapters/ecosystem-configure.test.ts src/i18n/zh.ts src/i18n/en.ts src/i18n/types.ts
git commit -m "$(cat <<'EOF'
feat: configure_plugin 点名最小 diff 写他人 data.json

密钥类整次拒绝；新 key 必须确认；失败不留半截 JSON。
EOF
)"
```

---

### Task 5: 卸载、status、回滚

**Files:**
- Create: `src/adapters/ecosystem-uninstall.ts`, `src/adapters/ecosystem-status.ts`, `src/adapters/ecosystem-restore.ts`, `src/tools/uninstall-plugin.ts`, `src/tools/get-plugin-status.ts`, `src/tools/list-ecosystem-changes.ts`, `src/tools/restore-backup.ts`
- Modify: `src/adapters/ecosystem-runtime.ts`（加 `tryDisableCommunityPlugin`）
- Test: `tests/adapters/ecosystem-uninstall.test.ts`, `tests/adapters/ecosystem-status.test.ts`, `tests/adapters/ecosystem-restore.test.ts`

**Interfaces:**
- Consumes: T1 日志/备份/锁；T3 `isCompleteInstall` / `compareDottedVersion` / `OFFICIAL_SHOW_PLUGIN`
- Produces: `uninstallCommunityPlugin`, `listInstalledPlugins`, `getCommunityPluginStatus`, `restoreEcosystemBackup`

- [ ] **Step 1: 写失败测试**

`tests/adapters/ecosystem-uninstall.test.ts`：

```typescript
/**
 * @file tests/adapters/ecosystem-uninstall.test.ts
 * @description 卸载备份后删目录
 * @module adapters/ecosystem-uninstall.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { uninstallCommunityPlugin } from '../../src/adapters/ecosystem-uninstall';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-un-'));
});

describe('uninstallCommunityPlugin', () => {
	it('卸载 - 目录消失且启用清单无 id', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar', 'other']));
		const r = await uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} });
		expect(r.ok).toBe(true);
		expect(r.backedUp).toBe(true);
		expect(await io.exists('.obsidian/plugins/calendar/main.js')).toBe(false);
		expect(JSON.parse(await io.readText('.obsidian/community-plugins.json'))).toEqual(['other']);
	});
	it('卸载 - 下架 id 本地仍有目录 - 可卸', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set(['oldplug']) }));
		await io.writeText('.obsidian/plugins/oldplug/manifest.json', '{"id":"oldplug"}');
		await io.writeText('.obsidian/plugins/oldplug/main.js', 'JS');
		const r = await uninstallCommunityPlugin('oldplug', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} });
		expect(r.ok).toBe(true);
		expect(await io.exists('.obsidian/plugins/oldplug/main.js')).toBe(false);
	});
	it('卸载 - ratel-vault - 拒绝', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set(['ratel-vault']) }));
		await expect(uninstallCommunityPlugin('ratel-vault', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} })).rejects.toThrow();
	});
	it('卸载 - writeEnabled false - 零写盘', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await expect(uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: false, appLike: {} })).rejects.toThrow();
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('JS');
	});
	it('卸载 - 目录不存在 - 失败不造假成功', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		await expect(uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} })).rejects.toThrow();
	});
});
```

`tests/adapters/ecosystem-status.test.ts`：`http()` / `CAL` 从 install 测试复制（禁止抽公共文件改 T3）。`pluginDir` 给 Registry 缓存。

```typescript
/**
 * @file tests/adapters/ecosystem-status.test.ts
 * @description 已装列表默认不出站；checkUpdate 才拉 HEAD
 * @module adapters/ecosystem-status.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { getCommunityPluginStatus, listInstalledPlugins } from '../../src/adapters/ecosystem-status';
import { COMMUNITY_PLUGINS_CATALOG_URL, EcosystemRegistry, type HttpGet } from '../../src/adapters/ecosystem-registry';

const CAL = { id: 'calendar', name: 'Calendar', author: 'Liam Cain', description: 'Calendar', repo: 'liamcain/obsidian-calendar-plugin' };

function http(): HttpGet {
	const manifest = JSON.stringify({ id: 'calendar', version: '1.5.10', minAppVersion: '0.12.0' });
	const map: Record<string, { status: number; text: string }> = {
		[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify([CAL]) },
		[`https://raw.githubusercontent.com/${CAL.repo}/HEAD/manifest.json`]: { status: 200, text: manifest },
	};
	const seen: string[] = [];
	const fn: HttpGet = async (url) => {
		seen.push(url);
		(fn as HttpGet & { seen: string[] }).seen = seen;
		return map[url] ?? { status: 404, text: '' };
	};
	(fn as HttpGet & { seen: string[] }).seen = seen;
	return fn;
}

describe('status', () => {
	let pluginDir: string;
	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-st-'));
	});
	it('listInstalled - 省略 id 不出站且不含 ratel-vault', async () => {
		const fetch = http();
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar', 'ratel-vault']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar', version: '1.0.0' }));
		await io.writeText('.obsidian/plugins/ratel-vault/manifest.json', JSON.stringify({ id: 'ratel-vault', version: '0.8.0' }));
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar']));
		const list = await listInstalledPlugins({ io, configDir: '.obsidian' });
		expect(list.map((p) => p.id)).toEqual(['calendar']);
		expect((fetch as HttpGet & { seen: string[] }).seen).toEqual([]);
	});
	it('status - checkUpdate 返回 updateAvailable 且 URL 不含 latest', async () => {
		const fetch = http();
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar', version: '1.0.0' }));
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar']));
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const r = await getCommunityPluginStatus('calendar', { io, configDir: '.obsidian', registry: reg, checkUpdate: true, includeKeys: false });
		expect(r.installed).toBe(true);
		expect(r.catalogVersion).toBe('1.5.10');
		expect(r.updateAvailable).toBe(true);
		expect((fetch as HttpGet & { seen: string[] }).seen.some((u) => u.includes('/releases/latest'))).toBe(false);
	});
	it('status - 未装 installed false', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		const r = await getCommunityPluginStatus('calendar', { io, configDir: '.obsidian', registry: new EcosystemRegistry(pluginDir, http()), checkUpdate: false, includeKeys: false });
		expect(r.installed).toBe(false);
	});
});
```

`tests/adapters/ecosystem-restore.test.ts`：

```typescript
/**
 * @file tests/adapters/ecosystem-restore.test.ts
 * @description 按 changeId 恢复备份
 * @module adapters/ecosystem-restore.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { appendEcosystemChange, markChangeStatus } from '../../src/core/ecosystem-change-log';
import { snapshotPluginDir } from '../../src/core/ecosystem-backup';
import { restoreEcosystemBackup } from '../../src/adapters/ecosystem-restore';

describe('restoreEcosystemBackup', () => {
	let pluginDir: string;
	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-rs-'));
	});
	it('restore - 卸载后还原目录与启用清单', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar', 'other']));
		const change = await appendEcosystemChange(pluginDir, {
			action: 'uninstall',
			pluginId: 'calendar',
			summary: 'calendar',
			before: { enabledIds: ['calendar', 'other'] },
		});
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.removeRecursive('.obsidian/plugins/calendar');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['other']));
		await restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true });
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('JS');
		expect(JSON.parse(await io.readText('.obsidian/community-plugins.json'))).toEqual(['calendar', 'other']);
	});
	it('restore - 恢复后 data.json 回到 before 并追加 restore', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'weekStart' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":1}');
		const r = await restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true });
		expect(r.ok).toBe(true);
		expect(r.restoredAction).toBe('configure');
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0}');
	});
	it('restore - expired 失败', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'x' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await markChangeStatus(pluginDir, change.id, 'expired');
		await expect(restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true })).rejects.toThrow();
	});
	it('restore - 未知 id 失败', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set() }));
		await expect(restoreEcosystemBackup('ch_999999', { io, pluginDir, configDir: '.obsidian', writeEnabled: true })).rejects.toThrow();
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-uninstall.test.ts tests/adapters/ecosystem-status.test.ts tests/adapters/ecosystem-restore.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/adapters/ecosystem-runtime.ts` 追加：

```typescript
export async function tryDisableCommunityPlugin(
	appLike: { plugins?: PluginsHost & { disablePlugin?: (id: string) => void | Promise<void> } },
	pluginId: string,
): Promise<{ disabled: boolean }> {
	const plugins = appLike.plugins;
	if (!plugins || typeof plugins.disablePlugin !== 'function') return { disabled: false };
	try {
		await plugins.disablePlugin(pluginId);
		return { disabled: true };
	} catch {
		return { disabled: false };
	}
}
```

`src/adapters/ecosystem-uninstall.ts`：

```typescript
/**
 * @file src/adapters/ecosystem-uninstall.ts
 * @description 备份后禁用并删除社区插件目录
 * @module adapters/ecosystem-uninstall
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { snapshotPluginDir } from '../core/ecosystem-backup';
import type { EcosystemIo } from './ecosystem-vault';
import { tryDisableCommunityPlugin } from './ecosystem-runtime';

export async function uninstallCommunityPlugin(
	pluginId: string,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean; appLike: unknown },
): Promise<{ ok: boolean; backedUp: boolean; changeId: string; message: string }> {
	if (pluginId === RATEL_PLUGIN_ID) throw new Error(tNow('error.ecosystem.self'));
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	return withPluginLock(pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
		if (!(await deps.io.exists(pluginRel))) {
			throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
		}
		const enableListRel = `${deps.configDir}/community-plugins.json`;
		let enabledIds: string[] = [];
		try {
			enabledIds = JSON.parse(await deps.io.readText(enableListRel)) as string[];
			if (!Array.isArray(enabledIds)) enabledIds = [];
		} catch {
			enabledIds = [];
		}
		const change = await appendEcosystemChange(deps.pluginDir, {
			action: 'uninstall',
			pluginId,
			summary: pluginId,
			before: { enabledIds },
		});
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		await tryDisableCommunityPlugin(deps.appLike as { plugins?: Parameters<typeof tryDisableCommunityPlugin>[0]['plugins'] }, pluginId);
		const next = enabledIds.filter((id) => id !== pluginId);
		await deps.io.writeText(enableListRel, JSON.stringify(next, null, 2));
		await deps.io.removeRecursive(pluginRel);
		return { ok: true, backedUp: true, changeId: change.id, message: tNow('ecosystem.uninstall.done', { id: pluginId }) };
	});
}
```

`src/adapters/ecosystem-status.ts`：

```typescript
/**
 * @file src/adapters/ecosystem-status.ts
 * @description 本地已装列表与单插件 status
 * @module adapters/ecosystem-status
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { compareDottedVersion, type EcosystemRegistry } from './ecosystem-registry';
import type { EcosystemIo } from './ecosystem-vault';

export interface InstalledSummary {
	id: string;
	name: string;
	version: string;
	enabled: boolean;
}

export async function listInstalledPlugins(deps: { io: EcosystemIo; configDir: string }): Promise<InstalledSummary[]> {
	const ids = (await deps.io.listPluginIds(deps.configDir)).filter((id) => id !== RATEL_PLUGIN_ID);
	let enabled: string[] = [];
	try {
		enabled = JSON.parse(await deps.io.readText(`${deps.configDir}/community-plugins.json`)) as string[];
		if (!Array.isArray(enabled)) enabled = [];
	} catch {
		enabled = [];
	}
	const out: InstalledSummary[] = [];
	for (const id of ids) {
		try {
			const man = JSON.parse(await deps.io.readText(`${deps.configDir}/plugins/${id}/manifest.json`)) as { id?: string; name?: string; version?: string };
			if (man.id !== id) continue;
			out.push({ id, name: man.name ?? id, version: man.version ?? '', enabled: enabled.includes(id) });
		} catch {
			/* 半成品跳过 */
		}
	}
	return out;
}

export async function getCommunityPluginStatus(
	pluginId: string,
	deps: { io: EcosystemIo; configDir: string; registry: EcosystemRegistry; checkUpdate: boolean; includeKeys: boolean },
): Promise<{
	installed: boolean;
	id?: string;
	name?: string;
	version?: string;
	enabled?: boolean;
	directoryExists?: boolean;
	keys?: string[];
	catalogVersion?: string | null;
	updateAvailable?: boolean;
	message?: string;
}> {
	const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
	const directoryExists = await deps.io.exists(pluginRel);
	if (!directoryExists) return { installed: false, id: pluginId, directoryExists: false };
	let man: { id?: string; name?: string; version?: string } = {};
	try { man = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as typeof man; } catch { return { installed: false, id: pluginId, directoryExists: true }; }
	if (man.id !== pluginId) return { installed: false, id: pluginId, directoryExists: true };
	const list = await listInstalledPlugins(deps);
	const row = list.find((p) => p.id === pluginId);
	const result: Awaited<ReturnType<typeof getCommunityPluginStatus>> = {
		installed: true,
		id: pluginId,
		name: man.name ?? pluginId,
		version: man.version ?? '',
		enabled: row?.enabled ?? false,
		directoryExists: true,
	};
	if (deps.includeKeys) {
		try {
			const data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>;
			result.keys = Object.keys(data);
		} catch {
			result.keys = [];
		}
	}
	if (deps.checkUpdate) {
		try {
			const catalog = await deps.registry.ensureCatalog();
			const entry = catalog.plugins.find((p) => p.id === pluginId);
			if (!entry) {
				result.catalogVersion = null;
				result.updateAvailable = false;
				result.message = tNow('error.ecosystem.notInCatalog', { id: pluginId });
			} else {
				const resolved = await deps.registry.resolveReleaseVersion(entry.repo, '99.0.0');
				result.catalogVersion = resolved.version;
				result.updateAvailable = compareDottedVersion(resolved.version, man.version ?? '0') === 1;
			}
		} catch (e) {
			result.catalogVersion = null;
			result.updateAvailable = false;
			result.message = e instanceof Error ? e.message : String(e);
		}
	}
	return result;
}
```

`checkUpdate` 用 `'99.0.0'` 作 apiVersion 只为过 `minAppVersion` 闸；本函数不安装。若担心测试环境 minApp 极高，registry 测试已用 `0.12.0`。

`src/adapters/ecosystem-restore.ts`：

```typescript
/**
 * @file src/adapters/ecosystem-restore.ts
 * @description 按 changeId 把备份拷回插件目录
 * @module adapters/ecosystem-restore
 */
import { tNow } from '../i18n';
import { appendEcosystemChange, readAllChanges } from '../core/ecosystem-change-log';
import { restoreSnapshot } from '../core/ecosystem-backup';
import { withPluginLock } from '../core/ecosystem-lock';
import type { EcosystemIo } from './ecosystem-vault';

export async function restoreEcosystemBackup(
	changeId: string,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean },
): Promise<{ ok: boolean; restoredAction: string; message: string }> {
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	const rows = await readAllChanges(deps.pluginDir);
	const row = rows.find((r) => r.id === changeId);
	if (!row) throw new Error(tNow('error.ecosystem.unknownChange', { id: changeId }));
	if (row.status === 'expired') throw new Error(tNow('error.ecosystem.expiredChange', { id: changeId }));
	return withPluginLock(row.pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${row.pluginId}`;
		await restoreSnapshot({ pluginDir: deps.pluginDir, changeId, io: deps.io, pluginRel });
		const before = row.before as { enabledIds?: string[] } | undefined;
		if (Array.isArray(before?.enabledIds)) {
			await deps.io.writeText(`${deps.configDir}/community-plugins.json`, JSON.stringify(before.enabledIds, null, 2));
		}
		await appendEcosystemChange(deps.pluginDir, { action: 'restore', pluginId: row.pluginId, summary: changeId });
		return { ok: true, restoredAction: row.action, message: tNow('ecosystem.restore.done', { id: row.pluginId, action: row.action }) };
	});
}
```

四个工具薄包装：

`src/tools/uninstall-plugin.ts`：

```typescript
/**
 * @file src/tools/uninstall-plugin.ts
 * @description uninstall_plugin
 * @module tools/uninstall-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createUninstallPluginTool(
	definition: ToolDefinition,
	deps: { run: (pluginId: string) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			return deps.run(args.pluginId.trim());
		},
	};
}
```

`src/tools/restore-backup.ts`：

```typescript
/**
 * @file src/tools/restore-backup.ts
 * @description restore_backup
 * @module tools/restore-backup
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createRestoreBackupTool(
	definition: ToolDefinition,
	deps: { run: (changeId: string) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.changeId !== 'string' || args.changeId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'changeId', type: typeof args.changeId }));
			}
			return deps.run(args.changeId.trim());
		},
	};
}
```

`src/tools/list-ecosystem-changes.ts`：

```typescript
/**
 * @file src/tools/list-ecosystem-changes.ts
 * @description list_ecosystem_changes 只读
 * @module tools/list-ecosystem-changes
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

export function createListEcosystemChangesTool(
	definition: ToolDefinition,
	deps: { run: (opts: { pluginId?: string; limit?: number }) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const pluginId = typeof args.pluginId === 'string' && args.pluginId.trim() ? args.pluginId.trim() : undefined;
			let limit = typeof args.limit === 'number' ? args.limit : 20;
			if (!Number.isFinite(limit)) limit = 20;
			limit = Math.min(Math.max(Math.floor(limit), 1), 100);
			return deps.run({ pluginId, limit });
		},
	};
}
```

`src/tools/get-plugin-status.ts`：

```typescript
export function createGetPluginStatusTool(
	definition: ToolDefinition,
	deps: {
		list: () => Promise<unknown>;
		status: (pluginId: string, opts: { includeKeys: boolean; checkUpdate: boolean }) => Promise<unknown>;
	},
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				return deps.list();
			}
			return deps.status(args.pluginId.trim(), {
				includeKeys: args.includeKeys === true,
				checkUpdate: args.checkUpdate === true,
			});
		},
	};
}
```

i18n：`ecosystem.uninstall.done`、`ecosystem.restore.done`、`error.ecosystem.unknownChange`、`error.ecosystem.expiredChange`。

- [ ] **Step 4: 提交**

Run: `npx vitest run tests/adapters/ecosystem-uninstall.test.ts tests/adapters/ecosystem-status.test.ts tests/adapters/ecosystem-restore.test.ts`
Expected: PASS

```bash
git add src/adapters/ecosystem-uninstall.ts src/adapters/ecosystem-status.ts src/adapters/ecosystem-restore.ts src/adapters/ecosystem-runtime.ts src/tools/uninstall-plugin.ts src/tools/get-plugin-status.ts src/tools/list-ecosystem-changes.ts src/tools/restore-backup.ts tests/adapters/ecosystem-uninstall.test.ts tests/adapters/ecosystem-status.test.ts tests/adapters/ecosystem-restore.test.ts src/i18n/zh.ts src/i18n/en.ts src/i18n/types.ts
git commit -m "$(cat <<'EOF'
feat: 卸载、已装列表与备份回滚

下架仍可清理；status 默认不出站，checkUpdate 才拉商店 HEAD。
EOF
)"
```

---

### Task 6: 档案加载、三源覆盖、只读/草稿工具

**Files:**
- Create: `src/adapters/plugin-profile-fs.ts`, `src/tools/list-plugin-profiles.ts`, `src/tools/match-plugin-profiles.ts`, `src/tools/draft-plugin-profile.ts`, `src/profiles/builtin.ts`
- Modify: 无 T1–T5 文件
- Test: `tests/adapters/plugin-profile-fs.test.ts`, `tests/tools/match-plugin-profiles.test.ts`, `tests/tools/draft-plugin-profile.test.ts`, `tests/profiles/builtin.test.ts`

**Interfaces:**
- Consumes: T2 `validateProfile` / `matchProfiles` / `expandPresetPatch`
- Produces: `loadAllProfiles`, `createListPluginProfilesTool`, `createMatchPluginProfilesTool`, `createDraftPluginProfileTool`, `syncBuiltinProfiles`, `BUILTIN_CALENDAR_YAML`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/adapters/plugin-profile-fs.test.ts
 * @description 三源覆盖与诊断
 * @module adapters/plugin-profile-fs.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAllProfiles, syncBuiltinProfiles } from '../../src/adapters/plugin-profile-fs';
import { BUILTIN_CALENDAR_YAML } from '../../src/profiles/builtin';
import { readFileSync } from 'node:fs';

const SAMPLE = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
install: { source: community-store }
forbid: [apiKey]
presets:
  - id: week-start-monday
    when: 周一开始
    patch: { weekStart: 1 }
`;

function dirs() {
	const root = mkdtempSync(path.join(tmpdir(), 'ratel-pf-'));
	const pluginDir = path.join(root, 'plugin');
	const vaultRoot = path.join(root, 'vault');
	const homedir = path.join(root, 'home');
	mkdirSync(path.join(pluginDir, 'plugin-profiles'), { recursive: true });
	mkdirSync(path.join(homedir, '.ratel', 'plugin-profiles'), { recursive: true });
	mkdirSync(path.join(vaultRoot, '.ratel', 'plugin-profiles'), { recursive: true });
	return { pluginDir, vaultRoot, homedir };
}

describe('loadAllProfiles', () => {
	it('同 id - vault 覆盖 global 覆盖 builtin', async () => {
		const d = dirs();
		writeFileSync(path.join(d.pluginDir, 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.homedir, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginName: Calendar', 'pluginName: G'));
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginName: Calendar', 'pluginName: V'));
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.loaded).toBe(1);
		expect(r.get('calendar-week-start')?.pluginName).toBe('V');
	});
	it('同源两文件同 id - 按文件名排序丢后者并 idCollision', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'a-calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'z-calendar-week-start.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.diagnostics.some((x) => x.code === 'idCollision')).toBe(true);
		expect(r.loaded).toBe(1);
	});
	it('坏 YAML - parseError 不拖垮其它', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'bad.yaml'), ': : not yaml');
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.loaded).toBe(1);
		expect(r.diagnostics.some((x) => x.code === 'parseError')).toBe(true);
	});
	it('draft 文件 - 不进 match 池', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.draft.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.matchPool).toHaveLength(0);
		expect(r.diagnostics.some((x) => x.code === 'draftSkipped')).toBe(true);
	});
	it('unknownPluginId - 清单无此 id 不进 match', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginId: calendar', 'pluginId: nope'));
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.matchPool).toHaveLength(0);
		expect(r.diagnostics.some((x) => x.code === 'unknownPluginId')).toBe(true);
	});
	it('unverifiedStoreId - 清单 null 仍可 match', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: null });
		expect(r.matchPool).toHaveLength(1);
		expect(r.diagnostics.some((x) => x.code === 'unverifiedStoreId')).toBe(true);
	});
});

describe('syncBuiltinProfiles', () => {
	it('缺省写入 calendar YAML 且与常量一致', () => {
		const d = dirs();
		syncBuiltinProfiles(d.pluginDir);
		const onDisk = readFileSync(path.join(d.pluginDir, 'plugin-profiles', 'calendar-week-start.yaml'), 'utf-8');
		expect(onDisk).toBe(BUILTIN_CALENDAR_YAML);
		expect(readFileSync('plugin-profiles/calendar-week-start.yaml', 'utf-8').replace(/\r\n/g, '\n').trim()).toBe(BUILTIN_CALENDAR_YAML.trim());
	});
});
```

`tests/tools/match-plugin-profiles.test.ts`：

```typescript
/**
 * @file tests/tools/match-plugin-profiles.test.ts
 * @description utterance 命中示例 preset
 * @module tools/match-plugin-profiles.test
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAllProfiles } from '../../src/adapters/plugin-profile-fs';
import { createMatchPluginProfilesTool } from '../../src/tools/match-plugin-profiles';

const SAMPLE = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
install: { source: community-store }
forbid: []
presets:
  - id: week-start-monday
    when: 周一开始
    patch: { weekStart: 1 }
`;

it('match_plugin_profiles - 周一开始 - patchPreview.weekStart 为 1', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'ratel-mt-'));
	const pluginDir = path.join(root, 'p');
	const vaultRoot = path.join(root, 'v');
	const homedir = path.join(root, 'h');
	mkdirSync(path.join(vaultRoot, '.ratel', 'plugin-profiles'), { recursive: true });
	writeFileSync(path.join(vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
	const loaded = await loadAllProfiles({ pluginDir, vaultRoot, homedir, catalogIds: new Set(['calendar']) });
	const tool = createMatchPluginProfilesTool(
		{ name: 'match_plugin_profiles', parameters: { type: 'object', properties: {} } },
		{ getPool: () => loaded.matchPool },
	);
	const r = await tool.execute({ utterance: '周一开始' }) as { hits: Array<{ patchPreview: { weekStart: number } }> };
	expect(r.hits[0]!.patchPreview.weekStart).toBe(1);
});
```

`tests/tools/draft-plugin-profile.test.ts`：

```typescript
/**
 * @file tests/tools/draft-plugin-profile.test.ts
 * @description 草稿默认不生效且不调用 configure
 * @module tools/draft-plugin-profile.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { createDraftPluginProfileTool } from '../../src/tools/draft-plugin-profile';

it('draft_plugin_profile - 已装写出 enabled false 且含 apiKey forbid', async () => {
	setConfigDir('.obsidian');
	const vaultRoot = mkdtempSync(path.join(tmpdir(), 'ratel-dr-'));
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar' }));
	await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0, apiKey: 's' }));
	const tool = createDraftPluginProfileTool(
		{ name: 'draft_plugin_profile', parameters: { type: 'object', properties: {} } },
		{ io, configDir: '.obsidian', vaultRoot, homedir: vaultRoot },
	);
	const r = await tool.execute({ pluginId: 'calendar' }) as { path: string; draft: boolean };
	expect(r.draft).toBe(true);
	const text = readFileSync(r.path, 'utf-8');
	expect(text).toContain('enabled: false');
	expect(text).toContain('apiKey');
	expect(text).toContain('待作者填写');
	expect(text).toContain('patch: {}');
	expect(text).not.toMatch(/^[^#]*weekStart:\s*0/m);
});

it('draft_plugin_profile - 未装失败', async () => {
	setConfigDir('.obsidian');
	const vaultRoot = mkdtempSync(path.join(tmpdir(), 'ratel-dr2-'));
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
	const tool = createDraftPluginProfileTool(
		{ name: 'draft_plugin_profile', parameters: { type: 'object', properties: {} } },
		{ io, configDir: '.obsidian', vaultRoot, homedir: vaultRoot },
	);
	await expect(tool.execute({ pluginId: 'calendar' })).rejects.toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/plugin-profile-fs.test.ts tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现加载器与 builtin 常量**

`src/profiles/builtin.ts`：`BUILTIN_CALENDAR_YAML` 字符串与仓库 `plugin-profiles/calendar-week-start.yaml` **字节级相同**（含末尾换行）。`syncBuiltinProfiles` 可放 fs adapter。

```typescript
/**
 * @file src/profiles/builtin.ts
 * @description builtin 示例档案正文（与仓库 YAML 对拍）
 * @module profiles/builtin
 */
export const BUILTIN_CALENDAR_YAML = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
enabled: true
tags: [calendar, week]
install:
  source: community-store
forbid:
  - token
  - apiKey
presets:
  - id: week-start-monday
    when: 周一开始
    patch:
      weekStart: 1
`;
```

`src/adapters/plugin-profile-fs.ts`：

```typescript
/**
 * @file src/adapters/plugin-profile-fs.ts
 * @description 档案三源加载
 * @module adapters/plugin-profile-fs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_CALENDAR_YAML } from '../profiles/builtin';
import { validateProfile } from '../profiles/validate';
import type { PluginProfile } from '../profiles/types';
import type { ProfileDiagnostic, LoadReport } from '../profiles/types';

type Source = 'builtin' | 'global' | 'vault';

export interface LoadedProfiles extends LoadReport {
	get(id: string): (PluginProfile & { source: Source }) | undefined;
	matchPool: Array<PluginProfile & { source: Source }>;
}

function dirOf(source: Source, opts: { pluginDir: string; vaultRoot: string; homedir: string }): string {
	if (source === 'builtin') return path.join(opts.pluginDir, 'plugin-profiles');
	if (source === 'global') return path.join(opts.homedir, '.ratel', 'plugin-profiles');
	return path.join(opts.vaultRoot, '.ratel', 'plugin-profiles');
}

export function syncBuiltinProfiles(pluginDir: string): void {
	const dir = path.join(pluginDir, 'plugin-profiles');
	mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, 'calendar-week-start.yaml');
	if (!existsSync(dest)) writeFileSync(dest, BUILTIN_CALENDAR_YAML, 'utf-8');
}

export async function loadAllProfiles(opts: {
	pluginDir: string;
	vaultRoot: string;
	homedir: string;
	catalogIds: Set<string> | null;
}): Promise<LoadedProfiles> {
	const diagnostics: ProfileDiagnostic[] = [];
	const byId = new Map<string, PluginProfile>();
	for (const source of ['builtin', 'global', 'vault'] as const) {
		const dir = dirOf(source, opts);
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
		const seenHere = new Set<string>();
		for (const file of files) {
			const full = path.join(dir, file);
			const draft = file.includes('.draft.');
			let raw: unknown;
			try {
				const text = readFileSync(full, 'utf-8');
				raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
			} catch {
				diagnostics.push({ path: full, code: 'parseError', message: file });
				continue;
			}
			const v = validateProfile(raw);
			if (!v.ok) {
				diagnostics.push({ path: full, code: 'schemaInvalid', message: v.errors.join(',') });
				continue;
			}
			const profile = { ...v.profile, enabled: draft ? false : v.profile.enabled !== false, source };
			if (seenHere.has(profile.id)) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'idCollision', message: profile.id });
				continue;
			}
			seenHere.add(profile.id);
			byId.set(profile.id, profile);
			if (draft) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'draftSkipped', message: file });
				continue;
			}
			if (opts.catalogIds && !opts.catalogIds.has(profile.pluginId)) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'unknownPluginId', message: profile.pluginId });
				continue;
			}
			if (opts.catalogIds === null) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'unverifiedStoreId', message: profile.pluginId });
			}
		}
	}
	const pool = [...byId.values()].filter((p) => {
		if (p.enabled === false) return false;
		if (opts.catalogIds && !opts.catalogIds.has(p.pluginId)) return false;
		const skipped = diagnostics.some((x) => x.profileId === p.id && (x.code === 'draftSkipped' || x.code === 'unknownPluginId'));
		return !skipped;
	});
	return {
		loaded: byId.size,
		skipped: diagnostics.length,
		diagnostics,
		get: (id) => byId.get(id),
		matchPool: pool,
	};
}
```

vault 后写 `byId.set` 覆盖 builtin/global。`unverifiedStoreId` 仍进 `matchPool`。`draft` / `unknownPluginId` 不进。

- [ ] **Step 4: 三个工具**

`src/tools/list-plugin-profiles.ts`：

```typescript
/**
 * @file src/tools/list-plugin-profiles.ts
 * @description list_plugin_profiles 只读
 * @module tools/list-plugin-profiles
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

export function createListPluginProfilesTool(
	definition: ToolDefinition,
	deps: { run: () => unknown },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute() {
			return deps.run();
		},
	};
}
```

`src/tools/match-plugin-profiles.ts`：

```typescript
export function createMatchPluginProfilesTool(
	definition: ToolDefinition,
	deps: { getPool: () => PluginProfile[]; getExistingKeys?: (pluginId: string) => Promise<string[]> },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const utterance = typeof args.utterance === 'string' ? args.utterance.trim() : '';
			const pluginId = typeof args.pluginId === 'string' ? args.pluginId.trim() : '';
			const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
			if (!utterance && !pluginId && tags.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'utterance|pluginId|tags', type: 'empty' }));
			}
			const hits = matchProfiles(deps.getPool(), { utterance: utterance || undefined, pluginId: pluginId || undefined, tags: tags.length ? tags : undefined });
			return {
				hits: await Promise.all(hits.map(async (h) => {
					const profile = deps.getPool().find((p) => p.id === h.profileId)!;
					const preset = profile.presets.find((p) => p.id === h.presetId)!;
					const existingKeys = deps.getExistingKeys ? await deps.getExistingKeys(profile.pluginId) : [];
					const expanded = expandPresetPatch({ preset, forbid: profile.forbid, existingKeys });
					return {
						...h,
						patchPreview: expanded.patch,
						needsConfirm: expanded.needsConfirm,
						sopSkill: profile.sopSkill,
						pluginVersionRange: profile.pluginVersionRange,
					};
				})),
			};
		},
	};
}
```

`src/tools/draft-plugin-profile.ts`：已装才扫；`dest` 默认 vault；写出 `id: <pluginId>-draft`、`enabled: false`、`forbid` 为 `data.json` 键名匹配 `FORBID_KEY_RE` 的项。本文件禁止 import `applyPluginData` / `configure_plugin`。实现：

```typescript
export function createDraftPluginProfileTool(
	definition: ToolDefinition,
	deps: { io: EcosystemIo; configDir: string; vaultRoot: string; homedir: string },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || !args.pluginId.trim()) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			const pluginId = args.pluginId.trim();
			const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
			try {
				const man = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as { id?: string; name?: string; version?: string };
				if (man.id !== pluginId) throw new Error('bad');
				let data: Record<string, unknown> = {};
				try { data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>; } catch { data = {}; }
				const forbid = Object.keys(data).filter((k) => FORBID_KEY_RE.test(k));
				const dest = args.dest === 'global' ? path.join(deps.homedir, '.ratel', 'plugin-profiles') : path.join(deps.vaultRoot, '.ratel', 'plugin-profiles');
				mkdirSync(dest, { recursive: true });
				const filePath = path.join(dest, `${pluginId}-draft.draft.yaml`);
				const comments = Object.keys(data).map((k) => `# snapshot ${k}: ${JSON.stringify(data[k])}`);
				const yaml = [
					'kind: obsidian-plugin-profile',
					`id: ${pluginId}-draft`,
					`pluginId: ${pluginId}`,
					`pluginName: ${man.name ?? pluginId}`,
					`pluginVersionRange: ">=${man.version ?? '0.0.0'}"`,
					'enabled: false',
					'install:',
					'  source: community-store',
					'forbid:',
					...forbid.map((k) => `  - ${k}`),
					...comments,
					'presets:',
					'  - id: default',
					'    when: 待作者填写',
					'    patch: {}',
				].join('\n') + '\n';
				writeFileSync(filePath, yaml, 'utf-8');
				return { path: filePath, draft: true };
			} catch {
				throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
			}
		},
	};
}
```

- [ ] **Step 5: 提交**

Run: `npx vitest run tests/adapters/plugin-profile-fs.test.ts tests/profiles/ tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts`
Expected: PASS

```bash
git add src/adapters/plugin-profile-fs.ts src/profiles/builtin.ts src/tools/list-plugin-profiles.ts src/tools/match-plugin-profiles.ts src/tools/draft-plugin-profile.ts tests/adapters/plugin-profile-fs.test.ts tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts plugin-profiles schemas
git commit -m "$(cat <<'EOF'
feat: 插件档案三源加载与匹配/草稿工具

draft 默认不进池；写入仍不走档案层。
EOF
)"
```

---

### Task 7: 接线、i18n、SOP、破坏性集合、文档指针

**Files:**
- Modify: `src/main.ts`, `src/settings.ts`, `src/core/tool-permissions.ts`, `src/ui/chat/format-tool-display.ts`, `src/ui/components/confirm-modal.ts`, `src/prompts/tool-schemas.ts`, `src/prompts/sections.ts`, `src/prompts/defaults/zh.ts`, `src/i18n/{zh,en,types}.ts`, `src/adapters/ecosystem-registry.ts`（加 `peekCatalog()`，只读内存）
- Create: `src/skills/builtin/install-community-plugin/SKILL.md`, `plugin-profiles/SKILL-AUTHORING.md`, `src/core/ecosystem-confirm.ts`
- Modify（文档，本 Task 授权）: `docs/adr/2026-09-18-ecosystem-outbound.md`、`docs/architecture/host/ecosystem.md`
- Test: `tests/core/tool-permissions.test.ts`、`tests/prompts/sections.test.ts`

**Interfaces:**
- Consumes: T3–T6 全部 `create*Tool`
- Produces: 对话里可调 8 个生态工具 + 3 个档案工具；命令「重载插件档案」

- [ ] **Step 1: 失败测试 — 破坏性集合**

在 `tests/core/tool-permissions.test.ts` 的 `describe('isDestructiveTool')` 追加：

```typescript
it('isDestructiveTool - update/uninstall/configure/restore - true', () => {
	expect(isDestructiveTool('update_plugin')).toBe(true);
	expect(isDestructiveTool('uninstall_plugin')).toBe(true);
	expect(isDestructiveTool('configure_plugin')).toBe(true);
	expect(isDestructiveTool('restore_backup')).toBe(true);
	expect(isDestructiveTool('get_plugin_status')).toBe(false);
	expect(isDestructiveTool('search_plugins')).toBe(false);
});
```

在 `tests/prompts/sections.test.ts` 已有 `toolDescIds` 断言旁追加 9 行 `toContain`（见 Step 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/tool-permissions.test.ts tests/prompts/sections.test.ts`
Expected: 新断言 FAIL

- [ ] **Step 3: 接线**

`src/core/tool-permissions.ts`：

```typescript
const DESTRUCTIVE_TOOLS = new Set([
	'delete_note', 'forget_memory', 'update_app_config', 'install_plugin',
	'update_plugin', 'uninstall_plugin', 'configure_plugin', 'restore_backup',
]);
```

`summarizeToolCall` 的 `default` 之前加（不要 `as never`）：

```typescript
		case 'install_plugin':
		case 'update_plugin':
		case 'uninstall_plugin':
		case 'configure_plugin': {
			const id = typeof toolCall.args.pluginId === 'string' ? toolCall.args.pluginId : '';
			const keyMap: Record<string, 'tool.name.install_plugin' | 'tool.name.update_plugin' | 'tool.name.uninstall_plugin' | 'tool.name.configure_plugin'> = {
				install_plugin: 'tool.name.install_plugin',
				update_plugin: 'tool.name.update_plugin',
				uninstall_plugin: 'tool.name.uninstall_plugin',
				configure_plugin: 'tool.name.configure_plugin',
			};
			const key = keyMap[toolCall.name];
			return id && key ? tNow(key, { id }) : toolCall.name;
		}
		case 'restore_backup': {
			const id = typeof toolCall.args.changeId === 'string' ? toolCall.args.changeId : '';
			return id ? tNow('tool.name.restore_backup', { id }) : toolCall.name;
		}
```

`src/settings.ts` `DEFAULT_SETTINGS.toolPermissions` 在 `install_plugin: 'ask'` 后追加：

```typescript
		get_plugin_status: 'allow',
		list_ecosystem_changes: 'allow',
		list_plugin_profiles: 'allow',
		match_plugin_profiles: 'allow',
		update_plugin: 'ask',
		uninstall_plugin: 'ask',
		configure_plugin: 'ask',
		restore_backup: 'ask',
		draft_plugin_profile: 'ask',
```

`buildToolPermissionItems` 的 `map` 与 `allTools` 同步这 9 个名字（key 为 `settings.toolPermissions.<name>`）。

`src/prompts/tool-schemas.ts` 在 `install_plugin` 后追加 parameters，并写入 `ALL_TOOL_NAMES`：

```typescript
	update_plugin: { name: 'update_plugin', parameters: { type: 'object', properties: { pluginId: { type: 'string' } }, required: ['pluginId'] } },
	uninstall_plugin: { name: 'uninstall_plugin', parameters: { type: 'object', properties: { pluginId: { type: 'string' } }, required: ['pluginId'] } },
	configure_plugin: {
		name: 'configure_plugin',
		parameters: {
			type: 'object',
			properties: {
				pluginId: { type: 'string' },
				op: { type: 'string' },
				patch: { type: 'object' },
				confirmedNewKeys: { type: 'array', items: { type: 'string' } },
			},
			required: ['pluginId'],
		},
	},
	get_plugin_status: {
		name: 'get_plugin_status',
		parameters: {
			type: 'object',
			properties: {
				pluginId: { type: 'string' },
				includeKeys: { type: 'boolean' },
				checkUpdate: { type: 'boolean' },
			},
		},
	},
	list_ecosystem_changes: {
		name: 'list_ecosystem_changes',
		parameters: { type: 'object', properties: { pluginId: { type: 'string' }, limit: { type: 'number' } } },
	},
	restore_backup: { name: 'restore_backup', parameters: { type: 'object', properties: { changeId: { type: 'string' } }, required: ['changeId'] } },
	list_plugin_profiles: { name: 'list_plugin_profiles', parameters: { type: 'object', properties: {} } },
	match_plugin_profiles: {
		name: 'match_plugin_profiles',
		parameters: { type: 'object', properties: { utterance: { type: 'string' }, pluginId: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
	},
	draft_plugin_profile: {
		name: 'draft_plugin_profile',
		parameters: { type: 'object', properties: { pluginId: { type: 'string' }, dest: { type: 'string' } }, required: ['pluginId'] },
	},
```

`ALL_TOOL_NAMES` 在 `'install_plugin'` 后追加：

```typescript
	'update_plugin', 'uninstall_plugin', 'configure_plugin', 'get_plugin_status',
	'list_ecosystem_changes', 'restore_backup',
	'list_plugin_profiles', 'match_plugin_profiles', 'draft_plugin_profile',
```

`src/prompts/sections.ts` 在 `tool.install_plugin.param.pluginId` 块后追加（每个 description 一块；有参再加 param）。描述块模板：

```typescript
		{
			id: 'tool.update_plugin.description',
			label: tNow('promptLabel.tool.update_plugin.description'),
			description: tNow('promptLabel.tool.update_plugin.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.update_plugin.param.pluginId',
			label: tNow('promptLabel.tool.update_plugin.param.pluginId'),
			description: tNow('promptLabel.tool.update_plugin.param.pluginId.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
```

对下列 **每一个** id 各写一块（四个字段与上相同，只改 `id` 与两处 `tNow` 的 key）：

`tool.uninstall_plugin.description`、`tool.uninstall_plugin.param.pluginId`、`tool.configure_plugin.description`、`tool.configure_plugin.param.pluginId`、`tool.configure_plugin.param.op`、`tool.configure_plugin.param.patch`、`tool.get_plugin_status.description`、`tool.get_plugin_status.param.pluginId`、`tool.get_plugin_status.param.includeKeys`、`tool.get_plugin_status.param.checkUpdate`、`tool.list_ecosystem_changes.description`、`tool.list_ecosystem_changes.param.pluginId`、`tool.list_ecosystem_changes.param.limit`、`tool.restore_backup.description`、`tool.restore_backup.param.changeId`、`tool.list_plugin_profiles.description`、`tool.match_plugin_profiles.description`、`tool.match_plugin_profiles.param.utterance`、`tool.match_plugin_profiles.param.pluginId`、`tool.match_plugin_profiles.param.tags`、`tool.draft_plugin_profile.description`、`tool.draft_plugin_profile.param.pluginId`、`tool.draft_plugin_profile.param.dest`。

`src/prompts/defaults/zh.ts`：

```typescript
	'tool.update_plugin.description': '在用户确认后覆盖已装插件的三件套,不改 data.json',
	'tool.update_plugin.param.pluginId': '已装且仍在官方清单中的插件 id',
	'tool.uninstall_plugin.description': '在用户确认后备份并删除该社区插件目录',
	'tool.uninstall_plugin.param.pluginId': '本地已装插件 id(下架仍可卸)',
	'tool.configure_plugin.description': 'inspect 列出 data.json 的 key;apply 只改点名叶子',
	'tool.configure_plugin.param.pluginId': '已装插件 id',
	'tool.configure_plugin.param.op': 'inspect 或 apply,默认 inspect',
	'tool.configure_plugin.param.patch': 'apply 时的点号路径叶子对象',
	'tool.get_plugin_status.description': '省略 pluginId 列出已装;指定 id 看版本,checkUpdate 才出站',
	'tool.get_plugin_status.param.pluginId': '可选;省略则列出本地已装',
	'tool.get_plugin_status.param.includeKeys': 'true 时只回 data.json 的 key 名',
	'tool.get_plugin_status.param.checkUpdate': 'true 时拉 HEAD/manifest 比较版本',
	'tool.list_ecosystem_changes.description': '列出生态变更日志,新在前',
	'tool.list_ecosystem_changes.param.pluginId': '可选,按插件过滤',
	'tool.list_ecosystem_changes.param.limit': '默认 20,上限 100',
	'tool.restore_backup.description': '按 changeId 恢复该次备份',
	'tool.restore_backup.param.changeId': 'ecosystem-changes.jsonl 中的 id',
	'tool.list_plugin_profiles.description': '列出已加载且可匹配的插件档案(不含 draft)',
	'tool.match_plugin_profiles.description': '按 utterance/pluginId/tags 匹配档案 preset,只预览不写盘',
	'tool.match_plugin_profiles.param.utterance': '用户原话,如 周一开始',
	'tool.match_plugin_profiles.param.pluginId': '可选商店 id',
	'tool.match_plugin_profiles.param.tags': '可选标签数组',
	'tool.draft_plugin_profile.description': '从已装插件生成 enabled:false 的档案草稿,不调用 configure_plugin',
	'tool.draft_plugin_profile.param.pluginId': '已装插件 id',
	'tool.draft_plugin_profile.param.dest': 'vault 或 global,默认 vault',
```

`tests/prompts/sections.test.ts`：

```typescript
expect(toolDescIds).toContain('tool.update_plugin.description');
expect(toolDescIds).toContain('tool.uninstall_plugin.description');
expect(toolDescIds).toContain('tool.configure_plugin.description');
expect(toolDescIds).toContain('tool.get_plugin_status.description');
expect(toolDescIds).toContain('tool.list_ecosystem_changes.description');
expect(toolDescIds).toContain('tool.restore_backup.description');
expect(toolDescIds).toContain('tool.list_plugin_profiles.description');
expect(toolDescIds).toContain('tool.match_plugin_profiles.description');
expect(toolDescIds).toContain('tool.draft_plugin_profile.description');
```

`src/ui/chat/format-tool-display.ts` 在 `TOOL_NAME_KEY` 加：

```typescript
	update_plugin: 'tool.name.update_plugin',
	uninstall_plugin: 'tool.name.uninstall_plugin',
	configure_plugin: 'tool.name.configure_plugin',
	get_plugin_status: 'tool.name.get_plugin_status',
	list_ecosystem_changes: 'tool.name.list_ecosystem_changes',
	restore_backup: 'tool.name.restore_backup',
	list_plugin_profiles: 'tool.name.list_plugin_profiles',
	match_plugin_profiles: 'tool.name.match_plugin_profiles',
	draft_plugin_profile: 'tool.name.draft_plugin_profile',
```

`switch` 在 `install_plugin` case 后追加：

```typescript
		case 'update_plugin':
		case 'uninstall_plugin':
		case 'configure_plugin':
		case 'get_plugin_status':
		case 'draft_plugin_profile': {
			const id = extractShort(obj.pluginId);
			const key = TOOL_NAME_KEY[name];
			return id && key ? tNow(key, { id }) : name;
		}
		case 'restore_backup': {
			const id = extractShort(obj.changeId);
			const key = TOOL_NAME_KEY[name];
			return id && key ? tNow(key, { id }) : name;
		}
		case 'list_ecosystem_changes':
		case 'list_plugin_profiles':
		case 'match_plugin_profiles': {
			const key = TOOL_NAME_KEY[name];
			return key ? tNow(key) : name;
		}
```

`src/main.ts`：`syncBuiltinSkills` 后立刻 `syncBuiltinProfiles(pluginDir)`（onload 已有局部变量 `pluginDir`，**禁止** `this.manifest.dir`）。`loadAllProfiles` 结果挂实例字段。在 `createInstallPluginTool` 注册旁，每个工具闭包各自 `new AdapterEcosystemIo`。`update` 的 deps 与现网 install 相同并加上 `pluginDir`：

```typescript
		this.tools.register(createUpdatePluginTool(toolDefMap.get('update_plugin')!, {
			run: async (pluginId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const catalogIds = new Set(catalog.plugins.map((p) => p.id));
				const installedIds = listInstalledPluginIds();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({ catalogIds, installedIds }));
				return updateCommunityPlugin(pluginId, {
					registry: this.ecosystemRegistry,
					io,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
					apiVersion,
					openOfficialPage: (uri) => openExternalUrl(uri),
					appLike: this.app,
					pluginDir,
				});
			},
		}));
		this.tools.register(createUninstallPluginTool(toolDefMap.get('uninstall_plugin')!, {
			run: async (pluginId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const catalogIds = new Set(catalog.plugins.map((p) => p.id));
				const installedIds = listInstalledPluginIds();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({ catalogIds, installedIds }));
				return uninstallCommunityPlugin(pluginId, {
					io,
					pluginDir,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
					appLike: this.app,
				});
			},
		}));
		this.tools.register(createConfigurePluginTool(toolDefMap.get('configure_plugin')!, {
			inspect: async (id) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return inspectPluginData(id, { io, configDir: this.app.vault.configDir });
			},
			apply: async (id, patch, confirmedNewKeys) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return applyPluginData(id, patch, {
					io, pluginDir, configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled, confirmedNewKeys,
				});
			},
		}));
		this.tools.register(createGetPluginStatusTool(toolDefMap.get('get_plugin_status')!, {
			list: async () => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return listInstalledPlugins({ io, configDir: this.app.vault.configDir });
			},
			status: async (id, opts) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return getCommunityPluginStatus(id, {
					io, configDir: this.app.vault.configDir, registry: this.ecosystemRegistry, ...opts,
				});
			},
		}));
		this.tools.register(createListEcosystemChangesTool(toolDefMap.get('list_ecosystem_changes')!, {
			run: (opts) => listEcosystemChanges(pluginDir, opts),
		}));
		this.tools.register(createRestoreBackupTool(toolDefMap.get('restore_backup')!, {
			run: async (changeId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return restoreEcosystemBackup(changeId, {
					io, pluginDir, configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
				});
			},
		}));
		this.tools.register(createListPluginProfilesTool(toolDefMap.get('list_plugin_profiles')!, {
			run: () => ({
				profiles: this.pluginProfiles.matchPool.map((p) => ({
					id: p.id, pluginId: p.pluginId, pluginName: p.pluginName, source: p.source,
					enabled: p.enabled !== false, sopSkill: p.sopSkill, pluginVersionRange: p.pluginVersionRange,
					presets: p.presets.map((x) => ({ id: x.id, when: x.when })),
				})),
			}),
		}));
		this.tools.register(createMatchPluginProfilesTool(toolDefMap.get('match_plugin_profiles')!, {
			getPool: () => this.pluginProfiles.matchPool,
			getExistingKeys: async (pluginId) => {
				try {
					const catalog = await this.ecosystemRegistry.ensureCatalog();
					const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
						catalogIds: new Set(catalog.plugins.map((p) => p.id)),
						installedIds: listInstalledPluginIds(),
					}));
					return (await inspectPluginData(pluginId, { io, configDir: this.app.vault.configDir })).keys;
				} catch {
					return [];
				}
			},
		}));
		this.tools.register(createDraftPluginProfileTool(toolDefMap.get('draft_plugin_profile')!, {
			io: new AdapterEcosystemIo(this.app.vault.adapter, () => ({
				catalogIds: new Set(),
				installedIds: listInstalledPluginIds(),
			})),
			configDir: this.app.vault.configDir,
			vaultRoot: this.vault.getRootDir(),
			homedir: os.homedir(),
		}));
```

类上增加 `pluginProfiles!: LoadedProfiles`。启动与命令共用：

```typescript
private async reloadPluginProfiles(): Promise<void> {
	const vaultBase = this.vault.getRootDir();
	const pluginDir = path.join(vaultBase, this.app.vault.configDir, 'plugins', 'ratel-vault');
	let catalogIds: Set<string> | null = null;
	try {
		const catalog = await this.ecosystemRegistry.ensureCatalog();
		catalogIds = new Set(catalog.plugins.map((p) => p.id));
	} catch {
		catalogIds = null;
	}
	this.pluginProfiles = await loadAllProfiles({
		pluginDir,
		vaultRoot: vaultBase,
		homedir: os.homedir(),
		catalogIds,
	});
}
```

`syncBuiltinProfiles(pluginDir)` 之后 `void this.reloadPluginProfiles()`。

`addCommand`：

```typescript
		this.addCommand({
			id: 'ratel-reload-plugin-profiles',
			name: tNow('cmd.reloadPluginProfiles'),
			callback: () => {
				void this.reloadPluginProfiles();
			},
		});
```

生态写工具 **只在 adapter 内** `withPluginLock`，main 不要再套一层。

写工具 `run` 开头：

```typescript
if ((this.app as { restrictedMode?: boolean }).restrictedMode) {
	throw new Error(tNow('error.ecosystem.restricted'));
}
```

`src/ui/components/confirm-modal.ts`：`summarizeToolCall` 那段 `p` 之后，若 `toolCall.name` 属于 `install_plugin` / `update_plugin` / `uninstall_plugin` / `configure_plugin`，再 `createEl('p')` 两行：

1. 从 `this.app` 不直接 fetch；注入可选 `lookup?: (id: string) => { name: string; author: string; downloads: number | null } | undefined`。`showToolConfirmModal` 增加第三参 `lookup`。main 里用 `this.ecosystemRegistry` 已缓存 catalog（`ensureCatalog` 可能出站——**禁止在弹窗里出站**）。lookup 只读内存：给 Registry 加 `peekCatalog(): CatalogSnapshot | null`（未拉过则 null，弹窗只显示 pluginId）。
2. `update_plugin` 额外一行 `tNow('ecosystem.confirm.noDataJson')`。
3. `configure_plugin` 把 `JSON.stringify(args.patch)` 截断到 200 字符。

单测 `tests/ui/confirm-modal.test.ts` 可只测纯函数 `formatEcosystemConfirmLines(toolCall, peek)`（放 `src/core/ecosystem-confirm.ts`），避免挂 Obsidian Modal。

- [ ] **Step 4: i18n key（zh + en + types 同一批）**

在 `ToolPermStrings` / `ToolNameStrings` / `ErrorStrings` / `CmdStrings` / `PromptLabelStrings` / `EcosystemStrings` 追加。中文 / 英文：

```
settings.toolPermissions.update_plugin = 更新社区插件 / Update community plugin
settings.toolPermissions.uninstall_plugin = 卸载社区插件 / Uninstall community plugin
settings.toolPermissions.configure_plugin = 配置社区插件 / Configure community plugin
settings.toolPermissions.get_plugin_status = 查看插件状态 / Plugin status
settings.toolPermissions.list_ecosystem_changes = 查看生态变更 / Ecosystem changes
settings.toolPermissions.restore_backup = 恢复生态备份 / Restore ecosystem backup
settings.toolPermissions.list_plugin_profiles = 列出插件档案 / List plugin profiles
settings.toolPermissions.match_plugin_profiles = 匹配插件档案 / Match plugin profiles
settings.toolPermissions.draft_plugin_profile = 生成插件档案草稿 / Draft a plugin profile
tool.name.update_plugin = 更新插件 {id} / Update plugin {id}
tool.name.uninstall_plugin = 卸载插件 {id} / Uninstall plugin {id}
tool.name.configure_plugin = 配置插件 {id} / Configure plugin {id}
tool.name.get_plugin_status = 插件状态 {id} / Plugin status {id}
tool.name.list_ecosystem_changes = 生态变更 / Ecosystem changes
tool.name.restore_backup = 恢复备份 {id} / Restore backup {id}
tool.name.list_plugin_profiles = 插件档案 / Plugin profiles
tool.name.match_plugin_profiles = 匹配档案 / Match profiles
tool.name.draft_plugin_profile = 档案草稿 {id} / Profile draft {id}
cmd.reloadPluginProfiles = 重载插件档案 / Reload plugin profiles
error.ecosystem.writeDisabled = 已关闭生态写盘，请在设置打开 / Ecosystem writes are disabled; turn them on in settings
error.ecosystem.newKey = 将新增 key: {key}，需要确认 / New key {key} needs confirmation
error.ecosystem.badKey = 拒绝写入敏感 key: {key} / Refusing sensitive key {key}
error.ecosystem.unknownChange = 未知变更 {id} / Unknown change {id}
error.ecosystem.expiredChange = 备份已过期 {id} / Backup expired {id}
error.ecosystem.updateCancelled = 已取消无法比较版本的更新 / Cancelled update because versions are incomparable
error.ecosystem.restricted = 请先在设置关闭「限制社区插件」/ Turn off Restricted mode before ecosystem writes
ecosystem.confirm.noDataJson = 不改 data.json / Will not modify data.json
ecosystem.confirm.authorDownloads = {name} · {author} · 下载 {downloads} / {name} · {author} · {downloads} downloads
profile.match.empty = 没有匹配的插件档案 / No matching plugin profiles
profile.versionMismatch = 已装 {installed} 不满足 {range} / Installed {installed} does not satisfy {range}
```

每个新工具的 `promptLabel.tool.<name>.description` = `'<name> description'`（与现网 install 一样英文 id），`.desc` 用中/英说明。`promptLabel.tool.<name>.param.<p>` 同样。

- [ ] **Step 5: builtin SOP**

创建 `src/skills/builtin/install-community-plugin/SKILL.md`（`inlineBuiltinSkillsPlugin` 会扫子目录）：

```markdown
---
name: install-community-plugin
description: 在官方社区商店内寻找、安装、更新、配置或卸载插件。用户说看板、日历、任务插件、装一个插件、更新插件、把周一开始时激活。
activation: auto
tags: [plugin, ecosystem]
---

# 安装官方商店插件

当用户要用某个社区能力（看板、日历、任务…）而当前库没有对应插件时：

1. 调用 search_plugins，只推荐返回列表里的项（作者、下载量或未知、是否已装）。
2. 用户点名一个 id 后调用 install_plugin；被拒绝或官方页模式则停止，不要改用脚本或笔记工具写配置目录。
3. 用户要更新已装插件时调用 update_plugin，不要用 install_plugin 覆盖。更新不得改 data.json。
4. 需要改设置时：先 match_plugin_profiles。有 hit 则：
   - 调 get_plugin_status（该 pluginId）。未装 → 用户确认后 install_plugin，不要据 unverifiedStoreId 安装。
   - 已装 version 不满足 hit.pluginVersionRange → 说明 mismatch，用户同意则 update_plugin，拒绝则不要 configure（除非用户明确要写并带上 needsConfirm）。
   - hit.sopSkill 存在且用户未拒绝说明 → activate_skill（只注入，不写盘）。
   - 把 patchPreview 交给 configure_plugin op=apply，confirmedNewKeys 用 hit.needsConfirm。
   无 hit 则 configure_plugin op=inspect，再按用户点名的 key apply。密钥类不要填。
5. 用户要卸：uninstall_plugin。不要自己删 .obsidian。
```

禁止在 SOP 里贴整份 `data.json`。

同 Task 创建 `plugin-profiles/SKILL-AUTHORING.md`：

```markdown
# 写一份社区插件 SOP Skill

放在 vault 或 global 的 Skill 目录，frontmatter 与其它 Skill 相同。正文只许教模型调工具，禁止脚本写 `.obsidian`。

## 工具（权限以设置为准）

只读：search_plugins、get_plugin_status、list_ecosystem_changes、list_plugin_profiles、match_plugin_profiles
需确认：install_plugin、update_plugin、uninstall_plugin、configure_plugin、restore_backup、draft_plugin_profile

## 流程

与 builtin `install-community-plugin` 五步相同。更新只走 update_plugin。配置只走 configure_plugin。档案 sopSkill 用 activate_skill 注入说明，仍不降 ask。

## 禁止

- run_skill_script 写 configDir / 他人 data.json
- 贴整份 data.json 让模型 extra 写盘
- 店外 URL / 管理 ratel-vault
```

- [ ] **Step 6: ADR / 架构指针**

`docs/adr/2026-09-18-ecosystem-outbound.md`：

§2 `install_plugin` 那条后面插入：

```markdown
- **`update_plugin`:** 同样仅在权限门放行之后才下载该 repo 同名 tag 三件套；拒绝则零出站、零写盘。不得请求 `/releases/latest`。
- **`get_plugin_status` 且 `checkUpdate=true`:** 只拉该 repo 的 `raw.githubusercontent.com/.../HEAD/manifest.json`，不拉 github.com release 资产。
```

§2 表「仅 `install_plugin` 且用户已确认」改为「仅 `install_plugin` / `update_plugin` 且用户已确认」。

§13 删除整行 `- 本刀不实现 \`update_plugin\`、\`configure_plugin\`、卸载回滚全集(可后续同一支柱)`，改为：

```markdown
- 配置、卸载、回滚已由 S-ECOSYSTEM 底座 plan（P-ECOSYSTEM-2）落地；本 ADR 仍禁止店外安装与管理 ratel-vault 自己
```

§10「**非本 ADR,第三刀。**」改为「点名改 `data.json` 见 S-ECOSYSTEM `configure_plugin`；本 ADR 仍禁止 Skill 脚本写 `configDir`。」

`docs/architecture/host/ecosystem.md`：

- 删除「现网：上述工具均未实现。」改为「现网（P-ECOSYSTEM-2）：search / install / update / uninstall / status / configure / changes / restore 已接线；档案只读匹配见 plugin-profile。」
- §4.3 全文换成：

```markdown
与安装相同按 HEAD/manifest 的 version 定位同名 tag，**只覆盖** `main.js` / `manifest.json` / 若 release 含则 `styles.css`。禁止写或删目标 `data.json`。本地 version 已等于 HEAD → already-current；本地高于 HEAD → 拒绝降级。未装 → 拒绝（走 install）。失败从本次整目录备份恢复。
```

§4.5 「是否落后于商店 latest」改为「是否落后于该 repo HEAD/manifest 的 version」。**不改**模块边界与端口文件名。

- [ ] **Step 7: 全量验证**

Run:

```
npx vitest run tests/adapters/ecosystem-*.test.ts tests/profiles tests/utils/setting-path.test.ts tests/core/ecosystem-*.test.ts tests/core/tool-permissions.test.ts tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts tests/prompts/sections.test.ts
npx tsc --noEmit --skipLibCheck
npm run lint
```

Expected: tests PASS；tsc 0 error；lint 0 error（允许既有 warning）

```bash
git add src/main.ts src/settings.ts src/core/tool-permissions.ts src/ui/chat/format-tool-display.ts src/prompts src/i18n src/skills/builtin/install-community-plugin/SKILL.md docs/adr/2026-09-18-ecosystem-outbound.md docs/architecture/host/ecosystem.md tests/core/tool-permissions.test.ts tests/prompts/sections.test.ts
git commit -m "$(cat <<'EOF'
feat: 接线生态与档案工具，并补社区安装 SOP

对话可装/升/卸/配/回滚；Skill 只教调工具，脚本仍进不了配置目录。
EOF
)"
```

## 自审

**1. Spec 覆盖**

| Spec | 任务 |
|---|---|
| EC-01 search | 已在 P-ECOSYSTEM-1 |
| EC-02 / EC-10 install + already-installed | T3 |
| EC-03 update 保 data.json | T3 |
| EC-04 uninstall | T5 |
| EC-05 configure | T4 |
| EC-06 / 07 日志回滚 | T1 + T5 |
| EC-08 通道 B | 已有；T1 扩展 list/copy |
| PP-08 denylist | 已有 |
| PP-01～04 / 09 schema 示例草稿 | T2 + T6 |
| PP-05～07 匹配消费 | T6；写入 T4 |
| Skill SOP | T7 |
| 破坏性 / i18n / 命令 | T7 |
| EC-09 / versions.json / 降级 | 故意不做 |

**2. 占位符：** 全文无 TBD / `/* ... */` /「形状同 Task N」。T1–T7 均含失败测试 + 实现正文 + 提交命令。T4 与 T3 并行时用本地 `installed()`，不 import `isCompleteInstall`。

**3. 类型：** `EcosystemPort` / `PluginProfile` / `LoadReport` / `applyLeafPatch` / `compareDottedVersion` / `isCompleteInstall` / `create*Tool` 名称跨 Task 一致。工具文件名 `get-plugin-status.ts` 对应 `get_plugin_status`。onload 用局部变量 `pluginDir`，不用 `manifest.dir`。

**4. 并行安全：** Wave 1 T1∥T2；Wave 2 T3∥T4；Wave 3 T5∥T6；Wave 4 T7。同波不改同一文件。

**6. 审查补丁（相对第一版 plan）：** 作者 SOP 文档钉 `plugin-profiles/SKILL-AUTHORING.md`；match/list 回 `sopSkill` / `pluginVersionRange` / `needsConfirm`；draft 空 patch；restore 还原启用清单；update 失败整目录恢复 + 不可比版本二次确认；configure rename 失败原 JSON 完好；确认弹窗补作者/下载量/不改 data.json；受限模式拒绝写盘。

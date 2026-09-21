# 社区插件底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `v9` 已有 search/install 上交出社区插件底座：卸 / 升（保 `data.json`）/ 点名配 / 日志回滚 + 一份可校验档案（schema、匹配、草稿、Calendar 示例）。

**Architecture:** 笔记工具继续走通道 A。生态 IO 只走通道 B + 独立 adapter。变更日志与备份写在 Ratel `pluginDir`（node:fs），不进 vault、不出网。档案纯逻辑在 `src/profiles/`（禁止 `import 'obsidian'`），写入永远调用已有/本 plan 落地的 `configure_plugin`，禁止第二套写盘。

**Tech Stack:** TypeScript / vitest / 现有 i18n 与工具权限门 / `yaml`（纯 JS，无原生模块）解析档案 / Obsidian `requestUrl` + `DataAdapter`。

**Spec:** [S-ECOSYSTEM](../specs/2026-08-20-ecosystem-management-design.md) + [S-PLUGIN-PROFILE](../specs/2026-09-10-plugin-profile-design.md)。基线切片 [P-ECOSYSTEM-1](2026-09-18-ecosystem-first-slice.md) 已合 `v9`，本 plan **不再冻结加功能**。

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

`tests/core/ecosystem-lock.test.ts`：并发两次 `withPluginLock('calendar', ...)`，后一次必须等前一次 `release` 后再进入。

`tests/core/ecosystem-change-log.test.ts`：临时 `pluginDir`，`appendEcosystemChange` 两次，`listEcosystemChanges({ limit: 1 })` 只返回最新；`pluginId` 过滤生效。

`tests/core/ecosystem-backup.test.ts`：`snapshotPluginDir` 把 `{configDir}/plugins/calendar/{manifest.json,data.json}` 拷到 `pluginDir/ecosystem-backups/ch_1/`；再改源文件；`restoreSnapshot` 后 `data.json` 回到快照。每插件第 4 份快照时最旧标 `expired`（改 jsonl `status`）。

- [ ] **Step 5: 实现锁、日志、备份**

`withPluginLock`：`Map<string, Promise<unknown>>`，同 id then 链，**finally 不删自己之后排队的链**。不同 id 不互等。

`appendEcosystemChange(pluginDir, entry)`：`pluginDir/ecosystem-changes.jsonl`，原子 append（读+写或 `fs.appendFile`）。字段按 spec §5.7。`id` 用 `ch_` + 6 位递增（读最后一行解析，空则 `ch_000001`）。

`snapshotPluginDir({ pluginDir, changeId, io, pluginRel })`：`copyTree` 到 `pluginDir/ecosystem-backups/<changeId>/`。备份根在 Ratel `pluginDir`，**不走通道 B**（node:fs）。源树走 `EcosystemIo.copyTree`。

`EcosystemIo` 增：

```typescript
listPluginIds(configDir: string): Promise<string[]>; // plugins/ 下目录名，排除 ratel-vault
copyTree(srcRel: string, dstAbs: string): Promise<void>; // dstAbs 是 pluginDir 备份路径，node:fs 写
readBinary?(rel: string): Promise<ArrayBuffer>;
```

`MemoryEcosystemIo` 同步实现：`listPluginIds` 从 `files` 键推断；`copyTree` 把匹配前缀的条目写到 `dstAbs`（`node:fs` mkdir+writeFile）。

过期策略：同一 `pluginId` 的 `recorded` 备份 >3 时，最旧目录删掉，对应 jsonl 行 `status: expired`（允许重写整个 jsonl 文件，append-only 对业务行仍只追加 `restore` 行；**过期是改 status 字段** — 实现用读入全部行、改匹配行、整文件写回，并在注释写「过期改 status 不是业务 append」）。

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

`tests/profiles/match.test.ts`：

- draft / `enabled: false` 不进池
- `pluginId` 精确 +100；utterance「周一开始」命中示例 `when`，`presetId === 'week-start-monday'`
- 无命中空数组；最多 5 条；同分按 `profileId` 字母序

`tests/profiles/expand.test.ts`：展开去掉 `forbid` 与未选 key；新 key 标 `needsConfirm`。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/profiles/`
Expected: FAIL

- [ ] **Step 4: 实现校验 / 匹配 / 展开**

`src/profiles/types.ts`：字段与 spec §6 一字不差（`kind` / `id` pattern `/^[a-z][a-z0-9-]{0,63}$/` / `pluginVersionRange` 只认 `*`、`x.y.z`、`>=x.y.z`）。

`validateProfile(raw)`：手写校验，**不引入 ajv**。`schemas/obsidian-plugin-profile.schema.json` 与手写规则对齐，给作者看，运行时不必加载。

`matchProfiles(pool, query)`：权重 +100 / +20 / +10，见 spec §9。池由调用方传入（本 Task 不读盘）。

`expandPresetPatch({ preset, forbid, existingKeys, selectedKeys? })`：返回 `{ patch, needsConfirm: string[] }`。

- [ ] **Step 5: 示例 YAML + AUTHORING.md**

`plugin-profiles/calendar-week-start.yaml` 正文用 spec §14 那份。`AUTHORING.md` 六条硬规则抄 spec §14.1。

加单测：读该 YAML（`yaml.parse`）后 `validateProfile` ok。

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
	// 先 R2 装入，改 main.js 为 marker，再 install
	// expect mode already-installed；io 中 main.js 仍为 marker
});

it('安装失败不得删除已完整安装的目录', async () => {
	// 先完整写入 manifest+main.js；第二次 http 让 downloadTriple 失败
	// expect 抛错且 manifest 仍在
});
```

`tests/adapters/ecosystem-update.test.ts`：

```typescript
it('update - 覆盖三件套后 data.json 字节不变', async () => { /* ... */ });
it('update - 已是 HEAD version - already-current 零写 main.js', async () => { /* ... */ });
it('update - 本地 2.0.0 高于商店 1.0.0 - 不降级', async () => { /* ... */ });
it('update - 写入失败从备份恢复含原 data.json', async () => { /* 第二次 writeText 抛错 */ });
it('update - 未装 - not-installed', async () => { /* ... */ });
it('update - R3 零写盘开官方页', async () => { /* ... */ });
it('update - 新 release 无 styles.css - 旧 styles.css 仍在', async () => { /* ... */ });
```

`compareDottedVersion` 单测可放 registry 测试文件：`'1.10.0' > '1.9.0'`；`'1.0.0-beta'` 无法比较返回 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-install.test.ts tests/adapters/ecosystem-update.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: `compareDottedVersion` + `isCompleteInstall`**

```typescript
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

`isCompleteInstall`：`exists(pluginDirRel/manifest.json)` 且 JSON `id === pluginId`。

- [ ] **Step 4: 改安装失败清理**

`installCommunityPlugin`：

1. 开头若 `isCompleteInstall` → `{ ok: true, mode: 'already-installed', filesWritten: false, ... }`，**先不下载**。
2. `let created = !(await io.exists(pluginDirRel))`；半成品（存在但无合法 manifest）可 `removeRecursive` 后再装。
3. `catch`：**仅当 `created` 或确认半成品**才 `removeRecursive`；完整安装失败禁止删目录。

成功路径：`snapshot`（若覆盖半成品）+ `appendEcosystemChange` action `install`。用 `withPluginLock(pluginId, ...)` 包住。

- [ ] **Step 5: 实现 `updateCommunityPlugin`**

流程严格按 spec §5.5 更新 R2/R3。伪代码：

```typescript
export async function updateCommunityPlugin(pluginId: string, deps: UpdateDeps): Promise<UpdateResult> {
	return withPluginLock(pluginId, async () => {
		if (pluginId === RATEL_PLUGIN_ID) throw new Error(tNow('error.ecosystem.self'));
		if (!deps.writeEnabled) { /* 开官方页，mode official-page */ }
		if (!(await isCompleteInstall(deps.io, rel, pluginId))) {
			return { ok: false, mode: 'not-installed', dataJsonUnchanged: true, message: tNow('error.ecosystem.notInstalled', { id: pluginId }) };
		}
		const localMan = JSON.parse(await deps.io.readText(`${rel}/manifest.json`)) as { version?: string };
		const resolved = await deps.registry.resolveReleaseVersion(entry.repo, deps.apiVersion);
		const cmp = compareDottedVersion(resolved.version, localMan.version ?? '0');
		if (cmp === 0) return { ok: true, mode: 'already-current', dataJsonUnchanged: true, fromVersion: localMan.version, toVersion: resolved.version, message: tNow('ecosystem.update.current', { id: pluginId, version: resolved.version }) };
		if (cmp !== null && cmp < 0) throw new Error(tNow('error.ecosystem.noDowngrade', { local: localMan.version ?? '', catalog: resolved.version }));
		const dataBefore = await deps.io.readText(`${rel}/data.json`).catch(() => '');
		const changeId = await snapshotThenLog(... action update ...);
		try {
			const triple = await deps.registry.downloadTriple(entry.repo, resolved.version);
			await deps.io.writeText(`${rel}/manifest.json`, triple.manifestText);
			await deps.io.writeBinary(`${rel}/main.js`, triple.mainJs);
			if (triple.stylesCss != null) await deps.io.writeText(`${rel}/styles.css`, triple.stylesCss);
			const dataAfter = await deps.io.readText(`${rel}/data.json`).catch(() => '');
			if (dataAfter !== dataBefore) throw new Error(tNow('error.ecosystem.dataJsonTouched'));
			await tryEnableCommunityPlugin(...);
			return { ok: true, mode: 'write', dataJsonUnchanged: true, fromVersion: localMan.version, toVersion: resolved.version, message: ... };
		} catch (e) {
			await restoreSnapshot(...); // 整目录
			throw e;
		}
	});
}
```

`src/tools/update-plugin.ts` 形状抄 `install-plugin.ts`（`args.pluginId`）。

i18n 本 Task 用到的 key 一并加（error / ecosystem.update.*），T7 会再补工具展示名。本 Task 最少：

- `error.ecosystem.notInstalled`
- `error.ecosystem.noDowngrade`
- `error.ecosystem.dataJsonTouched`
- `ecosystem.update.current`
- `ecosystem.update.filesOnly`
- `ecosystem.update.enabled`

- [ ] **Step 6: 跑测试通过并提交**

Run: `npx vitest run tests/adapters/ecosystem-install.test.ts tests/adapters/ecosystem-update.test.ts tests/adapters/ecosystem-registry.test.ts`
Expected: PASS

```bash
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

**Interfaces:**
- Consumes: T1 `applyLeafPatch` / `FORBID_KEY_RE` / `appendEcosystemChange` / `snapshotPluginDir` / `withPluginLock`
- Produces: `inspectPluginData`, `applyPluginData`

- [ ] **Step 1: 写失败测试**

```typescript
it('inspect - 无 data.json 当空对象', async () => { /* keys [] */ });
it('inspect - apiKey 值打码', async () => {
	// data.json { apiKey: 'secret', weekStart: 0 }
	// values.apiKey !== 'secret'；weekStart 为 0
});
it('apply - 只改点名叶子兄弟不变', async () => { /* ... */ });
it('apply - 命中 forbid/启发式 - 整次失败零写盘', async () => { /* patch { apiKey: 'x' } */ });
it('apply - 新 key 标 needsConfirm 且未确认则失败', async () => {
	// 实现：applyPluginData 第三参 { confirmedNewKeys?: string[] }
	// 无 confirmedNewKeys 时新 key 抛 error.ecosystem.newKey
});
it('apply - 中途写失败原 JSON 完好', async () => { /* io.writeText 第一次成功后第二次抛 — 用 tmp+rename 语义：MemoryIo 先写 tmp 再 rename */ });
```

工具层测试：`op` 缺省且无 patch → inspect；`op: apply` 无 patch 抛 `invalidArg`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-configure.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`inspectPluginData`：未装抛 `notInstalled`。读 `data.json`（无则 `{}`）。列出点号可达叶子（只展开 plain object，深度 ≤6，跳过数组）。值：key 名匹配 `FORBID_KEY_RE` 则替换为 `'***'`。

`applyPluginData(pluginId, patch, opts)`：

1. 未装拒绝；`writeEnabled===false` 拒绝 `error.ecosystem.writeDisabled`
2. 任一 patch key 匹配 `FORBID_KEY_RE` **或** `opts.forbidKeys` → 整次失败
3. 新 key 不在 `opts.confirmedNewKeys` → 失败
4. `applyLeafPatch` → 备份写前文件 → tmp 相对路径 `${rel}/data.json.tmp` 写入 → 读回校验 JSON.parse → rename 覆盖 `data.json`（MemoryIo：写完 delete tmp 键）。失败则 restore 写前备份
5. `appendEcosystemChange` action `configure`

`MemoryEcosystemIo.rename` 若无则加 `async rename(from, to)`。

`createConfigurePluginTool`：`op` 默认 `inspect`；`apply` 要 `patch` 为 object。

- [ ] **Step 4: 提交**

Run: `npx vitest run tests/adapters/ecosystem-configure.test.ts tests/utils/setting-path.test.ts`
Expected: PASS

```bash
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
- Test: `tests/adapters/ecosystem-uninstall.test.ts`, `tests/adapters/ecosystem-status.test.ts`, `tests/adapters/ecosystem-restore.test.ts`

**Interfaces:**
- Consumes: T1 日志/备份/锁；T3 安装后的目录布局；现有 `tryEnableCommunityPlugin`
- Produces: `uninstallCommunityPlugin`, `listInstalledPlugins`, `getCommunityPluginStatus`, `restoreEcosystemBackup`

- [ ] **Step 1: 写失败测试**

卸载：备份存在、目录消失、启用清单无 id；下架 id（catalog 空、本地有目录）仍可卸；`ratel-vault` 拒绝；R3/`writeEnabled=false` 零写盘。

status 省略 id：列出本地已装、不含 `ratel-vault`、http mock 的 `seen` 不含 raw.githubusercontent。指定 id + `checkUpdate: true`：返回 `catalogVersion` / `updateAvailable`（本地 1.0、HEAD 1.5 → true）。禁止请求 URL 含 `/releases/latest`。

restore：对一次 configure 或 update 的 `changeId` 恢复后文件回到 before；再追加一条 `action: restore`；未知 id / `expired` 失败。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/ecosystem-uninstall.test.ts tests/adapters/ecosystem-status.test.ts tests/adapters/ecosystem-restore.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`uninstallCommunityPlugin`：确认已有目录 → snapshot 整目录 + 启用清单 → 尽力 disable（`typeof disablePlugin === 'function'` 才调，失败只改清单）→ 清单去掉 id → `removeRecursive` 插件目录 → 记 `uninstall`。`writeEnabled=false` 抛 `writeDisabled`。

`listInstalledPlugins`：`io.listPluginIds` + 读各 `manifest.json`；启用态来自清单数组。不出站。

`getCommunityPluginStatus`：未装 `installed: false`。`includeKeys` 只回 key 名。`checkUpdate` 才 `resolveReleaseVersion`（会拉 HEAD manifest）。`updateAvailable`：`compareDottedVersion(catalog, local) === 1`；无法比较则 `updateAvailable: false` 且 message 说明。

`restoreEcosystemBackup`：读 jsonl 找 `changeId`；`expired` 失败；把备份拷回 `plugins/<id>/`（及清单若备份含）；append `restore`。

工具薄包装同 install。`list_ecosystem_changes`：`pluginId?` `limit?` 默认 20 上限 100。

- [ ] **Step 4: 提交**

Run: `npx vitest run tests/adapters/ecosystem-uninstall.test.ts tests/adapters/ecosystem-status.test.ts tests/adapters/ecosystem-restore.test.ts`
Expected: PASS

```bash
git commit -m "$(cat <<'EOF'
feat: 卸载、已装列表与备份回滚

下架仍可清理；status 默认不出站，checkUpdate 才拉商店 HEAD。
EOF
)"
```

---

### Task 6: 档案加载、三源覆盖、只读/草稿工具

**Files:**
- Create: `src/adapters/plugin-profile-fs.ts`, `src/tools/list-plugin-profiles.ts`, `src/tools/match-plugin-profiles.ts`, `src/tools/draft-plugin-profile.ts`, `src/profiles/builtin.ts`（写出示例 YAML 的常量 + `syncBuiltinProfiles`）
- Modify: 无 T1–T5 文件
- Test: `tests/adapters/plugin-profile-fs.test.ts`, `tests/tools/match-plugin-profiles.test.ts`, `tests/tools/draft-plugin-profile.test.ts`

**Interfaces:**
- Consumes: T2 `validateProfile` / `matchProfiles` / `expandPresetPatch`
- Produces: `loadAllProfiles`, `createListPluginProfilesTool`, `createMatchPluginProfilesTool`, `createDraftPluginProfileTool`, `syncBuiltinProfiles`

- [ ] **Step 1: 写失败测试**

覆盖：同 id vault > global > builtin。同源两文件按文件名排序丢后者，`idCollision`。坏 YAML `parseError` 不拖垮其它。draft 文件不进 match。`unknownPluginId`（清单无此 id 且清单已就绪）不进 match。`unverifiedStoreId` 清单不可用时仍可 match。

`match_plugin_profiles({ utterance: '周一开始' })`：`patchPreview.weekStart === 1`。

`draft_plugin_profile`：已装插件 → 写出 `enabled: false` 的 `.draft.yaml` 到 vault dest；`forbid` 含 `apiKey`；**不**调用 configure。未装失败。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/plugin-profile-fs.test.ts tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现加载器**

路径：

- builtin：`pluginDir/plugin-profiles/`
- global：`path.join(os.homedir(), '.ratel', 'plugin-profiles')`（测试注入 homedir）
- vault：`path.join(vaultRoot, '.ratel', 'plugin-profiles')`

`syncBuiltinProfiles(pluginDir)`：若 builtin 目录无 `calendar-week-start.yaml`，写入 T2 那份正文（从 `plugin-profiles/calendar-week-start.yaml` 用 `fs.readFileSync` 相对仓库根；测试 cwd 为仓库根。运行时用 `import calendarYaml from '../../plugin-profiles/calendar-week-start.yaml'` **不要**做 esbuild loader——改为 `src/profiles/builtin.ts` 导出字符串常量，与仓库 YAML 保持同步，单测 `expect(BUILTIN_CALENDAR_YAML).toContain('weekStart: 1')` 且 `readFileSync('plugin-profiles/calendar-week-start.yaml')` 相等）。

解析：`.json` → `JSON.parse`；`.yaml`/`.yml` → `yaml.parse`。`src/profiles/` 禁止 `import 'obsidian'`。

商店清单：调用方传入 `catalogIds: Set<string> | null`（null = 未就绪）。

- [ ] **Step 4: 三个工具**

`list` 只读，不含 draft/unknown。`match` 至少 utterance/pluginId/tags 一项。`draft` ask，`dest` 默认 `vault`。

识别器 `forbid` 启发式扫已装 `data.json` **键名**（经通道 B `readText`，只读）。

- [ ] **Step 5: 提交**

Run: `npx vitest run tests/adapters/plugin-profile-fs.test.ts tests/profiles/ tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts`
Expected: PASS

```bash
git commit -m "$(cat <<'EOF'
feat: 插件档案三源加载与匹配/草稿工具

draft 默认不进池；写入仍不走档案层。
EOF
)"
```

---

### Task 7: 接线、i18n、SOP、破坏性集合、文档指针

**Files:**
- Modify: `src/main.ts`, `src/settings.ts`, `src/core/tool-permissions.ts`, `src/ui/chat/format-tool-display.ts`, `src/prompts/tool-schemas.ts`, `src/prompts/sections.ts`, `src/prompts/defaults/zh.ts`, `src/i18n/{zh,en,types}.ts`
- Create: `src/skills/builtin/install-community-plugin/SKILL.md`
- Modify（文档，本 Task 授权）：`docs/adr/2026-09-18-ecosystem-outbound.md` §2 触发补 `update_plugin` 确认后下三件套；§13 删「本刀不实现 update」；`docs/architecture/host/ecosystem.md` 现网句改为工具已在本交付范围，去掉「均未实现」
- Test: `tests/core/tool-permissions.test.ts`（追加破坏性）, `tests/prompts/sections.test.ts`（`toolDescIds` 补新工具 description id）

**Interfaces:**
- Consumes: T3–T6 全部 `create*Tool` 与 adapter 函数
- Produces: 对话里可调 8 个生态工具 + 3 个档案工具；命令「重载插件档案」

- [ ] **Step 1: 失败测试 — 破坏性集合**

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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/tool-permissions.test.ts`
Expected: 新断言 FAIL

- [ ] **Step 3: 接线清单（必须全部做完）**

`DESTRUCTIVE_TOOLS` 加入 `update_plugin` `uninstall_plugin` `configure_plugin` `restore_backup`。

`DEFAULT_SETTINGS.toolPermissions`：

- allow: `get_plugin_status` `list_ecosystem_changes` `list_plugin_profiles` `match_plugin_profiles`
- ask: `update_plugin` `uninstall_plugin` `configure_plugin` `restore_backup` `draft_plugin_profile`

`settings.ts` `buildToolPermissionItems` 的 `map` 与 `allTools` 同步上述名字。

`tool-schemas.ts` `ALL_TOOL_NAMES` + 每个工具 parameters（与 spec §5.11 / §11.3 一致）。`sections.ts` + `defaults/zh.ts` 为每个新工具补 `description` 与 param。`tests/prompts/sections.test.ts` 的 `toolDescIds` 增加：

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

`format-tool-display.ts` 映射 `tool.name.*`。

`main.ts`：`syncBuiltinProfiles` 紧挨 `syncBuiltinSkills`；`loadAllProfiles`；注册全部新工具；`addCommand` id `ratel-reload-plugin-profiles` 回调 `loadAll`。生态写工具入口包 `withPluginLock`（adapter 内已锁则工具层不要套两层——**只在 adapter 锁**）。

`writeEnabled=false`：install/update 已在 adapter 开官方页；uninstall/configure apply/restore 抛 `error.ecosystem.writeDisabled`。

确认弹窗：`summarizeToolCall` 对 `install_plugin`/`update_plugin`/`uninstall_plugin`/`configure_plugin` 显示 `pluginId`（扩展 `extractToolPath` 或单独 case，用 `args.pluginId`）。

- [ ] **Step 4: i18n key（zh + en + types 三处同一批）**

在现有 `EcosystemStrings` / `ToolNameStrings` / `SettingsStrings` / `ErrorStrings` / `PromptLabelStrings` / `CmdStrings` 追加（中文如下，英文按同样语义翻译）：

```
settings.toolPermissions.update_plugin = 更新社区插件
settings.toolPermissions.uninstall_plugin = 卸载社区插件
settings.toolPermissions.configure_plugin = 配置社区插件
settings.toolPermissions.get_plugin_status = 查看插件状态
settings.toolPermissions.list_ecosystem_changes = 查看生态变更
settings.toolPermissions.restore_backup = 恢复生态备份
settings.toolPermissions.list_plugin_profiles = 列出插件档案
settings.toolPermissions.match_plugin_profiles = 匹配插件档案
settings.toolPermissions.draft_plugin_profile = 生成插件档案草稿
tool.name.update_plugin = 更新插件 {id}
tool.name.uninstall_plugin = 卸载插件 {id}
tool.name.configure_plugin = 配置插件 {id}
tool.name.get_plugin_status = 插件状态 {id}
tool.name.list_ecosystem_changes = 生态变更
tool.name.restore_backup = 恢复备份 {id}
tool.name.list_plugin_profiles = 插件档案
tool.name.match_plugin_profiles = 匹配档案
tool.name.draft_plugin_profile = 档案草稿 {id}
cmd.reloadPluginProfiles = 重载插件档案
error.ecosystem.writeDisabled = 已关闭生态写盘，请在设置打开
error.ecosystem.newKey = 将新增 key: {key}，需要确认
profile.match.empty = 没有匹配的插件档案
profile.versionMismatch = 已装 {installed} 不满足 {range}
```

`promptLabel.tool.<name>.*` 与 sections 一一对应，label 用英文 id、desc 用中文/英文各表。

- [ ] **Step 5: builtin SOP**

`src/skills/builtin/install-community-plugin/SKILL.md` frontmatter：`name: install-community-plugin`，`activation: auto`，`tags: [plugin, ecosystem]`。正文用 spec §5.16 骨架，并写上 `update_plugin` 那一步。现有 `inlineBuiltinSkillsPlugin` 会自动打包。

- [ ] **Step 6: ADR / 架构指针**

ADR-018 §2 `install_plugin` 旁加一句：`update_plugin` 同样仅确认后下载三件套；`get_plugin_status.checkUpdate` 只拉 raw HEAD/manifest。§13 删除「本刀不实现 update_plugin…」改为「配置与卸载回滚见 S-ECOSYSTEM 底座 plan」。

`docs/architecture/host/ecosystem.md`：删「现网：上述工具均未实现」；§4.3 升级与 spec 对齐（只覆盖三件套、不降级）。**不改**架构模块边界。

- [ ] **Step 7: 全量验证**

Run:

```
npx vitest run tests/adapters/ecosystem-*.test.ts tests/profiles tests/utils/setting-path.test.ts tests/core/ecosystem-*.test.ts tests/core/tool-permissions.test.ts tests/tools/match-plugin-profiles.test.ts tests/tools/draft-plugin-profile.test.ts
npx tsc -noEmit -skipLibCheck
npm run lint
```

Expected: tests PASS；tsc 0 error；lint 0 error（允许既有 warning）

```bash
git commit -m "$(cat <<'EOF'
feat: 接线生态与档案工具，并补社区安装 SOP

对话可装/升/卸/配/回滚；Skill 只教调工具，脚本仍进不了配置目录。
EOF
)"
```

---

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

**2. 占位符：** 无 TBD。YAML 运行时用 `yaml` 包，builtin 用 TS 字符串常量与仓库 YAML 对拍，避免 esbuild loader。

**3. 类型：** `EcosystemPort` / `PluginProfile` / `applyLeafPatch` 名称在后续 Task 与 T1/T2 一致。工具文件名 `get-plugin-status.ts` 对应工具名 `get_plugin_status`。

**4. 并行安全：** T1 与 T2 无共同文件。T3 改 install、T4 只新建 configure。T5 新建 uninstall/status/restore，T6 只碰 profiles。T7 独占 main/i18n/settings。

**5. P-ECOSYSTEM-1：** 切片已交付，本 plan 登记后将其标 Completed。

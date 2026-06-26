# Vault 文件工具集实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 S-VAULT-TOOLS 定义的 7 个 vault 工具(grep/glob/list_files/write_note/append_note/edit_note/delete_note)、VaultPort 扩展、三层安全防御(路径沙箱 + 可阻断 Hook + 工具权限),并在 Agent Loop 中接线。

**Architecture:** 发现类工具在 `src/tools/` 组合 `VaultPort` 只读 API;写入类走 VaultPort 新方法并标记 `readOnly: false`。所有路径经 `validateVaultPath` 沙箱校验。Agent Loop 在工具执行前依次经过权限门控 → `pre-tool-use` hooks → 工具 execute(内部参数校验) → adapter 再次校验路径。提示词方面:P-PROMPTS 尚未实施,本 plan 在 `context-manager.ts` 追加**中文版**工具选用指引(与 spec §4.13 对齐);P-PROMPTS 落地后迁移至 `agent.rag.toolGuide` section,勿重复维护。

**Tech Stack:** TypeScript(strict)、Obsidian Plugin API(`vault.cachedRead`/`process`/`trash`/`adapter.list`)、vitest、Obsidian `Modal`。

**所属 Spec:** [S-VAULT-TOOLS](../specs/2026-06-26-vault-file-tools-design.md)
**依赖:** 无硬阻塞;与 [S-PROMPTS](../specs/2026-06-26-ratel-prompts-design.md) 的 tool section 为软依赖(本 plan 用 interim 中文指引)

---

## 文件结构

### 新建

| 文件 | 职责 |
|------|------|
| `src/utils/path-safety.ts` | `validateVaultPath` 路径沙箱 |
| `src/utils/glob-to-regex.ts` | glob 子集转正则(供 grep include / glob 复用) |
| `src/tools/validate-args.ts` | 工具参数校验辅助(中文错误) |
| `src/tools/grep.ts` | grep 工具 |
| `src/tools/glob.ts` | glob 工具 |
| `src/tools/list-files.ts` | list_files 工具 |
| `src/tools/write-note.ts` | write_note 工具 |
| `src/tools/append-note.ts` | append_note 工具 |
| `src/tools/edit-note.ts` | edit_note 工具 |
| `src/tools/delete-note.ts` | delete_note 工具 |
| `src/core/tool-permissions.ts` | allow/ask/deny 决策 + 会话级临时放行 |
| `src/ui/confirm-modal.ts` | 工具确认 Obsidian Modal |
| `tests/helpers/mock-vault-port.ts` | 可复用 VaultPort mock |
| `tests/utils/path-safety.test.ts` | 路径沙箱测试 |
| `tests/utils/glob-to-regex.test.ts` | glob 转正则测试 |
| `tests/adapters/obsidian-vault.test.ts` | ObsidianVault 新方法 + 沙箱测试 |
| `tests/tools/grep.test.ts` | grep 测试 |
| `tests/tools/glob.test.ts` | glob 测试 |
| `tests/tools/list-files.test.ts` | list_files 测试 |
| `tests/tools/write-append-delete.test.ts` | write/append/delete 测试 |
| `tests/tools/edit-note.test.ts` | edit_note 测试 |
| `tests/core/tool-permissions.test.ts` | 权限三态 + trustMode + 会话放行测试 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/ports/vault.ts` | 新增 `cachedRead`/`appendFile`/`trashFile`/`listFiles`/`fileExists`/`processFile` |
| `src/adapters/obsidian-vault.ts` | 实现新方法;所有路径入口调 `validateVaultPath` |
| `src/core/hooks.ts` | `HookResult`/`HookDecision`;`run()` 可阻断 |
| `src/core/agent-loop.ts` | 全工具走 `pre-tool-use`/`post-tool-use`/`post-tool-failure`;接入权限门控 |
| `src/settings.ts` | `toolPermissions`/`trustMode` + 「工具权限」UI 分组 |
| `src/main.ts` | 注册 7 工具 + 路径安全 hook + 权限门控 + 会话 grants |
| `src/core/context-manager.ts` | RAG_PROMPT 追加中文版工具选用指引(interim) |
| `tests/helpers/mock-obsidian.ts` | 扩展 adapter.list/append/trash/process/cachedRead/exists |
| `tests/core/hooks.test.ts` | 阻断/放行/阶段隔离测试 |
| `tests/core/agent-loop.test.ts` | 更新 hook 阶段名;加权限拒绝测试 |
| `docs/superpowers/STATUS.md` | 新增 P-VAULT-TOOLS 行 |

---

## Task 1: 路径沙箱 `validateVaultPath`

**Files:**
- Create: `src/utils/path-safety.ts`
- Test: `tests/utils/path-safety.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { validateVaultPath } from '../../src/utils/path-safety';

describe('validateVaultPath', () => {
	it('正常相对路径 - 返回归一化结果', () => {
		expect(validateVaultPath('notes/foo.md')).toBe('notes/foo.md');
		expect(validateVaultPath('notes//bar.md')).toBe('notes/bar.md');
	});

	it('空路径 - 抛错', () => {
		expect(() => validateVaultPath('')).toThrow('路径不能为空');
	});

	it('绝对路径 - 抛错', () => {
		expect(() => validateVaultPath('/etc/passwd')).toThrow('不允许绝对路径');
		expect(() => validateVaultPath('C:\\secret')).toThrow('不允许绝对路径');
	});

	it('.. 穿越 - 抛错', () => {
		expect(() => validateVaultPath('../secret.md')).toThrow('禁止使用 ".." 穿越');
	});

	it('.obsidian 目录 - 抛错', () => {
		expect(() => validateVaultPath('.obsidian/config')).toThrow('不允许访问 .obsidian');
	});

	it('.trash 目录 - 抛错', () => {
		expect(() => validateVaultPath('.trash/old.md')).toThrow('不允许访问 .trash');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/utils/path-safety.test.ts`
Expected: FAIL — `validateVaultPath` 未定义

- [ ] **Step 3: 实现 `src/utils/path-safety.ts`**

```typescript
/**
 * @file src/utils/path-safety.ts
 * @description Vault 路径沙箱 — 所有文件操作前的硬性边界校验
 * @module utils/path-safety
 * @depends obsidian
 */

import { normalizePath } from 'obsidian';

/**
 * 校验路径是否在 vault 安全范围内,返回归一化后的路径。
 * @throws 路径越界时抛错
 */
export function validateVaultPath(path: string): string {
	if (!path || typeof path !== 'string') {
		throw new Error('路径不能为空');
	}

	const normalized = normalizePath(path);

	if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(`路径越界:不允许绝对路径 "${path}"`);
	}

	if (normalized.includes('..')) {
		throw new Error(`路径越界:禁止使用 ".." 穿越 "${path}"`);
	}

	if (normalized === '.obsidian' || normalized.startsWith('.obsidian/')) {
		throw new Error(`路径越界:不允许访问 .obsidian 配置目录 "${path}"`);
	}

	if (normalized === '.trash' || normalized.startsWith('.trash/')) {
		throw new Error(`路径越界:不允许访问 .trash 回收站 "${path}"`);
	}

	return normalized;
}

/** grep/glob 用:排除插件配置与回收站目录下的文件 */
export function isExcludedVaultPath(filePath: string): boolean {
	return (
		filePath === '.obsidian' ||
		filePath.startsWith('.obsidian/') ||
		filePath === '.trash' ||
		filePath.startsWith('.trash/')
	);
}

/** 判断 filePath 是否在 dir 目录树下(dir 为空表示整个 vault) */
export function isUnderDirectory(filePath: string, dir: string): boolean {
	if (!dir) return true;
	const base = dir.replace(/\/$/, '');
	return filePath === base || filePath.startsWith(`${base}/`);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/utils/path-safety.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/utils/path-safety.ts tests/utils/path-safety.test.ts
git commit -m "feat(vault-tools): 添加 validateVaultPath 路径沙箱"
```

---

## Task 2: `globToRegex` 纯函数

**Files:**
- Create: `src/utils/glob-to-regex.ts`
- Test: `tests/utils/glob-to-regex.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { globToRegex, escapeRegExp } from '../../src/utils/glob-to-regex';

describe('globToRegex', () => {
	const cases: Array<[string, string, boolean]> = [
		['*.md', 'readme.md', true],
		['*.md', 'notes/readme.md', false],
		['daily/*.md', 'daily/2026-06-26.md', true],
		['daily/*.md', 'other/2026.md', false],
		['**/*.md', 'a/b/c.md', true],
		['**/*.md', 'root.md', true],
		['note?.md', 'note1.md', true],
		['note?.md', 'note12.md', false],
	];

	it.each(cases)('pattern %s matches %s → %s', (pattern, path, expected) => {
		const re = globToRegex(pattern);
		expect(re.test(path)).toBe(expected);
	});
});

describe('escapeRegExp', () => {
	it('转义正则特殊字符', () => {
		expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/utils/glob-to-regex.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
/**
 * @file src/utils/glob-to-regex.ts
 * @description 轻量 glob 子集转正则 — 支持 *、**、?(不含 {a,b})
 * @module utils/glob-to-regex
 */

const REGEX_SPECIAL = new Set(['\\', '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']']);

/**
 * 将 glob 模式转为匹配 vault 相对路径的 RegExp。
 * 支持: `*`(单层)、`**`(跨层)、`?`(单字符)。不支持 `{a,b}` brace 扩展(v1)。
 */
export function globToRegex(glob: string): RegExp {
	let regex = '';
	let i = 0;
	while (i < glob.length) {
		const c = glob[i]!;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					regex += '(?:.*/)?';
					i += 3;
				} else {
					regex += '.*';
					i += 2;
				}
			} else {
				regex += '[^/]*';
				i += 1;
			}
		} else if (c === '?') {
			regex += '[^/]';
			i += 1;
		} else if (REGEX_SPECIAL.has(c)) {
			regex += `\\${c}`;
			i += 1;
		} else {
			regex += c;
			i += 1;
		}
	}
	return new RegExp(`^${regex}$`);
}

/** grep is_regex=false 时把 pattern 当字面量 */
export function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/utils/glob-to-regex.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/glob-to-regex.ts tests/utils/glob-to-regex.test.ts
git commit -m "feat(vault-tools): 添加 globToRegex 与 escapeRegExp"
```

---

## Task 3: VaultPort 扩展 + mock 辅助

**Files:**
- Modify: `src/ports/vault.ts`
- Create: `tests/helpers/mock-vault-port.ts`

- [ ] **Step 1: 扩展 `src/ports/vault.ts` 接口**

在 `listMarkdownFiles()` 之后追加:

```typescript
	/**
	 * 读取文件(优先 Obsidian 缓存,供 grep 等只读扫描)。
	 */
	cachedRead(path: string): Promise<string>;

	/** 追加内容;文件不存在则创建。 */
	appendFile(path: string, content: string): Promise<void>;

	/** 移到回收站(可恢复)。 */
	trashFile(path: string): Promise<void>;

	/**
	 * 列出目录内容(非递归)。
	 * @param dir - vault 相对路径;空串表示根目录
	 */
	listFiles(dir?: string): Promise<{ files: string[]; folders: string[] }>;

	/** 文件是否存在。 */
	fileExists(path: string): Promise<boolean>;

	/**
	 * 原子读-改-写,返回写入后的新内容。
	 */
	processFile(path: string, fn: (content: string) => string): Promise<string>;
```

- [ ] **Step 2: 创建 `tests/helpers/mock-vault-port.ts`**

```typescript
import type { VaultPort } from '../../src/ports/vault';

export interface MockVaultState {
	files: Record<string, string>;
	dirs?: Record<string, { files: string[]; folders: string[] }>;
}

export function createMockVaultPort(state: MockVaultState = { files: {} }): VaultPort {
	return {
		readFile: async (path) => {
			if (!(path in state.files)) throw new Error(`File not found: ${path}`);
			return state.files[path]!;
		},
		cachedRead: async (path) => {
			if (!(path in state.files)) throw new Error(`File not found: ${path}`);
			return state.files[path]!;
		},
		writeFile: async (path, content) => {
			state.files[path] = content;
		},
		appendFile: async (path, content) => {
			state.files[path] = (state.files[path] ?? '') + content;
		},
		trashFile: async (path) => {
			delete state.files[path];
		},
		listFiles: async (dir = '') => {
			if (state.dirs && dir in state.dirs) return state.dirs[dir]!;
			const files = Object.keys(state.files)
				.filter((p) => {
					const slash = p.lastIndexOf('/');
					const parent = slash >= 0 ? p.slice(0, slash) : '';
					const name = slash >= 0 ? p.slice(slash + 1) : p;
					return parent === dir && name.length > 0;
				})
				.map((p) => {
					const slash = p.lastIndexOf('/');
					return slash >= 0 ? p.slice(slash + 1) : p;
				});
			return { files, folders: [] };
		},
		fileExists: async (path) => path in state.files,
		processFile: async (path, fn) => {
			const current = state.files[path] ?? '';
			const next = fn(current);
			state.files[path] = next;
			return next;
		},
		getBacklinks: () => new Map(),
		getMetadata: () => null,
		listMarkdownFiles: () => Object.keys(state.files).filter((p) => p.endsWith('.md')),
	};
}
```

- [ ] **Step 3: 编译检查**

Run: `npm run build`
Expected: 类型错误仅来自 `ObsidianVault` 未实现新方法(下一步修复)及现有测试 mock 缺方法 — 记录待 Task 4 修复

- [ ] **Step 4: 提交**

```bash
git add src/ports/vault.ts tests/helpers/mock-vault-port.ts
git commit -m "feat(vault-tools): 扩展 VaultPort 接口与 mock 辅助"
```

---

## Task 4: ObsidianVault 适配器实现

**Files:**
- Modify: `src/adapters/obsidian-vault.ts`
- Modify: `tests/helpers/mock-obsidian.ts`
- Create: `tests/adapters/obsidian-vault.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ObsidianVault } from '../../src/adapters/obsidian-vault';
import { createMockApp, addMockFile } from '../helpers/mock-obsidian';

describe('ObsidianVault vault-tools methods', () => {
	it('readFile - 入口调用 validateVaultPath 拒绝 .obsidian', async () => {
		const app = createMockApp();
		const vault = new ObsidianVault(app);
		await expect(vault.readFile('.obsidian/config')).rejects.toThrow('.obsidian');
	});

	it('appendFile - 已存在文件追加内容', async () => {
		const app = createMockApp();
		addMockFile(app, 'notes/a.md', 'hello');
		const vault = new ObsidianVault(app);
		await vault.appendFile('notes/a.md', ' world');
		expect(await vault.readFile('notes/a.md')).toBe('hello world');
	});

	it('appendFile - 不存在则创建', async () => {
		const app = createMockApp();
		const vault = new ObsidianVault(app);
		await vault.appendFile('new.md', '# New');
		expect(await vault.readFile('new.md')).toBe('# New');
	});

	it('fileExists - 存在返回 true', async () => {
		const app = createMockApp();
		addMockFile(app, 'x.md', 'x');
		const vault = new ObsidianVault(app);
		expect(await vault.fileExists('x.md')).toBe(true);
		expect(await vault.fileExists('missing.md')).toBe(false);
	});

	it('processFile - 原子替换', async () => {
		const app = createMockApp();
		addMockFile(app, 'notes/edit.md', 'foo bar');
		const vault = new ObsidianVault(app);
		const result = await vault.processFile('notes/edit.md', (c) => c.replace('bar', 'baz'));
		expect(result).toBe('foo baz');
		expect(await vault.readFile('notes/edit.md')).toBe('foo baz');
	});

	it('trashFile - 调用 vault.trash', async () => {
		const app = createMockApp();
		addMockFile(app, 'del.md', 'x');
		const trash = vi.fn().mockResolvedValue(undefined);
		(app.vault as { trash: typeof trash }).trash = trash;
		const vault = new ObsidianVault(app);
		await vault.trashFile('del.md');
		expect(trash).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 扩展 `tests/helpers/mock-obsidian.ts`**

在 `mockVault` 对象中追加:

```typescript
		cachedRead: async (file: { path: string }) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			return entry.content;
		},
		append: async (file: { path: string }, content: string) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			entry.content += content;
		},
		trash: async (file: { path: string }) => {
			files.delete(file.path);
		},
		process: async (file: { path: string }, fn: (data: string) => string) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			entry.content = fn(entry.content);
			return entry.content;
		},
		adapter: {
			list: async (dir: string) => {
				const prefix = dir ? `${dir}/` : '';
				const fileNames = new Set<string>();
				const folderNames = new Set<string>();
				for (const p of files.keys()) {
					if (!p.startsWith(prefix) && dir) continue;
					const rest = dir ? p.slice(prefix.length) : p;
					const slash = rest.indexOf('/');
					if (slash === -1) fileNames.add(rest);
					else folderNames.add(rest.slice(0, slash));
				}
				return { files: [...fileNames], folders: [...folderNames] };
			},
			exists: async (path: string) => files.has(path),
		},
```

并把 `getAbstractFileByPath` 改为返回带 `instanceof` 兼容的对象 — 在文件顶部加:

```typescript
class MockTFile {
	constructor(public path: string) {}
}
```

`getAbstractFileByPath` 命中时 `return new MockTFile(path)`;ObsidianVault 用 `instanceof TFile` 判断 — **测试里用 vi.mock 或让 ObsidianVault 用 duck-type `path in file`**.

**更稳妥做法:** 在 `obsidian-vault.ts` 用辅助函数 `isTFile(file): file is TFile` 检查 `'path' in file && file instanceof TFile`。测试侧从 `obsidian` import `TFile` 构造真实 TFile 不现实。

**实施决策:** `obsidian-vault.ts` 私有方法:

```typescript
private resolveFile(path: string): TFile {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${path}`);
  return file;
}
```

mock 里让 `getAbstractFileByPath` 返回 `{ path, stat: {} } as TFile` — vitest 里 `as TFile` 足够,`instanceof TFile` 会失败。

**修复:** ObsidianVault 改为 duck-type:

```typescript
function asTFile(file: unknown): TFile | null {
  if (file && typeof file === 'object' && 'path' in file) return file as TFile;
  return null;
}
```

或在测试中 `vi.spyOn` — 最简单:**ObsidianVault 检查 `file && 'path' in file` 而非 `instanceof TFile`**(与现有 readFile 行为对齐,仅放宽 instanceof)。

现有代码用 `instanceof TFile` — mock-obsidian 已返回 `{ path, stat }`,测试能通过 readFile 说明 vitest 里 instanceof 可能为 true? 看 mock — 返回 plain object,`instanceof TFile` 应为 false。read-note 测试用 ObsidianVault cast mock 不经过 ObsidianVault 类。

**ObsidianVault 测试** 需扩展 mock 使 `instanceof TFile` 工作 — 用:

```typescript
import { TFile } from 'obsidian';
// 无法 new TFile()
```

**采用 duck-type 重构 ObsidianVault**(本 Task 范围内):把所有 `file instanceof TFile` 替换为 `isVaultFile(file)`:

```typescript
function isVaultFile(file: unknown): file is TFile {
  return !!file && typeof file === 'object' && 'path' in file;
}
```

- [ ] **Step 3: 实现 `src/adapters/obsidian-vault.ts` 变更**

在文件顶部 import:

```typescript
import { type App, TFile } from 'obsidian';
import { validateVaultPath } from '../utils/path-safety';

function isVaultFile(file: unknown): file is TFile {
	return !!file && typeof file === 'object' && 'path' in file;
}
```

每个公开方法入口对 path/dir 调 `validateVaultPath`(listMarkdownFiles 除外)。

新增方法按 spec §4.3 实现;`readFile`/`writeFile` 现有逻辑中把 `instanceof TFile` 改为 `isVaultFile(file)`。

`cachedRead`:

```typescript
async cachedRead(path: string): Promise<string> {
	const normalized = validateVaultPath(path);
	const file = this.app.vault.getAbstractFileByPath(normalized);
	if (!isVaultFile(file)) throw new Error(`File not found: ${normalized}`);
	return this.app.vault.cachedRead(file);
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test -- tests/adapters/obsidian-vault.test.ts`
Expected: PASS

- [ ] **Step 5: 修复因 VaultPort 扩展而断裂的现有 mock**

Run: `npm test`
Expected: 全部 PASS(更新 `tests/tools/read-note.test.ts` 等 mock 补上 stub 新方法)

在 `read-note.test.ts` 的 `createMockVault` 追加:

```typescript
		cachedRead: async (path: string) => { /* 同 readFile */ },
		appendFile: async () => {},
		trashFile: async () => {},
		listFiles: async () => ({ files: [], folders: [] }),
		fileExists: async (path) => path in files,
		processFile: async (path, fn) => fn(files[path] ?? ''),
```

- [ ] **Step 6: 提交**

```bash
git add src/adapters/obsidian-vault.ts tests/helpers/mock-obsidian.ts tests/adapters/obsidian-vault.test.ts tests/tools/read-note.test.ts
git commit -m "feat(vault-tools): ObsidianVault 实现 VaultPort 新方法与路径沙箱"
```

---

## Task 5: HookRegistry 可阻断升级 + Agent Loop 阶段迁移

**Files:**
- Modify: `src/core/hooks.ts`
- Modify: `src/core/agent-loop.ts`
- Modify: `tests/core/hooks.test.ts`
- Modify: `tests/core/agent-loop.test.ts`

- [ ] **Step 1: 写失败测试 — hooks 阻断**

在 `tests/core/hooks.test.ts` 末尾追加:

```typescript
	it('pre-tool-use - deny 阻断并返回原因', async () => {
		const hooks = new HookRegistry();
		hooks.register('pre-tool-use', async () => ({ allow: false, reason: 'blocked' }));
		const decision = await hooks.run('pre-tool-use', { id: '1', name: 'write_note', args: {} });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe('blocked');
	});

	it('pre-tool-use - deny 后不再执行后续 hook', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			calls.push('first');
			return { allow: false, reason: 'no' };
		});
		hooks.register('pre-tool-use', async () => {
			calls.push('second');
		});
		await hooks.run('pre-tool-use', { id: '1', name: 'x', args: {} });
		expect(calls).toEqual(['first']);
	});

	it('pre-tool-use - hook 抛错不阻断', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			throw new Error('boom');
		});
		hooks.register('pre-tool-use', async () => {
			calls.push('ok');
		});
		const decision = await hooks.run('pre-tool-use', { id: '1', name: 'x', args: {} });
		expect(decision.allowed).toBe(true);
		expect(calls).toEqual(['ok']);
	});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/core/hooks.test.ts`
Expected: FAIL — `decision.allowed` 不存在

- [ ] **Step 3: 重写 `src/core/hooks.ts`**

```typescript
import type { ToolCall } from '../ports/llm';
import { devLogger } from '../logging/dev-logger';

export type HookResult = { allow: boolean; reason?: string } | void;

export interface HookDecision {
	allowed: boolean;
	deniedBy?: string;
	reason?: string;
}

export class HookRegistry {
	private handlers = new Map<string, Array<(toolCall: ToolCall) => Promise<HookResult>>>();
	private handlerIds = new Map<string, string[]>();

	register(phase: string, handler: (toolCall: ToolCall) => Promise<HookResult>, id?: string): void {
		const list = this.handlers.get(phase) ?? [];
		list.push(handler);
		this.handlers.set(phase, list);
		if (id) {
			const ids = this.handlerIds.get(phase) ?? [];
			ids.push(id);
			this.handlerIds.set(phase, ids);
		}
	}

	async run(phase: string, toolCall: ToolCall): Promise<HookDecision> {
		const list = this.handlers.get(phase) ?? [];
		const ids = this.handlerIds.get(phase) ?? [];
		for (let i = 0; i < list.length; i++) {
			const handler = list[i]!;
			try {
				const result = await handler(toolCall);
				if (result && result.allow === false) {
					return {
						allowed: false,
						deniedBy: ids[i] ?? `hook-${i}`,
						reason: result.reason ?? '工具调用被钩子拒绝',
					};
				}
			} catch (err) {
				devLogger.error('hooks', `Hook error in ${phase}`, err);
			}
		}
		return { allowed: true };
	}

	/** 向后兼容:void 阶段(不阻断) */
	async runVoid(phase: string, toolCall: ToolCall): Promise<void> {
		await this.run(phase, toolCall);
	}
}
```

- [ ] **Step 4: 修改 `src/core/agent-loop.ts`**

在 `agentLoop` 函数签名末尾增加可选参数:

```typescript
	toolPermissionCheck?: (toolCall: ToolCall) => Promise<void>,
```

替换工具执行前逻辑(约 129–181 行):

```typescript
			yield { type: 'tool.call', payload: { name: toolCall.name, args: toolCall.args } };

			// 权限门控(allow/ask/deny/trustMode) — Task 6 接线
			if (toolPermissionCheck) {
				try {
					await toolPermissionCheck(toolCall);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					yield { type: 'error', payload: { code: 'TOOL_DENIED', message } };
					ctx.addAssistantToolCall(toolCall, accumulatedText);
					ctx.addToolResult(toolCall.id, `Error: ${message}`);
					continue;
				}
			}

			const preDecision = await hooks.run('pre-tool-use', toolCall);
			if (!preDecision.allowed) {
				const message = `工具调用被拒绝: ${preDecision.reason ?? '未知原因'}`;
				yield { type: 'error', payload: { code: 'TOOL_DENIED', message } };
				ctx.addAssistantToolCall(toolCall, accumulatedText);
				ctx.addToolResult(toolCall.id, `Error: ${message}`);
				continue;
			}

			let result: unknown;
			let toolFailed = false;
			try {
				result = await tools.execute(toolCall);
			} catch (err) {
				toolFailed = true;
				const message = err instanceof Error ? err.message : String(err);
				const code = (err as Error & { code?: string }).code ?? 'TOOL_ERROR';
				yield { type: 'error', payload: { code, message } };
				result = `Error: ${message}`;
				await hooks.runVoid('post-tool-failure', toolCall);
			}

			yield { type: 'tool.result', payload: { name: toolCall.name, result } };

			// search.result 事件块保持不变 ...

			if (!toolFailed) {
				await hooks.runVoid('post-tool-use', toolCall);
			}
```

删除原 `pre-write`/`post-write` 分支及 `isReadOnly` 条件。

- [ ] **Step 5: 更新 `tests/core/hooks.test.ts` 旧测试**

把 `await hooks.run('pre-write', ...)` 改为 `await hooks.runVoid('pre-write', ...)` 或改阶段名为 `pre-tool-use` 并断言 `decision.allowed`.

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS(修复 agent-loop 测试中若有 pre-write 断言)

- [ ] **Step 7: 提交**

```bash
git add src/core/hooks.ts src/core/agent-loop.ts tests/core/hooks.test.ts tests/core/agent-loop.test.ts
git commit -m "feat(vault-tools): HookRegistry 支持阻断,Agent Loop 统一 pre-tool-use 阶段"
```

---

## Task 6: 工具权限 + 确认对话框

**Files:**
- Create: `src/core/tool-permissions.ts`
- Create: `src/ui/confirm-modal.ts`
- Test: `tests/core/tool-permissions.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	type ToolPermission,
} from '../../src/core/tool-permissions';
import type { ToolCall } from '../../src/ports/llm';

const writeCall: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };

describe('resolveToolPermission', () => {
	it('trustMode - 直接放行', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(writeCall, { trustMode: true, toolPermissions: { write_note: 'deny' } }, grants, vi.fn()),
		).resolves.toBeUndefined();
	});

	it('deny - 抛错', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(
				writeCall,
				{ trustMode: false, toolPermissions: { write_note: 'deny' } },
				grants,
				vi.fn(),
			),
		).rejects.toThrow('已被禁用');
	});

	it('ask - 用户拒绝', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('deny' as const);
		await expect(
			resolveToolPermission(
				writeCall,
				{ trustMode: false, toolPermissions: { write_note: 'ask' } },
				grants,
				confirm,
			),
		).rejects.toThrow('用户拒绝');
	});

	it('ask - 会话放行后不再弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('session' as const);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: 实现 `src/core/tool-permissions.ts`**

```typescript
/**
 * @file src/core/tool-permissions.ts
 * @description 工具权限 allow/ask/deny 决策
 * @module core/tool-permissions
 */

import type { ToolCall } from '../ports/llm';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface ToolPermissionSettings {
	trustMode: boolean;
	toolPermissions: Record<string, ToolPermission>;
}

export type ToolConfirmResult = 'allow' | 'session' | 'deny';

export class ToolPermissionSessionGrants {
	private keys = new Set<string>();

	private key(toolName: string, path?: string): string {
		return path ? `${toolName}:${path}` : toolName;
	}

	has(toolName: string, path?: string): boolean {
		return this.keys.has(this.key(toolName, path));
	}

	grant(toolName: string, path?: string): void {
		this.keys.add(this.key(toolName, path));
	}
}

export function extractToolPath(toolCall: ToolCall): string | undefined {
	const p = toolCall.args.path;
	return typeof p === 'string' ? p : undefined;
}

export function summarizeToolCall(toolCall: ToolCall): string {
	const path = extractToolPath(toolCall);
	switch (toolCall.name) {
		case 'write_note':
			return path ? `创建或覆盖笔记 ${path}` : '写入笔记';
		case 'append_note':
			return path ? `追加内容到 ${path}` : '追加笔记';
		case 'edit_note':
			return path ? `精确替换 ${path} 中的文本` : '编辑笔记';
		case 'delete_note':
			return path ? `将 ${path} 移到回收站` : '删除笔记';
		default:
			return path ? `${toolCall.name} → ${path}` : toolCall.name;
	}
}

export async function resolveToolPermission(
	toolCall: ToolCall,
	settings: ToolPermissionSettings,
	grants: ToolPermissionSessionGrants,
	confirm: (toolCall: ToolCall) => Promise<ToolConfirmResult>,
): Promise<void> {
	if (settings.trustMode) return;

	const path = extractToolPath(toolCall);
	if (grants.has(toolCall.name, path)) return;

	const perm: ToolPermission = settings.toolPermissions[toolCall.name] ?? 'ask';
	if (perm === 'allow') return;
	if (perm === 'deny') {
		throw new Error(`工具调用被拒绝: ${toolCall.name} 已被禁用`);
	}

	const decision = await confirm(toolCall);
	if (decision === 'deny') {
		throw new Error('用户拒绝了工具调用');
	}
	if (decision === 'session') {
		grants.grant(toolCall.name, path);
	}
}
```

- [ ] **Step 3: 实现 `src/ui/confirm-modal.ts`**

```typescript
/**
 * @file src/ui/confirm-modal.ts
 * @description 工具执行确认对话框
 * @module ui/confirm-modal
 */

import { Modal, type App } from 'obsidian';
import type { ToolCall } from '../ports/llm';
import { summarizeToolCall, type ToolConfirmResult } from '../core/tool-permissions';

export function showToolConfirmModal(app: App, toolCall: ToolCall): Promise<ToolConfirmResult> {
	return new Promise((resolve) => {
		new ToolConfirmModal(app, toolCall, resolve).open();
	});
}

class ToolConfirmModal extends Modal {
	constructor(
		app: App,
		private toolCall: ToolCall,
		private onResolve: (result: ToolConfirmResult) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`确认工具调用: ${this.toolCall.name}`);
		contentEl.createEl('p', { text: summarizeToolCall(this.toolCall) });
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: '允许' }).onclick = () => {
			this.close();
			this.onResolve('allow');
		};
		btnRow.createEl('button', { text: '允许(本次会话不再询问)' }).onclick = () => {
			this.close();
			this.onResolve('session');
		};
		btnRow.createEl('button', { text: '拒绝' }).onclick = () => {
			this.close();
			this.onResolve('deny');
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test -- tests/core/tool-permissions.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/tool-permissions.ts src/ui/confirm-modal.ts tests/core/tool-permissions.test.ts
git commit -m "feat(vault-tools): 工具权限决策与会话级确认对话框"
```

---

## Task 7: `grep` 工具

**Files:**
- Create: `src/tools/validate-args.ts`
- Create: `src/tools/grep.ts`
- Test: `tests/tools/grep.test.ts`

- [ ] **Step 1: 创建 `src/tools/validate-args.ts`**

```typescript
export function requireString(args: Record<string, unknown>, key: string, label: string): string {
	const v = args[key];
	if (typeof v !== 'string' || v.length === 0) {
		throw new Error(`${label} 必须是非空字符串,收到: ${typeof v}`);
	}
	return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === 'string' ? v : undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
	const v = args[key];
	return typeof v === 'boolean' ? v : defaultValue;
}

export function optionalNumber(args: Record<string, unknown>, key: string, defaultValue: number): number {
	const v = args[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : defaultValue;
}
```

- [ ] **Step 2: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { createGrepTool } from '../../src/tools/grep';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('grep tool', () => {
	it('字面量匹配 - 找到关键词', async () => {
		const vault = createMockVaultPort({
			files: {
				'notes/a.md': '第一行\n包含死字的行\n第三行',
				'.obsidian/hidden.md': '死',
			},
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({
			pattern: '死',
			is_regex: false,
			context_lines: 1,
		}) as Array<{ file: string; line: number; match: string }>;
		expect(results).toHaveLength(1);
		expect(results[0]!.file).toBe('notes/a.md');
		expect(results[0]!.match).toContain('死');
	});

	it('max_results - 提前截断', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': 'x\nx\nx', 'b.md': 'x\nx' },
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({ pattern: 'x', is_regex: false, max_results: 2 });
		expect(results).toHaveLength(2);
	});

	it('path 限定目录', async () => {
		const vault = createMockVaultPort({
			files: { 'daily/a.md': 'hit', 'other/b.md': 'hit' },
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({ pattern: 'hit', is_regex: false, path: 'daily' }) as Array<{ file: string }>;
		expect(results.every((r) => r.file.startsWith('daily/'))).toBe(true);
	});
});
```

- [ ] **Step 3: 实现 `src/tools/grep.ts`**

```typescript
import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { globToRegex, escapeRegExp } from '../utils/glob-to-regex';
import { isExcludedVaultPath, isUnderDirectory } from '../utils/path-safety';
import { optionalBoolean, optionalNumber, optionalString, requireString } from './validate-args';

export interface GrepMatch {
	file: string;
	line: number;
	column: number;
	match: string;
	before: string[];
	after: string[];
}

export function createGrepTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'grep',
			description:
				'在 vault 所有笔记中做精确文本或正则搜索。适用于查找特定汉字、代码片段、固定字符串;语义相关请用 search_vault。',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: '搜索模式(正则或字面量)' },
					is_regex: { type: 'boolean', description: '默认 true;false 时按字面量匹配' },
					include: { type: 'string', description: 'glob 过滤,默认 "*.md"' },
					path: { type: 'string', description: '限定搜索目录(相对 vault 根)' },
					ignore_case: { type: 'boolean', description: '默认 true' },
					context_lines: { type: 'number', description: '上下文行数,默认 2' },
					max_results: { type: 'number', description: '最大匹配数,默认 50' },
				},
				required: ['pattern'],
			},
		},
		readOnly: true,
		async execute(args) {
			const pattern = requireString(args, 'pattern', 'pattern');
			const isRegex = optionalBoolean(args, 'is_regex', true);
			const include = optionalString(args, 'include') ?? '*.md';
			const searchPath = optionalString(args, 'path') ?? '';
			const ignoreCase = optionalBoolean(args, 'ignore_case', true);
			const contextLines = optionalNumber(args, 'context_lines', 2);
			const maxResults = optionalNumber(args, 'max_results', 50);

			const includeRe = globToRegex(include);
			const source = pattern;
			const regexSource = isRegex ? source : escapeRegExp(source);
			const flags = ignoreCase ? 'i' : '';
			const lineRe = new RegExp(regexSource, flags);

			const candidates = vault
				.listMarkdownFiles()
				.filter((f) => !isExcludedVaultPath(f))
				.filter((f) => isUnderDirectory(f, searchPath))
				.filter((f) => includeRe.test(f));

			const matches: GrepMatch[] = [];

			for (const file of candidates) {
				if (matches.length >= maxResults) break;
				const text = await vault.cachedRead(file);
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (matches.length >= maxResults) break;
					const lineText = lines[i]!;
					const m = lineRe.exec(lineText);
					if (!m) continue;
					const before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.trimEnd());
					const after = lines.slice(i + 1, i + 1 + contextLines).map((l) => l.trimEnd());
					matches.push({
						file,
						line: i + 1,
						column: m.index + 1,
						match: lineText.trimEnd(),
						before,
						after,
					});
				}
			}
			return matches;
		},
	};
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test -- tests/tools/grep.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/validate-args.ts src/tools/grep.ts tests/tools/grep.test.ts
git commit -m "feat(vault-tools): 添加 grep 精确搜索工具"
```

---

## Task 8: `glob` 与 `list_files` 工具

**Files:**
- Create: `src/tools/glob.ts`
- Create: `src/tools/list-files.ts`
- Test: `tests/tools/glob.test.ts`
- Test: `tests/tools/list-files.test.ts`

- [ ] **Step 1: 写 glob 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { createGlobTool } from '../../src/tools/glob';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('glob tool', () => {
	it('匹配 daily 目录下 md', async () => {
		const vault = createMockVaultPort({
			files: { 'daily/a.md': '', 'other/b.md': '', 'daily/x.txt': '' },
		});
		const tool = createGlobTool(vault);
		const paths = await tool.execute({ pattern: 'daily/*.md' }) as string[];
		expect(paths).toEqual(['daily/a.md']);
	});
});
```

- [ ] **Step 2: 实现 `src/tools/glob.ts`**

```typescript
import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { globToRegex } from '../utils/glob-to-regex';
import { isExcludedVaultPath, isUnderDirectory } from '../utils/path-safety';
import { optionalString, requireString } from './validate-args';

export function createGlobTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'glob',
			description: '按文件名 glob 模式查找 Markdown 笔记,如 "daily/*.md" 或 "**/*.project.md"。',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'glob 模式' },
					path: { type: 'string', description: '限定搜索目录' },
				},
				required: ['pattern'],
			},
		},
		readOnly: true,
		async execute(args) {
			const pattern = requireString(args, 'pattern', 'pattern');
			const basePath = optionalString(args, 'path') ?? '';
			const re = globToRegex(pattern);
			return vault
				.listMarkdownFiles()
				.filter((f) => !isExcludedVaultPath(f))
				.filter((f) => isUnderDirectory(f, basePath))
				.filter((f) => re.test(f));
		},
	};
}
```

- [ ] **Step 3: 写 list_files 失败测试并实现**

`src/tools/list-files.ts`:

```typescript
import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { optionalString } from './validate-args';

export function createListFilesTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'list_files',
			description: '列出 vault 某目录下的文件与子文件夹(非递归)。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目录路径,默认根目录' },
				},
			},
		},
		readOnly: true,
		async execute(args) {
			const path = optionalString(args, 'path') ?? '';
			const listing = await vault.listFiles(path);
			return { path, files: listing.files, folders: listing.folders };
		},
	};
}
```

测试断言 `{ path: 'notes', files, folders }` echo。

- [ ] **Step 4: 运行测试**

Run: `npm test -- tests/tools/glob.test.ts tests/tools/list-files.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/glob.ts src/tools/list-files.ts tests/tools/glob.test.ts tests/tools/list-files.test.ts
git commit -m "feat(vault-tools): 添加 glob 与 list_files 工具"
```

---

## Task 9: `write_note` / `append_note` / `delete_note`

**Files:**
- Create: `src/tools/write-note.ts`
- Create: `src/tools/append-note.ts`
- Create: `src/tools/delete-note.ts`
- Test: `tests/tools/write-append-delete.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { createWriteNoteTool } from '../../src/tools/write-note';
import { createAppendNoteTool } from '../../src/tools/append-note';
import { createDeleteNoteTool } from '../../src/tools/delete-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('write/append/delete tools', () => {
	it('write_note - 新建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createWriteNoteTool(vault);
		const res = await tool.execute({ path: 'new.md', content: '# Hi' }) as { created: boolean };
		expect(res.created).toBe(true);
		expect(await vault.readFile('new.md')).toBe('# Hi');
	});

	it('write_note - 覆盖', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'old' } });
		const tool = createWriteNoteTool(vault);
		const res = await tool.execute({ path: 'a.md', content: 'new' }) as { created: boolean };
		expect(res.created).toBe(false);
	});

	it('append_note - 追加', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'line1\n' } });
		const tool = createAppendNoteTool(vault);
		await tool.execute({ path: 'a.md', content: 'line2\n' });
		expect(await vault.readFile('a.md')).toBe('line1\nline2\n');
	});

	it('delete_note - 回收站', async () => {
		const vault = createMockVaultPort({ files: { 'del.md': 'x' } });
		const tool = createDeleteNoteTool(vault);
		const res = await tool.execute({ path: 'del.md' }) as { trashed: boolean };
		expect(res.trashed).toBe(true);
		expect(await vault.fileExists('del.md')).toBe(false);
	});
});
```

- [ ] **Step 2: 实现三个工具文件**

`write-note.ts`:

```typescript
import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createWriteNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'write_note',
			description: '创建新笔记或覆盖已有笔记全文。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目标笔记路径' },
					content: { type: 'string', description: '完整文件内容' },
				},
				required: ['path', 'content'],
			},
		},
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			const content = typeof args.content === 'string' ? args.content : (() => {
				throw new Error('content 必须是字符串');
			})();
			const existed = await vault.fileExists(path);
			await vault.writeFile(path, content);
			return { path, created: !existed };
		},
	};
}
```

`append-note.ts` 调 `vault.appendFile`,返回 `{ path, created: !(await vault.fileExists(path)) }` — **注意:** 应先 `fileExists` 再 append。

`delete-note.ts` 调 `vault.trashFile`,返回 `{ path, trashed: true }`。

- [ ] **Step 3: 运行测试并提交**

Run: `npm test -- tests/tools/write-append-delete.test.ts`

```bash
git add src/tools/write-note.ts src/tools/append-note.ts src/tools/delete-note.ts tests/tools/write-append-delete.test.ts
git commit -m "feat(vault-tools): 添加 write_note/append_note/delete_note"
```

---

## Task 10: `edit_note` 工具

**Files:**
- Create: `src/tools/edit-note.ts`
- Test: `tests/tools/edit-note.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { createEditNoteTool } from '../../src/tools/edit-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('edit_note tool', () => {
	it('唯一匹配 - 替换成功', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'foo bar baz' } });
		const tool = createEditNoteTool(vault);
		const res = await tool.execute({ path: 'a.md', old_string: 'bar', new_string: 'qux' }) as { replaced: boolean };
		expect(res.replaced).toBe(true);
		expect(await vault.readFile('a.md')).toBe('foo qux baz');
	});

	it('old_string 不存在 - 报错', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'x' } });
		const tool = createEditNoteTool(vault);
		await expect(
			tool.execute({ path: 'a.md', old_string: 'missing', new_string: 'y' }),
		).rejects.toThrow('未找到要替换的文本');
	});

	it('old_string 多次匹配 - 报错', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'dup\ndup' } });
		const tool = createEditNoteTool(vault);
		await expect(
			tool.execute({ path: 'a.md', old_string: 'dup', new_string: 'x' }),
		).rejects.toThrow('出现多次');
	});
});
```

- [ ] **Step 2: 实现**

```typescript
import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		count++;
		pos = idx + needle.length;
	}
	return count;
}

export function createEditNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'edit_note',
			description:
				'在笔记中精确替换一段文本。old_string 必须与文件内容完全一致(含缩进),且在文件中唯一;否则返回错误。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目标笔记路径' },
					old_string: { type: 'string', description: '要被替换的原文(唯一匹配)' },
					new_string: { type: 'string', description: '替换后的文本' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			const oldString = typeof args.old_string === 'string' ? args.old_string : (() => {
				throw new Error('old_string 必须是字符串');
			})();
			const newString = typeof args.new_string === 'string' ? args.new_string : (() => {
				throw new Error('new_string 必须是字符串');
			})();

			if (!(await vault.fileExists(path))) {
				throw new Error(`文件不存在: ${path}`);
			}

			const content = await vault.readFile(path);
			const n = countOccurrences(content, oldString);
			if (n === 0) {
				throw new Error('未找到要替换的文本,请确认 old_string 精确匹配(含空白缩进)');
			}
			if (n > 1) {
				throw new Error(`old_string 在文件中出现多次(共 ${n} 次),请提供更多上下文(前后各 3-5 行)以唯一确定`);
			}

			await vault.processFile(path, (c) => c.replace(oldString, newString));
			return { path, replaced: true };
		},
	};
}
```

- [ ] **Step 3: 运行测试并提交**

Run: `npm test -- tests/tools/edit-note.test.ts`

```bash
git add src/tools/edit-note.ts tests/tools/edit-note.test.ts
git commit -m "feat(vault-tools): 添加 edit_note 精确替换工具"
```

---

## Task 11: Settings — `toolPermissions` + UI

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: 扩展类型与默认值**

在 `RatelVaultSettings` 追加:

```typescript
import type { ToolPermission } from './core/tool-permissions';

// 在 interface 内:
	toolPermissions: Record<string, ToolPermission>;
	trustMode: boolean;
```

`DEFAULT_SETTINGS` 追加:

```typescript
	toolPermissions: {
		search_vault: 'allow',
		read_note: 'allow',
		grep: 'allow',
		glob: 'allow',
		list_files: 'allow',
		write_note: 'ask',
		append_note: 'ask',
		edit_note: 'ask',
		delete_note: 'ask',
	},
	trustMode: false,
```

- [ ] **Step 2: 在 `renderSettings` 中「开发者」分组之前插入「工具权限」**

```typescript
	private renderToolPermissions(container: HTMLElement): void {
		container.createEl('h3', { text: '工具权限' });
		new Setting(container)
			.setName('信任模式')
			.setDesc('开启后所有工具直接执行,不再弹出确认对话框')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.trustMode).onChange(async (v) => {
					this.plugin.settings.trustMode = v;
					await this.plugin.saveSettings();
				}),
			);

		const readonlyTools = ['search_vault', 'read_note', 'grep', 'glob', 'list_files'];
		const writeTools = ['write_note', 'append_note', 'edit_note', 'delete_note'];
		const labels: Record<string, string> = {
			search_vault: '语义搜索',
			read_note: '读取笔记',
			grep: '精确搜索',
			glob: '文件名匹配',
			list_files: '列目录',
			write_note: '创建/覆盖',
			append_note: '追加内容',
			edit_note: '精确替换',
			delete_note: '移到回收站',
		};
		const options: Record<ToolPermission, string> = { allow: '允许', ask: '询问', deny: '拒绝' };

		for (const name of [...readonlyTools, ...writeTools]) {
			new Setting(container)
				.setName(labels[name] ?? name)
				.setDesc(name)
				.addDropdown((dropdown) => {
					dropdown.addOption('allow', options.allow);
					dropdown.addOption('ask', options.ask);
					dropdown.addOption('deny', options.deny);
					dropdown.setValue(this.plugin.settings.toolPermissions[name] ?? 'ask');
					dropdown.onChange(async (v) => {
						this.plugin.settings.toolPermissions[name] = v as ToolPermission;
						await this.plugin.saveSettings();
					});
				});
		}
	}
```

在 `renderSettings` 里 `debugLog` 分组之前调用 `this.renderToolPermissions(containerEl)`。

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add src/settings.ts
git commit -m "feat(vault-tools): 设置面板工具权限与信任模式"
```

---

## Task 12: 主线程接线 — main.ts + context-manager + 路径 hook

> **若 P-PROMPTS 已完成:** 跳过 Step 2(`context-manager` RAG_PROMPT interim);vault 工具文案已在 `src/prompts/defaults/zh.ts`,只需扩展 `ACTIVE_TOOL_NAMES` 并 `syncToolDefinitions()`。

**Files:**
- Modify: `src/main.ts`
- Modify: `src/core/context-manager.ts`

- [ ] **Step 1: `main.ts` 注册工具与 hook**

在类上增加字段:

```typescript
import { ToolPermissionSessionGrants, resolveToolPermission } from './core/tool-permissions';
import { showToolConfirmModal } from './ui/confirm-modal';
import { validateVaultPath } from './utils/path-safety';
import { extractToolPath } from './core/tool-permissions';
import { createGrepTool } from './tools/grep';
// ... 其他 create*Tool imports

	toolSessionGrants = new ToolPermissionSessionGrants();
```

注册工具(在 search_vault 之后):

```typescript
		this.tools.register(createGrepTool(this.vault));
		this.tools.register(createGlobTool(this.vault));
		this.tools.register(createListFilesTool(this.vault));
		this.tools.register(createWriteNoteTool(this.vault));
		this.tools.register(createAppendNoteTool(this.vault));
		this.tools.register(createEditNoteTool(this.vault));
		this.tools.register(createDeleteNoteTool(this.vault));
```

`HookRegistry` 创建后注册路径安全 hook:

```typescript
		this.hooks.register('pre-tool-use', async (tc) => {
			const path = extractToolPath(tc);
			if (!path) return;
			try {
				validateVaultPath(path);
			} catch (err) {
				return {
					allow: false,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}, 'path-safety');
```

`ask()` 传入权限检查:

```typescript
		const toolPermissionCheck = (tc: ToolCall) =>
			resolveToolPermission(
				tc,
				{ trustMode: this.settings.trustMode, toolPermissions: this.settings.toolPermissions },
				this.toolSessionGrants,
				(call) => showToolConfirmModal(this.app, call),
			);

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
			signal,
			intentClassifier,
			toolPermissionCheck,
		);
```

需在 `agent-loop.ts` 把 `toolPermissionCheck` 作为第 8 个参数(在 `intentClassifier` 之后)。

- [ ] **Step 2: 更新 `context-manager.ts` RAG_PROMPT(interim 中文工具指引)**

在 `RAG_PROMPT` 常量末尾追加(中文,对应 spec §4.13):

```typescript
const VAULT_TOOLS_GUIDE_ZH = `

你可使用以下 vault 工具:
- search_vault: 语义搜索(向量+BM25),适合找概念相关的内容
- grep: 全文精确/正则搜索,适合查找特定汉字、代码、固定字符串
- glob: 按文件名模式查找笔记(如 "daily/*.md")
- list_files: 列出目录内容
- read_note: 读取笔记全文
- write_note: 创建或覆盖笔记
- append_note: 在笔记末尾追加内容
- edit_note: 精确替换文本(old_string 必须唯一且完全匹配)
- delete_note: 将笔记移到回收站(可恢复)

何时用 grep 而非 search_vault:
- 用户要找特定词语、精确字符串、正则模式,或「包含 X 的所有文件」→ 用 grep
- 用户问主题、概念、语义相关内容 → 用 search_vault
- 不确定时先试 search_vault;若结果未包含精确词,再用 grep 补充
`;

const RAG_PROMPT = BASE_PROMPT + `...现有工作流...` + VAULT_TOOLS_GUIDE_ZH;
```

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 全部 PASS(基线 309 + 新增)

- [ ] **Step 4: 提交**

```bash
git add src/main.ts src/core/context-manager.ts src/core/agent-loop.ts
git commit -m "feat(vault-tools): 注册 7 个工具、权限门控与中文工具指引"
```

---

## Task 13: STATUS 更新与总体验收

**Files:**
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 更新 STATUS.md**

在实施 Plan 表新增:

```markdown
| **P-VAULT-TOOLS** | [2026-06-26-ratel-vault-tools-implementation.md](plans/2026-06-26-ratel-vault-tools-implementation.md) | 🔄 In Progress | main | 2026-06-26 | — | S-VAULT-TOOLS |
```

Future queue 追加:

```markdown
12. **P-VAULT-TOOLS**(Vault 文件工具集 + 三层安全)
```

- [ ] **Step 2: 总体验收**

Run: `npm run build && npm test`
Expected: build 0 errors; tests 全部 PASS

手动检查清单:
- [ ] 设置面板出现「工具权限」分组,trustMode 开关可用
- [ ] Chat 中 LLM 调用 `write_note` 时弹出确认框
- [ ] `grep` 能搜到精确汉字而 `search_vault` 不必返回语义相近结果

- [ ] **Step 3: 将 P-VAULT-TOOLS 标为 Completed(实施完成后)**

```markdown
| **P-VAULT-TOOLS** | ... | ✅ Completed | main | 2026-06-26 | 2026-06-26 | S-VAULT-TOOLS |
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs: P-VAULT-TOOLS 实施完成,更新 STATUS"
```

---

## Spec 自检(Plan 作者)

| Spec 章节 | 覆盖 Task |
|-----------|-----------|
| §4.1 工具清单 | Task 7–10, 12 |
| §4.2 VaultPort | Task 3–4 |
| §4.3 ObsidianVault | Task 4 |
| §4.4–4.10 各工具 | Task 7–10 |
| §4.11 注册 | Task 12 |
| §4.12 readOnly | 各工具 `readOnly` 字段 |
| §4.13 提示词 | Task 12(interim 中文;P-PROMPTS 后迁移) |
| §6 测试策略 | Task 1–10, 13 |
| §8.1 路径沙箱 | Task 1, 4, 12 |
| §8.2 Hook 阻断 | Task 5, 12 |
| §8.3 权限配置 | Task 6, 11, 12 |
| §8.4 参数校验 | Task 7 `validate-args` |
| §8.5 安全链路 | Task 5–6, 12 串联 |
| 非目标 move/rename/ripgrep | 未纳入(符合 spec) |

**软依赖说明:** P-PROMPTS 实施后,删除 `context-manager.ts` 中 `VAULT_TOOLS_GUIDE_ZH` 硬编码,改为 `composeAgentSystem` + `tool.*` section;本 plan 工具 `description` 已为中文,可直接迁入 registry。

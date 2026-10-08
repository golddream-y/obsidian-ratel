# S-CATALOG-FRESH 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打开对话模型页时，models.dev 名单缓存超过 24 小时就重拉；失败仍用旧文件。

**Architecture:** 只改 `ModelsDevCatalogCache` 的 TTL 常量。比较仍是严格大于。下拉过滤、`deprecated`、启动和发送路径都不动。

**Tech Stack:** TypeScript、Vitest、现有 `ModelsDevCatalogCache`。

**Spec:** [2026-10-08-catalog-freshness-design.md](../specs/2026-10-08-catalog-freshness-design.md)

## Global Constraints

- `CATALOG_TTL_MS = 24 * 60 * 60 * 1000`。`Date.now() - fetchedAt > CATALOG_TTL_MS` 才重拉。
- 不按 `status` 隐藏模型。不改 `listCatalogModels`。
- 不在 `onload` 拉取。对话发送不拉取。设置页开着时不轮询。
- 拉取失败、非名单、超过 8MB：有旧文件就用旧文件。
- 不改生态清单和 LiteLLM 映射表的 7 天缓存。
- 工作区有无关改动。提交时只暂存本任务列出的文件。

---

### Task 1: 缓存超过 24 小时才重拉

**Files:**
- Modify: `src/settings/model-catalog-cache.ts`
- Test: `tests/settings/model-catalog-cache.test.ts`

**Interfaces:**
- Consumes: `ModelsDevCatalogCache.ensureCatalog()`
- Produces: `export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000`

- [x] **Step 1: Write the failing test**

在 `tests/settings/model-catalog-cache.test.ts` 增加 import `CATALOG_TTL_MS`，并加这两则。现有「8 天前的缓存、拉取失败、返回旧名单」保持不动。

```typescript
it('ensureCatalog - 超过 24 小时 - 重新拉取并覆盖', async () => {
	const dir = await tempDir();
	await writeFile(path.join(dir, 'models-dev.json'), body, 'utf-8');
	await writeFile(
		path.join(dir, 'models-dev.meta.json'),
		JSON.stringify({ fetchedAt: Date.now() - CATALOG_TTL_MS - 1000, sourceUrl: MODELS_DEV_URL }),
		'utf-8',
	);
	const next = JSON.stringify({
		openai: { id: 'openai', name: 'OpenAI', api: '', models: {} },
	});
	let calls = 0;
	const cache = new ModelsDevCatalogCache(dir, async () => {
		calls += 1;
		return { status: 200, text: next } as never;
	});
	const catalog = await cache.ensureCatalog();
	expect(calls).toBe(1);
	expect(catalog?.openai?.id).toBe('openai');
	expect(catalog?.deepseek).toBeUndefined();
});

it('ensureCatalog - 未超过 24 小时 - 不请求', async () => {
	const dir = await tempDir();
	await writeFile(path.join(dir, 'models-dev.json'), body, 'utf-8');
	await writeFile(
		path.join(dir, 'models-dev.meta.json'),
		JSON.stringify({ fetchedAt: Date.now() - CATALOG_TTL_MS + 60_000, sourceUrl: MODELS_DEV_URL }),
		'utf-8',
	);
	let calls = 0;
	const cache = new ModelsDevCatalogCache(dir, async () => {
		calls += 1;
		return { status: 500, text: '' } as never;
	});
	const catalog = await cache.ensureCatalog();
	expect(calls).toBe(0);
	expect(catalog?.deepseek?.id).toBe('deepseek');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/model-catalog-cache.test.ts`

Expected: FAIL。`CATALOG_TTL_MS` 尚未导出，或超过 24 小时的用例仍返回旧的 deepseek（当前 TTL 是 7 天）。

- [x] **Step 3: Write minimal implementation**

`src/settings/model-catalog-cache.ts`：

```typescript
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
```

删掉原来的 `const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000`。文件头 `@description` 与类注释里的「7 天」改成「24 小时」。`readCacheIfFresh` 的比较保持 `Date.now() - meta.fetchedAt > CATALOG_TTL_MS`。

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/model-catalog-cache.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

只暂存这两个文件。

```bash
git add src/settings/model-catalog-cache.ts tests/settings/model-catalog-cache.test.ts
git commit -m "$(cat <<'EOF'
fix: 模型名单缓存超过一天就重拉

EOF
)"
```

---

### Task 2: 把时长写回原规格和更新日志

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-model-catalog-design.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 的 24 小时 TTL
- Produces: 无

- [x] **Step 1: 改 S-MODEL-CATALOG 的两处时长**

`docs/superpowers/specs/2026-09-28-model-catalog-design.md`：

MC-01 验收口径里的「若缓存超过 7 天或没有缓存」改为「若缓存超过 24 小时或没有缓存」。句末加「时长以 S-CATALOG-FRESH 为准。」

§5.3 的「超过 7 天，下次打开对话模型页再拉。」改为「超过 24 小时，下次打开对话模型页再拉。时长以 S-CATALOG-FRESH 为准。」

- [x] **Step 2: 更新日志**

`CHANGELOG.md` 在最新已发布版本之前插入：

```markdown
## [Unreleased]

### Changed

- **对话模型名单超过一天会重新拉取** — 打开对话模型页时，本地名单超过 24 小时就向 models.dev 要一份新的。这次没要到仍用上次成功的名单。

```

若文件顶部已经有 `[Unreleased]`，只把这条加进它的 `### Changed`，不要再开一节。

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-28-model-catalog-design.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: 模型名单缓存改为超过一天重拉

EOF
)"
```

---

## 自审

| Spec 条款 | 对应任务 |
|---|---|
| 超过 24 小时重拉并覆盖 | Task 1 第一则测试 |
| 未超过不请求 | Task 1 第二则测试 |
| 失败仍用旧文件 | 现有「拉取失败且有过期缓存」测试，不改断言 |
| 不隐藏 `deprecated` | 不改 `listCatalogModels` 与其测试 |
| 原规格 MC-01 / §5.3 | Task 2 |
| 更新日志 | Task 2 |

无占位步骤。TTL 只在 `CATALOG_TTL_MS` 一处定义，测试引用该常量。

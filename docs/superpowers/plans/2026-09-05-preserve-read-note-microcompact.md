# P-READ-PRESERVE-1:microcompact 保留 read_note / 图切片

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 [S-READ-PRESERVE](../specs/2026-09-05-preserve-read-note-microcompact.md) — microcompact 不再把 `read_note` 折成占位;图切片继续不折;默认 prompt 禁止已有全文再读、禁止沿边巡库。

**Architecture:** 只改投影集合与两段默认 prompt。`microcompactMessages` 算法不动(仍按全部 tool 切「最早 N-5」候选,再按 `FOLDABLE_TOOL_NAMES` 跳过);从集合删除 `read_note`。`get_links` 等本就不在集合,用回归测试钉死。全量 compact 后的路径清单改文案,不再写「按需 read_note」。单条 32k 裁、`KEEP_RECENT=5`、85% 自动摘要、`search_vault` 契约、检索内 1 跳扩邻均不改。

**Tech Stack:** TypeScript strict / vitest / 现有 `compact-project.ts` / Composer 默认源 `prompts/defaults/zh.ts` / 无新依赖。

**关联文档:** [S-READ-PRESERVE](../specs/2026-09-05-preserve-read-note-microcompact.md)、[ADR-013](../../adr/2026-08-03-graph-retrieval-minimize-human-curation.md)

## Global Constraints

- 用户可见 CHANGELOG 用场景语言,不写模块名 / 路径
- 发给模型的占位与恢复路径文案**不**走 i18n(与现 `[compacted]` 同类)
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`
- 文件头 / JSDoc 中文;禁止 TS `enum`
- **禁止**把 `get_links` / `search_by_tag` / `search_by_property` / `get_vault_structure` 加入 `FOLDABLE_TOOL_NAMES`
- **禁止**改 `KEEP_RECENT_TOOL_RESULTS`、自动摘要阈值、`search_vault` 返回形状、agent-loop 拆条
- **禁止**实现 read-once 工具拦截或工具输出落盘
- 无新 npm 依赖

---

## 文件结构

```
src/core/compact-project.ts            [改] FOLDABLE 去掉 read_note;projectView 恢复路径文案
tests/core/compact-project.test.ts     [改] grep 可折 / read_note 与 get_links 不折 / 文案
src/prompts/defaults/zh.ts             [改] agent.rag.workflow + agent.rag.toolGuide
CHANGELOG.md                           [改] 顶部加 [Unreleased] Fixed
docs/superpowers/STATUS.md             [改] 本 plan 登记(与本文件同一次提交已做则跳过)
```

无新文件。

---

## 与 spec 的偏差

无。prompt 全文以本 plan Task 2 代码块为准(与 spec §4.4 同文,避免执行时两边对不齐)。

---

### Task 1: microcompact 集合与恢复路径文案

**Files:**
- Modify: `src/core/compact-project.ts`(FOLDABLE 集合;约 169 行 `projectView` 文案)
- Test: `tests/core/compact-project.test.ts`

**Interfaces:**
- Consumes: 现有 `microcompactMessages(messages, keepRecent?)`、`projectView`、`FOLDABLE_TOOL_NAMES`
- Produces: `FOLDABLE_TOOL_NAMES` 不含 `read_note`;含 `search_vault`/`grep`/`glob`/`list_files`/`search_memory`;恢复路径 system 前缀为 `最近读过的笔记（仅当上下文中没有该篇 read_note 全文时再读）:`

- [ ] **Step 1: 改测试(RED)**

在 `tests/core/compact-project.test.ts` 增加 import `FOLDABLE_TOOL_NAMES`。

**替换**现有 `it('microcompactMessages - 旧 read_note 超保留条数 - 正文变占位且保留 toolCallId'` 为 grep 用例,并追加下列用例(保留 Error / remember / 其余 describe):

```typescript
import {
	AUTO_COMPACT_THRESHOLD_PCT,
	CompactCircuitBreaker,
	FOLDABLE_TOOL_NAMES,
	extractRestoredNotePaths,
	isPromptTooLong,
	microcompactMessages,
	projectView,
	shouldAutoCompact,
} from '../../src/core/compact-project';

it('FOLDABLE_TOOL_NAMES - 发现类可折,read_note 与图切片不可折', () => {
	expect([...FOLDABLE_TOOL_NAMES].sort()).toEqual(
		['glob', 'grep', 'list_files', 'search_memory', 'search_vault'].sort(),
	);
	expect(FOLDABLE_TOOL_NAMES.has('read_note')).toBe(false);
	expect(FOLDABLE_TOOL_NAMES.has('get_links')).toBe(false);
	expect(FOLDABLE_TOOL_NAMES.has('search_by_tag')).toBe(false);
	expect(FOLDABLE_TOOL_NAMES.has('search_by_property')).toBe(false);
	expect(FOLDABLE_TOOL_NAMES.has('get_vault_structure')).toBe(false);
});

it('microcompactMessages - 旧 grep 超保留条数 - 正文变占位且保留 toolCallId', () => {
	const msgs: ChatMessage[] = [];
	for (let i = 0; i < 6; i++) {
		msgs.push(asstTool(`t${i}`, 'grep', { pattern: `p${i}` }));
		msgs.push(tool(`t${i}`, 'FULL'.repeat(20)));
	}
	const out = microcompactMessages(msgs, 5);
	const tools = out.filter((m) => m.role === 'tool');
	expect(tools[0]!.content.startsWith('[compacted] grep')).toBe(true);
	expect(tools[5]!.content.startsWith('FULL')).toBe(true);
	expect(tools[0]!.toolCallId).toBe('t0');
});

it('microcompactMessages - 6 条 read_note keepRecent=5 - 全部仍是全文', () => {
	const msgs: ChatMessage[] = [];
	for (let i = 0; i < 6; i++) {
		msgs.push(asstTool(`t${i}`, 'read_note', { path: `n${i}.md` }));
		msgs.push(tool(`t${i}`, `BODY${i}`.repeat(10)));
	}
	const out = microcompactMessages(msgs, 5);
	const tools = out.filter((m) => m.role === 'tool');
	expect(tools).toHaveLength(6);
	for (const t of tools) {
		expect(t.content.startsWith('[compacted]')).toBe(false);
		expect(t.content.startsWith('BODY')).toBe(true);
	}
});

it('microcompactMessages - 6 条 get_links keepRecent=5 - 切片全部保留', () => {
	const msgs: ChatMessage[] = [];
	for (let i = 0; i < 6; i++) {
		msgs.push(asstTool(`t${i}`, 'get_links', { path: `n${i}.md` }));
		msgs.push(tool(`t${i}`, JSON.stringify({ path: `n${i}.md`, outgoing: [`x${i}.md`] })));
	}
	const out = microcompactMessages(msgs, 5);
	const tools = out.filter((m) => m.role === 'tool');
	expect(tools).toHaveLength(6);
	for (const t of tools) {
		expect(t.content.startsWith('[compacted]')).toBe(false);
		expect(t.content).toContain('outgoing');
	}
});

it('microcompactMessages - 先 6 条 grep 再 1 条 get_links - grep 可折 links 仍在', () => {
	const msgs: ChatMessage[] = [];
	for (let i = 0; i < 6; i++) {
		msgs.push(asstTool(`g${i}`, 'grep', { pattern: 'q' }));
		msgs.push(tool(`g${i}`, 'GREP'.repeat(20)));
	}
	msgs.push(asstTool('L', 'get_links', { path: 'hub.md' }));
	msgs.push(tool('L', '{"path":"hub.md","outgoing":["a.md"]}'));
	const out = microcompactMessages(msgs, 5);
	const tools = out.filter((m) => m.role === 'tool');
	expect(tools[0]!.content.startsWith('[compacted] grep')).toBe(true);
	expect(tools[6]!.content).toContain('hub.md');
	expect(tools[6]!.content.startsWith('[compacted]')).toBe(false);
});
```

在 `projectView - 有标记` 用例末尾追加断言(原有摘要 / tail 断言保留):

```typescript
expect(p.head.some((m) => m.content.includes('没有该篇'))).toBe(true);
expect(p.head.some((m) => m.content.includes('按需 read_note'))).toBe(false);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/compact-project.test.ts`

Expected: FAIL — `FOLDABLE` 仍含 `read_note`;旧 grep 用例若先改测试而代码未改,grep 用例应通过(grep 本就可折);`6 条 read_note` 失败(第一条仍是 `[compacted] read_note`);`projectView` 失败(仍含「按需 read_note」)。

若「6 条 read_note」没有失败,停下来:说明集合已经不含 `read_note`,与仓库现状不符,先对一下 `compact-project.ts`。

- [ ] **Step 3: 最小实现**

`src/core/compact-project.ts` 的集合改为:

```typescript
export const FOLDABLE_TOOL_NAMES = new Set([
	'search_vault',
	'grep',
	'glob',
	'list_files',
	'search_memory',
]);
```

`projectView` 里恢复路径那一行改为:

```typescript
content: `最近读过的笔记（仅当上下文中没有该篇 read_note 全文时再读）:\n${lines}`,
```

不要改 `microcompactMessages` 循环、不要改 `KEEP_RECENT_TOOL_RESULTS`、不要改 `formatCompactedPlaceholder`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/compact-project.test.ts`

Expected: PASS 全部。

再跑(防止 context-manager 里还有「read_note 必被折」的断言):

Run: `npx vitest run tests/core/context-manager.test.ts tests/core/compact-project.test.ts`

Expected: PASS。若 context-manager 有用例假设旧 read_note 变 `[compacted]`,按同样语义改成 grep,不要把 read_note 加回 FOLDABLE。

- [ ] **Step 5: Commit**

```bash
git add src/core/compact-project.ts tests/core/compact-project.test.ts
# 若改了 context-manager.test.ts 一并 add
git commit -m "$(cat <<'EOF'
fix(compact): microcompact 不再折叠 read_note 全文

图切片保持不折;发现类工具仍按条数占位。全量摘要路径清单不再邀请按需再读。
EOF
)"
```

---

### Task 2: RAG prompt 与 CHANGELOG

**Files:**
- Modify: `src/prompts/defaults/zh.ts`(`agent.rag.workflow`、`agent.rag.toolGuide`)
- Modify: `CHANGELOG.md`(在 `[0.6.0]` **之上**新建 `[Unreleased]`,当前 0.6.0 已发版)

**Interfaces:**
- Consumes: Composer `resolveSection('agent.rag.workflow' | 'agent.rag.toolGuide')`;无 en 副本
- Produces: 默认中文工作流 6 步;toolGuide 在结构四条之后多 3 条复用/1 跳约束

- [ ] **Step 1: 替换 workflow 与 toolGuide**

`src/prompts/defaults/zh.ts` 中这两段**整段替换**为:

```typescript
	'agent.rag.workflow': `回答知识库问题时,按以下流程:
1. 语义主题用 search_vault 查找相关笔记(结果带 index 编号)。链接/标签/属性/目录结构问题先按 toolGuide 选图或过滤工具,需要语义补召时再 search_vault。
2. 对有价值、且上下文中尚无该 path 全文的笔记调用 read_note。
3. 禁止对「上一拍 tool 结果里已有该 path 全文」的笔记再次 read_note。仅当该篇只剩 [compacted]、[truncated、或全量摘要后的路径清单时,才允许再读。
4. 凡依据 search_vault 检索结论的句子,句末必须写 [n](与最后一次 search_vault 返回的 index 一致);禁止只用文件名或表格代替 [n] 作为唯一引用方式。仅依据 get_links 等图切片的句子不编造 [n]。
5. 同一回合若多次调用 search_vault,只用最后一次返回的 index;禁止为给图邻居凑引用而用相同 query 再搜一遍。
6. 若无结果,如实告知。`,

	'agent.rag.toolGuide': `工具选用说明:
- 问主题、概念、语义相关:优先 search_vault。
- 已知路径或需全文:用 read_note(同时返回全文及单篇 frontmatter / tags / links / backlinks 元数据)。
- 问「谁链到这篇 / 这篇链向哪 / 有哪些未解析链接或知识缺口」:先用 get_links 看链接图切片。
- 要按标签精确过滤:用 search_by_tag(支持嵌套标签前缀),再决定是否用 search_vault 做语义搜索。
- 要按 frontmatter 属性过滤:用 search_by_property;省略 value 可查询属性键是否存在。
- 要看知识库目录、标签统计或孤儿笔记:用 get_vault_structure。
- 图工具结果若已在上下文中且参数相同,不要重跑。
- 不要沿出链/反链逐个再 get_links(默认最多 1 跳)。日记、MOC、出链或反链特别多的篇,不要把邻居全部 read_note。
- 已有 read_note 全文的 path,不因出现在别人的链接清单里再读。
- 找精确字面、正则、文件名模式:用 grep / glob。
- 涉及「今天 / 本周 / 现在几点」:先看系统注入的当前本地时间;需要精确或相对日期时再调 get_datetime。
- 「当前这篇 / 打开的笔记」:先 get_active_note 拿路径,再 read_note。
- 「今天的日记」:get_daily_note(只探测路径,不自动创建)。
- 「最近改过哪些」:list_recent_notes。
- 「这篇有哪些章节」:get_note_outline(走标题缓存,不必读全文)。
- 检索到笔记后要为用户「打开原文并定位」:用 open_note(path 可省略 .md,anchor 定位标题或 ^块)。

当前可用工具:
{{toolList}}`,
```

图三条必须插在 `get_vault_structure` 那条**之后**、`grep / glob` **之前**。`{{toolList}}` 行保留。不要改 `tool.get_links.description` 等 schema 段。

- [ ] **Step 2: CHANGELOG**

`CHANGELOG.md` 在 `# 更新日志` 与 `## [0.6.0]` 之间插入:

```markdown
## [Unreleased]

### Fixed
- **同一轮里不会反复打开已经读过的笔记** — 以前上下文一瘦身,助手会把刚看过的几篇再「查看」多遍;现在全文还在就不会再读。链接关系问句仍用链接图,不会为了凑引用把邻居整表再搜再读一遍

```

不要改 `[0.6.0]` 已发版正文。不要写 `microcompact` / `FOLDABLE` / 文件路径。

- [ ] **Step 3: 验证**

Run: `npx vitest run tests/core/compact-project.test.ts`

Expected: PASS。

Run: `npx vitest run src/prompts` 若该目录无测试则跳过,改为:

Run: `rg -n "按需 read_note" src/core/compact-project.ts src/prompts/defaults/zh.ts`

Expected: 无匹配。

Run: `rg -n "FOLDABLE_TOOL_NAMES" -A6 src/core/compact-project.ts`

Expected: 集合五元素且无 `read_note`。

- [ ] **Step 4: Commit**

```bash
git add src/prompts/defaults/zh.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
fix(prompt): 已有笔记全文禁止再读,图查询默认一跳

避免沿出链把枢纽邻居整表灌进上下文,引用仍只认最后一次 search_vault。
EOF
)"
```

---

## 自审

| spec 条款 | 本 plan |
|---|---|
| 4.1 移出 `read_note`、发现类仍折 | Task 1 集合 + grep 用例 |
| 4.1 图切片不进 FOLDABLE | Task 1 `FOLDABLE` 断言 + 6×`get_links` + grep 后 `get_links` |
| 4.1a / 4.4 禁止再读、1 跳、不编造 `[n]` | Task 2 整段 prompt |
| 4.2 32k 裁不动 | Global Constraints;无代码步 |
| 4.3 恢复路径文案 | Task 1 `projectView` |
| 4.5 测试清单 | Task 1 全部覆盖 |
| 4.6 CHANGELOG Unreleased | Task 2;0.6.0 已发故新建 Unreleased |
| 非目标 read-once / 落盘 / 改阈值 / 检索扩邻 | 禁止项写在 Global Constraints |

无 TBD。类型名与现网 `FOLDABLE_TOOL_NAMES` / `microcompactMessages` / `projectView` 一致。

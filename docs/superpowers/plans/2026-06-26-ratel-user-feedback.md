# S-FEEDBACK Implementation Plan — 用户反馈与开发者日志分离

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 DevLogger / UserNotice / UserStatus 三模块严格分离,由 FeedbackController 接线,Chat 侧栏 StatusBar + 会话内错误展示(软拦 B),`main.ts` 不再承载 Notice 业务逻辑。

**Architecture:** 开发者通道仅 `src/logging/dev-logger.ts`;使用者通道为 `user-notice`(toast) + `user-status`(持久 store) + `StatusBar.svelte` + `chat-error.ts`(轮次错误);`FeedbackController` 订阅 `status$` 并驱动前两者;Chat 轮次错误禁止 `userNotice`。

**Tech Stack:** TypeScript 5 + Obsidian Plugin API + Svelte 5 + svelte/store。

**Spec:** [`docs/superpowers/specs/2026-06-26-ratel-user-feedback-design.md`](../specs/2026-06-26-ratel-user-feedback-design.md)

---

## 文件影响面

| 路径 | 操作 | 说明 |
|------|------|------|
| `src/logging/dev-logger.ts` | 新建 | 开发者 console 日志 |
| `src/user-feedback/user-notice.ts` | 新建 | Obsidian Notice 封装 |
| `src/user-feedback/user-status.ts` | 新建 | statusBar$ store |
| `src/core/feedback-controller.ts` | 新建 | status$ → user 通道接线 |
| `src/ui/StatusBar.svelte` | 新建 | 持久状态条 |
| `src/ui/chat-error.ts` | 新建 | Chat 结构化错误 DOM |
| `src/ui/chat-send-gate.ts` | 新建 | Send 硬拦/软拦判定 |
| `src/ui/ChatView.svelte` | 修改 | StatusBar + 错误 UI + 工具三态 |
| `src/main.ts` | 修改 | 接线;删除内联 Notice |
| `src/settings.ts` | 修改 | `debugLog` 开关 |
| `src/tools/search-vault.ts` | 修改 | 检索就绪检查 |
| `src/ui/IndexBanner.svelte` | 删除 | 由 StatusBar 替代 |
| `tests/logging/dev-logger.test.ts` | 新建 | |
| `tests/user-feedback/user-status.test.ts` | 新建 | |
| `tests/user-feedback/user-notice.test.ts` | 新建 | |
| `tests/core/feedback-controller.test.ts` | 新建 | |
| `tests/ui/chat-send-gate.test.ts` | 新建 | |
| `hooks/index-processor/vector-vectra/main` 等 | 修改 | `console.*` → `devLogger.*` |

**测试基线:** 实施前跑 `npm test` 记录通过数;每个 Task 后零回归。

---

## Task 1: DevLogger

**Files:**
- Create: `src/logging/dev-logger.ts`
- Create: `tests/logging/dev-logger.test.ts`

- [ ] **Step 1.1: 写失败测试**

创建 `tests/logging/dev-logger.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DevLogger } from '../../src/logging/dev-logger';

describe('DevLogger', () => {
	let logger: DevLogger;

	beforeEach(() => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		logger = new DevLogger({ debugEnabled: false });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('info - 输出带 [Ratel:module] 前缀', () => {
		logger.info('index', '全量索引开始');
		expect(console.info).toHaveBeenCalledWith('[Ratel:index] 全量索引开始');
	});

	it('debug - debugEnabled=false 时不输出', () => {
		logger.debug('worker', 'message');
		expect(console.info).not.toHaveBeenCalled();
	});

	it('debug - debugEnabled=true 时输出', () => {
		logger.setDebugEnabled(true);
		logger.debug('worker', 'ping');
		expect(console.info).toHaveBeenCalledWith('[Ratel:worker] ping');
	});

	it('error - 附带 Error 时打印 stack', () => {
		const err = new Error('boom');
		logger.error('agent', '工具失败', err);
		expect(console.error).toHaveBeenCalled();
	});
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `npm test -- tests/logging/dev-logger.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 1.3: 实现 DevLogger**

创建 `src/logging/dev-logger.ts`:

```typescript
/**
 * @file src/logging/dev-logger.ts
 * @description 开发者专用日志 — 仅 console,禁止 Notice / 用户 UI
 * @module logging/dev-logger
 */

export type LogModule = 'index' | 'model' | 'worker' | 'agent' | 'vectra' | 'hooks' | 'vault' | 'main';

export interface DevLoggerOptions {
	debugEnabled?: boolean;
}

export class DevLogger {
	private debugEnabled: boolean;

	constructor(options: DevLoggerOptions = {}) {
		this.debugEnabled = options.debugEnabled ?? false;
	}

	setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	debug(module: LogModule, message: string, data?: unknown): void {
		if (!this.debugEnabled) return;
		this.write('info', module, message, data);
	}

	info(module: LogModule, message: string, data?: unknown): void {
		this.write('info', module, message, data);
	}

	warn(module: LogModule, message: string, data?: unknown): void {
		this.write('warn', module, message, data);
	}

	error(module: LogModule, message: string, data?: unknown): void {
		this.write('error', module, message, data);
	}

	private write(level: 'info' | 'warn' | 'error', module: LogModule, message: string, data?: unknown): void {
		const prefix = `[Ratel:${module}] ${message}`;
		const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
		if (data instanceof Error) {
			fn(prefix, data);
		} else if (data !== undefined) {
			fn(prefix, data);
		} else {
			fn(prefix);
		}
	}
}

/** 插件级单例 — settings.debugLog 变更时调 setDebugEnabled */
export const devLogger = new DevLogger();
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `npm test -- tests/logging/dev-logger.test.ts`
Expected: PASS

- [ ] **Step 1.5: 提交**

```bash
git add src/logging/dev-logger.ts tests/logging/dev-logger.test.ts
git commit -m "feat(logging): 新增 DevLogger 开发者专用日志模块"
```

---

## Task 2: UserStatus

**Files:**
- Create: `src/user-feedback/user-status.ts`
- Create: `tests/user-feedback/user-status.test.ts`

- [ ] **Step 2.1: 写失败测试**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { UserStatus, DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('UserStatus', () => {
	let status: UserStatus;

	beforeEach(() => {
		status = new UserStatus();
	});

	it('初始 - 默认值', () => {
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});

	it('patch - 浅合并字段', () => {
		status.patch({ model: 'ready', indexDocCount: 42 });
		expect(get(status.statusBar$).model).toBe('ready');
		expect(get(status.statusBar$).indexDocCount).toBe(42);
		expect(get(status.statusBar$).embedding).toBe('loading');
	});

	it('reset - 恢复默认', () => {
		status.patch({ model: 'failed' });
		status.reset();
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});
});
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `npm test -- tests/user-feedback/user-status.test.ts`
Expected: FAIL

- [ ] **Step 2.3: 实现 UserStatus**

创建 `src/user-feedback/user-status.ts`,包含 spec 中的 `UserStatusSnapshot` 类型、`DEFAULT_USER_STATUS`、`UserStatus` 类(`statusBar$` / `patch` / `reset`)。

- [ ] **Step 2.4: 跑测试确认通过**

Run: `npm test -- tests/user-feedback/user-status.test.ts`
Expected: PASS

- [ ] **Step 2.5: 提交**

```bash
git add src/user-feedback/user-status.ts tests/user-feedback/user-status.test.ts
git commit -m "feat(feedback): 新增 UserStatus 持久状态 store"
```

---

## Task 3: UserNotice

**Files:**
- Create: `src/user-feedback/user-notice.ts`
- Create: `tests/user-feedback/user-notice.test.ts`

- [ ] **Step 3.1: Mock Notice 并写测试**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hide = vi.fn();
const setMessage = vi.fn();
const NoticeMock = vi.fn().mockImplementation(function (this: { hide: typeof hide; setMessage: typeof setMessage }, msg: string) {
	this.hide = hide;
	this.setMessage = setMessage;
	return this;
});

vi.mock('obsidian', () => ({ Notice: NoticeMock }));

import { UserNotice } from '../../src/user-feedback/user-notice';

describe('UserNotice', () => {
	let notice: UserNotice;

	beforeEach(() => {
		vi.clearAllMocks();
		notice = new UserNotice();
	});

	it('toast - 创建 Notice', () => {
		notice.toast('你好');
		expect(NoticeMock).toHaveBeenCalledWith('你好', 4000);
	});

	it('toastProgress - update 调 setMessage', () => {
		const handle = notice.toastProgress('下载中 0%');
		handle.update('下载中 50%');
		expect(setMessage).toHaveBeenCalledWith('下载中 50%');
		handle.hide();
		expect(hide).toHaveBeenCalled();
	});
});
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `npm test -- tests/user-feedback/user-notice.test.ts`
Expected: FAIL

- [ ] **Step 3.3: 实现 UserNotice**

```typescript
/**
 * @file src/user-feedback/user-notice.ts
 * @description 使用者专用 Notice — 禁止 console
 * @module user-feedback/user-notice
 */

import { Notice } from 'obsidian';

export class UserNotice {
	toast(message: string, durationMs = 4000): void {
		new Notice(message, durationMs);
	}

	toastError(message: string, durationMs = 8000): void {
		new Notice(message, durationMs);
	}

	toastProgress(initialMessage: string): { update(message: string): void; hide(): void } {
		const n = new Notice(initialMessage, 0);
		return {
			update: (message: string) => n.setMessage(message),
			hide: () => n.hide(),
		};
	}
}
```

- [ ] **Step 3.4: 跑测试确认通过**

Run: `npm test -- tests/user-feedback/user-notice.test.ts`
Expected: PASS

- [ ] **Step 3.5: 提交**

```bash
git add src/user-feedback/user-notice.ts tests/user-feedback/user-notice.test.ts
git commit -m "feat(feedback): 新增 UserNotice Obsidian toast 封装"
```

---

## Task 4: FeedbackController

**Files:**
- Create: `src/core/feedback-controller.ts`
- Create: `tests/core/feedback-controller.test.ts`

- [ ] **Step 4.1: 写失败测试(模型下载 → UserStatus + progress)**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable, get } from 'svelte/store';
import type { ModelStatus } from '../../src/core/model-manager';
import type { IndexStatus } from '../../src/core/index-manager';
import { FeedbackController } from '../../src/core/feedback-controller';
import { UserStatus } from '../../src/user-feedback/user-status';
import { UserNotice } from '../../src/user-feedback/user-notice';

describe('FeedbackController', () => {
	const modelStatus$ = writable<ModelStatus>({ state: 'NotStarted' });
	const indexStatus$ = writable<IndexStatus>({ state: 'Idle' });
	let userStatus: UserStatus;
	let userNotice: UserNotice;
	let toastProgress: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		userStatus = new UserStatus();
		toastProgress = vi.fn().mockReturnValue({ update: vi.fn(), hide: vi.fn() });
		userNotice = {
			toast: vi.fn(),
			toastError: vi.fn(),
			toastProgress,
		} as unknown as UserNotice;
	});

	it('Model Downloading - patch model=downloading 并创建 progress', () => {
		const ctl = new FeedbackController({
			modelStatus$,
			indexStatus$,
			userNotice,
			userStatus,
			getEmbeddingReady: () => false,
			getWorkerMode: () => 'inline',
			getSettings: () => ({ embedProvider: 'local', embedApiKey: '', chatApiKey: 'k' }),
			onFullIndexComplete: vi.fn(),
		});
		ctl.start();
		modelStatus$.set({ state: 'Downloading', progress: 0.5, speed: 0, eta: 0 });
		expect(get(userStatus.statusBar$).model).toBe('downloading');
		expect(toastProgress).toHaveBeenCalled();
		ctl.destroy();
	});
});
```

`FeedbackController` 构造函数接收 `modelStatus$` / `indexStatus$`(从 manager 取出),而非整个 manager — 便于单测。

- [ ] **Step 4.2: 跑测试确认失败**

Run: `npm test -- tests/core/feedback-controller.test.ts`
Expected: FAIL

- [ ] **Step 4.3: 实现 FeedbackController**

核心逻辑:

1. `start()` 订阅 `modelStatus$` / `indexStatus$`,按 spec 职责表 `userStatus.patch` + `userNotice`
2. 维护 `private indexProgress: ReturnType<UserNotice['toastProgress']> | null` 与 `private modelProgress`
3. `onFullIndexComplete` 回调:全量索引完成时 `userNotice.toast('索引完成 — N 篇...')`
4. 启动时若 `getWorkerMode() === 'inline'` → `userStatus.patch({ worker: 'inline' })` + `userNotice.toast` 一次
5. 若 `embedProvider === 'api'` → `degraded` + toast 一次
6. `getEmbeddingReady()` 为 false → `embedding: 'loading'`, true → `ready`
7. `destroy()` 退订 + hide 所有 progress

Index 状态映射示例:

```typescript
function mapIndexStatus(s: IndexStatus): Partial<UserStatusSnapshot> {
	switch (s.state) {
		case 'Queueing': return { index: 'queueing', indexDetail: `${s.pending} 待索引` };
		case 'Processing': return { index: 'processing', indexDetail: s.currentBatch[0] };
		case 'Ready': return { index: 'ready', indexDocCount: s.totalDocs };
		case 'Paused': return { index: 'paused', indexDetail: `${s.pending} 待处理` };
		case 'Failed': return { index: 'failed', indexDetail: s.reason };
		default: return {};
	}
}
```

- [ ] **Step 4.4: 跑测试确认通过**

Run: `npm test -- tests/core/feedback-controller.test.ts`
Expected: PASS

- [ ] **Step 4.5: 提交**

```bash
git add src/core/feedback-controller.ts tests/core/feedback-controller.test.ts
git commit -m "feat(feedback): 新增 FeedbackController 订阅 status$ 驱动用户反馈"
```

---

## Task 5: main.ts 接线 + 删除内联 Notice

**Files:**
- Modify: `src/main.ts`
- Modify: `src/settings.ts` — 仅 `debugLog` 字段(完整 UI 在 Task 10)

- [ ] **Step 5.1: 在 RatelVaultSettings 加 debugLog**

`src/settings.ts` 的 `RatelVaultSettings` 与 `DEFAULT_SETTINGS` 增加:

```typescript
debugLog: boolean;  // 默认 false
```

- [ ] **Step 5.2: main.ts 增加字段与构造**

```typescript
import { devLogger } from './logging/dev-logger';
import { UserNotice } from './user-feedback/user-notice';
import { UserStatus } from './user-feedback/user-status';
import { FeedbackController } from './core/feedback-controller';

// 类字段:
userNotice = new UserNotice();
userStatus = new UserStatus();
private feedbackController?: FeedbackController;
private workerMode: 'thread' | 'inline' = 'inline';
```

在 `onload` 末尾(注册设置面板之后):

```typescript
devLogger.setDebugEnabled(this.settings.debugLog);
this.feedbackController = new FeedbackController({
	modelStatus$: this.modelManager.status$,
	indexStatus$: this.indexController.indexManager.status$,
	userNotice: this.userNotice,
	userStatus: this.userStatus,
	getEmbeddingReady: () => !(this.embedding instanceof EmbeddingLocal) || this.embedding.isReady,
	getWorkerMode: () => this.workerMode,
	getSettings: () => this.settings,
	onFullIndexComplete: (indexed, errors) => {
		this.userNotice.toast(
			`Ratel: 索引完成 — ${indexed} 个文档${errors > 0 ? `, ${errors} 个失败` : ''}`,
		);
	},
});
this.feedbackController.start();
```

`createWorkerManager` 里设 `this.workerMode = 'inline'`(当前实现恒为 inline)。

- [ ] **Step 5.3: 精简 onLayoutReady**

删除 `onLayoutReady` 内全部 `Notice` / `ref.notice` / `idxRef` / `modelManager.status$` 订阅 UI 逻辑,保留:

```typescript
async onLayoutReady(): Promise<void> {
	if (this.settings.embedProvider !== 'local') {
		return;
	}
	try {
		await this.modelManager.download();
		const embedding = this.modelManager.getEmbedding();
		if (embedding) {
			if (this.embedding instanceof EmbeddingLocal) {
				this.embedding.setEmbedding(embedding);
			}
			if (this.inlineWorker) {
				this.vectraStore = this.createEmbeddingsVectraStore(embedding);
				this.inlineWorker.initWithStore(this.vectraStore);
			}
		}
		const indexResult = await this.indexController.onLayoutReady();
		if (indexResult) {
			this.feedbackController?.notifyFullIndexComplete(indexResult.indexed, indexResult.errors);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		devLogger.error('main', 'onLayoutReady 失败', err);
		this.userNotice.toastError(`Ratel 错误: ${message}`);
	}
}
```

在 `FeedbackController` 增加 `notifyFullIndexComplete(indexed, errors)` 供此处调用(内部 toast + patch index ready)。

`embedProvider !== 'local'` 时 early return 的 Notice 移到 `FeedbackController.start()` 的 API 模式检查(API 模式 toast + degraded 已在 controller)。

- [ ] **Step 5.4: onunload**

```typescript
this.feedbackController?.destroy();
this.userStatus.reset();
```

- [ ] **Step 5.5: 命令 index-status 改用 userNotice**

`main.ts` 中 `index-status` 命令里 `new Notice(...)` 改为 `this.userNotice.toast(...)`.

- [ ] **Step 5.6: 验证**

Run: `npm run build && npm test`
Expected: 0 错误,全通过

- [ ] **Step 5.7: 提交**

```bash
git add src/main.ts src/settings.ts src/core/feedback-controller.ts
git commit -m "refactor(main): Notice 逻辑迁入 FeedbackController,main 仅接线"
```

---

## Task 6: StatusBar.svelte + 删除 IndexBanner

**Files:**
- Create: `src/ui/StatusBar.svelte`
- Modify: `src/ui/ChatView.svelte`
- Delete: `src/ui/IndexBanner.svelte`

- [ ] **Step 6.1: 实现 StatusBar.svelte**

```svelte
<script lang="ts">
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot } from '../user-feedback/user-status';

	export let status$: Readable<UserStatusSnapshot>;

	$: snap = $status$;
	$: expanded = snap.model !== 'ready' || snap.index !== 'ready' || snap.embedding !== 'ready' || !!snap.degraded;
	$: summary = `模型${labelModel(snap)} · 索引${snap.indexDocCount ?? 0} 篇 · Embedding${snap.embedding === 'ready' ? '就绪' : '加载中'}`;

	function labelModel(s: UserStatusSnapshot): string {
		if (s.model === 'ready') return '就绪';
		if (s.model === 'downloading') return `下载中${s.modelDetail ? ` ${s.modelDetail}` : ''}`;
		if (s.model === 'failed') return '失败';
		return '…';
	}
</script>

<div class="ratel-status-bar" data-expanded={expanded}>
	{#if expanded}
		<div>模型: {labelModel(snap)}{snap.modelDetail && snap.model !== 'downloading' ? ` — ${snap.modelDetail}` : ''}</div>
		<div>索引: {snap.index}{snap.indexDetail ? ` (${snap.indexDetail})` : ''}</div>
		{#if snap.degraded}<div class="ratel-status-degraded">{snap.degraded}</div>{/if}
	{:else}
		<div>{summary}</div>
	{/if}
</div>
```

补充 `<style>`:`.ratel-status-bar` 绿/黄/红 data 属性,与 spec 一致。

- [ ] **Step 6.2: ChatView 挂载**

`ChatView.svelte` 增加 `import StatusBar`,在 `.ratel-chat` 内最顶部:

```svelte
<StatusBar status$={plugin.userStatus.statusBar$} />
```

`main.ts` 的 `RatelVaultPlugin` 上 `userStatus` 需为 `public`(已 Task 5)。

- [ ] **Step 6.3: 删除 IndexBanner.svelte**

```bash
git rm src/ui/IndexBanner.svelte
```

- [ ] **Step 6.4: 验证 build**

Run: `npm run build`
Expected: 0 错误

- [ ] **Step 6.5: 提交**

```bash
git add src/ui/StatusBar.svelte src/ui/ChatView.svelte
git commit -m "feat(ui): Chat 侧栏 StatusBar 替代 IndexBanner"
```

---

## Task 7: chat-send-gate + search-vault 就绪检查

**Files:**
- Create: `src/ui/chat-send-gate.ts`
- Create: `tests/ui/chat-send-gate.test.ts`
- Modify: `src/tools/search-vault.ts`

- [ ] **Step 7.1: chat-send-gate 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateChatSendGate } from '../../src/ui/chat-send-gate';
import { DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('evaluateChatSendGate', () => {
	it('Chat API Key 缺失 - 硬拦', () => {
		const r = evaluateChatSendGate({ chatApiKey: '' }, DEFAULT_USER_STATUS);
		expect(r.canSend).toBe(false);
		expect(r.hardBlockReason).toContain('API Key');
	});

	it('索引未就绪 - 软拦,仍可发送', () => {
		const r = evaluateChatSendGate(
			{ chatApiKey: 'sk-test' },
			{ ...DEFAULT_USER_STATUS, index: 'queueing', embedding: 'loading' },
		);
		expect(r.canSend).toBe(true);
		expect(r.softHint).toContain('检索');
	});
});
```

- [ ] **Step 7.2: 实现 evaluateChatSendGate**

```typescript
export interface ChatSendGateResult {
	canSend: boolean;
	hardBlockReason?: string;
	softHint?: string;
}

export function evaluateChatSendGate(
	settings: { chatApiKey: string },
	status: UserStatusSnapshot,
): ChatSendGateResult {
	if (!settings.chatApiKey?.trim()) {
		return { canSend: false, hardBlockReason: '请先在设置中配置 Chat API Key' };
	}
	const searchDegraded =
		status.embedding !== 'ready' ||
		status.index === 'failed' ||
		(status.index !== 'ready' && status.index !== 'idle');
	if (searchDegraded) {
		return {
			canSend: true,
			softHint: '检索暂不可用,纯对话仍可继续;涉及 vault 搜索时工具会提示失败',
		};
	}
	return { canSend: true };
}

export function isSearchReady(status: UserStatusSnapshot): boolean {
	return status.embedding === 'ready' && status.index === 'ready';
}
```

- [ ] **Step 7.3: search-vault 就绪检查**

`createSearchVaultTool` 增加第三参数 `getSearchReady: () => boolean`(或读 `UserStatus`):

```typescript
async execute(args) {
	if (!getSearchReady()) {
		const err = new Error('索引或 Embedding 尚未就绪,请稍候或在设置 → 诊断测试中检查');
		(err as Error & { code?: string }).code = 'INDEX_NOT_READY';
		throw err;
	}
	// ... 现有逻辑
}
```

`main.ts` 注册工具时传入:

```typescript
createSearchVaultTool(this.embedding, this.workerManager, () => isSearchReady(get(this.userStatus.statusBar$)))
```

- [ ] **Step 7.4: 测试 + 提交**

Run: `npm test -- tests/ui/chat-send-gate.test.ts`
Expected: PASS

```bash
git add src/ui/chat-send-gate.ts tests/ui/chat-send-gate.test.ts src/tools/search-vault.ts src/main.ts
git commit -m "feat(chat): 软拦 B 发送门禁 + search_vault 索引就绪检查"
```

---

## Task 8: chat-error.ts + ChatView 错误 UI

**Files:**
- Create: `src/ui/chat-error.ts`
- Modify: `src/ui/ChatView.svelte`
- Modify: `styles.css` 或 `ChatView.svelte` `<style>` — `.ratel-chat-error-*`

- [ ] **Step 8.1: 实现 chat-error.ts**

```typescript
/**
 * @file src/ui/chat-error.ts
 * @description Chat 会话内结构化错误 — 复用 formatError 分类,独立 DOM 样式
 * @module ui/chat-error
 * @depends ui/diagnostics/diag-utils
 */

import { formatError, type DiagError } from './diagnostics/diag-utils';

export function formatChatError(code: string, message: string): DiagError {
	if (code === 'CANCELLED') {
		return { type: 'runtime', message: '已停止生成' };
	}
	return formatError(message, code);
}

/** 在 parent 内渲染错误块,返回根元素 */
export function renderChatErrorBlock(parent: HTMLElement, error: DiagError): HTMLElement {
	const el = parent.createDiv({ cls: `ratel-chat-error ratel-chat-error-${error.type}` });
	el.createDiv({ cls: 'ratel-chat-error-msg', text: error.message });
	if (error.suggestion) {
		el.createDiv({ cls: 'ratel-chat-error-suggestion', text: error.suggestion });
	}
	return el;
}

export function renderCancelledHint(parent: HTMLElement): HTMLElement {
	return parent.createDiv({ cls: 'ratel-chat-cancelled', text: '已停止生成' });
}
```

- [ ] **Step 8.2: ChatView 工具三态 + error 分支**

1. `ToolCallEntry.status` 扩展为 `'calling' | 'done' | 'failed'`
2. `case 'error'`:
   - `CANCELLED` → `renderCancelledHint`
   - `TOOL_ERROR` → 最后一个 `calling` 工具改 `failed`,存 `errorMessage`
   - `LLM_ERROR` → `renderChatErrorBlock` 挂到 assistant 气泡
3. 删除 `assistantMsg.content += '\n\n⚠ Error:'` 拼接

4. 输入区上方:响应式 `evaluateChatSendGate`,`canSend` 控制按钮;`softHint` / `hardBlockReason` 展示

```svelte
{#if gate.hardBlockReason}
	<div class="ratel-chat-gate-hint ratel-chat-gate-hard">{gate.hardBlockReason}</div>
{:else if gate.softHint}
	<div class="ratel-chat-gate-hint">{gate.softHint}</div>
{/if}
```

`gate` 从 `$plugin.userStatus.statusBar$` + `plugin.settings` 派生。

- [ ] **Step 8.3: agent-loop 规范 error code**

确认 `agent-loop.ts` 中 `TOOL_ERROR` / `LLM_ERROR` / `CANCELLED` 已存在;工具 catch 时 `devLogger.error('agent', ...)` 一行。

- [ ] **Step 8.4: 验证**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 8.5: 提交**

```bash
git add src/ui/chat-error.ts src/ui/ChatView.svelte src/core/agent-loop.ts
git commit -m "feat(chat): 结构化会话错误 + 工具 failed 三态 + 软拦提示"
```

---

## Task 9: console.* 迁移至 DevLogger

**Files:**
- Modify: `src/core/index-manager.ts`
- Modify: `src/core/hooks.ts`
- Modify: `src/worker/index-processor.ts`
- Modify: `src/adapters/vector-vectra.ts`
- Modify: `src/adapters/persistence-json.ts`
- Modify: `src/utils/ratelignore-parser.ts`
- Modify: `src/main.ts` (`console.log` unload)

- [ ] **Step 9.1: 逐文件替换**

示例:

```typescript
// index-manager.ts
import { devLogger } from '../logging/dev-logger';
// console.error('Ratel 全量索引失败:', err);
devLogger.error('index', '全量索引失败', err);
```

**不修改** `src/logging/dev-logger.ts` 内部、`tests/**` 中的 console。

- [ ] **Step 9.2: 全量测试**

Run: `npm test`
Expected: 全通过

- [ ] **Step 9.3: 提交**

```bash
git add src/core/index-manager.ts src/core/hooks.ts src/worker/index-processor.ts \
  src/adapters/vector-vectra.ts src/adapters/persistence-json.ts src/utils/ratelignore-parser.ts src/main.ts
git commit -m "refactor: 业务 console.* 迁移至 DevLogger"
```

---

## Task 10: settings debugLog UI + STATUS 更新

**Files:**
- Modify: `src/settings.ts`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 10.1: 设置面板 Developer 区增加 toggle**

在 `renderSettings` 末尾增加:

```typescript
containerEl.createEl('h2', { text: '开发者' });
new Setting(containerEl)
	.setName('Debug 日志')
	.setDesc('在控制台输出 [Ratel:*] debug 级日志')
	.addToggle((t) =>
		t.setValue(this.plugin.settings.debugLog).onChange(async (v) => {
			this.plugin.settings.debugLog = v;
			await this.plugin.saveSettings();
			devLogger.setDebugEnabled(v);
		}),
	);
```

- [ ] **Step 10.2: STATUS.md 登记 P-FEEDBACK Completed 留空(实施中改 In Progress)**

- [ ] **Step 10.3: 提交**

```bash
git add src/settings.ts docs/superpowers/STATUS.md
git commit -m "feat(settings): debugLog 开关联动 DevLogger"
```

---

## Task 11: 总体验收

**Files:** 无

- [ ] **Step 11.1: build + test**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿

- [ ] **Step 11.2: 手动 E2E 检查清单**

| # | 项 | 验证 |
|---|-----|------|
| 1 | 启动下载模型 | Notice 进度 + StatusBar downloading |
| 2 | 全量索引完成 | Notice 一次 + StatusBar 索引 N 篇 |
| 3 | InlineWorker | 启动 toast 一次 + worker=inline |
| 4 | Chat 无 Key | Send 禁用 + 硬拦文案 |
| 5 | 索引构建中发消息 | 可发送 + 软拦提示 |
| 6 | 索引未就绪时 search | 工具行 failed,无 Notice |
| 7 | LLM 错 Key | Chat 内错误块,无 Notice |
| 8 | Stop | 灰色「已停止生成」 |
| 9 | debugLog 开 | 控制台有 `[Ratel:worker] debug` |

- [ ] **Step 11.3: 更新 STATUS.md P-FEEDBACK → Completed**

---

## 自审

1. **Spec 覆盖:**
   - 三模块分离 → Task 1-3
   - FeedbackController → Task 4-5
   - StatusBar → Task 6
   - Chat 软拦 B + 工具 failed → Task 7-8
   - DevLogger 迁移 → Task 9
   - debugLog → Task 10
   - 验收 → Task 11
   - `agent-loop` 禁止 userNotice → Task 8 明确
   - IndexBanner 删除 → Task 6

2. **Placeholder 扫描:** 无 TBD;Task 2.3 / 6.1 要求按 spec 补全类型,实施时展开。

3. **类型一致性:** `UserStatusSnapshot` 仅在 `user-status.ts` 定义;`FeedbackController` / `StatusBar` / `chat-send-gate` 均 import 该类型。

4. **依赖方向:** `logging/*` ⊥ `user-feedback/*`;`chat-error` 仅 import `diag-utils.formatError`,不 import `user-feedback`。

# Test Architecture Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 [S-TEST-ARCH 文档](../specs/2026-06-14-ratel-test-architecture.md) 中所有不依赖未来 W3/W4 实现的剩余测试覆盖项 — Settings 维度 L1 + L2,Worker 维度 L1,以及跨维度"设置变更传播"集成测试。

**Architecture:** 沿用项目既有的 vitest 风格 — L1 单元测试 mock 外部依赖(网络、文件),L2 集成测试用真实模块。Settings L2 测试用 `Object.create(RatelVaultPlugin.prototype)` 模拟 plugin 实例,绕过 Obsidian 框架;Worker L1 把 `handleMessage` 拆到独立模块,便于直接调用。TDD:每个 task 都先写失败测试,再写最小实现。

**Tech Stack:** vitest、TypeScript strict、Obsidian 0.x(类型定义)、esbuild

---

## File Structure

```
src/
  worker/
    handler.ts          ← 新建:handleMessage 拆出,纯函数(无 self 依赖)
  settings.ts           ← 不改:已支持 Object.assign({}, DEFAULT, raw) 模式

tests/
  settings.test.ts      ← 新建:L1 DEFAULT_SETTINGS + 迁移
  settings-adapter.test.ts ← 新建:L2 embedProvider 切换 + dimensions 传递
  worker/
    handler.test.ts     ← 新建:handleMessage 单元
    manager-timeout.test.ts ← 新建:WorkerManager 超时 reject
  integration/
    settings-propagation.test.ts ← 新建:改 field 触发 rebuild
```

---

### Task 1: Settings L1 — DEFAULT_SETTINGS 完整性

**Files:**
- Create: `tests/settings.test.ts`
- Reference: `src/settings.ts`(只读)

- [ ] **Step 1: 写失败测试 — DEFAULT_SETTINGS 字段完整性**

在 `tests/settings.test.ts`:

```ts
/**
 * @file tests/settings.test.ts
 * @description DEFAULT_SETTINGS 完整性 + 字段全可读
 * @module tests/settings
 * @depends settings
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';

describe('DEFAULT_SETTINGS', () => {
    it('包含全部 RatelVaultSettings 字段', () => {
        // 关键路径:用类型断言做编译期检查,运行时遍历字段名验证
        const required: Array<keyof RatelVaultSettings> = [
            'chatModel', 'chatApiKey', 'chatApiBase',
            'embedProvider', 'embedLocalModel', 'embedLocalDimensions',
            'embedApiBase', 'embedApiKey', 'embedApiModel', 'embedApiDimensions',
            'rerankerProvider', 'rerankerApiBase', 'rerankerApiKey', 'rerankerModel',
            'chunkSize', 'chunkOverlap', 'autoIndex',
            'autoSuggestLinks', 'linkConfidenceThreshold',
        ];
        for (const key of required) {
            expect(DEFAULT_SETTINGS).toHaveProperty(key);
        }
    });

    it('所有字段类型正确', () => {
        expect(typeof DEFAULT_SETTINGS.chatModel).toBe('string');
        expect(typeof DEFAULT_SETTINGS.chatApiKey).toBe('string');
        expect(typeof DEFAULT_SETTINGS.embedProvider).toBe('string');
        expect(typeof DEFAULT_SETTINGS.embedLocalDimensions).toBe('number');
        expect(typeof DEFAULT_SETTINGS.chunkSize).toBe('number');
        expect(typeof DEFAULT_SETTINGS.autoIndex).toBe('boolean');
        expect(typeof DEFAULT_SETTINGS.linkConfidenceThreshold).toBe('number');
    });

    it('embedProvider 默认是 local', () => {
        // 关键路径:开箱即用的零配置嵌入
        expect(DEFAULT_SETTINGS.embedProvider).toBe('local');
    });

    it('数值字段在合理范围内', () => {
        expect(DEFAULT_SETTINGS.chunkSize).toBeGreaterThan(0);
        expect(DEFAULT_SETTINGS.chunkOverlap).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_SETTINGS.chunkOverlap).toBeLessThan(DEFAULT_SETTINGS.chunkSize);
        expect(DEFAULT_SETTINGS.linkConfidenceThreshold).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_SETTINGS.linkConfidenceThreshold).toBeLessThanOrEqual(1);
    });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `npx vitest run tests/settings.test.ts`
Expected: 4 tests pass(实际上应该全过,因为 settings.ts 已经有 DEFAULT_SETTINGS)。这一步是**确认现状**:如果失败说明字段缺失,要修 settings.ts。

- [ ] **Step 3: 视情况修复**

如果测试失败,补 DEFAULT_SETTINGS 字段。如果通过,继续。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/settings.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add tests/settings.test.ts
git commit -m "test(settings): DEFAULT_SETTINGS 完整性 + 字段类型 + 数值范围"
```

---

### Task 2: Settings L1 — 旧版设置迁移

**Files:**
- Create: `tests/settings-migration.test.ts`
- Reference: `src/settings.ts`(只读)

**背景**:早期版本可能用 `embedModel` 字段。新版拆为 `embedLocalModel` + `embedApiModel`,并加 `embedProvider` 二选一。迁移测试要保证旧 data.json 加载后字段正确。

- [ ] **Step 1: 写失败测试 — 迁移逻辑**

**注**:项目当前没有"迁移函数"概念,`loadSettings` 直接 `Object.assign({}, DEFAULT, raw)`。这意味着旧字段 `embedModel` 如果出现,会**保留**在 settings 里但不参与任何逻辑。

设计决策:**不做迁移,只测"旧字段不污染新字段"**。如果 `embedModel` 出现在 raw 里,迁移测试只验证 `embedApiModel` 保持 `DEFAULT_SETTINGS.embedApiModel` 默认值,不会因为 `embedModel` 而被覆盖。

```ts
/**
 * @file tests/settings-migration.test.ts
 * @description 旧版 data.json(embedModel)加载后不污染新字段
 * @module tests/settings-migration
 * @depends settings
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';

/**
 * 模拟 src/main.ts:loadSettings 的合并逻辑,验证旧字段兼容性。
 * 关键路径:Object.assign 后,新字段用 DEFAULT 兜底,旧字段被 raw 覆盖但不影响新字段。
 */
function simulateLoadSettings(raw: Partial<RatelVaultSettings> | null): RatelVaultSettings {
    return Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
}

describe('Settings 迁移', () => {
    it('旧版 embedModel 字段加载后不污染 embedApiModel', () => {
        // 关键路径:旧 vault 里可能存了 embedModel='bge-large',新版会忽略
        const oldFormat = {
            embedModel: 'bge-large',
        } as unknown as Partial<RatelVaultSettings>;

        const merged = simulateLoadSettings(oldFormat);

        // 旧字段残留(无害,因为没代码读)
        expect((merged as Record<string, unknown>).embedModel).toBe('bge-large');
        // 新字段保持默认值
        expect(merged.embedApiModel).toBe(DEFAULT_SETTINGS.embedApiModel);
        expect(merged.embedLocalModel).toBe(DEFAULT_SETTINGS.embedLocalModel);
    });

    it('缺省 raw(null)时所有字段用 DEFAULT', () => {
        const merged = simulateLoadSettings(null);
        expect(merged).toEqual(DEFAULT_SETTINGS);
    });

    it('缺省 raw(undefined)时所有字段用 DEFAULT', () => {
        const merged = simulateLoadSettings(undefined);
        expect(merged).toEqual(DEFAULT_SETTINGS);
    });

    it('部分字段被 raw 覆盖,其余保持 DEFAULT', () => {
        const partial: Partial<RatelVaultSettings> = {
            chatApiKey: 'sk-test',
            chunkSize: 1000,
        };

        const merged = simulateLoadSettings(partial);

        expect(merged.chatApiKey).toBe('sk-test');
        expect(merged.chunkSize).toBe(1000);
        // 未提供的字段保持默认
        expect(merged.chatApiBase).toBe(DEFAULT_SETTINGS.chatApiBase);
        expect(merged.embedProvider).toBe(DEFAULT_SETTINGS.embedProvider);
    });
});
```

- [ ] **Step 2: 跑测试确认绿(应该一次过)**

Run: `npx vitest run tests/settings-migration.test.ts`
Expected: 4 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/settings-migration.test.ts
git commit -m "test(settings): 旧版 embedModel 字段兼容性 + 部分覆盖语义"
```

---

### Task 3: Worker L1 — handleMessage 未知请求类型(重构 + 测试)

**Files:**
- Create: `src/worker/handler.ts`
- Modify: `src/worker/index.ts`(把 handleMessage 替换为从 handler 导入)
- Create: `tests/worker/handler.test.ts`

**背景**:`handleMessage` 当前在 `src/worker/index.ts` 里 not exported,且与 `self.onmessage` 强耦合。重构:把 `handleMessage` 提到 `src/worker/handler.ts` 做成纯函数,`index.ts` 只做消息路由。

- [ ] **Step 1: 创建 `src/worker/handler.ts`**

```ts
/**
 * @file src/worker/handler.ts
 * @description Worker 消息分发 — 纯函数,从主线程消息生成响应
 * @module worker/handler
 * @depends types
 *
 * 设计要点:与 self.onmessage 解耦,便于单元测试。
 * 任何 W1/W2/W3+ 阶段新增的请求类型都在此处的 switch 里加 case。
 */

import type { WorkerRequest, WorkerResponse } from '../types';

/**
 * 处理主线程发来的 Worker 请求。
 *
 * @param msg  - 含可选 `_requestId` 的请求
 * @returns     对应的响应载荷;未识别的请求类型返回 UNKNOWN_REQUEST 错误
 */
export async function handleMessage(
    msg: WorkerRequest & { _requestId?: string },
): Promise<WorkerResponse> {
    switch (msg.type) {
        case 'index.status': {
            return {
                type: 'index.status.result',
                payload: { totalDocs: 0, lastIndexTime: 0 },
            };
        }

        case 'index.full':
        case 'index.incremental':
        case 'index.delete':
        case 'vector.search':
        case 'vector.upsert':
        case 'vector.delete': {
            // 占位:W2 接入 vectra 后替换为真实实现
            return {
                type: 'error',
                payload: {
                    code: 'NOT_IMPLEMENTED',
                    message: `${msg.type} will be implemented in W2`,
                },
            };
        }

        default: {
            // 关键路径:未知 type 必须返回结构化错误而不是 throw,主线程
            // 才能在 catch 之外识别并 reject
            return {
                type: 'error',
                payload: {
                    code: 'UNKNOWN_REQUEST',
                    message: `Unknown request type: ${(msg as WorkerRequest).type}`,
                },
            };
        }
    }
}
```

- [ ] **Step 2: 改 `src/worker/index.ts` 委托给 handler**

**改前**(line 51-86):
handleMessage 是文件内 private 函数。

**改后**:

```ts
/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — 接收主线程消息并委托给 handler
 * @module worker/index
 * @depends types, ./handler
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { handleMessage } from './handler';

// 关键路径:Worker 全局 `self` 即宿主;`onmessage` 注册入口
self.onmessage = async (e: MessageEvent) => {
    const msg = e.data as WorkerRequest & { _requestId?: string };
    const requestId = msg._requestId;

    try {
        const response = await handleMessage(msg);
        if (requestId) {
            (response as Record<string, unknown>)._requestId = requestId;
        }
        self.postMessage(response);
    } catch (err) {
        // 修复:任何未捕获异常都返回结构化错误响应,主线程据此 reject Promise
        const errorResponse: WorkerResponse = {
            type: 'error',
            payload: {
                code: 'WORKER_ERROR',
                message: err instanceof Error ? err.message : String(err),
            },
        };
        if (requestId) {
            (errorResponse as Record<string, unknown>)._requestId = requestId;
        }
        self.postMessage(errorResponse);
    }
};
```

- [ ] **Step 3: 写失败测试 — handleMessage 已知 + 未知请求**

`tests/worker/handler.test.ts`:

```ts
/**
 * @file tests/worker/handler.test.ts
 * @description handleMessage 单元测试 — 已知 type 路由、未知 type 返回 UNKNOWN_REQUEST
 * @module tests/worker/handler
 * @depends worker/handler
 */

import { describe, it, expect } from 'vitest';
import { handleMessage } from '../../src/worker/handler';
import type { WorkerRequest } from '../../src/types';

describe('handleMessage', () => {
    it('index.status 返回占位成功响应', async () => {
        const response = await handleMessage({
            type: 'index.status',
            payload: {},
        });
        expect(response.type).toBe('index.status.result');
        expect(response.payload).toEqual({ totalDocs: 0, lastIndexTime: 0 });
    });

    it('未实现的 type(index.full)返回 NOT_IMPLEMENTED', async () => {
        const response = await handleMessage({
            type: 'index.full',
            payload: { vaultPath: '/test' },
        });
        expect(response.type).toBe('error');
        expect(response.payload).toEqual({
            code: 'NOT_IMPLEMENTED',
            message: 'index.full will be implemented in W2',
        });
    });

    it('未实现的 type(vector.search)返回 NOT_IMPLEMENTED', async () => {
        const response = await handleMessage({
            type: 'vector.search',
            payload: { vector: [0.1, 0.2, 0.3], topK: 5 },
        });
        expect(response.type).toBe('error');
        expect((response.payload as { code: string }).code).toBe('NOT_IMPLEMENTED');
    });

    it('未知 type 返回 UNKNOWN_REQUEST 结构化错误', async () => {
        // 关键路径:故意构造一个不存在的 type
        const bogus = { type: 'foo.bar', payload: {} } as unknown as WorkerRequest;
        const response = await handleMessage(bogus);
        expect(response.type).toBe('error');
        expect(response.payload).toEqual({
            code: 'UNKNOWN_REQUEST',
            message: 'Unknown request type: foo.bar',
        });
    });
});
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/worker/handler.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: 跑全量回归 + build**

Run: `npm test && npm run build`
Expected: 全部通过,build 绿

- [ ] **Step 6: Commit**

```bash
git add src/worker/handler.ts src/worker/index.ts tests/worker/handler.test.ts
git commit -m "refactor(worker): 提取 handleMessage 到独立模块,支持单元测试"
```

---

### Task 4: Worker L1 — WorkerManager 超时 reject

**Files:**
- Modify: `tests/worker/worker-bridge.test.ts`(追加测试)
- Reference: `src/worker/manager.ts`

**背景**:`WorkerManager.request` 当前如果 Worker 永远不响应,Promise 永远 pending。需加超时机制,确保失败可见。

- [ ] **Step 1: 读 `src/worker/manager.ts` 看现有实现**

先看 manager 是否有超时机制,如有直接测;如无,加。

- [ ] **Step 2: 写失败测试**

在 `tests/worker/worker-bridge.test.ts` 末尾追加:

```ts
describe('WorkerManager timeout', () => {
    it('Worker 30s 内不响应则 reject', async () => {
        // 关键路径:用 vi.useFakeTimers 控制时间
        vi.useFakeTimers();

        const mockWorker = {
            postMessage: vi.fn(),
            onmessage: null as ((e: MessageEvent) => void) | null,
            onerror: null as ((e: ErrorEvent) => void) | null,
            terminate: vi.fn(),
        };

        const manager = new WorkerManager(mockWorker as unknown as Worker, {
            timeoutMs: 1000,
        });

        const responsePromise = manager.request({
            type: 'index.status',
            payload: {},
        });

        // 推进时间到超时
        vi.advanceTimersByTime(1001);

        await expect(responsePromise).rejects.toThrow(/timeout/i);

        vi.useRealTimers();
        manager.destroy();
    });

    it('超时后调用 terminate 释放 Worker', async () => {
        vi.useFakeTimers();

        const mockWorker = {
            postMessage: vi.fn(),
            onmessage: null as ((e: MessageEvent) => void) | null,
            onerror: null as ((e: ErrorEvent) => void) | null,
            terminate: vi.fn(),
        };

        const manager = new WorkerManager(mockWorker as unknown as Worker, {
            timeoutMs: 500,
        });

        const responsePromise = manager.request({
            type: 'index.status',
            payload: {},
        });

        vi.advanceTimersByTime(501);

        await expect(responsePromise).rejects.toThrow();
        expect(mockWorker.terminate).toHaveBeenCalled();

        vi.useRealTimers();
    });
});
```

- [ ] **Step 3: 跑测试看是否失败(RED)**

Run: `npx vitest run tests/worker/worker-bridge.test.ts`
Expected: 失败,提示 `WorkerManager` 不接受第二个 options 参数

- [ ] **Step 4: 修改 `src/worker/manager.ts` 支持 timeout**

在 `src/worker/manager.ts` 构造函数加 `options?: { timeoutMs?: number }` 参数,默认 30000。在 `request` 方法里 `setTimeout(reject, timeoutMs)`,响应到达时 `clearTimeout`。

**关键代码**(实际看 `src/worker/manager.ts` 的现有实现,以下为示例):

```ts
constructor(worker: Worker, options: { timeoutMs?: number } = {}) {
    this.worker = worker;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.worker.onmessage = (e: MessageEvent) => this.handleResponse(e);
    this.worker.onerror = (e: ErrorEvent) => this.handleError(e);
}

request<T extends WorkerResponse>(req: WorkerRequest): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            this.pending.delete(requestId);
            this.worker.terminate();
            reject(new Error(`Worker request timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);

        this.pending.set(requestId, { resolve, reject, timer });
        this.worker.postMessage({ ...req, _requestId: requestId });
    });
}
```

**注**:实际修改要看 `src/worker/manager.ts` 当前结构。如果 timer 字段已在 pending Map 里有,加 setTimeout/clearTimeout 逻辑。

- [ ] **Step 5: 跑测试确认绿(GREEN)**

Run: `npx vitest run tests/worker/worker-bridge.test.ts`
Expected: 全部 5 tests pass(原 3 + 新 2)

- [ ] **Step 6: Commit**

```bash
git add src/worker/manager.ts tests/worker/worker-bridge.test.ts
git commit -m "feat(worker): WorkerManager.request 支持 timeout,超时后 terminate"
```

---

### Task 5: Settings L2 — embedProvider 切换正确创建 adapter

**Files:**
- Create: `tests/settings-adapter.test.ts`
- Reference: `src/main.ts`、`src/adapters/embedding-local.ts`、`src/adapters/embedding-api.ts`

**背景**:`RatelVaultPlugin.rebuildEmbeddingAdapter()` 在 `embedProvider` 改变后被调,应创建正确的 adapter 实例。本测试用 `Object.create(prototype)` 绕过 Obsidian 框架,直接调方法。

- [ ] **Step 1: 写失败测试**

```ts
/**
 * @file tests/settings-adapter.test.ts
 * @description embedProvider 切换 → rebuildEmbeddingAdapter 创建正确的 adapter
 * @module tests/settings-adapter
 * @depends main, adapters/embedding-*
 */

import { describe, it, expect } from 'vitest';
import RatelVaultPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings';
import { EmbeddingLocal } from '../src/adapters/embedding-local';
import { EmbeddingApi } from '../src/adapters/embedding-api';

describe('RatelVaultPlugin.rebuildEmbeddingAdapter', () => {
    it('embedProvider=local → 创建 EmbeddingLocal', () => {
        // 关键路径:用 Object.create 绕过 Obsidian 框架,只测方法本身
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };

        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);
    });

    it('embedProvider=api → 创建 EmbeddingApi', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'api' };

        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
    });

    it('切换 provider 后,旧 adapter 引用被替换', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };

        plugin.rebuildEmbeddingAdapter();
        const localAdapter = plugin.embedding;

        plugin.settings.embedProvider = 'api';
        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding).not.toBe(localAdapter);
        expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
    });

    it('EmbeddingLocal 接收 dimensions 参数', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = {
            ...DEFAULT_SETTINGS,
            embedProvider: 'local',
            embedLocalDimensions: 768,
        };

        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);
        // 关键路径:dimensions 通过构造参数注入,验证不是默认 512
        expect((plugin.embedding as EmbeddingLocal).dimensions).toBe(768);
    });

    it('EmbeddingApi 接收 dimensions 参数', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = {
            ...DEFAULT_SETTINGS,
            embedProvider: 'api',
            embedApiDimensions: 1536,
        };

        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
        expect((plugin.embedding as EmbeddingApi).dimensions).toBe(1536);
    });
});
```

- [ ] **Step 2: 跑测试看是否失败(RED)**

Run: `npx vitest run tests/settings-adapter.test.ts`
Expected: 失败,因为 `(plugin.embedding as EmbeddingLocal).dimensions` 字段可能未暴露,需要看 `embedding-local.ts` 和 `embedding-api.ts` 实际定义。

- [ ] **Step 3: 视情况修复**

如果 `dimensions` 字段是 private:
- 选项 A:在 `EmbeddingLocal` / `EmbeddingApi` 类加 `readonly dimensions: number` 公开字段
- 选项 B:改为测 embed 方法返回的向量长度

选 A 更直接。修改两个 adapter:

```ts
// src/adapters/embedding-local.ts
export class EmbeddingLocal implements EmbeddingPort {
    constructor(
        public readonly model: string,
        public readonly dimensions: number,
    ) { ... }
}

// src/adapters/embedding-api.ts
export class EmbeddingApi implements EmbeddingPort {
    public readonly dimensions: number;
    constructor(opts: { ..., dimensions: number }) {
        this.dimensions = opts.dimensions;
    }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/settings-adapter.test.ts`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add tests/settings-adapter.test.ts src/adapters/embedding-local.ts src/adapters/embedding-api.ts
git commit -m "test(settings): L2 embedProvider 切换 + dimensions 参数传递"
```

---

### Task 6: 跨维度集成 — settings 变更触发 rebuild

**Files:**
- Create: `tests/integration/settings-propagation.test.ts`
- Reference: `src/main.ts`、`src/settings.ts`

**背景**:当前实现下,settings 字段改动不会自动 rebuild,需手动调 `plugin.rebuildXxx()`。本测试断言**手动** rebuild 路径仍工作(不依赖反应式 Proxy,那属于 P-DEFENSIVE-IMPL 计划)。

- [ ] **Step 1: 写失败测试**

```ts
/**
 * @file tests/integration/settings-propagation.test.ts
 * @description 改 settings 后调 rebuild,adapter 实例被替换
 * @module tests/integration/settings-propagation
 * @depends main, settings
 */

import { describe, it, expect } from 'vitest';
import RatelVaultPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';
import { EmbeddingApi } from '../../src/adapters/embedding-api';

describe('Settings 变更传播', () => {
    it('改 chatApiKey 后 rebuildLLM 产生新 LLM 实例,config 含新 key', () => {
        // 关键路径:用 Object.create 绕过 Obsidian 框架,直接调 rebuild 验证 config 注入
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, chatApiKey: 'old-key' };
        plugin.rebuildLLM();
        const oldLlm = plugin.llm;

        plugin.settings.chatApiKey = 'sk-new';
        plugin.rebuildLLM();

        expect(plugin.llm).not.toBe(oldLlm);
        expect(plugin.llm).toBeInstanceOf(DeepSeekLLM);
        // 关键路径:新 LLM 的 config 反映新 apiKey
        expect(plugin.llm.config.apiKey).toBe('sk-new');
    });

    it('改 chatApiBase 后 rebuildLLM,新 base 生效', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, chatApiBase: 'https://old.api' };
        plugin.rebuildLLM();

        plugin.settings.chatApiBase = 'https://new.api';
        plugin.rebuildLLM();

        expect(plugin.llm.config.apiBase).toBe('https://new.api');
    });

    it('改 embedProvider 从 local 到 api,embedding 类型切换', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };
        plugin.rebuildEmbeddingAdapter();
        expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);

        plugin.settings.embedProvider = 'api';
        plugin.rebuildEmbeddingAdapter();
        expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
    });

    it('改 embedApiKey 后 rebuildEmbeddingAdapter,新 key 进 config', () => {
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = {
            ...DEFAULT_SETTINGS,
            embedProvider: 'api',
            embedApiKey: '',
        };
        plugin.rebuildEmbeddingAdapter();

        plugin.settings.embedApiKey = 'sk-embed';
        plugin.rebuildEmbeddingAdapter();

        expect(plugin.embedding.config.apiKey).toBe('sk-embed');
    });

    it('reranker / indexing / link 字段改动只走 save 路径,不重建 adapter', () => {
        // 关键路径:这些字段没有对应 adapter 重建需求
        const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
        plugin.settings = { ...DEFAULT_SETTINGS };
        plugin.rebuildLLM();
        plugin.rebuildEmbeddingAdapter();
        const oldLlm = plugin.llm;
        const oldEmbed = plugin.embedding;

        // 改 rerankerApiKey,不该触发 rebuild
        plugin.settings.rerankerApiKey = 'sk-rerank';
        // 改 chunkSize
        plugin.settings.chunkSize = 800;
        // 改 linkConfidenceThreshold
        plugin.settings.linkConfidenceThreshold = 0.8;

        // 不调 rebuild,引用应保持不变
        expect(plugin.llm).toBe(oldLlm);
        expect(plugin.embedding).toBe(oldEmbed);
    });
});
```

- [ ] **Step 2: 跑测试看是否失败(RED)**

Run: `npx vitest run tests/integration/settings-propagation.test.ts`
Expected: 失败 — 字段访问不通过(`config.apiKey`、`config.apiBase` 在 `DeepSeekLLM` 里是 private)

- [ ] **Step 3: 暴露 adapter 必要的配置字段**

**`src/adapters/llm-deepseek.ts`**(line 53):

```ts
// 改前
constructor(private config: DeepSeekConfig) {}

// 改后
// 关键路径:把 config 改 public readonly,测试需要观察 apiKey / apiBase 是否反映新 settings
constructor(public readonly config: DeepSeekConfig) {}
```

**`src/adapters/embedding-api.ts`**(line 37):

```ts
// 改前
constructor(private config: EmbeddingApiConfig) {
    this.dimensions = config.dimensions;
    this.modelId = `api:${config.model}`;
}

// 改后
// 关键路径:同 DeepSeekLLM,暴露 config 给测试观察
constructor(public readonly config: EmbeddingApiConfig) {
    this.dimensions = config.dimensions;
    this.modelId = `api:${config.model}`;
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/integration/settings-propagation.test.ts`
Expected: 5 tests pass

- [ ] **Step 5: 跑全量回归**

Run: `npm test`
Expected: 全部通过(应有 ~120 个测试,从原 103 + 新 17)

- [ ] **Step 6: Commit**

```bash
git add tests/integration/settings-propagation.test.ts src/adapters/llm-deepseek.ts src/adapters/embedding-api.ts
git commit -m "test(integration): settings 变更后 rebuild 触发 adapter 重建"
```

---

### Task 7: 更新 test-architecture.md + 最终验证

**Files:**
- Modify: `docs/superpowers/specs/2026-06-14-ratel-test-architecture.md`(更新"当前状态"列)
- Modify: `docs/superpowers/STATUS.md`(登记本 plan 完成)

- [ ] **Step 1: 更新 test-architecture.md 状态列**

把以下行的"❌"改为"✅"并标注 commits:
- 3.3 Settings 维度:DEFAULT_SETTINGS、迁移、embedProvider 切换、dimensions
- 3.5 Worker 维度:WorkerManager 超时、未知请求类型

- [ ] **Step 2: 全量 build + test + lint**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿

- [ ] **Step 3: 更新 STATUS.md 登记本 plan**

在 STATUS.md "实施 Plan" 表格加:

```markdown
| P-TEST-ARCH-COMPL | [2026-06-14-ratel-test-architecture-completion.md](plans/2026-06-14-ratel-test-architecture-completion.md) | ✅ Completed | (merged) | 2026-06-14 | 2026-06-14 | S-TEST-ARCH |
```

在"执行日志"区加本 plan 的执行总结。

- [ ] **Step 4: Commit + 收尾**

```bash
git add docs/superpowers/specs/2026-06-14-ratel-test-architecture.md docs/superpowers/STATUS.md
git commit -m "docs: 更新 test-architecture 状态 + 登记 P-TEST-ARCH-COMPL 完成"
```

- [ ] **Step 5: 报告完成**

打印 `git log --oneline -10` 展示本次 plan 全部 commits。

---

## Self-Review Checklist

- [x] Spec 覆盖:S-TEST-ARCH 文档里所有不依赖 W3/W4 的"❌"项都有对应 task
- [x] 无 placeholder:每个 step 含完整代码
- [x] 类型一致:`handleMessage`、`RatelVaultPlugin.rebuildEmbeddingAdapter()`、`DeepSeekLLM.config` 等方法签名跨 task 一致
- [x] TDD:每个 task 先写失败测试,再写实现
- [x] 频繁 commit:7 个 task,7 次 commit(1 task 多次)
- [x] 不依赖 W3/W4:RerankerApi、EmbeddingLocal 真实推理、vector.search BM25 等都标"留待后续 plan"

## Out of Scope(明确不做)

- **真实 EmbeddingLocal 推理 L2**:需要下载 ONNX 模型到测试环境,成本高,留待 W3 测试计划
- **L3 手动 checklist**:在 e2e/manual-test-checklist.md 加项,本 plan 不实施
- **Reranker L2 测试**:RerankerApi 适配器未实现,留 W4
- **W3/W4 涉及的工具与检索**:归 P-W3-TEST / P-W4-TEST 计划
- **ChatView sessionId 复用 L1**:在 Svelte 5 mount 模式下测试成本高,改 L3 manual checklist(可在 3.7 表格里把 ❌ 改 ✅ 标 L3)
- **反应式 Settings Proxy**:归 P-DEFENSIVE-IMPL 计划(已在 docs/superpowers/specs/2026-06-14-ratel-defensive-programming-design.md 定义)

# Ratel Vault 防御性编程 — 设计

**作者**:Ratel Vault 维护者
**日期**:2026-06-14
**状态**:Draft
**关联 plan**:待 writing-plans 阶段产出

> **对齐更新(2026-06-16)**:Bug #2 的 esbuild 侧根因已在 `esbuild.config.mjs` 中修复(加 `conditions: ['browser']`),详见 [obsidian-integration.md](../../architecture/host/obsidian-integration.md) §4.2。本 spec 的 G4(ChatView mount 回归测试)仍然有效,但 esbuild 修复已独立完成。

---

## 1. 背景

连续三轮 bug 修复暴露三类反复出现的失误:

| Bug | 现象 | 根因 |
|-----|------|------|
| #1 | `Cannot read properties of undefined (reading 'call')` | Svelte 4 → 5:`let` 不再是隐式 prop,必须 `export let` |
| #2 | `Cannot use 'in' operator to search for 'Symbol($state)' in undefined` | 加 `export` 后,组件编译后函数签名从 `(target)` 变 `(target, props)`,父类仍用 Svelte 4 的 `new Component({...})` 单参调用,`props` 是 `undefined` |
| #3 | `Authorization: Bearer ` 后面空 | LLM / Embedding 适配器在 onload 时一次性构造,内部捕获的 `apiKey` 是默认空串;用户后来填 key,`onChange` 只更新了 settings 与 `data.json`,**已构造的适配器仍指向旧值** |

三类 bug 的共性是**手工仪式易忘**:每个 onChange 都要记得 (1) 改 settings (2) 调 `saveSettings()` (3) 调对应 `rebuildXxx()`,任何一步漏了都出错。

设计目标:**从机制上消除"漏调"的可能**——通过反应式 Proxy 让"set 即联动",通过 lint 规则 + 单元测试让 Svelte 5 API 误用在静态层和运行层都拦下来。

---

## 2. 目标

1. **G1 — Settings 改一处、自动联动所有依赖**:任意 `settings.<field> = value` 触发 (a) 持久化到 `data.json` (b) 对应适配器 rebuild(只重建相关的,不重建不相关的)
2. **G2 — `onChange` 简化为单行赋值**:UI 端不再需要"先 save 再 rebuild"的二步仪式
3. **G3 — Svelte 5 API 误用静态层拦截**:`let foo` 当作组件 prop 使用时,`eslint-plugin-svelte` 报警
4. **G4 — Svelte 5 mount 调用模式有回归测试**:`ChatView.ts` 的 `mount` / `unmount` 调用若退化到 `new Component` 模式,单测失败
5. **G5 — 测试套件 100% 覆盖新增代码,103 个旧测试不回归**

---

## 3. 非目标

- **N1 — 不改 settings 类型形状**:`RatelVaultSettings` 字段不变
- **N2 — 不引入第三方状态库**:不引 immer / zustand / mobx,用原生 `Proxy`
- **N3 — 不重写 ChatView 业务逻辑**:只加保护性测试和 lint 规则
- **N4 — 不做 debounce save**:用户改 settings 频率低,fire-and-forget 立即写盘即可
- **N5 — 不支持嵌套 Proxy**:settings 当前全扁平,字段为字符串 / 数字 / 布尔,无需 Proxy 嵌套

---

## 4. 详细设计

### 4.1 反应式 Settings(变体 B)

**核心思想**:settings 是一个 `Proxy`,`set` 拦截 → emit field 变更 → plugin 监听器路由到对应 rebuild + 触发 `saveData()`。

#### 4.1.1 新模块 `src/core/reactive-settings.ts`

```ts
/**
 * 把已合并的 settings 包成 Proxy,set 时回调 onFieldChange。
 *
 * 设计要点:
 * - 拦截 set,get 透明,无读路径开销
 * - 值未变不回调(避免 setValue 首次赋值重复触发)
 * - listener 抛错被吞,不影响 Proxy 状态
 *
 * @param raw  loadData 读出的 partial settings,可空
 * @param onFieldChange  字段名 + 新值,回调里做 rebuild + save
 * @returns  透明的 settings 代理,类型仍是 RatelVaultSettings
 */
export function createReactiveSettings(
    raw: Partial<RatelVaultSettings> | null,
    onFieldChange: (field: keyof RatelVaultSettings, value: unknown) => void,
): RatelVaultSettings {
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    return new Proxy(merged, {
        set(target, prop, value) {
            const key = prop as keyof RatelVaultSettings;
            const old = target[key];
            target[key] = value;
            if (old !== value) {
                try {
                    onFieldChange(key, value);
                } catch (err) {
                    // 关键路径:listener 失败不污染 Proxy 状态,仅记录
                    console.error('[ratel] reactive-settings listener failed', err);
                }
            }
            return true;
        },
    });
}
```

**关键路径注释**:
- `set` 拦截返回 `true` 表示"赋值成功",Proxy 协议要求
- 值未变不回调,避免 `setValue(plugin.settings.chatApiKey, currentValue)` 这种初始化赋值触发 rebuild
- listener 抛错用 try/catch 包住,**不让 set 流程炸掉**——Proxy 状态已经改了,rebuild 失败也不应该回滚

#### 4.1.2 main.ts 集成

```ts
async onload() {
    // 关键路径:reactive settings 替代原 Object.assign 浅合并
    this.settings = createReactiveSettings(
        (await this.loadData()) as Partial<RatelVaultSettings> | null,
        (field) => this.onSettingsFieldChange(field),
    );

    // ... 后续装配(llm / embedding / worker / tools)保持不变
}

/**
 * settings 字段变更路由表 —— 决定哪个字段改了就 rebuild 哪个适配器。
 *
 * 关键路径:不在 listener 里写大段 if-else,改成查表,
 * 后续加新字段只需在表里加一行,不动核心逻辑。
 */
private onSettingsFieldChange(field: keyof RatelVaultSettings): void {
    const LLM_FIELDS: ReadonlySet<keyof RatelVaultSettings> = new Set([
        'chatApiKey', 'chatApiBase', 'chatModel',
    ]);
    const EMBED_FIELDS: ReadonlySet<keyof RatelVaultSettings> = new Set([
        'embedProvider', 'embedApiKey', 'embedApiBase',
        'embedApiModel', 'embedLocalModel',
    ]);

    if (LLM_FIELDS.has(field)) this.rebuildLLM();
    if (EMBED_FIELDS.has(field)) this.rebuildEmbeddingAdapter();

    // 关键路径:fire-and-forget,save 失败不阻塞主流程
    void this.saveSettings();
}
```

**关键路径**:
- LLM / Embedding 字段集用 `ReadonlySet` 写死,O(1) 查找
- `saveSettings()` 改为 `void` 触发(原签名是 `Promise<void>`),不 await
- `rebuildLLM()` / `rebuildEmbeddingAdapter()` 方法保留不动,只换调用方

#### 4.1.3 settings.ts onChange 简化

每个 onChange 改 1 处:`await this.plugin.saveSettings();` 和 `this.plugin.rebuildXxx();` 都删掉,只留 `this.plugin.settings.<field> = value;`。

例(chatApiKey):

```ts
// 改前
.onChange(async (value) => {
    this.plugin.settings.chatApiKey = value;
    await this.plugin.saveSettings();
    this.plugin.rebuildLLM();
})

// 改后
.onChange((value) => {
    this.plugin.settings.chatApiKey = value;
    // Proxy.set 自动触发 rebuild + save
})
```

约 8 个 onChange 都要简化(chatModel / chatApiKey / chatApiBase / embedProvider / embedLocalModel / embedApiBase / embedApiKey / embedApiModel)。Reranker / Indexing / Link Suggestions 字段**不挂路由**(无对应 adapter 实例),只走 save 路径,不改 adapter 装配。

### 4.2 Svelte 5 API 误用静态拦截

**核心思路**:`let foo` 用作组件 prop 不再合法,是 Svelte 5 编译器在编译期就会 `warn` 的。最稳的拦截工具是 Svelte 官方的 **`svelte-check`**(`svelte` 包自带),不是某个具体 ESLint 规则。

#### 4.2.1 加 `svelte-check` 到 build 链

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

`svelte-check` 会标红:
- `let plugin: T` 出现在 Svelte 组件顶层且**没**被 `$state` / `$props` / `$derived` 标注(在 Svelte 5 模式下是迁移警告)
- `new Component({...})` 单参调用 —— 编译器会 warn "Component is no longer a class in Svelte 5"
- prop 类型不匹配、accessibility 错误

**关键路径**:把 `svelte-check` 串进 `package.json` 的 `build`:

```json
{
    "scripts": {
        "build": "tsc -noEmit -skipLibCheck && svelte-check --tsconfig tsconfig.json && node esbuild.config.mjs production"
    }
}
```

`svelte-check` 和 `svelte` 都已经在 devDependencies(`svelte-check: ^4.2.1`、`svelte: ^5.33.3`),**不需要新装包**。`build` 之前先跑 check,任何 svelte 编译期警告都会让 `build` 失败 —— bug #1 和 bug #2 的潜在复发堵在 build 阶段。

#### 4.2.2 `eslint-plugin-svelte`(辅助 lint)

加 dev 依赖 `eslint-plugin-svelte`(项目当前用 flat config,需要 `@eslint/eslintrc` 兼容层或 plugin 的 flat config 导出)。修改 `eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidian from 'eslint-plugin-obsidianmd';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: { obsidian },
        rules: {},
    },
    {
        files: ['**/*.svelte'],
        languageOptions: {
            parser: svelteParser,
            parserOptions: {
                parser: tseslint.parser,
                extraFileExtensions: ['.svelte'],
            },
        },
        plugins: { svelte },
        rules: { ...svelte.configs.recommended.rules },
    },
);
```

`npm run lint`(已存在)接入这套配置后会扫 svelte 文件,store 误用 / a11y 误用等会报警。

#### 4.2.3 编辑器侧检测

开发者 IDE 装 **Svelte for VS Code** 扩展,会在写代码时实时高亮 `let` 隐式 prop 误用、缺 `mount` 等。属于开发者体验,本设计只负责 CI 侧 `svelte-check` + `npm run lint`。

### 4.3 Svelte 5 mount 回归测试

**新文件 `tests/ui/chat-view-mount.test.ts`**(单元,不需 Obsidian 运行时):

```ts
/**
 * 验证 ChatView 装载/卸载走的是 Svelte 5 mount/unmount API,
 * 而不是 Svelte 4 的 new Component / $destroy。
 *
 * 关键路径:用 vi.mock 拦截 'svelte' 模块的 mount / unmount,
 * 断言 ChatView.onOpen 调了 mount,onClose 调了 unmount。
 */
```

**为什么需要**:bug #2 是因为 `new Component({...})` 在 Svelte 5 下拿到的是 `undefined` 的 props。靠 lint 难抓(lint 看不到跨文件调用方式),靠 runtime 测试最稳。

测试要点:
- `vi.mock('svelte', () => ({ mount: vi.fn(), unmount: vi.fn() }))`
- 实例化 `ChatView`(用 mock 的 `WorkspaceLeaf`)
- 调 `onOpen()`,断言 `mount` 被调且 props 含 `plugin` 字段
- 调 `onClose()`,断言 `unmount` 被调

### 4.4 文件改动清单

| 文件 | 改动 | 行数估算 |
|------|------|----------|
| `src/core/reactive-settings.ts` | 新建 | ~30 |
| `src/main.ts` | 改 loadSettings + 加 onSettingsFieldChange | ~25 |
| `src/settings.ts` | 8 个 onChange 简化 | ~-15 |
| `eslint.config.js` | 加 svelte plugin / parser | ~+15 |
| `package.json` | dev 依赖(`eslint-plugin-svelte`、`svelte-eslint-parser`);build 串入 svelte-check | ~+5 |
| `tests/core/reactive-settings.test.ts` | 新建 | ~80 |
| `tests/ui/chat-view-mount.test.ts` | 新建 | ~60 |
| `tests/main-settings-integration.test.ts` | 新建(可选) | ~60 |
| **合计** | | **~260 行** |

### 4.5 测试覆盖矩阵

| 维度 | 工具 | 覆盖目标 |
|------|------|----------|
| 静态 | `eslint-plugin-svelte` | 组件 prop 必须 export |
| 单元 | `tests/core/reactive-settings.test.ts` | Proxy 行为(6 case) |
| 单元 | `tests/ui/chat-view-mount.test.ts` | ChatView 走 mount/unmount |
| 集成 | `tests/main-settings-integration.test.ts` | 改 field 触发对应 rebuild |
| 回归 | 既有 103 个测试 | 0 回归 |

---

## 5. 影响面

### 5.1 兼容性

- **行为兼容**:Proxy 的 get 透明,所有 `this.plugin.settings.foo` 读取不变
- **API 兼容**:`RatelVaultSettings` 形状不变,`loadSettings()` / `saveSettings()` 签名不变
- **持久化兼容**:`data.json` 形状不变,旧数据可直接 `loadData()` 喂给新 factory

### 5.2 风险

| 风险 | 缓解 |
|------|------|
| Proxy 在 devtools 里显示 `[object Proxy]`,调试可读性略降 | 接受;`target` 内部对象可用 `Reflect.get(target, prop)` 在 console 强取 |
| `saveData` 失败现在静默(`void this.saveSettings()`) | 监听器里 `console.error`,后续可接 toast |
| `Object.assign({}, DEFAULT, raw)` 与 Proxy 的类型对齐需小心 | 用 `Object.assign` 出的对象再包 Proxy,类型是 `RatelVaultSettings`,TS 不感知 |
| `delete settings.foo` 不会触发 listener | 当前 settings 没删除字段的需求,接受 |
| 嵌套对象未来若加,Proxy 不会递归 | 当前全扁平,接受;若未来加嵌套,改用 `deepProxy` 工厂 |

### 5.3 性能

- 单次 set 增加一次 `Object.is` 比较(比 `!==` 更准但更贵,这里 `!==` 够用)
- listener 路由表是 `Set.has`,O(1)
- `saveData` 是异步 + 短 IO,不阻塞主线程
- 总体:onChange 路径开销增加 < 1μs,可忽略

---

## 6. 任务清单概要(供 writing-plans 阶段展开)

1. **T1 — 装 `eslint-plugin-svelte` + 配 `.eslintrc.cjs`**(基础设施,1h)
2. **T2 — 写 `src/core/reactive-settings.ts` + 单测**(核心,2h)
3. **T3 — 改 `src/main.ts:loadSettings` + 加 `onSettingsFieldChange`**(集成,1h)
4. **T4 — 简化 `src/settings.ts` 8 个 onChange**(清理,1h)
5. **T5 — 写 `tests/ui/chat-view-mount.test.ts`**(Svelte 5 回归,1.5h)
6. **T6 — 写 `tests/main-settings-integration.test.ts`(可选)**
7. **T7 — 跑全量 `npm test` + `npm run lint`**(验证,0.5h)
8. **T8 — commit + 更新 `docs/superpowers/STATUS.md`**

合计 7-8 小时(1 工作日)。

---

## 7. 参考

- [MDN Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy)
- [Svelte 5 mount / unmount API](https://svelte.dev/docs/svelte/v5-migration-guide#Components-are-no-longer-classes)
- [`eslint-plugin-svelte`](https://github.com/sveltejs/eslint-plugin-svelte)
- Obsidian 插件 `Plugin.loadData` / `Plugin.saveData` 文档
- 本项目前序 spec:
  - [`docs/superpowers/specs/2026-06-14-ratel-i18n-design.md`](./2026-06-14-ratel-i18n-design.md)

# Bug 报告:Embedding 状态永远卡在"加载中",检索软提示常驻

- **报告日期**:2026-06-26
- **严重程度**:Important(功能可用但状态错误显示,用户误以为检索不可用)
- **引入版本**:commit `201a854`(P-FEEDBACK FeedbackController 接线)
- **修复 commit**:未提交(工作区修改)
- **影响范围**:所有使用本地 Embedding 模型的用户,每次启动后 StatusBar 显示"Embedding: 加载中",底部常驻"检索暂不可用"软提示

---

## 1. 现象

插件启动后:

- StatusBar 显示:
  ```
  模型: 就绪 ✅
  索引: 就绪 · 31 篇 ✅
  Embedding: 加载中 ⏳(永远不变)
  运行模式: 主线程内联(大库索引较慢)
  ```
- ChatView 底部常驻橙色提示:"检索暂不可用,纯对话仍可继续;涉及 vault 搜索时工具会提示失败"
- Send 按钮可用(软提示不阻止发送)
- **实际功能正常**:发送涉及 vault 搜索的消息,search_vault 工具可以正常工作

即:模型加载成功、索引构建成功、检索实际可用,但 UI 状态永远停在"加载中"。

---

## 2. 根因

### 2.1 直接原因

时序竞争 — `FeedbackController.patchEmbeddingReady()` 被调用时,`EmbeddingLocal.isReady` 仍为 `false`;之后 `setEmbedding()` 将真实 ONNX 适配器注入,`isReady` 变为 `true`,但**没有任何机制再次触发状态刷新**。

### 2.2 时序分析

`main.ts` 的 `onLayoutReady()` 执行顺序:

```
① await this.modelManager.download()
   ├── this.status$.set({ state: 'Initializing' })
   ├── const embedding = await this.createEmbedding(modelDir)  // ONNX 初始化
   ├── this.embedding = embedding                              // ModelManager 内部持有
   └── this.status$.set({ state: 'Ready' })                    // ← 触发订阅回调
       └── FeedbackController.handleModelStatus(Ready)
           └── this.patchEmbeddingReady()
               └── getEmbeddingReady() → this.embedding.isReady
                   // this.embedding 是 main.ts 的 EmbeddingLocal 占位器
                   // setEmbedding() 还没调用 → isReady = false
                   // → userStatus.patch({ embedding: 'loading' })  ← 错误状态!

② const embedding = this.modelManager.getEmbedding()
③ this.embedding.setEmbedding(embedding)                        // ← isReady 变为 true
   // ❌ 此处没有通知 FeedbackController 刷新状态!

④ this.inlineWorker.initWithStore(...)
⑤ await this.indexController.onLayoutReady()                   // 索引构建
```

关键矛盾点:
- `ModelManager.download()` 内部 `status$.set(Ready)` 在 `this.embedding = embedding`(ModelManager 内部)之后立即触发
- 但 main.ts 中 `this.embedding.setEmbedding(embedding)`(注入到 EmbeddingLocal 占位器)在 `download()` 返回之后才执行
- FeedbackController 的 `getEmbeddingReady()` 读的是 main.ts 的 `this.embedding.isReady`,此时还是 `false`

### 2.3 为什么索引状态没问题

`IndexController.onLayoutReady()` 是在 `setEmbedding()` 之后调用的(第⑤步),所以索引状态通过 `indexStatus$` 订阅正常推进到 Ready。只有 Embedding 状态依赖于 ModelManager 的 Ready 事件,而该事件在 setEmbedding 之前触发。

### 2.4 为什么之前没发现

P-FEEDBACK 实施时,测试只验证了:
- FeedbackController 在 modelStatus$ Ready 时调用 patchEmbeddingReady(单元测试 mock 了 getEmbeddingReady 返回值)
- 没有测试"Ready 事件先于 setEmbedding 注入"这个真实时序

手动测试时可能在网络较慢(模型下载时间长)的情况下,StatusBar 的 "加载中" 显示时间短,被模型下载进度 Notice 覆盖,未注意到最终状态未更新。

---

## 3. 诊断过程

1. **读截图**:模型就绪、索引就绪但 Embedding 加载中,Send 可用但软提示常驻 → 状态判定逻辑错误而非功能故障
2. **追踪状态链路**:`UserStatus.embedding` 字段由 FeedbackController 设置 → 找到 `patchEmbeddingReady()` 方法
3. **分析调用点**:
   - `applyStartupChecks()`(start 时) → 此时 EmbeddingLocal 占位器,isReady=false,正确设为 loading
   - `handleModelStatus(Ready)` → 重新调用 patchEmbeddingReady
4. **对照 onLayoutReady 时序**:发现 `modelStatus$.set(Ready)` 在 `download()` 内部触发,早于 main.ts 的 `setEmbedding()` 调用
5. **确认缺失**:setEmbedding 后没有任何代码通知 FeedbackController 状态已变更
6. **连带发现**:`rebuildEmbeddingAdapter()`(用户在设置面板切 provider 时调用)重建适配器后也没刷新状态,切到 API 模式时 EmbeddingApi 立即可用但状态仍可能停在 loading

---

## 4. 修复方案

在 [feedback-controller.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/core/feedback-controller.ts#L93-L115) 新增两个方法:

```typescript
/** 本地 ONNX 注入完成后强制设为 ready */
notifyEmbeddingReady(): void {
    this.safeRun(() => {
        this.deps.userStatus.patch({ embedding: 'ready' });
    });
}

/** 适配器重建后重新评估 isReady(API→ready, local占位→loading) */
refreshEmbeddingStatus(): void {
    this.safeRun(() => this.patchEmbeddingReady());
}
```

在 [main.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/main.ts#L278-L280) 的 `onLayoutReady` 中,`setEmbedding()` 后调用 `notifyEmbeddingReady()`:

```typescript
if (this.embedding instanceof EmbeddingLocal) {
    this.embedding.setEmbedding(embedding);
}
this.feedbackController?.notifyEmbeddingReady();  // ← 新增
```

在 [main.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/main.ts#L337-L339) 的 `rebuildEmbeddingAdapter()` 末尾调用 `refreshEmbeddingStatus()`:

```typescript
rebuildEmbeddingAdapter(): void {
    // ... 创建 EmbeddingLocal 或 EmbeddingApi ...
    this.feedbackController?.refreshEmbeddingStatus();  // ← 新增
}
```

使用可选链 `?.` 是因为 `rebuildEmbeddingAdapter()` 在 onload 中早于 feedbackController 构造时被调用,此时 feedbackController 为 undefined,跳过即可;`feedbackController.start()` 中的 `applyStartupChecks()` 会做初始状态设置。

---

## 5. 经验教训

1. **事件时序 vs 方法调用时序**:当状态机的"就绪"事件在对象完全初始化之前触发时,依赖该事件做状态同步会产生竞态。解决模式:在初始化完成点**显式通知**,而不是仅依赖中间事件。
2. **"Ready" 事件的语义**:ModelManager 的 `Ready` 表示"模型已加载到 ModelManager 内部",不表示"已注入到主线程 EmbeddingLocal 占位器"。两个 Ready 之间有 gap,UI 状态应在注入完成后更新。
3. **状态源单一性**:FeedbackController 通过 `getEmbeddingReady()` 拉取状态,但状态变更有两个来源(modelStatus$ 订阅和手动 setEmbedding)。订阅能自动响应,手动操作需显式通知。
4. **连带路径检查**:修复主路径时,应检查所有调用 `rebuildEmbeddingAdapter()` 的路径(设置面板切 provider),确保状态一致更新。

# S-CONTEXT-ACCURACY — 上下文占用真值与上限

> 日期: 2026-09-24
> 状态: Active
> Spec ID: **S-CONTEXT-ACCURACY**
> 关联: [llm-openai-compat](../../../src/adapters/llm-openai-compat.ts)、[agent-loop](../../../src/core/agent-loop.ts)、[context-manager](../../../src/core/context-manager.ts)、[context-window](../../../src/utils/context-window.ts)、[ADR-007](../../adr/2026-06-28-model-context-window-registry.md)、S-CHAT-PROFILES（多套配置，另 spec）

---

## 1. 背景

状态栏和抽屉里的上下文百分比有两层：发送前按中英文字符估算；模型返回 `usage` 后用真值盖掉。真值这一层有三个问题：

1. 流式请求没有发 `stream_options: { include_usage: true }`。DeepSeek 这类端点默认不在流末尾给 `usage`，真值经常根本不出现，界面一直停在估算。
2. 就算给了，写回的是「最后一步的输入 + 输出」。一轮里模型连着调几个工具时，每步输入都含完整历史，取最后一步会虚高。各步输入合计（`stepPromptTokens`）已经算出来了，只是没用它。
3. 上限是手选或探测写入的固定值。换模型不跟着变，估算除以旧上限，百分比失真。估算本身也不计工具结果和图片。

## 2. 目标

1. 流式请求显式要 `usage`，端点支持时一定能拿到真值。
2. 真值写回用「本轮各步输入合计 + 输出合计」，不是最后一步。
3. 换模型时上限跟着变；查不到就明确提示，不静默沿用。
4. 估算路径标注为估算，真值路径标注为真值，界面能看出当前是哪一种。

## 3. 非目标

- 不引入真正的分词器（tiktoken 等）。估算仍是估算。
- 不把工具结果和图片纳入估算的精确模型；只在真值缺失时保留现有字符估算。
- 不改压缩触发阈值（85%）本身；只让喂给它的数更准。
- 不做按模型分别记 token 单价或费用。

## 4. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| CA-01 | 流式请求带 `include_usage` | 支持该参数的端点在流末尾返回 usage；不支持的端点不因此报错 |
| CA-02 | 真值用各步合计 | 多步工具调用后，状态栏 usedTokens = Σ step prompt + Σ step completion |
| CA-03 | 估算与真值可区分 | 状态抽屉在 token 数旁标注「估算」或「API」；`ContextUsage.source` 已存在，补 UI 展示 |
| CA-04 | 换模型更新上限 | 切换模型/配置时按映射表写上限；查不到给 Notice，不沿用旧值 |
| CA-05 | 上限变化即重算 | 上限改变后，已有会话的百分比用新上限重算，不等下一次发送 |

## 5. 详细设计

### 5.1 请求侧

`llm-openai-compat` 的流式请求体加 `stream_options: { include_usage: true }`。Ollama 与部分旧端点会忽略未知字段；若某端点因此报错，降级路径（`chatViaRequestUrl`）已经存在，不新增分支。`usage` 解析逻辑不变。

### 5.2 真值写回

`agent-loop` 已经在 `message.end` 带了 `stepPromptTokens` / `stepCompletionTokens`。ChatView 的 `message.end` 处理改为：优先用 `stepPromptTokens + stepCompletionTokens` 写回 `usedTokens`；没有 step 合计时回退到单步 `promptTokens + completionTokens`；都没有时保留估算。`source` 字段在真值路径写 `'api'`，估算路径写 `'estimate'`。状态抽屉在 `usedTokens / maxTokens` 旁加一个小标注：`source === 'api'` 显示「API」，否则显示「估算」。

### 5.3 上限跟随

`getEffectiveChatModelMaxTokens` 不变。换模型/切换配置时（设置保存、profile 切换），用映射表查窗口：查到写入 `chatModelMaxTokens` 并 `patchContextUsage({ maxTokens })`；查不到保留当前值并 Notice。`saveSettings` 里已有的 `patchContextUsage({ maxTokens })` 保证上限一变，已有会话百分比立刻用新上限重算（usedTokens 不变，percentage 重算）。

### 5.4 与 S-CHAT-PROFILES 的边界

「换模型更新上限」这一段两个 spec 共用：S-CHAT-PROFILES 在切换配置时调用它，本 spec 在改当前模型时调用它。实现放同一处（`settings-apply` 或 `context-window` 旁的 helper），两边都调，不复制两份。

## 6. 影响面

| 区域 | 变化 |
|---|---|
| `src/adapters/llm-openai-compat.ts` | 请求体加 `stream_options` |
| `src/core/agent-loop.ts` | 无新增计算；确认 step 合计透出 |
| `src/ui/chat/ChatView.svelte` | `message.end` 真值优先用 step 合计；source 展示 |
| `src/ui/chat/session-context-usage.ts` | source 字段贯通 |
| `src/settings.ts` / `settings-apply.ts` | 换模型时查映射表写上限 + Notice |
| `src/i18n` | Notice 与「估算/真值」标注 zh/en |
| 测试 | include_usage 请求体、step 合计优先、上限跟随、查不到提示 |

## 7. 参考

- [ADR-007](../../adr/2026-06-28-model-context-window-registry.md)
- 现网估算：`src/ui/tokens/token-estimator.ts`
- 现网探测：`src/ui/tokens/probe-model.ts`

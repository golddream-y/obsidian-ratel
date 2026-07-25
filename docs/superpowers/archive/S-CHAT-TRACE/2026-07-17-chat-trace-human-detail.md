# Chat Trace 收口 — 时间线 · reasoning 回传 · 旁注中间层(S-CHAT-TRACE)

> 日期: 2026-07-17  
> 状态: Active  
> 作者: 对话驱动(V3 落地后观感打磨 + thinking 400 根因 + 旁注人读)  
> 关联: [S-CHAT-UI-V3](2026-07-16-chat-ui-v3-conversation-first.md)(P1–P4 已合入 0.1.8);原型 [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)

---

## 1. 背景

S-CHAT-UI-V3 已把侧栏推到 Conversation-first,但实机反馈暴露三类缺口:

1. **Trace 观感**:工具/思考各自独立左边线、meta 冗长、展开区像调试 dump,与原型「一根脊柱 + muted 行」不符。  
2. **DeepSeek thinking 400**:带 `tool_calls` 的 assistant 未回传 `reasoning_content`,API 报  
   `The reasoning_content in the thinking mode must be passed back to the API.`  
3. **旁注可读性**:展开后一度裸 JSON;补结构化后又偏「路径: / 文件 (n)」标签体,对人仍抽象。若按工具名堆 `formatXxx`,会变成难维护的胶水映射。

本 spec 把上述收口为**可实施契约**:已部分落地的行为写清「完成态」,旁注中间层写清「目标态」,避免下一轮 plan 与现网分叉。

---

## 2. 目标

1. **一根 Trace 脊柱**:连续 `tool`/`think` 段合并进同一 `.ratel-trace`;`text` 打断时间线。  
2. **人读旁注,编码稳定**:经**中间层**把 `args+result` 归一为少量形态,再 i18n 渲染;禁止为每个工具写长胶水。  
3. **thinking 工具轮可续跑**:session 持久化并上送 `reasoning_content`,满足 DeepSeek thinking + tool 契约。  
4. **i18n 硬约束**:旁注标签、叙事句、失败/执行中文案全部走 `chat.tool.*` / `chat.thinking*`。  
5. **与 V3 气质一致**:muted 色阶、短折叠 meta、展开轻量旁注(可滚动),无 uppercase「参数/结果」双框。

## 3. 非目标

- 不改工具 `execute` 的返回 JSON 契约(不在 tool 侧塞 `uiDetail`)  
- 不合并多 `tool_calls` 为单条 OpenAI assistant 消息(既有「一条 tool 一条 assistant」结构保留;reasoning 整轮复用即可)  
- 不重做 Agent Loop 步数/权限/钩子  
- 不做完整「原始 JSON」调试开关(若未来需要,另开 spec)  
- 不把原型暖墨色硬编码进生产 CSS  

---

## 4. 详细设计

### 4.1 Trace 时间线(UI)

**分组**(`groupTraceSegments`):

```
segments: think → tool → think → text → tool → tool
blocks:   [trace{…}]          [text] [trace{…}]
```

- `MessageBubble` 对 `trace` 块包一层 `.ratel-trace`(唯一 `border-left`)。  
- `ToolSegment` / `ThinkSegment` **不再**各自画左边线;行容器用普通 flex 列(`min-width: 0`),**禁止** `display: contents`(Obsidian/Electron 下易裁切展开区、破坏 scoped 状态色)。  
- 折叠行:`ico` + `displayName` + 短 `meta`(数字 /「图」/「失败」/「…」)。  
- 展开行:旁注由 §4.3 中间层产出;区域 `max-height` + 滚动,避免撑爆消息流。

**色阶**(对齐原型):

| 状态 | ico | label |
|------|-----|-------|
| done | success | muted |
| calling | warning + pulse | warning |
| failed | error | muted + meta error |
| think | faint | faint / muted |

### 4.2 reasoning_content 回传(协议)

**根因**:流式 `delta.reasoning` 只推 UI,未写入 `ChatMessage`,`DeepSeekLLM.buildRequestBody` 也不上送 → thinking 模式下 tool 续轮 400。

**契约**:

| 层 | 行为 |
|----|------|
| `ChatMessage` | 可选字段 `reasoning?: string`(思考全文) |
| `ContextManager` | `addAssistantMessage` / `addAssistantToolCall` 可选写入 `reasoning` |
| `agentLoop` | 每步累积 `accumulatedReasoning`;无 tool 收尾写入;有 tool 时本轮 `turnReasoning` **复用到该轮每条** assistant+tool 消息 |
| `DeepSeekLLM.buildRequestBody` | `m.role==='assistant' && m.reasoning` → `reasoning_content` |

**持久化**:`reasoning` 随 session JSON 保存,后续用户轮若历史含 tool 仍必须带回(DeepSeek 文档:tool 轮的 reasoning 在之后请求中都要传)。

**测试最低线**:

- `buildRequestBody` 带 reasoning → 体含 `reasoning_content`  
- agent-loop 工具轮后 session 中对应 assistant 含 `reasoning`  
- 无 reasoning 时不上送该字段  

### 4.3 旁注中间层(方案 B — 目标态)

> 现状:`format-tool-detail.ts` 仍按工具名 `switch`,属过渡实现。Plan 应**收敛**为下列两段式,删除 per-tool 长函数。

#### 4.3.1 数据流

```
ToolCallEntry { name, args, result, error?, status }
        │
        ▼
  normalizeToolDetail(name?, args, result, error?)   ← 形状探测(+可选 name 弱提示)
        │
        ▼
  ToolDetailModel  (判别联合,种类固定且少)
        │
        ▼
  renderToolDetail(model)  ← 仅 i18n 模板 + 列表裁剪
        │
        ▼
  string (多行旁注)
```

UI(`ToolSegment`)只调一个入口(可仍名 `formatToolDetail`),内部必须是 normalize → render。

#### 4.3.2 ToolDetailModel(稳定形态 — 编码稳定性来源)

种类 **≤ 7**,新增种类需改本 spec:

| kind | 含义 | 典型命中形状(不绑工具名) |
|------|------|-------------------------|
| `busy` | 执行中 | status calling |
| `error` | 失败 | errorMessage |
| `listing` | 目录列举 | 对象含 `files`/`folders` 数组 |
| `links` | 链接统计 | 含 `outgoing`/`backlinks`(数组或可数) |
| `hits` | 命中列表 | 顶层数组,或对象内 `notes`/`paths`/`files` 路径列表;条目可含 `path`/`metadata.path` |
| `snippet` | 文本体量 | 含 `content: string`,或结果本身是长字符串 |
| `kv` | 浅键值兜底 | 其它对象;只展开一层标量字段 |

可选字段(按 kind):

- 共用:`path?: string`(从 args/result 浅取)  
- `listing`:`files: string[]`,`folders: string[]`  
- `links`:`outgoing/backlinks/unresolved: number`  
- `hits`:`items: string[]`,`hint?: 'reranked' | 'grep' | 'generic'`  
- `snippet`:`chars: number` 或 `preview?: string`(≤ 1 行)  
- `kv`:`entries: Array<{ key: string; value: string }>`(最多 8)  
- `error`:`message: string`

**工具名弱提示**(允许,但禁止成为主路径):

- 仅当形状歧义时使用,例如顶层数组 + `name==='search_vault'` → `hits` + `hint:'reranked'` 探测。  
- **禁止**为每个工具写独立 normalize 分支超过 ~5 行;新工具应通过返回常见形状自动可读。

#### 4.3.3 人话渲染原则(可读性来源)

在**不增加形态种类**的前提下,用 i18n **叙事句**替代纯标签堆砌:

| 形态 | 中文示例(气质) | 英文示例 |
|------|----------------|----------|
| listing | `在 Adventurer 找到 3 个文件` + `· 文件名…` | `Found 3 files in Adventurer` |
| listing 空 | `Adventurer 是空的` | `Adventurer is empty` |
| links | `出链 6 · 反链 12 · 未解析 1`(可保留短标签,因是图语义) | 同结构 en |
| hits | `找到 5 条` + 路径列表;`已重排`作后缀 | `Found 5 hits · reranked` |
| snippet | `读了约 1.2k 字` / `1200 characters` | — |
| kv | `key: value · …` | — |
| busy/error | 复用 `chat.tool.executing` / 错误原文 | — |

规则:

1. **首行是结论**(结果优先),路径/目录名嵌进句子或作次行。  
2. 列表最多 12 条,超出 `chat.tool.detail.more`。  
3. 同目录文件可去公共前缀(展示层,不改数据)。  
4. **不**输出 pretty-print JSON 作为默认旁注。  
5. 所有用户可见词走 i18n;`·` 分隔符可硬编码(非自然语言)。

#### 4.3.4 模块边界

| 模块 | 职责 | 禁止 |
|------|------|------|
| `normalize-tool-detail.ts`(新或拆自现文件) | 形状 → Model | 拼用户句子、读 Svelte |
| `render-tool-detail.ts` | Model → 多行 string | 再猜 JSON 形状 |
| `format-tool-detail.ts` | 门面:`normalize`+`render` | 变回大 switch |
| `ToolSegment.svelte` | 折叠 meta + 展开调门面 | 内联格式化逻辑 |

折叠行 **短 meta** 可继续用轻量规则(数组长度 / `files.length` / 图标签),不必走完整 Model;或从 Model 派一字段 `metaShort`——二选一在 plan 定,spec 要求**单一实现**,禁止两套互拷逻辑长期并存。

### 4.4 i18n key 约定

命名空间:`chat.tool.detail.*`(旁注)、`chat.tool.meta.*`(折叠)、既有 `chat.tool.executing|failed|noResult`。

叙事句示例 key(plan 落地时以 types 为准,可微调文案,不可改形态集合):

- `chat.tool.detail.listingFiles`: `在 {path} 找到 {n} 个文件` / `Found {n} files in {path}`  
- `chat.tool.detail.listingFolders`: `在 {path} 找到 {n} 个文件夹`  
- `chat.tool.detail.listingBoth`: `在 {path} 找到 {files} 个文件、{folders} 个文件夹`  
- `chat.tool.detail.listingEmpty`: `{path} 是空的`  
- `chat.tool.detail.hitsFound`: `找到 {n} 条`  
- `chat.tool.detail.hitsReranked`: `找到 {n} 条 · 已重排`  
- `chat.tool.detail.snippetChars`: `约 {n} 字` / `{n} characters`  
- 既有 links / bullet / more / kv 等短标签可保留或并入叙事  

删除/停用偏标签体且不再使用的 key 时,在同一 PR 清理 types/zh/en,避免死 key。

### 4.5 与 S-CHAT-UI-V3 的关系

| V3 条款 | 本 spec |
|---------|---------|
| §5 Trace 时间线皮肤 | **细化并强制**分组 + 禁止 contents + 旁注中间层 |
| 「Trace 行可展开查看 args/result」 | 改为展开查看**人话旁注**,非 raw args/result |
| 不影响 Agent Loop / ports | **例外**:`ChatMessage.reasoning` + DeepSeek 上送(文档化为本期必要协议补丁) |

V3 主表可在归档时注明「Trace/thinking 收口见 S-CHAT-TRACE」。

---

## 5. 落地状态(事实源)

> 写 spec 时 worktree 已有部分实现;plan 应以本表核对,避免重复劳动。

| 项 | 状态 | 说明 |
|----|------|------|
| `groupTraceSegments` + MessageBubble 接线 | ✅ 已有 | 保留 |
| Trace 去独立边线 / muted / 短 meta | ✅ 已有 | 保留;审核 contents 已去除 |
| `ChatMessage.reasoning` + loop 累积 + buildRequestBody | ✅ 已有 | 补齐测试进 CI;文档入本 spec |
| `format-tool-detail` per-tool switch | ⚠️ 过渡 | **Plan 重构为 normalize→render** |
| 叙事句 i18n(listing/hits/snippet) | ❌ 未齐 | 替换当前「路径:」「文件 (n)」标签体 |
| metaShort 与 Model 单一来源 | ❌ 未齐 | plan 选定一种 |

---

## 6. 影响面

| 区域 | 影响 |
|------|------|
| `src/ui/chat/message-stream/*` | Trace 分组与皮肤(多已落地) |
| `src/ui/chat/format-tool-detail.ts` 及拆分文件 | 中间层重构主战场 |
| `src/ui/chat/message-stream/ToolSegment.svelte` | 只调门面 |
| `src/ports/llm.ts` / `context-manager` / `agent-loop` / `llm-deepseek` | reasoning 契约(已落地,测固) |
| `src/i18n/types.ts` `zh.ts` `en.ts` | 叙事 key 增减 |
| `tests/ui/chat/*` `tests/adapters/llm-deepseek*` `tests/core/agent-loop*` | 形状用例 + reasoning 用例 |
| **不影响** | Worker、索引、权限、tool execute 返回值形状(仅消费) |

---

## 7. 成功标准

1. 连续 tool/think 共享一根左边线;text 后时间线重新开段。  
2. 展开 `list_files` 旁注**首行**为人话结论(含目录与数量),下列文件名;默认**不见** JSON 花括号。  
3. 新工具若返回 `{ files, folders }` 或路径数组,**零新胶水**即可得到可读旁注。  
4. thinking + 多工具轮次不再因缺 `reasoning_content` 400;session 重载后带 tool 的历史仍带 reasoning 上送。  
5. zh/en 切换旁注语言正确;`formatToolDetail` / normalize / render 有单测覆盖 listing / links / hits / 兜底 kv。  
6. `normalize` + `render` 源码中**不存在**按工具名的大段文案分支(允许 ≤1 处弱提示表,条目数有上限注释)。  

---

## 8. 建议实施分 Phase

| Phase | 内容 | 风险 |
|-------|------|------|
| **T0 固 baselinetests** | reasoning + groupTrace 测进入常规 CI 路径 | 低 |
| **T1 中间层重构** | 拆 normalize/render;用形状用例替换 per-tool;叙事 i18n | 中(文案回归) |
| **T2 收口** | metaShort 单一来源;删死 key;对照原型扫一眼 | 低 |

---

## 9. 参考

- DeepSeek Thinking Mode / Tool Calls:`reasoning_content` 在 tool 轮必须回传  
- 原型 Trace 旁注:`docs/prototype/chat-ui-mockup.html`(短人话,非 JSON)  
- S-CHAT-UI-V3 §5 Trace / §7 成功标准  
- 现网门面:`src/ui/chat/format-tool-detail.ts`(待收敛)

---

## 10. 自审

- [x] 背景含三类缺口,不与 V3 重复铺陈布局  
- [x] 中间层形态集合封闭(≤7),编码稳定性有据  
- [x] 人话原则与「禁止 per-tool 胶水」同时写明,无「又要散文又要每工具定制」矛盾  
- [x] reasoning 标为必要协议补丁,非偷偷改 ports  
- [x] 落地状态表区分 ✅/⚠️/❌,plan 可增量  
- [x] 无 TBD/TODO 占位;弱提示边界写清  

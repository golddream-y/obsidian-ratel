# Bug/改进 报告:ChatView UI 对齐设计稿 + 流式渲染回归 + 工具错误样式

- **报告日期**:2026-06-27
- **严重程度**:Mixed(Critical 回归 / High UX 问题 / Medium 视觉问题)
- **引入版本**:工作区未提交代码(修复"模型返回内容未渲染"时引入的回归 + 初版 UI 与 mockup 差距大)
- **修复 commit**:未提交(工作区修改)
- **影响范围**:所有用户使用聊天功能时的视觉呈现与流式体验

---

## 一、问题全景

本轮共修复 **3 大类问题**,分别位于 [ChatView.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/ChatView.svelte)、[StatusLine.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/StatusLine.svelte)、[StatusDrawer.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/StatusDrawer.svelte) 三个 Svelte 组件中:

| # | 问题 | 性质 | 现象 |
|---|------|------|------|
| 1 | UI 整体与 mockup 设计稿差距大 | 视觉/UX | 大红错误块铺满、按钮阴影、输入框太矮、工具调用无进行中指示 |
| 2 | 流式打字机效果消失 | **回归 bug**(Critical) | 模型回复一段一段刷新,而非逐字追加 |
| 3 | 工具权限错误(路径越界等)显示为底部大红色块 | **逻辑 bug**(High) | "工具调用被拒绝:路径越界:不允许绝对路径 /" 以全宽大红条横亘在气泡下方 |

---

## 二、问题 1:UI 视觉对齐设计稿

### 2.1 现象

初次实现的 UI 与 `mockup.html` 设计稿差距明显:

- 错误提示 / 降级提示为**全宽大红底白字块**,视觉冲击强、打断对话流
- `+` 附件按钮、Send 按钮、压缩按钮继承了 Obsidian 默认 `button` 样式,有阴影和边框
- 输入框 `textarea` 仅 32px 高(一行文字),无法舒适输入多行
- 工具调用 `calling` 状态显示旋转符号 `⟳`,没有 pulse 动画,与状态行样式脱节
- 工具调用结果文字为斜体、无分隔符,看起来像正文一部分
- "Search 搜索库" 徽章用紫色 accent 底,过于抢眼
- 搜索结果 idx 编号用紫色,与 muted 辅助信息定位不符
- "思考中…" 指示器为纯斜体文字,无状态点
- StatusLine hover 时背景变白(`--background-primary`),与主题不一致

### 2.2 修复方案

对照 `mockup.html` 逐组件重构样式:

#### StatusLine.svelte
- 状态点尺寸 7px,加 `box-shadow` 发光,`pulse` 关键帧动画(呼吸效果)
- 进度条改为 80px 宽、3px 高、rounded 胶囊,颜色随 tone 变化
- 右侧箭头 `▸` chevron 指示展开/收起状态
- hover 背景改为 `var(--background-modifier-hover)`,自然融入主题

#### StatusDrawer.svelte
- `section-title` 改为大写 `text-transform: uppercase`,字号 11px、letter-spacing 0.08em、muted 色
- `progress-track` 改为 4px 高灰底 + accent-fill
- `hint-pill`(提示徽章)改为药丸胶囊,`border-radius: 10px`,form-field 底
- `degraded`(降级提示)从大红块改为 **3px 左边框 + form-field 背景** 的轻量卡片
- `micro-btn` 去掉阴影,加 `appearance: none` 重置 Obsidian 默认 button 样式

#### ChatView.svelte(重点)
- 输入区 textarea:`min-height: 54px`、`max-height: 160px`,`padding: 10px 12px`,`border-radius: 8px`
- 所有 button 重置:`appearance: none; box-shadow: none;`
- 工具调用 `calling` 状态:用黄色 7px 圆点 + `ratel-pulse` 动画(替代 `⟳`)
- 工具调用 `failed` 状态:红色 `✗` 图标 + 错误信息红字(不再走独立大错误块)
- 工具调用 `done` 状态:绿色 `✓` 图标,结果摘要前加 `—` 分隔符,去掉斜体
- "思考中…" 指示器:同样用黄色 pulse 圆点 + "思考中…" 文字
- 搜索结果徽章:改为 `--background-secondary` 底 + muted 文字(不再紫色)
- 搜索 idx:改为 muted 灰色(不再紫色)
- `.ratel-err`(聊天级错误):与 degraded 一致,改为 3px 左边框 + form-field 底,不再铺大红
- 附件图片在工具调用**之前**展示(原顺序反了)

---

## 三、问题 2:流式打字机效果消失(Critical 回归)

### 3.1 现象

模型回复过程中,气泡内容**一段一段刷新**(积攒到一定量才跳出来),而不是逐字追加的打字机效果。

### 3.2 根因

上一轮修复"模型返回内容未渲染"bug 时,采用了**不可变更新**策略:

```typescript
// 错误写法(回归源)
const updateAssistant = (updater: (m: Message) => void) => {
  messages = messages.map((m, i) => {
    if (i !== messages.length - 1) return m;
    const copy: Message = { ...m, toolCalls: m.toolCalls ? m.toolCalls.map(t => ({...t})) : undefined };
    updater(copy);
    return copy;
  });
};
```

每次 `message.delta` 事件到达时:
1. 构造全新数组 `messages = [...]`
2. 最后一条消息被浅拷贝为全新对象 `copy`
3. Svelte 的细粒度响应式追踪到的是"整条消息对象引用变了",而非"`.content` 字符串变了"

Svelte 5 在微任务队列中批处理连续的赋值,当多次 `messages = newArray` 在同一帧内发生时,会做引用合并,最终 DOM 更新粒度退化为"整段消息替换",表现为一段一段跳字。

最初的 bug(模型返回内容未渲染)是因为用**局部原始对象**直接修改:

```typescript
// 最初的错误写法
const am: Message = { role: 'assistant', content: '' };
messages.push(userMsg, am);
// 之后直接 am.content += delta.text — am 是原始对象,不是 Svelte Proxy,不触发更新
```

Svelte 5 的 `$state` 数组在 `push` 时会把元素包装为深度 Proxy,但**局部变量 `am` 持有的是 push 之前的原始对象引用**,所以后续对 `am.content` 的修改不会被 Proxy 拦截。

### 3.3 正确修复方案

从 `$state` 数组中**取出 Proxy 引用**再修改:

```typescript
messages.push({ role: 'user', ... });
messages.push({ role: 'assistant', content: '' });
const am = messages[messages.length - 1] as Message; // ✅ 这是 Svelte Proxy
// ...
case 'message.delta':
  am.content += event.payload.text; // ✅ 直接修改 Proxy 属性,细粒度更新 text node
  scrollToBottom();
  break;
```

- `messages[messages.length - 1]` 取出的是 Svelte 包装过的 Proxy,对 `.content` 的字符串拼接会被 Proxy 的 `set` trap 拦截
- Svelte 能精确追踪到"绑定 `am.content` 的那个 text node 需要更新",实现逐字 DOM 替换
- 无需每次重建数组,性能也更好

同时添加了自动滚底逻辑(`requestAnimationFrame` 等待 DOM 更新后再滚)。

### 3.4 经验教训

1. **Svelte 5 `$state` 正确用法**:向 `$state` 数组 `push` 对象后,如果后续要修改这个对象,**必须从数组里重新读取**(`arr[arr.length-1]`),不能保留 push 前的局部引用。
2. **不要盲目用不可变更新"治百病"**:不可变更新(map+浅拷贝)是 React 范式,Svelte 5 依赖 Proxy 做细粒度更新,不可变大列表替换反而会退化成粗粒度重渲染。
3. **诊断步骤**:看到"打字机变段刷新",首先怀疑更新粒度,再看编译产物中是否对 text node 做了细粒度订阅。

---

## 四、问题 3:工具权限错误显示为大红色块(逻辑 bug)

### 4.1 现象

用户让模型读根路径 `/` 时,路径安全检查抛出错误,底部出现全宽大红色块:**"工具调用被拒绝:路径越界:不允许绝对路径 /"**。

截图中显示的大红块是 reload 前旧 CSS 的视觉效果(旧版 `.ratel-err` 为 `background: var(--text-error); color: white`),新 CSS 已经改为轻量左边框样式 — 但问题本质是**这个错误根本不应该走到 chatError 分支**。

### 4.2 根因

[agent-loop.ts#L137](file:///Users/golddream/code/git-public/Ratel-CLI/src/core/agent-loop.ts#L137) 在工具权限检查失败时 yield 的错误码是 `TOOL_DENIED`:

```typescript
yield { type: 'error', payload: { code: 'TOOL_DENIED', message } };
```

而 [ChatView.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/ChatView.svelte) 的 `handleAgentError` 函数只识别 `TOOL_ERROR` 和 `INDEX_NOT_READY` 两个工具类错误码:

```typescript
if (code === 'TOOL_ERROR' || code === 'INDEX_NOT_READY') {
  // 附到最近一个 calling 状态的 toolCall 上(小红字显示在工具条)
  ...
  return;
}
am.chatError = formatChatError(code, message); // ← TOOL_DENIED 落到这里,触发大错误块
```

`TOOL_DENIED` 漏判,直接落到了兜底的 `am.chatError` 分支,表现为整条消息级错误块。

### 4.3 事件顺序验证

确认 agent-loop 的事件发射顺序:

```
yield { type: 'tool.call', ... }  // L130,先加入 toolCalls 数组,状态 calling
// ... 权限检查 throw ...
yield { type: 'error', code: 'TOOL_DENIED', ... }  // L137
```

前端收到 `error` 事件时,该 toolCall 已经以 `calling` 状态存在于 `am.toolCalls` 中,所以"就近挂到最近 calling 的 toolCall 上"的逻辑能正确找到目标。

### 4.4 修复方案

在 `handleAgentError` 的工具错误分支加上 `TOOL_DENIED`:

```typescript
if (code === 'TOOL_ERROR' || code === 'TOOL_DENIED' || code === 'INDEX_NOT_READY') {
  if (am.toolCalls) {
    for (let i = am.toolCalls.length - 1; i >= 0; i--) {
      const tc = am.toolCalls[i]!;
      if (tc.status === 'calling' && (!toolName || tc.name === toolName)) {
        tc.status = 'failed';
        tc.errorMessage = message;
        return; // 修复:原来用 break,找到了就应该直接 return,避免 fallthrough 到 chatError
      }
    }
  }
}
am.chatError = formatChatError(code, message);
```

修复后,权限拒绝错误会显示为:

> ✗ search_vault — 工具调用被拒绝:路径越界:不允许绝对路径 /

即工具条本身变红、显示 `✗` 和错误摘要,不再出现大错误块。

同时修复了原来 `break` 未阻断 fallthrough 的隐患(break 只跳出 for 循环,之后还是会走到 `am.chatError = ...`,实际没复现是因为调用 `continue` 外层 try 已结束 — 但改为 `return` 语义更明确)。

### 4.5 经验教训

1. **错误码枚举必须对齐**:agent-loop 定义的错误码(TOOL_ERROR / TOOL_DENIED / INDEX_NOT_READY / CANCELLED / LLM_ERROR)应集中在一个类型定义中,UI 层 switch 时做穷尽检查,避免漏判。
2. **错误展示分层**:工具级错误(工具失败/被拒绝)应就近挂在工具条目上;会话级错误(网络失败、LLM 报错)才走消息级错误块。两类错误视觉权重不同,不应混用。

---

## 五、修改文件清单

| 文件 | 修改性质 |
|------|----------|
| [ChatView.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/ChatView.svelte) | 视觉样式全面重构 + 流式 Proxy mutation 修复 + TOOL_DENIED 错误码处理 + 自动滚底 + 删除未使用 `toolIcon` |
| [StatusLine.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/StatusLine.svelte) | 状态点脉冲/发光、进度条样式、hover 色 |
| [StatusDrawer.svelte](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/StatusDrawer.svelte) | section-title、progress-track、hint-pill、degraded、micro-btn 样式 |

---

## 六、验证

- `npm run build` 构建通过(exit 0),无 TypeScript 错误
- `npx svelte-check` : **0 errors**,7 warnings 为 svelte 编译器固有噪音
- 视觉验证需在 Obsidian 中 Reload app without saving(Cmd+P → "Reload app without saving")加载新的 `dist/main.js` 后对照 mockup 确认

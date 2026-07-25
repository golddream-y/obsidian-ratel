# Chat 会话管理与保持

> 日期: 2026-07-23  
> 状态: Active  
> ID: **S-SESSION**  
> 原型: [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)(v3.1 Sessions)  
> 关联: [ADR-012](../../adr/2026-07-23-skill-activation-claude-aligned.md) · [ADR-009](../../adr/2026-07-06-skill-mechanism.md) · `docs/architecture/host/persistence.md` · `docs/architecture/agent/chat.md`

---

## 1. 背景

### 1.1 问题

- 持久化层已有 Session CRUD,每轮 `message.end` 会写入消息;但 Chat 侧栏**每次挂载新建 `sessionId`**,不恢复、无列表
- 架构文档中的「侧栏历史 / 重开续聊」与现网不一致
- `data.json` 上 settings 与 PersistenceJson **整文件互覆盖**风险仍在;若继续把全部会话正文塞进同一文件,会话变长后**每次 load 都解析全量历史**
- Skill 激活曾用插件级 `activeSkills` + Active 段,与多会话冲突;已由 ADR-012 改为对齐 Claude(写入会话消息)

### 1.2 目标

1. **重开即续聊**:关侧栏 / 重启 Obsidian 后打开 Chat,回到 `lastSessionId` 对应场并 hydrate UI  
2. **`/new` 做好**:有内容则归档旧场、开空白新场;无内容则丢掉空场再开新  
3. **轻量多会话**:Header **一个历史图标** → 小 popover(最近列表 / 新对话 / 删除);不为频繁切换设计  
4. **按需加载**:索引轻、单场正文独立文件;打开/切换只读一场  
5. **切换动效与 loading**(见 §6):可感知、可取消连点、尊重减少动态效果  
6. **Trace 可恢复**:从已落盘 `ChatMessage[]` hydrate think/tool/text;不强制持久化引用芯片  
7. **标题**:首轮结束后 LLM 异步短标题(失败回退首条 user 截断)  
8. Skill 激活遵循 **ADR-012**(本 spec 假定实施或与会话 plan 同批落地)

### 1.3 非目标

- 独立大历史侧栏 / 会话搜索 / 置顶 / 云同步 / 导出分享(可后续)  
- 像素级还原流式过程中的 `startAt`、附件、取消标记  
- 强制持久化 `searchResults` 芯片行(path 可从工具结果打开;笔记缺失 Notice)  
- 每条消息一个文件、或 GraphRAG 级会话图谱  
- 改 Agent Loop 协议本身(仍 `ask(sessionId, …)`)

---

## 2. 产品原则

| 原则 | 说明 |
|------|------|
| 主路径是续聊与 `/new` | 列表是找回工具,入口只占一个图标 |
| Session = 这场对话的容器 | 消息与「写进 transcript 的 Skill 正文」属 Session;Memory / 索引 / 设置属库或插件级 |
| 能靠消息带走的不另挂旁路表 | 对齐 ADR-012;新机制先问「换场后还算不算上一场的事」 |
| 加载按需 | 启动不解析全部会话正文 |
| 动效服务状态 | loading 表达「正在读盘/切换」,不是装饰噪音 |

---

## 3. 存储与加载契约

### 3.1 布局

```
.obsidian/plugins/ratel-vault/
  data.json                 # settings + 会话索引 + lastSessionId(无消息正文)
  sessions/
    <sessionId>.json        # 单场 Session 正文
```

### 3.2 索引条目(轻)

每场:`id`、`title`、`createdAt`、`updatedAt`;可选 `messageCount`。  
全局:`lastSessionId`。

### 3.3 单场文件

与现有 `Session` 对齐:`id`、`title`、`messages: ChatMessage[]`、`createdAt`、`updatedAt`。  
Skill 全文按 ADR-012 已在 `messages` 内,不另存激活表。

### 3.4 读写规则

| 时机 | 行为 |
|------|------|
| 打开侧栏 | 读索引 → `lastSessionId` → **只 load 该场文件** → hydrate UI |
| 切换会话 | flush 当前场(若脏)→ load 目标场 → hydrate(带 §6 动效) |
| `/new` / 菜单「新对话」 | 见 §4.2 |
| `message.end` | upsert **当前场文件** + 更新索引中该行 `updatedAt`(及标题若已生成) |
| settings 保存 | 只更新 `data.json` 的 settings 侧;**read-merge-write**,不得抹掉索引 |
| 会话索引更新 | 与 settings 同文件时必须 merge,禁止整文件只写 settings 或只写 store |

### 3.5 保留上限

固定合理默认(如最近 **N=30** 场,可后续做成设置):超出按 `updatedAt` 删除最旧场文件 + 索引行。单场过长仍靠现有 `/compact`。

### 3.6 迁移

首次升级:若旧 `data.json` 内嵌全量 `sessions[]`,一次性拆到 `sessions/*.json` + 写索引,再清掉内嵌正文(保留备份策略由 plan 定,须可测、失败可回退或明确报错)。

---

## 4. 打开 / `/new` / 列表交互

### 4.1 打开侧栏(续聊)

1. 读索引与 `lastSessionId`  
2. 场文件存在 → load → hydrate → 当前 `sessionId`  
3. 不存在(首次或丢失)→ 新建空 session,UI 空白  
4. **禁止**每次 `onOpen` 无条件 `session-' + Date.now()`

关侧栏:flush 脏数据 + 持久化 `lastSessionId`;不删会话。

### 4.2 `/new` 与菜单「新对话」(同一条路径)

「有内容」= 至少一条 user,或一条含非空文本/工具/思考的 assistant。

| 当前场 | 行为 |
|--------|------|
| 有内容 | upsert 旧场 + 更新索引 → 新 `sessionId` → 清 UI → 更新 `lastSessionId` → 按 ADR-012 注入 `always` Skill(若有) |
| 无内容 | 删除已落盘空场(若有) + 摘索引 → 同上「新开」 |

工具「本会话允许」等会话态授权在 `/new` / 切换时清空。  
Skill **不再**依赖全局 `clearActive`;旧场指令留在旧场消息里。

### 4.3 Header 小图标菜单

- 位置:模型芯片左侧,单个图标(时钟/历史语义)  
- 点击:popover(非第二侧栏);含「＋ 新对话」+ 最近列表(标题 + 相对时间)  
- 点行:切换(§4.4 + §6)  
- 行内删除:删文件+索引;若删的是当前场 → 切到最近一场或 `/new`  
- 默认可滚动;高度克制(原型约 280px 内)

### 4.4 切换

1. 忽略「已是当前」与切换进行中的连点  
2. 先关菜单(或保持,实现可选;原型为关闭)  
3. 走 §6 动效与 loading  
4. flush 旧场 → load 新场 → hydrate → 滚到顶或底(实现选「顶」与原型一致,或「底」若产品更偏好续聊阅读;默认 **滚到顶部**,避免误以为仍是旧场中部)

---

## 5. Hydrate 与引用

### 5.1 `ChatMessage[]` → UI `Message[]`

- 折叠协议序:user / assistant(+reasoning→think) / tool 对 → tool 段 / 最终 text  
- `displayName` 用现有 `formatToolDisplayName` 重算;工具状态一律 done(或失败可解析则 failed)  
- 替换今日仅包 text、过滤 tool 的 `preservedChatMessagesToUi` 用途(compact 可继续精简,恢复会话用完整 hydrate)

### 5.2 引用芯片

- **不**单独持久化 `searchResults`  
- 恢复后无芯片可接受  
- 若 UI 从工具结果解析出 path:点击打开笔记;笔记不存在 → Notice 提示  
- 正文 `[n]` 对不上可接受(本期不强制重建映射)

---

## 6. 切换动画与 Loading(硬性要求)

原型已演示,实现必须对齐下列行为(时长可微调,但**不得省略** loading 态与进出场)。

### 6.1 状态机

```
idle → exiting → loading → entering → idle
```

- `exiting`:当前消息区退出动画  
- `loading`:遮罩 + spinner + 文案;读盘/hydrate 在此阶段  
- `entering`:新内容进入动画  
- 全程 `switching=true`,禁止并行再切

### 6.2 视觉要求

| 元素 | 要求 |
|------|------|
| 消息区 | 退出:短时淡出 + 轻微位移;进入:淡入 + 反向位移(与原型同方向语义) |
| 遮罩 | 半透明 + 可选轻 blur;居中铜/强调色 spinner + 文案「加载会话…」或「新对话…」 |
| Header 历史图标 | loading 期间旋转或等价 busy 态 |
| 菜单目标行 | loading 期间行内小 spinner(切走后清除) |
| `aria-busy` | 遮罩/容器在 loading 时为 true;`aria-live` 可礼貌提示 |

### 6.3 时长(默认,可测)

| 阶段 | 默认 |
|------|------|
| exit | ~150ms |
| loading(含读盘;本地通常更快,但 UI **至少**展示一瞬以免闪烁,建议下限 ~120–200ms,上限随 IO) | 原型模拟 ~320ms;实现按真实 IO,短于下限则补齐 |
| enter | ~220ms |

### 6.4 减少动态效果

`prefers-reduced-motion: reduce` 时:

- 跳过 exit/enter 位移动画与图标旋转  
- **仍显示** loading 遮罩与文案(或静态 busy),避免无反馈硬切

### 6.5 `/new`

同一套状态机;文案可用「新对话…」;空内容进入可略短,但不得无 loading 闪白。

### 6.6 i18n

用户可见文案走 i18n,例如:

- `chat.session.loading`  
- `chat.session.loadingNew`  
- `chat.session.menuRecent` / `chat.session.new` / `chat.session.delete`  
- 笔记缺失 Notice 键  

(具体 key 在 plan 落地时写入 `types.ts` / zh / en。)

---

## 7. 自动标题

1. 某场首次出现「有内容」且 `title` 仍为空或占位「新对话」时,在 `message.end` 后 **异步** 调 LLM 生成短标题(≤ ~40 字,无引号堆砌)  
2. 成功:写单场文件 + 索引  
3. 失败/超时:回退首条 user 消息截断  
4. 不阻塞用户继续输入;切换走时可取消未完成的标题请求(AbortSignal)

---

## 8. 与 ADR-012 / Skill

- 激活 = 写入当前 `Session.messages`;恢复会话即恢复曾注入的指令  
- Discovery 段仍每轮注入;废除以全局 `activeSkills` + Active 段为正确注入源  
- `always`:新 session 首次组上下文时写入一次(若尚未在该场消息中)  
- `deactivate`:supersede 消息或 best-effort(见 ADR-012)  
- 实施可与本 spec 同 plan 或紧随 plan;会话验收不得依赖「切场后全局 Active 串台」的旧行为

---

## 9. 错误处理

| 情况 | 行为 |
|------|------|
| 单场文件损坏 / JSON 解析失败 | Notice;回退空场或上一场;devLogger 中文日志 |
| 索引与文件不一致 | 以文件扫描修复索引或删除孤儿文件(plan 定策略,须可测) |
| 切换中读盘失败 | 结束 loading,保留旧场 UI,Notice |
| 笔记 path 不存在 | Notice,不抛崩 |

---

## 10. 成功标准

1. 重启 Obsidian 后打开 Chat,看到的是上次对话(标题与 Trace 工具/思考/正文可辨),不是空白新 id  
2. `/new` 与菜单「新对话」行为一致;有内容旧场可在图标菜单找回  
3. 切换可见 exit → loading → enter;减少动态效果下仍有 loading 反馈  
4. 启动/打开不因「历史很多」而明显变慢(只读索引 + 一场正文)  
5. settings 保存不再抹掉会话索引  
6. 自动化:hydrate 纯函数测;Persistence 分文件测;切换状态机/防连点测(UI 可用组件测或轻 harness)

---

## 11. 影响面

| 区域 | 影响 |
|------|------|
| `PersistenceJson` / `SessionRepository` | 分文件 + 索引 API |
| `main.ts` saveSettings | merge 写入 |
| `ChatView` | lastSession、菜单、切换动效、`/new`、hydrate |
| `chat-message-to-ui` 或新 hydrate 模块 | 完整 Trace 恢复 |
| i18n | 会话菜单与 loading 文案 |
| Skill 激活路径 | ADR-012 |
| 原型 | `chat-ui-mockup.html` v3.1 为 UX 真源 |

---

## 12. 参考

- 原型: `docs/prototype/chat-ui-mockup.html`  
- [ADR-012 Skill 激活对齐 Claude](../../adr/2026-07-23-skill-activation-claude-aligned.md)  
- [Claude Code Skills](https://code.claude.com/docs/en/skills)(激活进入 conversation)  
- agentskills.io progressive disclosure  
- 既有 `Session` / `ChatMessage` / `Message` 类型

# S-CHAT-PROTO — Chat 原型对齐与三级权限

> **ID:** S-CHAT-PROTO  
> **状态:** Active  
> **日期:** 2026-08-10  
> **原型:** [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)（v3.3）  
> **前置:** S-CHAT-UI-V3 / S-SESSION / S-CITE / 0.1.18 会话体验  
> **动机:** 原型与现网双向漂移；发送钮与权限档位未对齐；需一次收口并落地三级权限 + 底栏避让。

---

## 1. 背景

对照 2026-08-10 的原型与 `ChatView` / `SessionMenu` / `StatusDrawer` / 消息流后发现两类差距：

1. **现网已有、原型未画** — 0.1.16–0.1.18 能力（✎ 标题、切换确认、来源折叠、抽屉入口等）未回写 mockup。  
2. **原型已定、现网未落** — hint 行三级权限、发送 ↑ 方钮、composer 底避让 Obsidian 状态栏等。

发送钮是显著视觉差：原型为 **34×34 ↑ 铜色方钮**；现网为加宽文字「发送 / 停止」。已确认对齐方向：**现网改为原型形态（方案 1）**。

---

## 2. 目标

1. **发送 / 停止对齐原型**：空闲为 ↑ 方钮；运行中为停止图标（非「停止」二字）；尺寸 / 圆角 / 强调色行为与原型一致。  
2. **落地三级工具权限档位**（安全 / 自动 / 危险），入口在输入框下 hint 行左侧分段开关；持久化；取代布尔 `trustMode` 的产品语义（或等价映射）。  
3. **composer 底避让**：为 Obsidian 状态栏预留约 22px，避免 hint / 权限档被挡。  
4. **双向对齐文档化**：本 spec 列出全部差距；实施分「回写原型」与「改产品」两条任务轨，可同 plan 或拆 plan。  
5. **i18n**：新增用户可见文案走 `zh` / `en` / `types`。

成功标准（可验收）：

- 侧栏发送钮视觉与原型 ↑ 一致；生成中可一键停止（图标）。  
- hint 行可切换三档，刷新 Obsidian 后档位仍在。  
- 安全档写工具必弹确认；自动档写放行、删仍确认；危险档 ask 级全跳过（`deny` 仍生效）。  
- 窄侧栏底部 hint / 分段开关不被状态栏切掉。  
- 原型 HTML 反映 0.1.18 已有能力 + 本 spec 的发送 / 权限 / 底避让。

---

## 3. 非目标

- 不改 Agent Loop 步数、工具执行语义、MCP transport。  
- 不引入外网字体加载（继续本机可选 Instrument Sans；无 Google Fonts 请求）。  
- 不把「单工具权限表」从设置里删掉（细调保留；档位是快捷预设，见 §5.2）。  
- 不做会话级独立权限档（档位全局，跟 settings；会话「本次不再询问」仍按工具名缓存）。  
- 不重做 Trace / 引用算法（仅原型回写折叠 UI）。

---

## 4. 差距清单（事实源）

### 4.1 现网已有 → 需回写原型

| # | 能力 | 现网位置 | 原型现状 |
|---|---|---|---|
| P1 | 会话 ✎ + 重命名 Modal + AI 总结 | `ChatView` chip 旁 | 无 |
| P2 | 生成中切换 / 新建确认 | `session-switch-confirm` | 无 |
| P3 | 「来源 N 篇」折叠 pill | `SearchResults.svelte` | 常开 cite-chip |
| P4 | 抽屉底：记忆 / MCP / 反馈 / 赞助 | `StatusDrawer` | 仅索引+上下文 |
| P5 | 工具行 MCP 徽章 | `ToolSegment` | 无 |
| P6 | 附件条 | `AttachmentStrip` | 仅 `+` |
| P7 | 生成中停止态 | `ratel-stop` 文字钮 | 无（本 spec 改图标时一并画） |
| P8 | 会话授权按工具名 | `ToolPermissionSessionGrants` | 未表达（可选注记，非必须 UI） |

### 4.2 原型已定 → 需改产品

| # | 能力 | 原型 | 现网 |
|---|---|---|---|
| I1 | **发送 ↑ 方钮** | 34×34、`border-radius:10`、↑ | 文字「发送」、加宽 padding |
| I2 | **停止图标** | （随 I1） | 文字「停止」+ 红底 |
| I3 | **三级权限分段** | hint 左 `安全\|自动\|危险` | 设置布尔 `trustMode` + 单工具表 |
| I4 | **hint 说明文案** | 随档变色短句 | 无 hint 行 |
| I5 | **composer 底避让** | `padding-bottom: ~22px` | 贴底 |

### 4.3 刻意不对齐（保持现状）

| 项 | 理由 |
|---|---|
| 外网加载 Instrument / Plex | 隐私：不拉 Google Fonts |
| 原型外壳假 Obsidian 状态栏 | 产品在真 Obsidian 内，只留 padding |
| 用户泡 thumbs 装饰图 | 产品用附件条，不复制假图 |

---

## 5. 详细设计

### 5.1 发送 / 停止（I1 / I2）

**形态：**

- 空闲：`34×34`、圆角 `10px`、背景 `--interactive-accent`（强调色，对齐铜色语义）、内容为 **↑**（或同尺寸 SVG chevron-up）。  
- `disabled`（无输入 / gate 不可发）：`opacity: 0.4`。  
- 运行中：同尺寸方钮，背景 `--text-error`（或原型约定的停止色），内容为 **■** 或「停止」图标（正方形 / 实心方），**不**用两字「停止」撑宽。  
- `aria-label` / `title` 仍用 i18n（`chat.input.send` / `chat.input.stop`），保证读屏。

**交互不变：** Enter 发送、运行中点停止 → 现有 `stopGeneration`。

**验收：** 窄侧栏下发送钮不因文案变宽；停止态宽度与发送态一致。

### 5.2 三级权限档位（I3 / I4）

**产品名（中文）：** 安全 / 自动 / 危险  
**存储字段（建议）：** `settings.toolPermissionLevel: 'safe' | 'auto' | 'danger'`，默认 `'safe'`。

**语义：**

| 档位 | 行为 |
|---|---|
| `safe` | 所有默认会 `ask` 的工具继续询问；**读类若当前为 allow 保持 allow**（见下「与『啥啥都问』的折中」）。写 / 删 / 记忆写入等 ask 工具每次确认（会话 grant 仍有效）。 |
| `auto` | **读 + 写**（`write_note` / `append_note` / `edit_note` 及只读工具）运行时视为 allow；**删除类**（`delete_note`，以及同级破坏性如 `forget_memory` 若存在）仍 ask。MCP 工具：非只读默认仍 ask，除非后续单开规则。 |
| `danger` | 等价原 `trustMode: true`：跳过所有 `ask` 确认；**`deny` 仍拒绝**。 |

**与用户口述「安全=啥啥都问」的折中：**

- 严格「连读都问」会破坏现网只读默认 allow、弹窗过多。  
- **本 spec 定稿：`safe` = 当前默认安全策略（读 allow、写/删 ask）**；若产品日后要「读也问」，另开开关，不塞进三档。  
- UI 文案用「读写删都会询问」易误解 → 改为 **「写与删除会询问」**（中）/ **「Asks before write & delete」**（英）。自动 / 危险文案对齐原型语义。

**与单工具表关系：**

- 档位是 **运行时覆盖层**；决策顺序以 §5.5 为准：`deny` → 会话 grant → 档位放行 → 单工具 `allow` → 弹窗。  
- 设置页「工具权限」表保留；`deny` 永远优先。  
- `trustMode`：**迁移** — 读旧数据 `trustMode===true` → `toolPermissionLevel='danger'`；写盘后可停止依赖布尔（或只读兼容一层）。设置页原「信任模式」toggle **改为与三档同步的下拉**（与侧栏同一字段），避免双入口打架。

**UI：**

- 位置：`.ratel-input` 内、输入壳下方 hint 行；左分段、右短说明 + Enter 提示（可省略 kbd 若太挤）。  
- 样式对齐原型 `.perm-seg`（安全绿 / 自动铜强调 / 危险玫）。  
- 切换立即 `saveSettings`；进行中的 tool 确认不回溯改已弹出的 Modal。

### 5.3 composer 底避让（I5）

- `.ratel-composer` 增加 `padding-bottom: 22px`（或 `max(22px, env(safe-area-inset-bottom))`）。  
- 不在插件内画假状态栏。  
- 验收：hint 行完整可见，不被 Obsidian 底栏裁切。

### 5.4 原型回写（P1–P7）

在 `chat-ui-mockup.html` 增补（静态即可）：

- Header：chip 旁 ✎。  
- 菜单 / 流程：注明生成中切换有确认（可用示意 Modal 或注释块，**不**再挂可见「确认点」长文）。  
- 来源：折叠「来源 N 篇」。  
- 抽屉底四入口。  
- Trace：MCP badge 样例。  
- 附件条 chip。  
- 发送 ↑ + 停止方钮态（可用 toggle 演示）。  
- 保留三级权限 + 底 padding。

### 5.5 `resolveToolPermission` 伪逻辑

```
if toolPermissions[name] === 'deny' → throw
if grants.has(name) → allow
level = settings.toolPermissionLevel ?? 'safe'
if level === 'danger' → allow
if level === 'auto' && !isDestructive(name) → allow
# safe 或 auto+destructive:
if toolPermissions[name] === 'allow' → allow
else → confirm modal（session grant 照旧）
```

`isDestructive`：至少 `delete_note`；建议含 `forget_memory`。MCP：一期全部视为可能破坏 → auto 下仍 ask（保守）。

---

## 6. 影响面

| 区域 | 变更 |
|---|---|
| `ChatView.svelte` | 发送/停止 UI；hint 行；composer padding |
| `tool-permissions.ts` + 测试 | 档位决策；destructive 集合 |
| `settings.ts` / DEFAULT / 迁移 | `toolPermissionLevel`；`trustMode` 迁移 |
| 设置面板 | 信任模式 UI → 三档或说明 |
| i18n | 档位名、说明、aria |
| `docs/prototype/chat-ui-mockup.html` | 回写 P1–P7 + 与产品一致的发送态 |
| user-guide | 权限三档说明（实施后 docs 任务） |
| CHANGELOG | 发版时 Added/Changed |

---

## 7. 测试要点

- 单元：`resolveToolPermission` × `{safe,auto,danger}` × `{read,write,delete,deny,session grant}`。  
- 迁移：旧 `trustMode:true` → `danger`。  
- UI 手测：发送钮尺寸不闪动；三档切换后写/删弹窗行为；底栏不被挡。  
- 原型：静态目视清单勾选 P1–P7 / I1–I5。

---

## 8. 实施建议拆分

可一个 plan 两轨，或两个 plan：

1. **P-CHAT-PROTO-UI** — I1/I2/I5 + 原型回写 P1–P7（视觉对齐，风险低）。  
2. **P-CHAT-PROTO-PERM** — I3/I4 权限档位 + 设置迁移 + 测试 + user-guide（行为变更）。

推荐先 UI 轨再权限轨，便于分 PR。

---

## 9. 参考

- 原型：`docs/prototype/chat-ui-mockup.html`  
- 权限：`src/core/tool-permissions.ts`、`docs/architecture/host/settings.md` §3.6  
- 会话：0.1.18 CHANGELOG；`session-rename-modal` / `session-switch-confirm`  
- 引用：S-CITE / SearchResults 折叠

---

## 10. 自审记录

- 无 TBD 占位；「安全=啥啥都问」与只读默认的矛盾已在 §5.2 显式折中。  
- MCP 在 auto 下保守仍 ask，避免误放开。  
- `deny` 在所有档位生效，与旧 trustMode 文档不一致处已按代码正确行为写清。

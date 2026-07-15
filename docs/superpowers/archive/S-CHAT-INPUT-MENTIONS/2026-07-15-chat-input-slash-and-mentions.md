# Chat 输入：`/` + `@` 提及 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 S-CHAT-INPUT-MENTIONS：文件菜单插入 `@vault相对路径`、输入框高亮 chip、`@` 补全；发送策略 A（只带路径字面量，不读全文）；不回归现有 `/` 斜杠。

**Architecture:** 保持 **textarea + 上方 MentionStrip（chip 条）**，对标现有 `AttachmentStrip`，**不用 contenteditable**（大库下选区/IME/性能坑多）。纯函数 `mention-parser.ts` 负责从发送文本提取 path；`MentionMenu` 对标 `SlashMenu`；`main.ts` 注册 `file-menu`。补全只扫 `vault.getMarkdownFiles()` 的 path/basename，防抖 + topK，**禁止**为 `@` 读文件内容。

**Tech Stack:** TypeScript、Svelte 5、Obsidian `file-menu` / `TFile`、现有 i18n / ChatView

**Spec:** [2026-07-15-chat-input-slash-and-mentions-design.md](../specs/2026-07-15-chat-input-slash-and-mentions-design.md)

---

## 性能风险（实现硬约束）

| 风险 | 约束 |
|---|---|
| 每键全库扫描 | `@` 查询 **debounce ≥ 80ms**；结果 **≤ 20**；只匹配 `path`/`basename` 小写 includes，不做模糊编辑距离 |
| contenteditable | **禁止**；chip 放 `MentionStrip`，textarea 只插字面量 `@path`（可加尾随空格） |
| 策略 A | 发送/解析路径 **零 `readFile`**；不预拉全文 |
| 文件菜单 | 只 `file.path` 字符串插入；不打开、不读盘 |
| 列表源 | 优先 `app.vault.getMarkdownFiles()`（已在内存）；不要每次 `listMarkdownFiles` + stat |
| 重渲染 | chip 列表用稳定 key=`path`；避免每个按键 `getSettingDefinitions` 级全树更新 |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/chat/input/mention-parser.ts` | 提取/校验 `@path`；归一化为 vault 相对路径 |
| `src/ui/chat/input/mention-suggest.ts` | 纯函数：query + paths → topK 建议 |
| `src/ui/chat/input/MentionMenu.svelte` | `@` 弹出菜单（对标 SlashMenu） |
| `src/ui/chat/input/MentionStrip.svelte` | 已选提及 chip 条（可删） |
| `src/ui/chat/ChatView.svelte` | 接线：菜单互斥、发送合并文本、插入 API |
| `src/main.ts` | `file-menu` → activateChat + insertMention |
| `src/i18n/{types,zh,en}.ts` | 菜单/placeholder/空状态文案 |
| `tests/ui/chat/mention-parser.test.ts` | 解析与建议纯函数测 |

---

### Task 1: mention-parser 纯函数 + 测试

**Files:**
- Create: `src/ui/chat/input/mention-parser.ts`
- Create: `tests/ui/chat/mention-parser.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { extractMentions, formatMentionToken, isSafeVaultMentionPath } from '../../../src/ui/chat/input/mention-parser';

describe('extractMentions', () => {
  it('extractMentions - 含 @path - 抽出相对路径', () => {
    expect(extractMentions('看 @Work/a.md 和 @b.md')).toEqual(['Work/a.md', 'b.md']);
  });
  it('extractMentions - 绝对路径形态 - 不当作合法 mention 或标记 unsafe', () => {
    expect(isSafeVaultMentionPath('/Users/x/Vault/a.md')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
npx vitest run tests/ui/chat/mention-parser.test.ts
```

- [ ] **Step 3: 最小实现**

- Token 形态：发送文本保留 `@` + vault 相对 path（可含空格的 path 用 `` `@` + path `` 或 `` @"path with space.md" ``；v1 约定 path **不含空格**，与现网笔记一致，简单正则 `@([^\s@]+)`）
- `isSafeVaultMentionPath`：拒绝 `..`、Windows 盘符、以及以 `Users/` 开头的「假相对绝对路径」（见截图类 bug）
- 可选：若 path 以 `/` 开头，剥成相对（仅单段 vault 根写法），**不要**把 `/Users/...` 当 vault 路径

- [ ] **Step 4: GREEN + commit**

```bash
npx vitest run tests/ui/chat/mention-parser.test.ts
git add src/ui/chat/input/mention-parser.ts tests/ui/chat/mention-parser.test.ts
git commit -m "feat(chat): @mention 路径解析纯函数"
```

---

### Task 2: mention-suggest 纯函数 + 测试

**Files:**
- Create: `src/ui/chat/input/mention-suggest.ts`
- Create: `tests/ui/chat/mention-suggest.test.ts`

- [ ] **Step 1: RED** — `suggestMentions(query, paths, limit=20)`：空 query 返回最近/前 N；非空 path/basename includes；稳定排序 basename 优先

- [ ] **Step 2: GREEN** — 实现时 **O(n) 单趟**，n=文件数，limit 截断；无 IO

- [ ] **Step 3: commit** `feat(chat): @mention 补全建议纯函数`

---

### Task 3: MentionMenu + MentionStrip UI

**Files:**
- Create: `src/ui/chat/input/MentionMenu.svelte`
- Create: `src/ui/chat/input/MentionStrip.svelte`
- Modify: `styles.css`（chip / menu，复用 diag/slash 间距变量）
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

- [ ] **Step 1:** i18n keys：`chat.mention.menuTitle`、`chat.mention.empty`、`chat.mention.fileMenu`、`chat.mention.stripAria`、`chat.mention.removeAria`

- [ ] **Step 2:** `MentionMenu` — props：`query`、`items`、`onSelect(path)`、`onClose`；键盘上下/回车对标 SlashMenu

- [ ] **Step 3:** `MentionStrip` — props：`paths: string[]`、`onRemove(path)`；展示 basename，title=全 path

- [ ] **Step 4:** 目视：窄侧栏下 chip 换行不撑破布局

- [ ] **Step 5: commit** `feat(chat): MentionMenu/Strip UI + i18n`

---

### Task 4: 接入 ChatView

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`

- [ ] **Step 1:** state：`mentionPaths: string[]`；`mentionQuery` 从 textarea 光标前最近一段解析（仅当正在输入 `@…` 且无空格结束）

- [ ] **Step 2:** `/` 与 `@` **互斥**：`input.startsWith('/')` 时只开 SlashMenu；检测到 `@` 补全态时关 SlashMenu

- [ ] **Step 3:** debounce 80ms 后 `suggestMentions`；数据源 `plugin.app.vault.getMarkdownFiles().map(f => f.path)`

- [ ] **Step 4:** 选中建议 → `insertMention(path)`：strip 去重 push；textarea 在光标处插入 `@path `（策略 A 字面量）

- [ ] **Step 5:** `sendMessage`：最终 `text` 以 textarea 为准（已含 `@path`）；可选 `extractMentions` 仅日志；**不** readFile；发送后清空 strip 与 input

- [ ] **Step 6:** 暴露 `plugin.insertChatMention?.(path)` 或 ChatView 实例方法供 main 调用（二选一，优先 plugin 上薄封装避免循环依赖）

- [ ] **Step 7: commit** `feat(chat): ChatView 接入 @ 补全与 chip`

---

### Task 5: file-menu「添加到 Ratel」

**Files:**
- Modify: `src/main.ts`（`onload` 注册）
- Modify: i18n（若 Task3 未加 `chat.mention.fileMenu`）

- [ ] **Step 1:**

```typescript
this.registerEvent(
  this.app.workspace.on('file-menu', (menu, file) => {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    menu.addItem((item) => {
      item.setTitle(tNow('chat.mention.fileMenu'))
        .setIcon('rabbit') // 或现有 badger；无则 'file-plus'
        .onClick(async () => {
          await this.activateChatView();
          this.insertChatMention(file.path);
        });
    });
  }),
);
```

- [ ] **Step 2:** `insertChatMention`：若 ChatView 未挂载，短延迟/一次 `onLayoutReady` 后再插；path 必须已是 vault 相对（`TFile.path`）

- [ ] **Step 3:** 手测：右键 md → 插入 → 侧栏出现 chip + 文本

- [ ] **Step 4: commit** `feat(chat): 文件菜单添加到 Ratel(@mention)`

---

### Task 6: 路径防御（与截图问题对齐）

**Files:**
- Modify: `src/ui/chat/input/mention-parser.ts`（或 `path-safety` 增补 helper）
- Test: 扩展 mention-parser 测试

- [ ] **Step 1:** 插入与解析时拒绝/剥离 macOS 绝对路径；若误粘贴 `/Users/.../Vault/Template/x.md`，尝试检测 vault base 前缀并裁成相对（可选增强）；v1 至少 **拒绝** 并 Notice「请使用库内相对路径」

- [ ] **Step 2: commit** `fix(chat): @mention 拒绝绝对路径粘贴`

---

### Task 7: user-guide 一行 + STATUS

**Files:**
- Modify: `docs/user-guide.md`（设置/提问节：`@笔记` + 右键）
- Modify: `docs/superpowers/STATUS.md` — P-CHAT-INPUT-MENTIONS → Completed（完成后）

- [ ] **Step 1:** 文档 + STATUS

- [ ] **Step 2: commit** `docs: @mention 使用说明与 STATUS`

---

## 自审

- [ ] 无 contenteditable  
- [ ] 无发送前读全文  
- [ ] 补全有 debounce + limit  
- [ ] `/` 行为不回归  
- [ ] i18n 双端齐全  

---

## 执行顺序

Task 1 → 2 → 3 → 4 → 5 → 6 → 7（4/5 可同 PR，但 commit 分开）

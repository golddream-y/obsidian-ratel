# 对话内输入能力 — `/` 斜杠指令与 `@` 文档引用

> 日期: 2026-07-15  
> 状态: Active  
> Spec ID: **S-CHAT-INPUT-MENTIONS**  
> 关联: 现有 `slash-commands.ts` / `SlashMenu.svelte`；文件资源管理器右键「添加到 Ratel」；发送策略用户选定 **A**

---

## 1. 背景

用户希望：

1. 左侧文件菜单：把笔记以 **`@相对路径`** 形式插入 Ratel 输入框，并显示为**高亮 tag**  
2. 输入框内支持 `@` 补全与解析，与现有 `/` 指令同属「对话内输入能力」  
3. 发送时采用策略 **A**：`@path` **只作路径提示**，不自动灌全文；由 Agent 自行 `read_note` / `search_vault`

当前 Chat 附件仅支持图片；斜杠菜单已有 `/new` `/compact` `/model` `/reindex` `/skill*`，但无统一「输入解析层」，也无 `@`。

---

## 2. 目标

1. 统一 **输入解析**：识别行首/词边界的 `/命令` 与任意位置的 `@vault相对路径`  
2. UI：`@…` 渲染为可删除的高亮 chip/tag（专业观感）  
3. 文件菜单：`添加到 Ratel` → 打开/聚焦 Chat → 插入 `@path`（path = vault 相对路径，含 `.md`）  
4. 发送 payload：用户可见文本可保留 `@path` 字面量；可选结构化 `mentions: string[]` 供后续扩展（v1 可不强制改 Agent 协议）  
5. i18n 全覆盖新文案  

## 3. 非目标（v1）

- 发送前自动读入全文/摘要（策略 B/C）  
- `@` 引用非 md / 文件夹 / 多选批量（可后续）  
- 替换现有图片附件系统  
- 大改 Prompt / 强制 tool call（模型自行决定是否 `read_note`）

---

## 4. 详细设计

### 4.1 路径约定

- 一律 **vault 相对路径**，正斜杠，如 `Work/Diary/2026-05-15.md`  
- 与 `read_note` / `VaultPort` 一致；不用绝对路径、不用 `file://`  
- 显示名可用 basename，chip 的 data 存完整相对路径  

### 4.2 `@` 语法

| 规则 | 说明 |
|---|---|
| 触发 | 输入 `@` 打开笔记补全（模糊匹配 path/basename） |
| 确认 | 选中或文件菜单插入 → 变成 chip，底层 token 如 `@[[path]]` 或零宽标记 + 平行数组（实现择一，需可序列化进发送文本） |
| 删除 | Backspace 删整 chip；或 chip 上 × |
| 冲突 | `@` 出现在代码块/行内代码时不触发（v1 可简化：仅 plain 输入区） |

推荐落盘文本形态（便于策略 A 与日志可读）：

```
请根据 @Work/foo.md 总结要点
```

解析器提取 `mentions = ['Work/foo.md']`；UI 把该 span 画成 tag。

### 4.3 `/` 指令（保持并纳入同一层）

- 现有：必须以 `/` 开头、无空格时弹出 `SlashMenu`  
- 解析层：发送或确认时若整段匹配已知命令 → 走命令 handler，不发 LLM  
- 文档化：`/` = 本地控制面；`@` = 文档指称  

### 4.4 文件菜单

```
registerEvent(app.workspace.on('file-menu', (menu, file) => {
  if (!(file instanceof TFile) || file.extension !== 'md') return;
  menu.addItem(item => item.setTitle(t('…')).onClick(() => insertMention(file.path)));
}));
```

- 未打开 Chat 时：先 `activateChatView()` 再插入  
- 已打开：聚焦输入框并 append  

### 4.5 发送策略 A（已定）

- 发给 Agent 的 user message **保留** `@path` 文本  
- 系统提示可补一句（可选，v1 可省略）：「用户用 @path 点名笔记时，优先 read_note(path)」  
- **不**在发送前自动 `readFile`  

### 4.6 模块建议

| 模块 | 职责 |
|---|---|
| `src/ui/chat/input/mention-parser.ts` | 纯函数：从文本提取/替换 mentions |
| `src/ui/chat/input/MentionMenu.svelte` | `@` 补全（可对标 SlashMenu） |
| `src/ui/chat/input/ChatInput.svelte`（或现有输入组件） | chip 渲染 + 与 / 菜单互斥 |
| `src/main.ts` | `file-menu` 注册 |

---

## 5. 验收

1. 右键 md → 添加到 Ratel → 输入框出现高亮 `@…` tag，path 正确  
2. 输入 `@` 可补全并插入  
3. 发送后消息气泡可见 `@path`；Agent 能据此调用 `read_note`（不保证每次，但路径可读）  
4. `/new` 等斜杠行为不回归  
5. 中英 i18n  

---

## 6. 影响面

- Chat 输入 UI、i18n、main 菜单注册  
- 可能轻量改 user-guide「怎么问」  
- 不改索引 / Worker  

---

## 7. 参考

- `src/ui/chat/input/slash-commands.ts`  
- `get_active_note` / `read_note` 路径约定  
- 用户决策：发送策略 A；与索引修复分拆为独立 spec

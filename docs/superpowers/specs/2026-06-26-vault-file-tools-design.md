# S-VAULT-TOOLS — Vault 基础文件操作工具集(grep/glob/list/write/append/edit/delete)

- **Spec ID**: S-VAULT-TOOLS
- **状态**: Active
- **创建日期**: 2026-06-26
- **所属**: 知识库管理能力补齐(独立于 RAG 流水线)

---

## 1. 背景

当前 Ratel Vault 插件暴露给 LLM 的工具只有 2 个:

- `search_vault` — 语义搜索(向量 + BM25 混合搜索),擅长找"意思相近"的内容
- `read_note` — 读取单个笔记全文

用户在测试中遇到典型痛点:搜"死"字想找所有包含该汉字的文件,但语义搜索返回的是"死亡、结束"等语义相关段落,无法满足**精确字符串/正则匹配**需求。Agent 自己在回答中也承认"这是工具的局限",需要 grep 类工具。

同时,Agent 只能读不能写,无法完成"帮我在 daily note 后面追加一条记录""新建一个 meeting note""把笔记里的 X 改成 Y"等知识库管理任务,限制了作为 Obsidian 知识库管理助手的实用性。

### 运行时能力确认

Obsidian 桌面版插件运行在 **Electron renderer 进程**,拥有完整 Node.js API 能力:

- ✅ `Vault.create/read/modify/append/delete/rename/trash` 等完整 CRUD API
- ✅ Node.js `fs` / `path` / `worker_threads` 等原生模块可用(项目已在用)
- ✅ 网络请求可用(已用于 LLM/Embedding API)
- ❌ 移动端不支持(`isDesktopOnly: true`,因 Worker Threads 与 Node API)
- ❌ 不引入外部二进制(如 ripgrep),违反"无原生模块"约束

**文件读取架构**:现有架构中 Worker 不直接读 md 文件,文件内容由主线程通过 `ObsidianVault`(走 `app.vault` API)读取后传入 Worker。grep 操作在主线程完成,走 Obsidian API,与现有架构一致。

---

## 2. 目标

补齐 LLM 操作 Obsidian vault 的基础工具集,覆盖三类能力:

1. **发现类(只读)**:grep(全文精确搜索)、glob(文件名模式匹配)、list_files(列目录)
2. **写入类**:write_note(创建/覆盖)、append_note(追加)、edit_note(精确替换)
3. **管理类**:delete_note(移到回收站)

让 Agent 能:
- 精确搜索关键词/正则(弥补语义搜索的盲区)
- 按文件名模式查找文件(如"找所有 daily note")
- 浏览目录结构
- 创建、修改、追加、删除笔记
- 精确替换文件中的特定文本

---

## 3. 非目标

以下明确不做(可后续独立 spec 覆盖):

- **move_note / rename_note**:YAGNI,底层 `fileManager.renameFile` API 已就绪,后续按需加
- **create_folder**:write_note 自动建父目录(ObsidianVault.writeFile 已实现),无需单独工具
- **批量操作**:如"批量替换所有文件中的 X",LLM 可通过多次调工具实现,不需要专门批处理工具
- **附件操作(图片/PDF)**:当前只处理 Markdown 文件,附件读写留后续
- **undo/历史版本**:Obsidian 有文件恢复功能,工具层不做版本管理
- **子进程调用(ripgrep 等)**:违反"无原生模块"约束,用 JS 正则实现
- **选区/光标编辑工具**:如 get_selection / replace_selection / insert_at_cursor,涉及编辑器焦点管理,属于 UI 交互范畴,留独立 spec

---

## 4. 详细设计

### 4.1 工具清单总览

| 工具名 | 类型 | readOnly | 底层 Obsidian API | 说明 |
|--------|------|----------|-------------------|------|
| `grep` | 发现 | ✅ true | `vault.cachedRead()` + JS RegExp | 正则/字面量全文搜索 |
| `glob` | 发现 | ✅ true | `vault.getMarkdownFiles()` + 自写 globToRegex | 按文件名模式匹配 |
| `list_files` | 发现 | ✅ true | `vault.adapter.list()` | 列出目录内容 |
| `write_note` | 写入 | ❌ false | `vault.create()` / `vault.modify()` | 创建或覆盖笔记 |
| `append_note` | 写入 | ❌ false | `vault.append()` | 追加内容到笔记末尾 |
| `edit_note` | 写入 | ❌ false | `vault.process()` | 精确替换(原子操作) |
| `delete_note` | 管理 | ❌ false | `vault.trash()` | 移到回收站(可恢复) |

### 4.2 VaultPort 扩展

在现有 [vault.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/ports/vault.ts) 接口上新增方法:

```typescript
export interface VaultPort {
  // --- 现有方法保留 ---
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  getBacklinks(path: string): Map<string, number>;
  getMetadata(path: string): VaultMetadata | null;
  listMarkdownFiles(): string[];

  // --- 新增方法 ---

  /**
   * 追加内容到文件末尾。文件不存在则创建。
   */
  appendFile(path: string, content: string): Promise<void>;

  /**
   * 将文件移到回收站(优先系统回收站,失败用本地 .trash)。
   */
  trashFile(path: string): Promise<void>;

  /**
   * 列出目录内容(非递归)。
   * @param dir - vault 相对路径,传空串或 '/' 表示根目录
   * @returns { files: 文件名[], folders: 文件夹名[] }
   */
  listFiles(dir?: string): Promise<{ files: string[]; folders: string[] }>;

  /**
   * 检查文件是否存在。
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * 原子读-改-写:读取文件内容,传入 fn 转换,写回结果。
   * 封装 Obsidian `vault.process(TFile, fn)` 的原子操作,避免读写竞态。
   * @returns 写入后的新内容
   */
  processFile(path: string, fn: (content: string) => string): Promise<string>;
}
```

grep 和 glob 作为**工具层逻辑**实现(组合 listFiles + readFile + 正则匹配),不作为 VaultPort 的方法。理由:grep/glob 是复合操作,不是对 Obsidian API 的简单包装,放工具层更符合端口的简洁性原则。

### 4.3 ObsidianVault 适配器实现

[obsidian-vault.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/obsidian-vault.ts) 新增方法实现:

```typescript
async appendFile(path: string, content: string): Promise<void> {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    await this.app.vault.append(file, content);
  } else {
    // 文件不存在时,create 会自动建父目录
    await this.app.vault.create(path, content);
  }
}

async trashFile(path: string): Promise<void> {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error(`File not found: ${path}`);
  // 优先系统回收站,失败时降级到本地 .trash
  try {
    await this.app.vault.trash(file, true);
  } catch {
    await this.app.vault.trash(file, false);
  }
}

async listFiles(dir: string = ''): Promise<{ files: string[]; folders: string[] }> {
  const result = await this.app.vault.adapter.list(dir);
  return { files: result.files, folders: result.folders };
}

async fileExists(path: string): Promise<boolean> {
  return this.app.vault.adapter.exists(path);
}

async processFile(path: string, fn: (content: string) => string): Promise<string> {
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${path}`);
  return this.app.vault.process(file, fn);
}
```

同时需要在 writeFile 中补充 `fileExists` 检查以区分 create/modify 路径,现有实现用 `instanceof TFile` 判断,已正确处理。

### 4.4 grep 工具

**文件**: `src/tools/grep.ts`

**参数**:
```typescript
{
  pattern: string;        // 搜索模式(正则或字面量)
  is_regex?: boolean;     // 默认 true;false 时转义为字面量匹配
  include?: string;       // glob 过滤文件,如 "*.md"、"daily/*.md",默认 "*.md"
  path?: string;          // 限定搜索目录(相对 vault 根),默认整个 vault
  ignore_case?: boolean;  // 默认 true
  context_lines?: number; // 前后上下文行数,默认 2
  max_results?: number;   // 最大匹配数,默认 50
}
```

**返回格式**:
```typescript
Array<{
  file: string;           // 文件路径(相对 vault 根)
  line: number;           // 行号(1-based)
  column: number;         // 列号(1-based)
  match: string;          // 匹配到的行文本(trim 后)
  before: string[];       // 前 N 行上下文
  after: string[];        // 后 N 行上下文
}>
```

**实现要点**:
1. 获取候选文件列表:用 `vault.listMarkdownFiles()` 得到所有 .md 文件,再用 include glob 过滤
2. 始终排除 `.obsidian/` 和 `.trash/` 目录下的文件(插件配置和回收站不应被搜索)
3. 如指定 path,过滤为该目录下的文件(path 作为目录前缀匹配)
4. 逐文件 `vault.cachedRead(file)` 读取内容(利用 Obsidian 缓存,性能好)
5. 按 `\n` 分行,逐行正则匹配
6. 收集前后 N 行上下文
7. 达到 max_results 时提前终止

**性能考量**:
- 千级文件的 vault,逐文件 cachedRead + 正则匹配在 ms~百 ms 级,不阻塞 UI
- 使用 `cachedRead` 而非 `read`,利用 Obsidian 文件缓存避免重复磁盘 IO
- 大文件(>500KB)可考虑跳过或截断,初版先不做特殊处理

**is_regex=false 时的转义**:使用标准正则转义,将 pattern 中的特殊字符(`.*+?^${}()|[]\`)前加反斜杠。

### 4.5 glob 工具

**文件**: `src/tools/glob.ts`

**参数**:
```typescript
{
  pattern: string;  // glob 模式,如 "*.md"、"daily/*.md"、"**/*.project.md"
  path?: string;    // 限定搜索目录,默认整个 vault
}
```

**返回**: `string[]`(匹配的文件路径数组,均为 .md 文件)

**范围**:只匹配 Markdown 文件(基于 `vault.getMarkdownFiles()`)。非 md 文件(图片、PDF 等)不在搜索范围内。

**glob 模式支持**(子集,够用即可):
- `*` — 匹配单层内任意字符(不含 `/`)
- `**` — 匹配任意多层目录
- `?` — 匹配单个字符(不含 `/`)
- `{a,b}` — 匹配 a 或 b(初版可简化不做)

实现一个轻量 `globToRegex` 函数(约 30 行),不引入第三方依赖。用 `vault.getMarkdownFiles()` 获取所有 md 文件后过滤。

### 4.6 list_files 工具

**文件**: `src/tools/list-files.ts`

**参数**:
```typescript
{
  path?: string;  // 目录路径(相对 vault 根),默认根目录
}
```

**返回**:
```typescript
{
  path: string;         // 实际列出的目录路径(echo 输入的 path 参数,便于 LLM 拼接)
  files: string[];      // 文件名列表(短名,不含路径前缀)
  folders: string[];    // 子目录名列表(短名,不含路径前缀)
}
```

直接调用 `vault.listFiles(path)`。返回的 files/folders 是相对于 path 的短名,LLM 需要拼接 path + "/" + name 得到完整路径。

### 4.7 write_note 工具

**文件**: `src/tools/write-note.ts`

**参数**:
```typescript
{
  path: string;    // 目标文件路径(相对 vault 根)
  content: string; // 完整文件内容
}
```

**返回**: `{ path: string; created: boolean }`(created=true 表示新建,false 表示覆盖)

实现逻辑:先用 `vault.fileExists(path)` 判断,再调 `vault.writeFile(path, content)`,返回是否新建。writeFile 已实现自动建父目录。

### 4.8 append_note 工具

**文件**: `src/tools/append-note.ts`

**参数**:
```typescript
{
  path: string;    // 目标文件路径
  content: string; // 要追加的内容(建议自带换行符)
}
```

**返回**: `{ path: string; created: boolean }`

调 `vault.appendFile(path, content)`,文件不存在时 appendFile 内部会创建。

### 4.9 edit_note 工具(精确替换)

**文件**: `src/tools/edit-note.ts`

**参数**:
```typescript
{
  path: string;        // 目标文件路径
  old_string: string;  // 要替换的文本(必须在文件中唯一且精确匹配,含空白缩进)
  new_string: string;  // 替换后的文本
}
```

**返回**: `{ path: string; replaced: boolean }`

**实现要点**:
1. 先用 `vault.fileExists(path)` 检查文件是否存在,不存在返回明确错误
2. 读取全文(用 `vault.readFile` 而非 `cachedRead`,因为后续要修改)
3. 统计 old_string 在文件中出现次数:
   - 0 次:返回错误"未找到要替换的文本,请确认 old_string 精确匹配(含空白缩进)"
   - 1 次:执行替换
   - 多次:返回错误"old_string 在文件中出现多次(共 N 次),请提供更多上下文(前后各 3-5 行)以唯一确定"
4. 用 `vault.processFile(path, fn)` 执行原子替换(fn 中做 string replace),避免读写间竞态
5. 替换成功后返回 `{ path, replaced: true }`

**安全设计**:old_string 必须唯一匹配的要求参考 Claude Code Edit 工具设计,防止误替换。错误消息中明确告诉 LLM 需要提供更多上下文(前后各 3-5 行)。

### 4.10 delete_note 工具

**文件**: `src/tools/delete-note.ts`

**参数**:
```typescript
{
  path: string;  // 要删除的文件路径
}
```

**返回**: `{ path: string; trashed: true }`

使用 `vault.trashFile(path)`,优先系统回收站(可恢复),失败时降级到 Obsidian 本地 `.trash` 文件夹。不使用 `vault.delete()`(不可恢复)。

### 4.11 工具注册(`src/main.ts` 修改)

在现有工具注册处新增 7 个工具:

```typescript
this.tools.register(createReadNoteTool(this.vault));
this.tools.register(createSearchVaultTool(multiQuerySearcher, () => this.readyForSearch()));
// 新增:
this.tools.register(createGrepTool(this.vault));
this.tools.register(createGlobTool(this.vault));
this.tools.register(createListFilesTool(this.vault));
this.tools.register(createWriteNoteTool(this.vault));
this.tools.register(createAppendNoteTool(this.vault));
this.tools.register(createEditNoteTool(this.vault));
this.tools.register(createDeleteNoteTool(this.vault));
```

### 4.12 工具 readOnly 标记与 Hooks

写入工具(write_note / append_note / edit_note / delete_note)标记 `readOnly: false`,触发现有 hooks 机制(知识治理钩子)。发现类工具标记 `readOnly: true`,跳过 hooks。

写入操作触发 Obsidian 的 `modify`/`create`/`delete` 事件,现有文件监控+去抖+增量索引流水线会自动处理向量索引更新,工具层无需额外操作。

### 4.13 系统提示词更新

RAG_PROMPT 中补充工具使用指引(让 LLM 知道何时用 grep 而非 search_vault):

```
You have access to these vault tools:
- search_vault: Semantic search (vector + BM25). Best for finding conceptually related content.
- grep: Exact text/regex search across all notes. Best for finding exact strings, code patterns, specific words.
- glob: Find files by name pattern (e.g. "daily/*.md").
- list_files: List contents of a directory.
- read_note: Read the full content of a note.
- write_note: Create or overwrite a note.
- append_note: Append content to the end of a note.
- edit_note: Precisely replace text in a note (old_string must match exactly and uniquely).
- delete_note: Move a note to the trash (recoverable).

When to use grep vs search_vault:
- Use grep when the user asks about specific words, exact strings, regex patterns, or "find all files containing X"
- Use search_vault when the user asks about topics, concepts, or semantically related content
- When unsure, try search_vault first; if results don't contain the exact term, follow up with grep
```

---

## 5. 影响面

### 5.1 新建文件

| 文件 | 职责 |
|------|------|
| `src/tools/grep.ts` | grep 工具 |
| `src/tools/glob.ts` | glob 工具 |
| `src/tools/list-files.ts` | list_files 工具 |
| `src/tools/write-note.ts` | write_note 工具 |
| `src/tools/append-note.ts` | append_note 工具 |
| `src/tools/edit-note.ts` | edit_note 工具 |
| `src/tools/delete-note.ts` | delete_note 工具 |
| `src/utils/glob-to-regex.ts` | glob 模式转正则(纯函数,供 grep/glob 复用) |
| `src/utils/path-safety.ts` | validateVaultPath 路径沙箱函数(第 8.1 节) |
| `src/ui/confirm-modal.ts` | 工具执行确认对话框(第 8.3 节,Obsidian Modal) |
| `tests/utils/path-safety.test.ts` | 路径校验测试(越界/绝对路径/.obsidian/..穿越) |
| `tests/utils/glob-to-regex.test.ts` | glob 模式测试 |
| `tests/tools/grep.test.ts` | grep 工具测试 |
| `tests/tools/glob.test.ts` | glob 工具测试 |
| `tests/tools/edit-note.test.ts` | edit_note 工具测试(重点测"多次匹配报错"逻辑) |
| `tests/core/hooks.test.ts` | HookRegistry 阻断机制测试 |

### 5.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/ports/vault.ts` | 新增 appendFile / trashFile / listFiles / fileExists / processFile 方法 |
| `src/adapters/obsidian-vault.ts` | 实现上述 5 个新方法 + 每个方法入口调 validateVaultPath |
| `src/core/hooks.ts` | HookResult 类型 + run() 返回 HookDecision 支持阻断;阶段名统一为 pre-tool-use/post-tool-use/post-tool-failure |
| `src/core/agent-loop.ts` | 所有工具调用前走 pre-tool-use hook(含权限检查+路径校验),调用后走 post-tool-use hook;失败走 post-tool-failure |
| `src/settings.ts` | 新增 toolPermissions / trustMode 配置项 + 「工具权限」设置 UI 分组 |
| `src/main.ts` | 注册 7 个新工具 + 注册内置路径安全 hook;设置变更时重建相关组件 |
| `src/core/context-manager.ts` | RAG_PROMPT 补充工具使用指引(grep vs search_vault) |

### 5.3 不需要修改的文件

- Worker 相关文件(handler.ts / index-processor.ts / manager.ts / inline-worker.ts):grep 在主线程做,不涉及 Worker
- VectraStore / 向量索引相关:grep 是独立于向量搜索的新能力
- UI 文件:工具调用结果由 Agent Loop 正常处理,不需要新的 UI 卡片(search_vault 的 search.result 卡片已有,grep 不需要)

---

## 6. 测试策略

| 组件 | 测试文件 | 测试要点 |
|------|----------|----------|
| globToRegex | `tests/utils/glob-to-regex.test.ts` | `*.md` 匹配根目录 md;`**/*.md` 递归匹配;`daily/*.md` 匹配子目录;边界用例 |
| path-safety | `tests/utils/path-safety.test.ts` | 正常路径放行;`../`穿越拒绝;绝对路径拒绝;`.obsidian/`拒绝;`.trash/`拒绝;空路径拒绝;normalizePath 已处理 .. 时仍二次检查 |
| grep 工具 | `tests/tools/grep.test.ts` | 正则匹配、字面量匹配、ignore_case、context_lines、max_results 截断、path 限定、include 过滤、空结果、排除 .obsidian |
| glob 工具 | `tests/tools/glob.test.ts` | 各种 glob 模式的匹配正确性;只返回 .md 文件 |
| edit_note 工具 | `tests/tools/edit-note.test.ts` | 正常替换、old_string 不存在报错、old_string 多次匹配报错、空文件处理 |
| write_note / append_note / delete_note | `tests/tools/write-append-delete.test.ts` | 创建新文件、覆盖已存在文件、追加到已有/不存在文件、删除到回收站 |
| list_files 工具 | `tests/tools/list-files.test.ts` | 根目录列表、子目录列表、空目录、返回 path echo |
| HookRegistry | `tests/core/hooks.test.ts` | 空 hook 放行;单个 deny 阻断;多个 hook 按序执行;deny 后停止后续 hook;hook 抛错不阻断;pre-tool-use/post-tool-use 阶段隔离 |
| VaultPort 新方法 | `tests/adapters/obsidian-vault.test.ts` | 用 mock App 验证正确调用 Obsidian API + validateVaultPath 被调用 |
| 权限检查 | `tests/core/tool-permissions.test.ts`(新文件) | allow/ask/deny 三态;trustMode 覆盖;ask 弹确认后允许/拒绝;会话级临时 allow |

测试全部使用 mock VaultPort,无需启动 Obsidian 环境。

---

## 7. 性能考量

- **grep 性能**:千级文件 vault,cachedRead + JS 正则在 100-500ms 内完成(取决于文件总大小)。max_results=50 提供早退机制
- **glob 性能**:纯文件名匹配,从 `getMarkdownFiles()` 返回数组过滤,O(N) N=文件数,μs 级
- **list_files 性能**:直接委托 `vault.adapter.list()`,Obsidian 内部有缓存
- **写入性能**:所有写入走 Obsidian API,Obsidian 内部处理文件 IO + 元数据缓存更新 + 事件派发
- **不阻塞 UI**:grep 是 async 函数,使用 cachedRead(Promise-based),不会阻塞主线程;vault 大小在万级文件以下时单次 grep 不会有明显卡顿
- **增量索引自动触发**:写入操作触发 Obsidian modify/create/delete 事件 → 现有去抖+增量索引流水线自动更新向量索引

---

## 8. 安全设计:三层防御

参考 Claude Code 的 `PreToolUse` 可阻断 hook + `permissions` allow/ask/deny 三态模型,结合 Obsidian 插件运行时特性,设计三层防御体系,确保所有文件操作严格限制在 vault 范围内且用户可控。

### 8.1 第 1 层:Adapter 路径沙箱(硬性约束,始终启用)

**文件**: `src/utils/path-safety.ts`(新建) + `src/adapters/obsidian-vault.ts`(修改)

所有经过 VaultPort 的路径(读/写/追加/删除/list)在操作前**必须**通过 `validateVaultPath()` 校验。这是最后一道防线,即使 hook 被绕过、LLM 构造恶意路径,adapter 也会拒绝。

**`validateVaultPath(path)` 逻辑**:

```typescript
/**
 * 校验路径是否在 vault 安全范围内,返回归一化后的路径。
 * @throws 路径越界时抛错
 */
function validateVaultPath(path: string): string {
  // 1. 空路径直接拒绝
  if (!path || typeof path !== 'string') throw new Error('路径不能为空');

  // 2. 使用 Obsidian 内置 normalizePath 归一化(处理 .. / . / 多余斜杠 / 反斜杠)
  const normalized = normalizePath(path);

  // 3. 禁止绝对路径(normalizePath 不会生成以 / 开头的路径,但做二次确认)
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`路径越界:不允许绝对路径 "${path}"`);
  }

  // 4. normalizePath 应该已解析 .. 但做二次确认
  if (normalized.includes('..')) {
    throw new Error(`路径越界:禁止使用 ".." 穿越 "${path}"`);
  }

  // 5. 禁止访问 .obsidian/ 目录(插件配置)
  if (normalized === '.obsidian' || normalized.startsWith('.obsidian/')) {
    throw new Error(`路径越界:不允许访问 .obsidian 配置目录 "${path}"`);
  }

  // 6. 禁止访问 .trash/ 目录(回收站)
  if (normalized === '.trash' || normalized.startsWith('.trash/')) {
    throw new Error(`路径越界:不允许访问 .trash 回收站 "${path}"`);
  }

  return normalized;
}
```

ObsidianVault 的每个方法入口(`readFile`/`writeFile`/`appendFile`/`trashFile`/`processFile`)开头先调 `validateVaultPath(path)`,通过后再执行。`listFiles` 对 dir 参数也做同样校验。`listMarkdownFiles()` 返回的路径已经是 vault 内部的,不需要再校验。

**为什么不用 Node.js path.resolve + 比较前缀**:ObsidianVault 使用 `app.vault` API 而非 Node fs,路径是 vault 相对的,normalizePath 是 Obsidian 内置的路径归一化函数,天然适配 vault 语义(它把反斜杠转正斜杠、解析 `.` 和 `..`、去掉开头的 `/`、压缩重复斜杠)。

### 8.2 第 2 层:Hook 系统升级支持阻断(治理扩展点)

**文件**: `src/core/hooks.ts`(修改) + `src/core/agent-loop.ts`(修改)

现有 `HookRegistry` 的 hook 签名是 `() => Promise<void>`,返回 void 意味着无法阻断操作。参考 Claude Code PreToolUse 可阻断模型,升级为:

```typescript
/**
 * Hook 执行结果。
 * - void / undefined:放行(无意见)
 * - { allow: false, reason: string }:阻断,throw Error(reason)
 * - { allow: true }:显式放行
 */
export type HookResult = { allow: boolean; reason?: string } | void;
```

**HookRegistry.run 改造**:
- hook handler 签名改为 `(toolCall: ToolCall) => Promise<HookResult>`
- 串行执行所有 hook,任一返回 `{ allow: false }` 则立即停止并返回阻断结果
- hook 抛错时仍吞掉并记录(不阻断),但 hook 显式返回 deny 则阻断
- 新增 `HookDecision` 返回值:

```typescript
interface HookDecision {
  allowed: boolean;
  deniedBy?: string;    // 哪个 hook 阻断的
  reason?: string;      // 阻断原因
}

async run(phase: string, toolCall: ToolCall): Promise<HookDecision>;
```

**Agent Loop 改造**(在现有 pre-write hook 位置):
- 执行工具前,调用 `hooks.run('pre-tool-use', toolCall)`(所有工具都走,不仅是写工具)
- 如果 `decision.allowed === false`,throw Error 返回给 LLM:`工具调用被拒绝: {reason}`
- 工具执行后调用 `hooks.run('post-tool-use', toolCall)`(不阻断,只做审计/通知)
- 废弃原来的 `pre-write`/`post-write` phase 名,统一为 `pre-tool-use`/`post-tool-use`(与 Claude Code 对齐)
- 内置注册一个"路径安全 hook"(pre-tool-use),从 toolCall.args 中提取 path 参数,调 `validateVaultPath` 校验。这是对第 1 层的冗余防御(adapter 层已校验,但 hook 层在到达 adapter 前就拦截,错误信息更友好)

**Hook 阶段扩展**(对齐 Claude Code,但只实现我们需要的):
- `pre-tool-use`:工具执行前,可阻断
- `post-tool-use`:工具执行成功后,不阻断(用于审计/通知/自动格式化)
- `post-tool-failure`:工具执行失败后(新增,用于错误审计)

### 8.3 第 3 层:工具权限配置(用户可控)

**文件**: `src/settings.ts`(修改) + 新增设置 UI

参考 Claude Code 的 `permissions.allow/deny` 模型,在设置面板新增「工具权限」分组,为每个工具配置三态:

| 权限模式 | 行为 |
|----------|------|
| **allow**(允许) | 工具可直接执行,无需确认 |
| **ask**(确认) | 执行前弹 Modal 对话框,用户点"允许"才执行,"拒绝"则返回错误给 LLM |
| **deny**(拒绝) | 工具直接返回错误"该工具已被禁用",不执行 |

**默认值**(开箱即用,安全):

| 工具 | 默认权限 | 理由 |
|------|----------|------|
| search_vault | allow | 只读,无副作用 |
| read_note | allow | 只读,无副作用 |
| grep | allow | 只读,无副作用 |
| glob | allow | 只读,无副作用 |
| list_files | allow | 只读,无副作用 |
| write_note | ask | 写入操作,默认需确认 |
| append_note | ask | 写入操作,默认需确认 |
| edit_note | ask | 写入操作,默认需确认 |
| delete_note | ask | 删除操作,默认需确认 |

**Settings 配置项新增**:

```typescript
export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface RatelVaultSettings {
  // ... 现有字段 ...

  // 工具权限控制(第 8.3 节)
  toolPermissions: Record<string, ToolPermission>;
  // 信任模式:开启后所有工具默认 allow,跳过确认对话框(相当于全局 allow)
  trustMode: boolean;
}
```

**默认值**:
```typescript
toolPermissions: {
  search_vault: 'allow',
  read_note: 'allow',
  grep: 'allow',
  glob: 'allow',
  list_files: 'allow',
  write_note: 'ask',
  append_note: 'ask',
  edit_note: 'ask',
  delete_note: 'ask',
},
trustMode: false,
```

**Settings UI** 新增「工具权限」分组(在「开发者」分组之前):
- 一个"信任模式"总开关(toggle):开启后全部工具 allow,不弹确认(适合信任 AI 的高级用户)
- trustMode 关闭时,逐个工具展示下拉框:允许/询问/拒绝
- 只读工具组(search_vault/read_note/grep/glob/list_files)默认收起或标注"只读",用户可改但一般不需要
- 写入工具组(write_note/append_note/edit_note/delete_note)默认展开

**确认对话框实现**:新增 `src/ui/confirm-modal.ts`(Svelte Component 或原生 Obsidian Modal),展示:
- 工具名(如"write_note")
- 目标路径
- 操作摘要(如"创建笔记 notes/meeting.md")
- 三个按钮:"允许"、"允许(本次会话不再询问)"、"拒绝"
- "允许(本次会话不再询问)"在当前会话内存中把对应工具+路径对记为 allow,不持久化到 settings

**权限决策逻辑**(Agent Loop 中工具执行前):
```
if trustMode → 放行
if toolPermissions[toolName] === 'allow' → 放行
if toolPermissions[toolName] === 'deny' → 拒绝,返回错误
if toolPermissions[toolName] === 'ask' → 弹确认对话框,等待用户选择
```

### 8.4 工具层参数校验(LLM 友好)

每个工具在 execute 入口做基础参数校验:
- path 必须是非空字符串
- content(写入内容)必须是 string(允许空串,创建空文件)
- pattern(grep/glob)必须是非空字符串
- 校验失败返回明确的中文错误信息(如"path 参数必须是字符串,收到:number"),帮助 LLM 自纠

### 8.5 安全设计总结

```
LLM 工具调用
  ↓
[8.4 工具层参数校验]  ← 参数类型/非空检查,LLM 友好错误
  ↓
[8.3 权限配置]  ← allow/ask/deny + 确认对话框,用户可控
  ↓
[8.2 pre-tool-use hook]  ← 路径校验 hook + 可扩展治理钩子
  ↓
[8.1 Adapter 路径沙箱]  ← validateVaultPath 强制校验,最后防线
  ↓
执行 Obsidian API 操作
  ↓
[8.2 post-tool-use hook]  ← 审计/通知
```

每一层都独立起作用:
- 即使上层都被绕过,adapter 层的 validateVaultPath 会拒绝越界路径
- 即使 adapter 层有 bug,hook 层和权限层也提供了深度防御
- 用户可通过 settings 面板完全控制每个工具的权限

### 8.6 隐私

- **无新增网络调用**:所有工具都是 vault 本地操作
- **无数据收集**:工具调用不上传到任何服务器
- **审计日志**(可选,留后续):post-tool-use hook 可将写操作记录到本地日志文件,默认关闭

---

## 9. 参考

- [Claude Code Tool 设计](https://juejin.cn/post/7507991734794911782) — GrepTool/GlobTool/Edit/Replace 的参数与行为参考
- [Coding Agent 核心机制解析](https://juejin.cn/post/7597258378591617034) — 文件工具集分层模式(read/list/glob/grep/write/edit/delete)
- [Obsidian API Vault 类](file:///Users/golddream/code/git-public/Ratel-CLI/node_modules/obsidian/obsidian.d.ts#L7321-L7578) — 可用文件操作 API 清单
- [ObsidianVault 现有实现](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/obsidian-vault.ts) — 适配器模式参考
- [现有工具 read-note.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/tools/read-note.ts) — 工具实现模式参考
- [现有工具 search-vault.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/tools/search-vault.ts) — 工具实现模式参考

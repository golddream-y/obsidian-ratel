# Ratel 下一步进化:图谱原生 Agent(S-EVOLUTION)

> 日期: 2026-07-15  
> 状态: **Terminated(2026-08-19 部分完成后终止归档)**  
> 终止原因: Phase A 读侧 + open_note + 回收站语义已发版(核心价值交付);任务机制摘出 S-TASK、子代理模板化移出(依赖不存在);写侧三件套(update_frontmatter / Write Gate / append_to_daily)未实施,重启时开轻量 spec 单独立项。详见 archive/S-EVOLUTION/execution-log.md  
> 作者: Erwin(0.1.6 发版后,对「合格 Agent × Obsidian 知识系统」的系统性缺口分析)  
> 关联: S-BASIC-ENV(已归档,Phase 3 缺口在此收编)、S-SKILL(Phase D 执行层,独立推进)、S-RAG-ARCH(检索管线基座)

---

## 1. 背景

0.1.6 已具备:Agent Loop + 21 个工具、本地 ONNX RAG + 引用、环境感知(时间/活动笔记/日记/大纲)、记忆、Skill 发现层、权限 + Keychain。定位上已与「纯聊天插件」和「外挂 coding CLI」区分开。

但对照「合格 Agent」与「最适合 Obsidian 的知识系统」两条标尺,仍有三类系统性缺口:

1. **结构盲区** — Agent 只会「语义搜 + 读文件」,看不见 Obsidian 免费维护的链接图、tag、frontmatter、未解析链接。而 `metadataCache` 是实时、毫秒级、零索引成本的知识图谱,是本插件相对通用 RAG 方案的最大杠杆。
2. **写入信任缺口** — 有 per-tool ask/deny,但缺统一 diff 预览、批量操作预检、失败回滚。Obsidian 用户对「AI 改我的库」极度敏感,这是采纳率门槛而非锦上添花。
3. **长任务不闭环** — 多步任务无显式计划、无落盘、插件重载(Electron 生命周期)即丢失;对话产出也缺少「回流到库」的一等公民通道。

### 边界约束(Electron / Obsidian 运行时)

| 约束 | 设计含义 |
|---|---|
| 单渲染进程,主线程 = UI | CPU 重活留 Worker;禁止主线程同步扫全库的新功能 |
| 无原生模块、无子进程 | 不做任意 shell;扩展执行只能是受控 JS 沙箱(S-SKILL 范畴) |
| `isDesktopOnly`(fs/vectra) | 本 spec 的 Phase A 工具全部**不依赖 fs**,为未来移动端降级留口子,但不为其付出当前成本 |
| 插件随 Obsidian 重载 | 长任务状态必须落盘、可恢复,不能是纯内存态 |
| 网络仅模型 API(已由 [ADR-014](../../adr/2026-08-03-mcp-host-platform.md) 修订) | 本 spec 不做联网搜索/爬虫**内置**工具;网页搜索等外联能力走 MCP(opt-in,配置后才出站) |

### 杠杆(Obsidian 独有优势)

- `metadataCache`:`resolvedLinks` / `unresolvedLinks` / frontmatter / headings / tags / blocks——实时且免费
- 双链语义:反链 =「谁引用这个概念」;未解析链接 =「用户想要但还不存在的笔记」(知识缺口信号)
- frontmatter = 库的类型系统;Daily Notes / Templates = 用户工作流锚点
- `Workspace` API:Agent 可「带用户去看」(打开/跳转),而不只是贴引用
- `fileManager.processFrontMatter`:原子、保格式的属性写入通道

**总纲:向量索引负责「语义模糊」,metadataCache 负责「结构精确」,二者合流 + 可信写入 + 可恢复任务,构成「长在链接图上的知识 Agent」。**

---

## 2. 目标

- **Phase A(结构感知)**:Agent 可按 tag / 属性 / 链接关系精确检索与导航;语义检索结果携带结构信号(反链数、tags);可安全地批量维护 frontmatter。
- **Phase B(行动与信任)**:Agent 可打开/定位笔记;所有写操作有统一 diff 预览与批量确认;删除/覆盖永远可逆(走 `.trash`)。
- **Phase C(任务闭环)**:多步任务有显式 checklist,状态落盘、重载可恢复;对话产出可一键沉淀到日记 / 新笔记;Curator/Librarian 子代理以「结构化任务模板」形态落地。
- 全程遵守既有约束:网络边界以 ADR-014 为准(默认仅模型 API;MCP opt-in)、所有 Obsidian API 走 `ObsidianVault` / `ObsidianWorkspace` 外观、i18n 强制、写操作走权限模型。

## 3. 非目标

- 自建图数据库 / 图索引(`metadataCache` 即图,自建即技术债)
- 任意 shell / 文件系统漫游 / 代码执行(安全与定位双重否决)
- 联网搜索 / fetch_url 内置工具(外联能力由 MCP Host 承接,见 [ADR-014](../../adr/2026-08-03-mcp-host-platform.md) 与 [host/mcp.md](../../architecture/host/mcp.md))
- 移动端支持(本期不做;仅要求 Phase A 工具不依赖 fs)
- Canvas / Bases 深集成(API 未定型,另行评估)
- Skill references/scripts 沙箱与 Skill UI(属 S-SKILL 的 P-SKILL-2/3,不在本 spec)
- `rename_note` 级联改链(风险高,视 Phase B Write Gate 落地效果再评估)

---

## 4. 详细设计

### 4.1 Phase A — 结构感知(Graph-Native Retrieval)

全部只读(除 `update_frontmatter`)、全部走 `metadataCache`、零 Worker 改动、不依赖 fs。

| 人话:什么时候用 | 工具 / 机制 | 它干什么 | 主要入参 | 主要返回 |
|---|---|---|---|---|
| 「谁引用了这篇 / 这篇连向哪」 | **`get_links`** | 给定笔记,返回出链 + 反链 + **未解析链接**(单独标注为知识缺口) | `path` | `outgoing[]` / `backlinks[]` / `unresolved[]` |
| 「找所有 #project/active 的笔记」 | **`search_by_tag`** | tag 精确检索(含嵌套 tag 前缀匹配) | `tag`、`limit?` | `[{ path, tags }]` |
| 「找 status: draft 的笔记」 | **`search_by_property`** | frontmatter 属性过滤(等值 / 存在性) | `key`、`value?`、`limit?` | `[{ path, value }]` |
| 「我的库长什么样 / 有哪些孤儿」 | **`get_vault_structure`** | 文件夹树 + tag 计数 + orphan 清单(可分节请求) | `include?`(folders/tags/orphans) | 结构化概览 |
| 「给这批笔记统一打 tag / 改状态」 | **`update_frontmatter`** | 走 `fileManager.processFrontMatter` 原子写属性,不碰正文 | `path`、`set` / `remove` | 变更前后值 |

**检索管线增强**:`search_vault` 结果的每个 chunk 附带所在笔记的反链数与 tags,作为结构信号供 LLM 判断权威度;并支持「先结构过滤(tag/属性)缩小候选,再语义排序」的交集模式,顺带改善大库检索精度。

**设计决策:**

| # | 决策 | 说明 |
|---|---|---|
| A1 | 不与 `read_note` 重复 | `read_note` 保留单篇视角;`get_links` 面向「未读先看图」与未解析链接场景 |
| A2 | `update_frontmatter` 是唯一属性写通道 | 禁止用 `edit_note` 改 YAML 文本;`processFrontMatter` 原子且保格式 |
| A3 | orphan 定义 | 无反链且无出链的 Markdown 文件;排除模板/附件目录(可配置) |
| A4 | 全部默认 allow(读)/ ask(`update_frontmatter`) | 沿用现有权限模型 |

### 4.2 Phase B — 行动与信任(Act & Trust)

| 能力 | 设计 |
|---|---|
| **`open_note`** | ✅ 已落地(P-CFG,随 0.3.0 发版):`Workspace.openLinkText` + 标题/^block 锚点定位(锚点内嵌 path 自动拆分);readOnly + 默认 allow(纯 UI 导航不改库)。**修订**:原设计的 `split?` 分屏与默认 ask 落地时判定为过度设计——导航无破坏性,ask 反而打断「AI 打开笔记给我看」的核心体验;split? 标记为非目标 |
| **Write Gate(统一写入预览层)** | 工具执行层新增 pending-changes 队列:`write/edit/delete/append/update_frontmatter` 先生成 diff,聚合到「本轮变更」面板(Svelte);单笔操作沿用现有 ask 流,**批量操作(≥ N 笔)强制聚合确认**,一次通过、失败即停并报告已完成部分。不改 Agent Loop 协议,只在 tool 执行前插一层 |
| **回收站语义** | 删除/整篇覆盖一律走 `app.vault.trash`(Obsidian 原生 `.trash`),对用户承诺 every change is reversible |

**设计决策:**

| # | 决策 | 说明 |
|---|---|---|
| B1 | Write Gate 在 tool 层不在 loop 层 | Agent Loop / 消息协议零改动,降低回归面 |
| B2 | 批量阈值可配置 | 默认 ≥3 笔进聚合面板;trust mode 下仍可跳过(尊重现有信任模型) |
| B3 | diff 用现有 Markdown 渲染栈 | 不引入新 diff 库前先用 unified 文本 diff 展示 |

### 4.3 Phase C — 任务闭环(Plan-Execute-Verify)

| 能力 | 设计 |
|---|---|
| **任务机制** | 已摘出为独立 spec [S-TASK](2026-08-19-agent-task-store.md)(task_plan 工具、落盘恢复、GC——通用 Agent 基建,非图谱能力,独立排期) |
| **沉淀通道** | `append_to_daily`(补 `get_daily_note` 的写入端,不存在时按 Daily Notes 插件模板创建,走 Write Gate);chat 消息级「存为笔记」一键操作 |
| **子代理模板化** | **已移出本 spec**(2026-08-19):Curator/Librarian 尚不存在(subagents/ 仅 indexer),且模板化依赖 S-TASK 的 task_plan 机制;移交 S-TASK 消费侧或未来 spec,S-EVOLUTION 以 A-FM + B-GATE + C-SINK 收口 |

**设计决策:**

| # | 决策 | 说明 |
|---|---|---|
| C1 | 任务落盘与索引清单同思路 | JSON 落盘 + 版本字段;损坏即丢弃不崩溃 |
| C2 | 恢复是「提示 + 注入」不是「自动续跑」 | 用户确认后才继续,避免重载后无人监督的写操作 |
| C3 | 子代理不引入新进程/线程 | 仍在主 Agent Loop 内以受约束上下文运行(Electron 无子进程沙箱) |

### 4.4 执行顺序

```
Phase A(P-EVO-A-READ → P-EVO-A-FM) → Phase B → Phase C(沉淀 + 子代理模板)
S-TASK(task 机制)独立排期,不阻塞图谱线;Phase C 子代理模板消费其成果
S-SKILL P-SKILL-2 降优先级,不挡图谱原生落地
```

- A 先于 B:全读操作、零风险、见效最快;且 B 要保护的批量 frontmatter 操作来自 A。
- C 最后:依赖 A 的工具做原料、B 的确认机制做安全网。
- 每 Phase 对应 1-2 个 plan:`P-EVO-A-READ`(已归档)、`P-EVO-A-FM`(`update_frontmatter`)、`P-EVO-B-GATE`、`P-EVO-B-OPEN`、`P-EVO-C-SINK`。task 机制原 `P-EVO-C-TASK` 移交 S-TASK。

---

## 5. 影响面

| 区域 | 影响 |
|---|---|
| `src/adapters/obsidian-vault.ts` / `obsidian-workspace.ts` | 扩展外观:resolvedLinks 反向查询、tag/属性枚举、`processFrontMatter`、`openLinkText`、`vault.trash` |
| `src/tools/` | 新增约 8 个工具文件 + 对应测试;`search_vault` 输出结构增强 |
| `src/core/`(tool 执行层) | Write Gate pending-changes 队列(B);task 状态管理归 S-TASK |
| `src/ui/` | 变更聚合面板(B)、work-bar 任务 checklist(归 S-TASK)、「存为笔记」操作(C) |
| `src/i18n/` | 新增 namespace(工具显示名、面板文案、Notice) |
| 权限模型 | 新工具注册默认权限;不改模型本身 |
| 文档 | ARCHITECTURE(端口契约变更时)、user-guide(新工具与面板)、README(能力清单) |
| **不影响** | Worker / embedding 管线、消息协议、构建产物形态 |

## 6. 参考

- S-BASIC-ENV(archive/S-BASIC-ENV/):Phase 3 预留的 `search_by_tag` / unresolved links 在本 spec Phase A 收编
- S-RAG-ARCH(archive/S-RAG-ARCH/):检索管线;本 spec 的结构信号增强建立其上
- S-SKILL(specs/2026-07-06-skill-mechanism-design.md):Phase D(扩展执行层)归属该 spec
- Obsidian API:`MetadataCache.resolvedLinks/unresolvedLinks`、`FileManager.processFrontMatter`、`Workspace.openLinkText`、`Vault.trash`
- 业界对照:Claude Code(TodoWrite / plan 模式)、Cursor(diff 预览 + 批量确认)的任务与信任机制

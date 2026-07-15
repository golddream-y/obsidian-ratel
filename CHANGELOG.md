# 更新日志 / Changelog

本项目遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
本文件由 AI 从 Conventional Commits 生成草稿,开发者确认后合入。详见[生成规则](docs/superpowers/specs/2026-06-28-docs-system-v1-design.md)。

## [Unreleased]

## [0.1.7] - 2026-07-16

### Added
- **图谱原生 Phase A 读工具** — `get_links`(出链/反链/未解析链接)、`search_by_tag`(嵌套前缀)、`search_by_property`(frontmatter)、`get_vault_structure`(目录/标签计数/orphan)
- **`search_vault` 结构信号** — 结果附带 `tags` 与 `backlinkCount`,便于模型判断权威度
- **VaultPort 图谱查询** — `getLinks` / `findByTag` / `findByProperty` / `getVaultStructure`,全部走 `metadataCache`,不改索引

### Changed
- **对外主张** — README / manifest 立 Graph-native AI agent;toolGuide 与架构文档对齐新工具
- **状态抽屉** — 去掉误导性的「可在设置启用 Worker 线程」红字(Obsidian 渲染进程无法启用 `worker_threads`;Embedding 已在 Web Worker)

## [0.1.6] - 2026-07-15

### Added
- **设置四 Tab** — 对话模型 / 笔记索引 / 记忆与权限 / 高级;`chatPreset`(DeepSeek / Ollama / 自定义);默认对话模型 `deepseek-v4-flash`;钥匙串 checklist 前置
- **`@` 笔记引用** — 输入补全 + chip 条 + 文件菜单「添加到 Ratel」;发送策略 A(只带 `@相对路径`,不预读全文)

### Fixed
- **索引每次重启全量重建** — 清单迁入 `.index/ratel-manifest.json`(兼容旧根目录路径);有索引无清单时只重建 hash,不全量 embed;全量后写真实 mtime/非空 entries
- **DeepSeek 400 孤立 `role:tool`** — `/compact` 保留窗口对齐 + 上送前 `sanitizeToolMessageOrder`
- **设置 Tab 切换无效** — 改用声明式 `visible` + `refreshDomState`(不再依赖 CSS `is-hidden`)
- **对话进行中状态三重叠** — 不再误标 `model:checking`;StatusLine / work-bar / 打字指示去重

### Changed
- README / user-guide 场景与设置速查按 Tab 更新;架构文档同步 settings / vector-index / chat

## [0.1.5] - 2026-07-14

### Added
- **Agent 基础环境感知** — 每轮 `ask()` 注入本地时间(「今天几号」通常无需调工具);新增只读工具 `get_datetime` / `get_active_note` / `get_daily_note` / `list_recent_notes` / `get_note_outline`(工具总数 14→19)
- **WorkspacePort** — 活动 Markdown 文件与编辑器选区与 Vault IO 解耦;`get_note_outline` 走 `metadataCache.headings`,禁止全文正则
- **日记约定设置** — `dailyNoteFolder` / `dailyNoteFormat`(`YYYY-MM-DD`);`get_daily_note` 只探测路径,不自动创建

### Changed
- **README / 使用手册** — 以社区商店安装为主入口;手册改为场景表驱动;架构文档同步 WorkspacePort 与环境工具

## [0.1.4] - 2026-07-14

### Fixed
- **首次安装加载失败** — `loadData()` 返回 `null` 时读 `loaded.toolPermissions` 抛 TypeError;归一成 `{}` 后再合并。`onunload` 对未初始化字段改用可选链,避免卸载二次报错

## [0.1.3] - 2026-07-14

### Fixed
- **社区商店安装加载失败** — 0.1.2 release 的 `main.js` 与 0.1.1 字节级相同,仍含 deprecated `PluginSettingTab.display()`,被 Obsidian 1.13+ plugin checker(`no-deprecated-display`)静默拦截;本版重新构建正确产物(声明式 `getSettingDefinitions()`),CI 增加 `this.display()` 门禁防止复发

### Added
- **Skill 机制基础层** — 三源加载(builtin `<pluginDir>/skills/` + global `~/.ratel/skills/` + vault `.ratel/skills/`),gray-matter frontmatter 解析;`SkillRegistry` enabled/disabled/active 三态管理;`SkillPort` 端口 + `skill-fs`/`skill-vault` 双适配器(node:fs 与 VaultPort);2 个工具 `activate_skill`/`deactivate_skill`;3 个斜杠命令 `/skill`/`/skills`/`/skill off`;`agent.skills` prompt section(zone: 'dynamic')注入 Discovery + Active 段;Settings 面板新增「Skills」group(enableSkills 开关)
- **用户记忆系统** — 两层架构(global + topic),Agent 跨会话记住用户偏好与决策;3 个工具 `search_memory`/`remember`/`forget_memory`;记忆存于 vault 的 `.ratel/memory/`,纯 Markdown 可直接编辑;`MemoryStore` 注入 `EmbeddingPort` 预计算向量,独立索引;启动时 global.md + index.md 注入 system prompt(20KB 截断 + retrieval wrapper 防注入);总存储上限 10MB
- **记忆管理面板** — Svelte 5 侧边栏面板(brain 图标),查看/搜索/筛选/行内编辑/删除记忆条目;设置面板新增「记忆」group(6 个参数:启用/自动写入/存储上限/注入上限/动态上限/上下文总上限)
- **i18n V2 基础设施** — `src/i18n/` 模块(svelte/store-based),12 namespace ~340 key,开放式 Strings interface 扩展;中英文界面切换,Settings → Ratel → Language 下拉(auto 跟随系统 / 中文 / English),UI 文案即时生效
- **tool.name.* 友好名** — 工具调用展示从英文工具名改为本地化友好名(如"查看 xxx.md"、"语义搜索")
- **Chat UI 打磨** — Header 百分比胶囊 + 状态 tone;StatusLine 精简;work 条(indexing/downloading/preparing 等);抽屉精简
- **smart reindex 启动路径** — 启动期 hash diff 跳过未变更文件,热启动零 embed 调用
- **IndexManifest 持久化** — `pluginDir/index-manifest.json` 记录每文件 sha256 + mtime + chunkCount + 全局 embedding 参数,原子写避免半写损坏
- **mtime 快速跳过** — mtime 未变则不读 content 不算 sha256,直接复用旧 hash
- **`index.batch` Worker 协议** — 批量索引消息类型,reembedFile 先 `deleteByPath` 清旧 chunk 防残留
- **Diffing 状态** — IndexStatus 新增"检查变更中"状态,UI 状态条适配
- **设置面板重启提示** — embedProvider / chunkSize / chunkOverlap 改动需重启 Obsidian 生效

### Fixed
- **`/reindex` 不清 manifest** — 手动重索引时未变更文件被跳过,违反用户预期;现先 dropIndex + manifest.invalidate 再全量
- **`.index/` 损坏无降级** — smartReindex 任意步骤异常降级清 .index + 全量重建,不再卡在 Failed
- **`autoIndex=false` 仍跑 smartReindex** — 关闭自动索引后仍被启动期索引,违反设置语义;现仅启动 FolderWatcher
- **VectraStore catalog 旁路 bug** — `upsertItem` 不写 vectra 内部 catalog,`deleteDocument(uri)` 静默失败;`deleteByPath` 改用 `deleteItems(itemIds)` 按 metadata.path 过滤

## [0.1.0] - 2026-06-28

### Added
- **问答 vault** — 自然语言提问,流式回答带引用
- **多步闭环** — Agent Loop 自动检索多篇笔记生成综述,MAX_STEPS 默认 50 可配置
- **混合检索** — 向量召回 + BM25 全文匹配 + Backlinks 增强
- **本地 ONNX 嵌入** — Web Worker 子线程推理,主线程零阻塞,批量处理 maxBatchSize=16
- **DeepSeek / Claude / Ollama** 三模型适配器,流式输出支持思考过程(DeepSeek reasoning_content)
- **SecretStorage 密钥管理** — Obsidian 1.11.4+ 钥匙串,API Key 不出现在 data.json
- **状态条** — 模型/索引状态 + 上下文使用率 + token 数据源指示(估算/流式/API)
- **诊断面板** — 模型连接 / 嵌入健康 / 索引状态 / 工具权限自查
- **斜杠命令** — `/new` `/compact` `/model` `/reindex`
- **中文界面 + i18n 框架**
- **工具权限** — read_note / write_note / delete_note 的 allow / ask / deny 配置
- **三产物构建** — main.js + worker.js + embedding-worker.js

### Known Limitations
- 仅桌面端(依赖 Node.js fs)
- 索引大 vault(>5000 笔记)首扫较慢
- Claude adapter 未接 thinking blocks(仅 DeepSeek 接入 reasoning_content)

**English summary:** Initial public release. Chat with vault, multi-step agent loop (MAX_STEPS=50), hybrid retrieval (vector + BM25 + backlinks), local ONNX embedding in Web Worker with batch processing, three model adapters (DeepSeek/Claude/Ollama) with reasoning_content support, SecretStorage key management, status line with token source indicator, diagnostics panel, slash commands, i18n framework, tool permissions, three-artifact build.

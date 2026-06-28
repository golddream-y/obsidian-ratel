# 文档体系 v1 — README / 使用手册 / Changelog 设计

- **Spec ID**: S-DOCS-V1
- **创建日期**: 2026-06-28
- **状态**: Active
- **关联**: 无前置 spec
- **关联 Plan**: 待 writing-plans 生成

---

## 1. 背景

当前项目文档存在三个问题:

1. **无 CHANGELOG.md** — 版本 0.1.0,从未发 release,无 tag,无变更记录。作为开源项目缺少发版追溯能力。
2. **README.md 不适合 Obsidian 商店详情页** — 含开发导向内容(V1 W1-W8 路线图、竞品对比表格、🚧 规划中功能、ARCHITECTURE.md 直接链接、营销语气),违反 Obsidian 开发者政策(贬低竞品、宣传未实现功能)。
3. **无用户使用手册** — 用户安装后无可查阅的操作指引,issue 重复问同类问题。

Obsidian 商店读取规则(已查证官方 `obsidianmd/obsidian-releases` 仓库):

| 阶段 | 读取内容 |
|---|---|
| 列表搜索 | `manifest.json` 的 `name` / `author` / `description` |
| **详情页** | **从 GitHub 仓库根读 `README.md` + `manifest.json`** |
| 安装下载 | 用 `manifest.json` 的 `version` 值作为 tag 名找 GitHub Release,下载 `main.js` / `manifest.json` / `styles.css` |
| 版本兼容 | `versions.json` 决定兼容回退版本 |

**关键约束**:GitHub Release 的 tag **必须与 `manifest.json` 的 `version` 完全一致(不带 `v` 前缀)**,否则 Obsidian 找不到匹配 release,用户无法安装/升级。此约束已写入 AGENTS.md,本 spec 重申。

## 2. 目标

- 建立面向三类受众(商店访客 / 已安装用户 / 开发者)的完整文档体系
- README 重构为商店详情页风格,纯用户向,双语
- 新建单文件双语用户使用手册
- 新建 CHANGELOG.md(Keep a Changelog 1.1.0 格式),并定义 AI 生成 + 开发者确认的发版工作流
- 定义 Demo 可交互原型嵌入规则(GitHub Pages 托管)

## 3. 非目标

- 不做 CI 自动化 release(不做 GitHub Actions 自动发版)
- 不写 CLI 脚本(`npm run release`)
- 不引入 release-please / standard-version 工具依赖
- 不做拆分多文件用户手册(单文件足够 0.1.x 阶段)
- 不做 GitHub Pages 在线 demo(留待 0.2.x 评估)
- 不做截图实际拍摄(本 spec 只定结构与占位,发版前补)
- 不做视频教程(超出文档范围)

## 4. 文档体系结构

```
README.md                       # 商店详情页风格,纯用户向,双语
├── CHANGELOG.md                # 新建,Keep a Changelog 1.1.0 格式,双语(中文主体 + 英文摘要)
├── docs/
│   ├── user-guide.md           # 新建,单文件双语用户使用手册
│   ├── prototype/              # 可交互原型 HTML(GitHub Pages 托管)
│   │   └── chat-ui-mockup.html # UI 设计原型
│   ├── ARCHITECTURE.md         # 已有,开发者向,不动
│   ├── architecture/           # 已有,开发者向,不动
│   ├── adr/                    # 已有,开发者向,不动
│   ├── contributing/           # 已有,补"如何更新 changelog"小节
│   └── superpowers/            # 已有,工作流文档,不动
└── docs/superpowers/specs/
    └── 2026-06-28-docs-system-v1-design.md   # 本 spec
```

### 文档受众边界

| 文档 | 受众 | 内容定位 |
|---|---|---|
| **README.md** | 商店访客(潜在用户) | 是什么 / 怎么装 / 核心能力,200 字内说清,链接到手册 |
| **user-guide.md** | 已安装用户 | 配置 + 日常操作 + 故障排查 |
| **ARCHITECTURE.md** / **adr/** | 开发者 | 架构设计、模块职责、决策追溯 |
| **CHANGELOG.md** | 用户 + 开发者 | 版本变更记录 |

## 5. 详细设计 — README.md 重构

### 5.1 双语结构

单文件 `README.md`,中文在前,英文在后,`<hr>` 分隔:

```markdown
# Ratel — Obsidian AI Agent

(中文正文)

---

# Ratel — Obsidian AI Agent (English)

(English body)
```

### 5.2 内容结构(中文部分)

```markdown
# Ratel — Obsidian AI Agent

> 让 Obsidian vault 变成可对话、可检索、可治理的第二大脑。
> 隐私优先,支持本地 Ollama,零服务零终端。

## 它能做什么
- 问答 vault — 自然语言提问,带引用带来源
- 多步闭环 — 自动检索多篇笔记,生成综述写入新笔记
- 混合检索 — 向量召回 + BM25 + Backlinks 增强
- 增量索引 — 文件变更毫秒级响应,后台 Worker 不阻塞

## 演示
**[Try the interactive prototype →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**

## 安装
1. Obsidian → 设置 → 社区插件 → 浏览 → 搜索 "Ratel"
2. 安装并启用
3. 设置 → Ratel → 配置模型(DeepSeek / Claude / 本地 Ollama 任选)
4. 首次启动自动扫描 vault 生成索引
5. 侧边栏 🦡 图标开始使用

(注:商店未上架前用 BRAT 安装)

## 隐私
- 数据全部本地存储
- 模型 API 是唯一外发通道,使用 Ollama 则零外发
- API Key 存储于 Obsidian 1.11.4+ SecretStorage,不出现在配置文件中
- 无遥测、无数据收集

## 文档
- [使用手册](docs/user-guide.md)
- [架构设计](docs/ARCHITECTURE.md)(开发者)
- [更新日志](CHANGELOG.md)

## 反馈
- GitHub Issues: 提交 bug 或 feature request
- 使用手册 FAQ 先自查常见问题
```

英文部分结构与中文完全对应,内容翻译,不删减。

### 5.3 删除清单(当前 README 中要移除的内容)

| 内容 | 删除原因 |
|---|---|
| "为什么选 Ratel" 竞品对比表格 | 商店页贬低竞品不专业,违反 Obsidian 开发者政策 |
| V1 W1-W8 路线图表格 | 开发计划不该出现在用户商店页 |
| 🚧 规划中功能(Learner / 主动提醒 / 自动学经验) | 未实现功能不该宣传,违反商店审核 |
| docs/ARCHITECTURE.md 在正文直接链接 | 架构文档面向开发者,移到"文档"小节 |
| "自动建链"、"主动整理"、"自动学经验" 宣传 | 0.1.0 尚未实现,避免过度承诺 |
| 比较随意的营销语气 | 改为简洁专业陈述 |

### 5.4 保留并优化

| 内容 | 处理 |
|---|---|
| 核心定位(隐私优先 / 本地 Ollama) | 保留 |
| 安装步骤 | 保留并优化(补 BRAT 路径) |
| 隐私说明 | 保留并补充 SecretStorage |
| "不做什么"小节 | 保留(明确边界反而专业) |

## 6. 详细设计 — CHANGELOG.md + Release 工作流

### 6.1 CHANGELOG.md 格式

遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/),双语(中文正文 + 每版本块末尾 1-2 句英文摘要)。顶层有"如何生成"小节链接到本 spec。

```markdown
# 更新日志 / Changelog

本项目遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
本文件由 AI 从 Conventional Commits 生成草稿,开发者确认后合入。详见 [生成规则](docs/superpowers/specs/2026-06-28-docs-system-v1-design.md)。

## [Unreleased]

### Added
- (待发版时由 AI 填充)

## [0.1.0] - 2026-MM-DD

### Added
- **问答 vault** — 自然语言提问,流式回答带引用
- **多步闭环** — Agent Loop 自动检索多篇笔记生成综述
- **混合检索** — 向量召回 + BM25 + Backlinks 增强
- **本地 ONNX 嵌入** — Web Worker 子线程推理,主线程零阻塞
- **DeepSeek / Claude / Ollama** 三模型适配器
- **SecretStorage** 密钥管理(Obsidian 1.11.4+)
- **状态条** — 模型/索引状态 + 上下文使用率 + token 数据源指示
- **诊断面板** — 模型连接 / 索引健康 / 工具权限自查
- **斜杠命令** — /new /compact /model /reindex
- **中文界面 + i18n 框架**

### Known Limitations
- 仅桌面端(依赖 Node.js fs)
- 索引大 vault(>5000 笔记)首扫较慢

**English summary:** Initial public release. Chat with vault, multi-step agent loop, hybrid retrieval, local ONNX embedding in Web Worker, three model adapters, SecretStorage key management.
```

### 6.2 Release Notes 格式(GitHub Release 描述)

面向用户,简洁可视化,中文主体:

```markdown
# 🦡 Ratel 0.1.0 — 首个公开版本

## ✨ 亮点
(3-5 句话,突出核心价值)

## 🎬 演示
**[查看可交互原型 →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**

## 📦 安装
商店搜 "Ratel" 或 BRAT 安装。详见 [使用手册](docs/user-guide.md)。

## ⚠️ 升级提示
- 需 Obsidian 1.11.4+
- API Key 请在 Obsidian 设置 → Keychain 中配置

## 📝 完整变更
详见 [CHANGELOG.md](CHANGELOG.md)

## 🙏 反馈
GitHub Issues / 论坛 showcase
```

### 6.3 工作流(对话驱动 + 开发者确认)

```
开发者: "准备发版 vX.Y.Z" 或 "准备发版 0.2.0"
   ↓
AI 读 git log <last-tag>..HEAD(首次读全部 commit)
   ↓
AI 按 Conventional Commits 分类:
  feat(scope)              → Added / Changed
  fix(scope)               → Fixed
  perf(scope)              → Changed
  refactor(scope) 影响用户  → Changed
  docs / chore / test      → 内部变更,不进 changelog
   ↓
AI 生成两份草稿:
  1. CHANGELOG.md 顶部新增 [Unreleased] → [X.Y.Z] 版本块
  2. Release notes 草稿(临时文件)
   ↓
AI 呈现在对话中,标注:
  - 推断的版本号(从 commits 推断 + 推荐理由)
  - 升级提示(若有 BREAKING CHANGE 或数据迁移)
   ↓
开发者 review / 编辑 / 确认(可在对话中要求修改)
   ↓
AI 执行(顺序,任一步失败即停):
  1. 升 manifest.json version → "X.Y.Z"(不带 v 前缀)
  2. 升 versions.json 加 "X.Y.Z": "<currentMinAppVersion>"
  3. git add CHANGELOG.md manifest.json versions.json
  4. git commit -m "docs(release): X.Y.Z changelog"
  5. git tag X.Y.Z(不带 v 前缀,与 manifest.json version 完全一致)
  6. npm run build 验证三产物(main.js / worker.js / embedding-worker.js)
  7. gh release create X.Y.Z \
       dist/main.js dist/worker.js dist/embedding-worker.js dist/manifest.json \
       --title "Ratel X.Y.Z — <副标题>" \
       --notes-file <release-notes-temp.md>
  8. 清理临时文件
```

### 6.4 版本号推断规则

| Commit 类型 | 0.1.x 阶段 | 1.0+ 阶段 |
|---|---|---|
| `BREAKING CHANGE:` 或 `feat!:` | minor (0.2.0) | major (2.0.0) |
| `feat(scope):` | minor (0.2.0) | minor (1.1.0) |
| `fix(scope):` / `perf(scope):` | patch (0.1.1) | patch (1.0.1) |
| `refactor(scope):` 影响用户行为 | patch | patch |
| `refactor` / `docs` / `chore` / `test` | 不发版 | 不发版 |

**0.1.x 阶段不发 major**(0.x 阶段 major 含义弱),有 breaking 也走 minor。开发者可在对话中覆盖 AI 推断的版本号。

### 6.5 Tag 与 Release 命名

| 字段 | 命名 |
|---|---|
| `manifest.json` version | `0.1.0`(无 v) |
| `versions.json` key | `0.1.0`(无 v) |
| **git tag** | **`0.1.0`(无 v,必须与 manifest.json version 完全一致)** |
| GitHub Release 名称 | `Ratel 0.1.0 — <副标题>`(release 名称自由,tag 必须无 v) |

**关键约束**:Obsidian 升级检测机制读取 `manifest.json` 的 `version` 值作为 tag 名找 GitHub Release。若 tag 带 `v` 前缀而 manifest 不带,用户**无法安装/升级**。

### 6.6 首次落地

- 创建 `CHANGELOG.md`,顶部含 `[Unreleased]` 空块 + `[0.1.0]` 初始条目(从现有功能梳理)
- **不立即发 release**,只完成文件创建
- 0.1.0 实际 release 时机由用户决定,届时按 6.3 工作流执行

## 7. 详细设计 — 用户使用手册

### 7.1 文件定位

`docs/user-guide.md` —— 单文件,双语,简洁清晰。README 的"文档"小节链接到此。

### 7.2 双语结构

与 README 一致,中文在前,英文在后,`<hr>` 分隔。

### 7.3 内容结构(中文部分)

```markdown
# Ratel 使用手册

## 一、配置 — 让 Ratel 跑起来

### 1.1 安装
- 商店安装(上架后):设置 → 社区插件 → 浏览 → 搜 "Ratel"
- BRAT 安装(上架前):BRAT → Add → 填仓库地址

### 1.2 首次启动
- 启用插件后自动扫描 vault → 生成索引
- 状态条显示"索引中" + 进度,期间可正常用 Obsidian
- 索引完成 → 状态条变"就绪"

### 1.3 配置对话模型(三选一)
- DeepSeek:Endpoint `https://api.deepseek.com` + 模型名 + Max Tokens(点"测试连接"自动探测)
- Claude:Endpoint `https://api.anthropic.com` + 模型名
- 本地 Ollama:Endpoint `http://localhost:11434` + 模型名(无需 API Key)
- API Key 配置:Obsidian 设置 → Keychain → 用固定 secret ID 添加(详见 1.6)

### 1.4 配置嵌入模型
- 默认本地 ONNX(零配置,首次自动下载模型)
- 可选 API 嵌入:设置 → Embedding → 切 provider 为 `api` + 配置端点
- 模型管理:设置面板可查看/切换/删除已下载的本地模型

### 1.5 (可选)配置 Reranker
- 仅百炼 API 可选,提升搜索精度
- Keychain 添加 `ratel-rerank-bailian` 即自动启用,不配则纯向量 + BM25 检索

### 1.6 API Key 清单
| secret ID | 用途 | 必需? |
|---|---|---|
| `ratel-chat-openai-compatible` | 对话模型 API Key(DeepSeek/OpenAI/硅基流动等) | 远端模型必需,Ollama 不需要 |
| `ratel-embed-openai-compatible` | API 嵌入 Key | 仅 provider=api 时必需 |
| `ratel-rerank-bailian` | 百炼 Reranker Key | 可选 |

## 二、日常使用 — 与 vault 对话

### 2.1 打开聊天
- 侧边栏 🦡 图标,或命令面板 `Cmd+P` → "Ratel: Ask vault"
- 命令面板还能触发 "Ratel: Show index status"

### 2.2 基础问答
- 输入问题 → 流式回答
- 引用标记可点击跳转源笔记
- 上下文使用率在状态条实时显示

### 2.3 多步任务
- 描述复杂任务:"帮我研究 X 主题,写一份综述"
- Ratel 自动多步检索 → 工具调用 → 生成 → 写入新笔记
- 工具调用过程可视化(可展开看 args/result)

### 2.4 思考过程
- 支持 reasoning 能力的模型(如 DeepSeek-R1)会展示思考过程
- 以可折叠"思考"块呈现,流式中默认展开,完成后自动折叠
- 点击可手动展开查看完整推理

### 2.5 斜杠命令
输入 `/` 触发菜单:
| 命令 | 作用 |
|---|---|
| `/new` | 开始新对话,清空当前上下文 |
| `/compact` | 压缩上下文,将历史总结为摘要 |
| `/model` | 切换模型 |
| `/reindex` | 重新索引 vault |

### 2.6 状态条解读
- 状态点:就绪(绿)/ 思考中(黄脉冲)/ 索引中(黄脉冲)/ 错误(红)/ 未配置(空心)
- 上下文使用率:0-79% 绿 / 80-94% 黄 / 95-100% 红
- 数据源指示:估算(灰)/ 流式(黄)/ API(绿)— 反映 token 统计可信度
- 点击状态条展开详情抽屉

### 2.7 工具权限与确认
- Ratel 读写笔记前会询问(默认 ask 模式)
- 可在设置 → Tool permissions 改为 allow / ask / deny
- trustMode 开启后跳过询问(谨慎使用)

### 2.8 诊断与故障排查
- 命令面板 → "Ratel: Show index status" 或设置面板入口
- 三项自查:模型连接 / 嵌入健康 / 索引状态
- 出错时查看诊断面板的具体错误信息

### 2.9 FAQ

| 问题 | 回答 |
|---|---|
| 为什么必须 Obsidian 1.11.4+? | 用了 SecretStorage API 存密钥 |
| API Key 存哪了? | Obsidian Keychain,不出现在 data.json |
| 索引大 vault 很慢? | 首扫在 Worker 后台,可继续用 Obsidian |
| 用 Ollama 需要联网吗? | 不需要,纯本地推理 |
| 支持移动端吗? | 暂不支持(依赖 Node.js fs) |
| 数据上传到哪? | 仅模型 API 端点,Ollama 模式零外发 |
| 思考段只有 DeepSeek 有? | 当前已接入 DeepSeek,其他 reasoning 模型视 adapter 实现支持 |
```

### 7.4 写作原则

- **用户视角**:每节回答"我要怎么操作",不解释实现
- **只写已实现功能**:设置项存在但未接线的功能(如 Link Suggestions)不写
- **简洁**:每节 100-250 字,不灌水
- **无营销**:不吹"为什么选 Ratel",只说"怎么用"
- **不录 GIF**:demo 通过 GitHub Pages 上的可交互原型展示,详见 § 8

### 7.5 英文部分

结构与中文完全对应,内容翻译,不删减。

## 8. 详细设计 — Demo 可交互原型

### 8.1 策略

README 链接到可交互原型 HTML,托管在 GitHub Pages。用户点击链接直接在浏览器预览 UI 设计,无需安装插件。

**为什么不录 GIF:**
- GIF 录制 + 压缩流程繁琐,维护成本高
- 原型 HTML 可交互(点击展开/折叠、切换状态),GIF 只能被动观看
- 原型与实际 UI 1:1 对应,发版后原型仍可作为设计参考

### 8.2 原型文件位置

`docs/prototype/chat-ui-mockup.html`(从 `.superpowers/brainstorm/` 移出,因 GitHub Pages 不发布隐藏目录)。

### 8.3 访问路径

通过 GitHub Pages 访问:
```
https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html
```

**前置条件:** 仓库 Settings → Pages → Source: Deploy from a branch → `main` 分支 + `/docs` 文件夹。

**关键:** 因为选了 `/docs` 作为源文件夹,`docs/` 目录的内容直接发布到站点根,URL **不带 `docs/` 前缀**。若误写成 `…/obsidian-ratel/docs/prototype/…` 会 404。详见 [GitHub Pages 发布源配置](https://docs.github.com/zh/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

### 8.4 嵌入方式

README 用链接(非图片):

```markdown
**[Try the interactive prototype →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**
```

中文版:
```markdown
**[查看可交互原型 →](https://golddream-y.github.io/obsidian-ratel/prototype/chat-ui-mockup.html)**
```

## 9. 影响面

### 9.1 新增文件

- `CHANGELOG.md`
- `docs/user-guide.md`
- `docs/prototype/chat-ui-mockup.html`(原型从 `.superpowers/brainstorm/` 移出)
- `docs/contributing/how-to-release.md`(可选,补"如何更新 changelog"小节)

### 9.2 修改文件

- `README.md` — 完全重构(从开发导向改为商店详情页风格,双语)

### 9.3 不动文件

- `docs/ARCHITECTURE.md` / `docs/architecture/` / `docs/adr/` — 开发者向,本 spec 不涉及
- `manifest.json` / `versions.json` — 首次落地不改版本号,0.1.0 实际发版时按工作流升
- `src/` — 本 spec 是文档体系,不涉及代码改动

### 9.4 STATUS.md 登记

spec 合入后,在 `docs/superpowers/STATUS.md` 主表新增一行:

```
| S-DOCS-V1 | docs/superpowers/specs/2026-06-28-docs-system-v1-design.md | Active | 文档体系 v1 — README / 使用手册 / Changelog |
```

## 10. 参考与查证

- Obsidian 官方 plugin 提交说明: https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions
  - 关键引文:"Create a tag that matches the version in the `manifest.json` file. For Obsidian plugins, this must be the same as the version."
- Obsidian 官方 releases 仓库 README: https://github.com/obsidianmd/obsidian-releases/blob/master/README.md
  - 关键引文:"When the user opens the detail page of your plugin, Obsidian will pull the `manifest.json` and `README.md` from your GitHub repo."
- Keep a Changelog 1.1.0: https://keepachangelog.com/zh-CN/1.1.0/
- Semantic Versioning: https://semver.org/lang/zh-CN/
- Conventional Commits: https://www.conventionalcommits.org/zh-hans/v1.0.0/

## 11. 验证标准

Plan 执行完成后,需满足:

- [ ] `README.md` 重构为双语商店风格,删除清单中所有内容已移除
- [ ] `CHANGELOG.md` 创建,含 `[Unreleased]` + `[0.1.0]` 两个版本块,0.1.0 条目覆盖已实现功能
- [ ] `docs/user-guide.md` 创建,双语,覆盖配置 6 小节 + 日常使用 9 小节
- [ ] `docs/prototype/chat-ui-mockup.html` 存在,GitHub Pages 可访问
- [ ] `STATUS.md` 主表登记 S-DOCS-V1
- [ ] git commit 遵循 Conventional Commits(`docs(scope): ...`)
- [ ] 手册内容**无未实现功能**(Link Suggestions 不写、Learner 不写、主动提醒不写)
- [ ] 手册斜杠命令清单与 `src/ui/chat/input/slash-commands.ts` 实际定义一致
- [ ] 手册 API Key secret ID 与 `src/secrets/ratel-secrets.ts` 实际定义一致

# Ratel 2.0 开源技术候选调研

> 2026-10-20 · Web 调研与工程静态核对。用于选择验证对象，尚未安装、跑样本或确定最终依赖，不构成 spec、实施或版本范围批准。

本文为[用户故事](../../prd/2.0/stories/README.md)寻找可复用的技术。重点是：多格式材料如何变得可读取、可检索和可查看，以及 Skill 生态如何接入现有 Ratel。知识组织仍是独立的内置 Skill 话题，不在这里扩大为自动全库治理或用户方法提炼。

## 1. 选型结论与工程前提

建议采用**插件内本地提取与检索为基础，同时验证 Xerj 独立检索服务；复杂文档处理作为可选增强，预览交给生态插件**的方向。开源工具已能承担大量格式解析与索引工作；文件版本、覆盖状态、权限和来源衔接仍需 Ratel 保证。基础安装与可选本地服务是两条部署路线，不应把两套提取和索引链路同时叠加为默认配置。

| 能力 | 优先验证的选择 | 选择理由与条件 |
|---|---|---|
| 文本型 PDF | Obsidian `loadPdfJs()` 提供的 PDF.js | 工程依赖的 Obsidian API 类型已公开该入口；先验证实际宿主版本、文字顺序、资源释放及页定位，避免重复打包引擎 |
| PPTX 与统一 Office 提取 | officeParser | JavaScript/TypeScript 路线与现有工程接近，可输出结构与分块元数据；先核对锁定版本、包体、依赖和定位完整性 |
| XLSX 精确结构 | SheetJS CE，与 officeParser 同样本比较 | 直接取得单元格值、显示格式、公式及地址更利于区域核查；是否单独引入取决于统一解析结果 |
| DOCX 专用备选 | Mammoth.js | 适合提取标题、段落等语义内容；不提供可靠排版页码，不用纯文本导出替代所有结构 |
| 文本向量化 | 延用本地 BGE-small-zh-v1.5＋ONNX Worker 与已有 API 端口 | 格式差异在提取、结构和分块阶段解决；先测现有模型的检索质量，不因新增格式直接更换模型 |
| 关键词与向量索引 | 先复用当前检索与 Vectra，补齐派生文本查找 | 精确查找必须独立成立；扩大规模后用实测决定是否增加全文索引或更换向量后端 |
| 大批量混合文件的整套检索服务 | [Xerj](https://github.com/xerj-org/xerj) 作为优先验证对象 | 自带提取、索引、BM25、向量、混合搜索与 MCP；需要额外本地进程，先验证中文、Office 保真、变更一致性和隐私边界 |
| 复杂 PDF、扫描件 | Docling 作为外部本地处理候选；MarkItDown 作转换对照 | 需要额外 Python 环境，部分处理需模型或系统依赖，不成为基础安装条件 |
| Office 原件预览 | 用场景 Skill 验证、准备已有预览插件 | 可查看与可检索分别验收，不把第三方插件内部缓存当作 Ratel 稳定接口 |
| Skill 生态 | Agent Skills 格式＋参考 Vercel skills 的发现和维护机制 | 复用目录与包约定；Ratel 安装位置、兼容性、权限和更新一致性仍需适配 |

上述是基于资料与现有架构的选型判断，并非已经证明可用的组合。PDF 引擎复用有[Obsidian 官方 API 声明](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)和本地依赖声明两处依据；API 返回 `any`，不能据此假定内置 PDF.js 的具体版本或全部能力。

| 当前工程事实 | 对选型的影响 |
|---|---|
| TypeScript、Svelte、esbuild，桌面 Obsidian；项目不引入原生模块 | 默认依赖优先 JS/WASM；Python、原生库或独立服务只能另行评估为可选环境 |
| 已有 `onnxruntime-web`、本地 embedding Worker、`EmbeddingPort` 和 Vectra 适配器 | 不必新增整套 RAG 框架才能支持 Office；可先接入现有端口 |
| 现有 grep 读取 Markdown，尚不能搜索 Office 二进制内容 | 派生文本必须接入精确查找；仅把文本放进向量库不能补齐 grep |
| MCP 已有 HTTP 与 stdio 传输；Skill 脚本执行限定受控 JS | 配置外部文档 MCP 是可选接入路径；安装 Python Skill 不等于获得 Python 或通用命令行执行能力 |
| 已有插件搜索、安装、配置与状态工具 | 预览场景优先编排已有工具，不再开发另一套插件安装器 |

静态核对入口：`package.json`、`src/adapters/embedding-onnx.ts`、`src/adapters/bert-tokenizer.ts`、`src/adapters/vector-vectra.ts`、`src/tools/grep.ts`、`src/ports/mcp.ts` 与 `src/skills/`。具体接口仍以代码为准。

**后续工程安排（2026-10-20 已确认）：** 自有底层组件的拆包、独立维护与发包，放在 2.0 功能稳定后再评估，不作为当前交付目标。当前保持内部模块边界，继续验证现成开源库与可选服务；是否自建或独立发布，取决于实际缺口、需求共性与维护成本。详见[稳定后的组件评估安排](../../roadmap/2.0.md#20-功能稳定后的组件独立化评估)，跟踪项为 `REQ-POST2-ENG-001`。

## 2. 多格式材料的处理路线

```mermaid
flowchart LR
    A[原件 PDF / PPTX / XLSX / DOCX] --> B[格式解析与覆盖识别]
    B --> C[结构化文字与来源位置]
    C --> D[可重建文本缓存]
    D --> E[原词与正则查找]
    C --> F[按结构及 token 上限分块]
    F --> G[已有文本 embedding]
    G --> H[向量索引]
    E --> I[结果与出处]
    H --> I
    I --> J[按需读取与打开原件]
```

这里的“文字缓存”是程序维护的派生产物，不要求用户维护第二套笔记。应同时保存必要结构与位置；只留下一个大 Markdown 字符串，后续可能无法恢复原件定位。需要规范化文本时保留与提取内容的对应关系，不让处理后的偏移冒充原件位置。

| 格式 | 提取与分块重点 | 向量化边界 | 来源核查 |
|---|---|---|---|
| PDF | 按页取文字，再处理阅读顺序和段落；页内过长内容继续拆分 | 图片中的文字、复杂表格及扫描页不能视作已覆盖 | 文件版本＋物理页；只有取得可靠坐标时才细化到区域 |
| PPTX | 幻灯片顺序、标题、文本和表格；备注单独标记 | 不把图表含义、图片和视频默认当作已理解 | 文件版本＋幻灯片；读取顺序与界面视觉顺序需核查 |
| XLSX | 工作表、表头、单位、显示值和区域；表格分块重复必要表头 | 值检索不等于计算分析；公式与缓存值区分，缺缓存不自行补算 | 文件版本＋工作表＋单元格或范围 |
| DOCX | 标题层级、段落与表格；大段按模型 token 上限再拆 | 连续文本与 Word 最终分页不同 | 文件版本＋标题/段落等可核查位置，不承诺稳定页码 |

因此，几十 MB 的 PPTX 主要影响读取、解压、解析和预览成本。文本 embedding 的工作量更接近**实际提取文字、分块数量和变更量**，不能直接用文件 MB 推算。图片多而文字少的材料，与密集文字或表格材料应分别测量。

## 3. 格式解析候选比较

### 可在插件内评估的 JavaScript 路线

| 候选与主项目许可 | 上游已提供的能力 | Ratel 需要验证或补齐 | 初步判断 |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js)，Apache-2.0 | PDF 加载、逐页处理与浏览器显示；[官方示例](https://mozilla.github.io/pdf.js/examples/)展示文档和页接口 | Obsidian 内置版本、中文及多栏文字顺序、扫描页识别、取消与释放；宿主入口不是独立 Worker 可调用保证 | 文本 PDF 首选验证；优先使用宿主公开入口 |
| [officeParser](https://github.com/harshankur/officeParser)，MIT | Office/PDF 等格式解析为 AST；分块元数据可包含页、幻灯片、工作表和标题 | 页/表信息是否足够；尤其 XLSX 地址、单位、公式缓存和稀疏表；长内容需按现有 tokenizer 再约束 | PPTX 及统一 Office 提取的主要候选，不按支持格式数量直接定案 |
| [SheetJS CE](https://docs.sheetjs.com/docs/csf/cell/)，[Apache-2.0](https://github.com/SheetJS/sheetjs/blob/github/LICENSE) | 读取工作簿、单元格底层值、格式化文字及公式字段 | 保留表头与范围、隐藏内容策略、合并单元格与内存上限；[CE 不自动计算公式结果](https://docs.sheetjs.com/docs/csf/features/formulae/) | Excel 定位与语义保真优先对照 |
| [ExcelJS](https://github.com/exceljs/exceljs)，MIT | XLSX 工作簿处理；[文档提供流式读取](https://github.com/exceljs/exceljs#streaming-xlsx-reader) | 流式路线依赖 Node 能力，不能据此假定在 Web Worker 可用；需验证共享字符串及行结构内存 | 大 XLSX 的备选，与实际执行环境一起评估 |
| [Mammoth.js](https://github.com/mwilliamson/mammoth.js)，BSD-2-Clause | DOCX 转语义 HTML、提取文字，提供浏览器用法 | 结构与定位、表格覆盖；上游明确不负责 HTML 净化，渲染需沿用工程净化机制 | DOCX 专用备选，避免从零解析 OOXML |

officeParser 并非“加一个无负担的小依赖”：当前[包声明](https://github.com/harshankur/officeParser/blob/master/package.json)含 PDF.js、Tesseract.js 等依赖，README 提供不带 OCR 的 slim 浏览器包；标准浏览器用法默认从 CDN 加载 PDF Worker。验证时应锁版本，检查实际产物，避免重复打包 PDF 引擎、隐式下载或引入暂不需要的 OCR。浏览器可运行也不等于可直接放进 Ratel 当前 Worker。

SheetJS 的[官方安装说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)指出公共 npm 上的 `xlsx` 版本落后于其官方分发源。后续应采用可追溯、固定版本与校验的依赖方式，不直接把 `npm install xlsx` 当作已完成维护核对。

### 需要外部环境的文档处理路线

| 候选与许可 | 能直接复用什么 | 依赖与边界 | 在 Ratel 中的位置 |
|---|---|---|---|
| [Microsoft MarkItDown](https://github.com/microsoft/markitdown)，MIT | PDF、Word、PowerPoint、Excel 等转 Markdown；有官方 [MCP 包](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) | Python 与按格式安装的依赖；Markdown 输出不自动满足精确来源定位；LLM 图片描述等能力另有配置和外发边界 | 转换质量基准；可选本地 MCP，不作为基础安装前提 |
| [Docling](https://github.com/docling-project/docling)，代码 MIT，模型许可另查 | 统一文档表示；[结构与 token 感知分块](https://docling-project.github.io/docling/concepts/chunking/)，包括表头处理 | Python；模型型处理有下载和资源成本，可 CPU 运行不等于轻量；[支持预下载后离线使用](https://docling-project.github.io/docling/usage/advanced_options/) | 复杂 PDF、表格和 OCR 的优先外部增强候选；不整套塞进插件 |
| [Unstructured](https://github.com/Unstructured-IO/unstructured)，Apache-2.0 | 多格式 partition 和结构元素处理 | Python；依格式可能需要 Poppler、Tesseract、LibreOffice 等系统依赖 | 后续集中批处理的比较对象；当前桌面基础路线安装成本偏高 |
| [MinerU](https://github.com/opendatalab/MinerU)，当前为附加条款许可 | PDF 等文档内容提取与模型处理路线 | 运行环境、模型和硬件需单独评估；[当前 LICENSE](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)为 Apache-2.0 加附加条件，不应笼统标成标准 Apache-2.0 | 中文复杂材料的后续比较对象，不列为当前默认依赖 |

这几项工具解决的主要是转换、结构识别或分块；即使有完整 RAG 示例，也不能直接替代 Ratel 的库权限、文件事件、更新状态、原件跳转与索引一致性。引入外部处理时，还要解决输出如何被可靠导回本地索引，不能只让模型临时调用一次转换工具。

## 4. 向量化、关键词与规模选择

| 层次 | 建议 | 选择依据与验证条件 |
|---|---|---|
| 分块 | 优先结构边界，再按实际 tokenizer 控制长度；必要时重复标题、表头 | Docling 的 HybridChunker 可借鉴，JS 侧不必引入其 Python 运行时；officeParser 的字符大小配置不能直接当成 token 上限 |
| embedding | 首轮延用已有 BGE-small-zh-v1.5＋ONNX 路线 | [官方模型资料](https://huggingface.co/BAAI/bge-small-zh-v1.5)为 MIT；工程当前为 512 维、512 token 输入。小模型可处理提取后的文本，是否够用取决于领域样本，不由文件后缀决定 |
| 精确查找 | 在派生文字上支持原词/正则及上下文，保留出处 | 确定性查找与语义召回互补；分词全文排名不能完全替代 grep 的子串或正则语义 |
| 全文排名候选 | 需要时比较 [MiniSearch](https://github.com/lucaong/minisearch)（MIT）与 [Orama](https://github.com/oramasearch/orama)（Apache-2.0） | 均有 JS 路线；前者是内存全文索引，后者有全文/向量/混合搜索。中文切词、序列化、更新与内存仍需验证，当前不同时引入 |
| 向量存储 | 首轮保留 [Vectra](https://github.com/Stevenic/vectra)（MIT），复用工程适配器 | 上游为本地文件、内存查询路线，适合较小语料；不能据此承诺大量材料的常驻内存与延迟，新增格式不等于必须换库 |
| 独立服务 | 整套文件检索先验证 Xerj；仅需独立向量存储时比较 [Qdrant](https://github.com/qdrant/qdrant)（Apache-2.0） | 两者职责不同。Xerj 包含文件提取与全文检索；Qdrant 是向量后端候选，不负责 Office 提取。都需要额外进程与权限管理，规模上限由实测决定 |
| 增量复用 | 对提取文字与片段建立内容身份，结合模型、提取器和分块版本判断复用 | 仅图片或文件元数据变化时，可重新核对提取结果，但不应因此强制重算所有文本向量；这是 Ratel 机制，不能只依赖文件 hash |

现有 tokenizer 会截断超过上限的输入。因此，不能直接把整页、整张工作表或整份转换结果送入 embedding，再认为全部内容都已参与检索；新链路需要在截断之前完成分块，并为标题、表头与特殊 token 预留空间。

本地向量化没有按次 embedding API 账单，但仍占用模型存储、CPU、内存和电量。API 路线按实际输入及供应商计费，需要单独测量；本报告不估报未选供应商的价格。

**容量的量纲示例：** 以每片段 512 维、每维 float32 计算，1 万片段的纯向量约 19.5 MiB，10 万片段约 195.3 MiB。这只是 `片段数 × 512 × 4` 的理论载荷，不是 Vectra 的实际文件或内存占用；JSON、JS 数组、元数据、文本和索引会产生额外开销。后续应按片段规模而非文件数量评估，测量解析、embedding、存储与查询各自耗时。

### Xerj：可选本地检索服务

**结论：值得优先验证其整套文件检索能力，暂不作为插件默认依赖。** [Xerj](https://github.com/xerj-org/xerj) 是 Apache-2.0 的 Rust 独立程序，可以承担目录摄取、全文与向量检索，减少自建后端的工作量。它与 PDF.js、SheetJS 等解析库处于不同层次；采用其原生提取已满足要求的格式时，不必再重复运行同格式解析器。

本轮检查的是 2026-10-20 获取的源码快照 [`cf346ba`](https://github.com/xerj-org/xerj/tree/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958)，其 [Cargo 清单](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/Cargo.toml)版本为 `1.0.0-rc.97`。在线文档和发布二进制不一定对应同一提交，后续验证应固定可核对的发布包与源码，不把 main 分支能力等同于已经安装的版本。

| 评估点 | 已核对的能力或边界 | 对 Ratel 的选择影响 |
|---|---|---|
| 部署 | 独立服务＋目录摄取程序；`xerj mcp` 代理已运行的节点 | 可接现有 MCP/HTTP 能力；仍需管理二进制来源、进程、端口、鉴权、数据目录和升级。MCP 接入不等于自动完成原生检索适配 |
| PDF / PPTX | [PDF 提取器](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/crates/xerj-autoindex/src/extract/pdf.rs)保留页与片段定位；[PPTX 提取器](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/crates/xerj-autoindex/src/extract/pptx.rs)处理幻灯片顺序、标题、表格和备注 | 可直接列入 PDF/PPTX 同样本对照；需验证阅读顺序、截断告警和图片盲区。定位字段仍需转成 Obsidian 可打开的出处 |
| Excel | [XLSX 源码](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/crates/xerj-autoindex/src/extract/xlsx.rs)按表头将行转记录；只取公式缓存值，存储值代替显示值；识别为表格时不索引表头上方内容，一张工作表按一张表处理，隐藏表也会索引 | 适合规则表格检索，不能直接满足显示值、单位、复杂表区域与可见性要求；Excel 保真仍优先比较 SheetJS，必要时将受控提取结果交给后端 |
| 中文与语义 | [向量文档](https://xerj.org/docs/vectors)区分默认词法哈希、可选本地神经模型和外部 embedding 端点；也允许传入已有向量 | 默认词法哈希不能当作神经语义检索。内置 MiniLM 的[模型卡标为英语](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)；中文先对照现有 BGE，复用既有向量仍需适配写入与查询 |
| 受限范围查询 | 当前向量文档说明部分 kNN 路径使用 HNSW，带过滤条件时会回到精确扫描 | 重点测文件夹和授权范围过滤下的延迟；不能把不带过滤的基准当作我们的使用效果 |
| 增量与图关系 | [增量说明](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/docs/LIVE_REINDEXING.md)明确 `--watch` 需要 `--no-graph`；该路线核对新增、修改、改名和删除，图关系路线有不同限制 | 不能同时承诺原生目录监听和完整图关系。Obsidian 正反链接仍以宿主事实为准；索引写入由 Ratel 或 Xerj 摄取流程明确负责，避免两边独立维护同一份状态 |
| 本地与外发 | [安全模型](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/docs/SECURITY_MODEL.md)说明网络与鉴权；可选远端 embedding、rerank 和反馈分别有外发边界 | 不照搬关闭鉴权的快速示例；只授权选定目录与索引，不能把同用户运行的外部进程当作已受库路径沙箱保护 |

**反馈机制需要单独处理。** 当前 [MCP 源码](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/crates/xerj-mcp/src/lib.rs)的初始化说明及 `xerj_field_report` 工具描述，会要求 Agent 使用后自动提交反馈、不必询问用户；调用该工具时默认尝试向上游提交 GitHub PR，无法使用 GitHub 时再发往反馈端点。这里确认的是工具行为与引导指令，不能据此断言引擎在后台自动上传文件。

[反馈开关源码](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/engine/crates/xerj-common/src/feedback.rs)及 MCP 发送路径支持 `XERJ_DISABLE_FEEDBACK=true` / `--disable-feedback` 阻止发送，但初始化说明和工具描述仍需过滤。Ratel 当前 MCP Client 未消费 `initialize.instructions`，仍会读取工具描述；因此不能只依赖忽略初始化说明，应关闭反馈、只暴露所需检索工具，并验证外部进程的网络行为。本轮没有执行上述反馈指令、安装程序或发送材料。

自动索引还不等于可审计的材料覆盖。其[上游监听测量](https://github.com/xerj-org/xerj/blob/cf346ba116d87c91b0ed33c9cb4f4d8c8cc42958/docs/measurements/autoindex-watch-2026-09-19.md)以小文本和词法模式为主，不能证明大 Office 文件与神经 embedding 的吞吐。精确原词/正则、覆盖告警、删除后的不可检索、文件版本与出处跳转，仍需按 Ratel 的故事逐项验证。

## 5. 原件预览与 Skill 生态

### 预览插件候选

| 候选 | 上游声明的能力 | 本轮判断 |
|---|---|---|
| Obsidian 已有 PDF 查看 | 现有宿主 PDF 能力 | 优先复用，单独验证从 Ratel 结果打开及页定位，不另装相同能力 |
| [Office Viewer](https://github.com/jerry4pan/obsidian-office-viewer-plugin)，MIT | 桌面本地只读 PPTX、DOCX；提供幻灯片引用工作流，声明正常查看不上传内容 | PPTX 查看及出处衔接候选；高级内容可能降级，需验证实际插件版本和跳转接口 |
| [Office Reader](https://github.com/qianwei4712/obsidian-word-reader)，MIT | 桌面本地只读 DOCX、PPTX、XLSX，声明不自动获取外部资源 | 多格式预览候选；仓库标题、发布版本与 README 的覆盖可能不同，必须验证选定发布包 |
| [Local Office Preview](https://github.com/tndgyq/local-office-preview) | 本地预览，多种格式可通过本地 Office 软件转换 | 需要较高版式还原时的备选；PPT 和旧格式等依赖 LibreOffice/WPS/Office，不能当作零依赖方案；许可在纳入候选发布包时另核 |

以上仅验证了上游文档，不等于审计了插件代码、安装来源或隐私行为，也不据此认定成熟度。推荐前还要核查社区目录和 Releases、固定版本、兼容性、资源加载、扩展名接管冲突与真实样本效果。能打开文件不代表存在供 Ratel 调用的稳定跳页/跳单元格接口。

### Skill 发现、安装与运行

| 开源机制或工具 | 可复用内容 | Ratel 的缺口与选择 |
|---|---|---|
| [Agent Skills 规范](https://agentskills.io/specification) | `SKILL.md`、参考文件与资源目录；`compatibility` 等环境说明 | 采用格式并映射已有加载器；兼容性说明不是可自动安装依赖的完整清单，声明权限也不代替宿主检查 |
| [Vercel skills](https://github.com/vercel-labs/skills)（[MIT](https://github.com/vercel-labs/skills/blob/main/package.json)） | 搜索、安装、来源记录、检查更新等 CLI 工作流 | 参考并评估复用组件，不能把 CLI 当成已兼容的插件 API；核对许可、Node 环境、网络和来源锁定 |
| Vercel [支持的 Agent 路径](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) | 多宿主安装目录与适配模式 | 本轮未确认 Ratel 为其安装目标；Ratel 当前 `.ratel/skills` 等加载位置仍需适配，不假定 `.agents/skills` 安装即生效 |
| [Docling 官方 Skill](https://docling-project.github.io/docling/usage/agent_skills/) | 官方维护的 CLI、SDK、分块和依赖参考 | 是值得验证的第三方文档能力样本；依赖 Docling/Python，不能直接交给当前受控 JS runner 执行 |
| [MarkItDown MCP](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) | 已有 stdio/HTTP 转换工具，可接现有 MCP 传输 | 是可选外部工具，不是格式插件；需配置本地环境和可读目录，外部进程权限不自动受 Ratel 的库路径校验约束 |

另外，[Anthropic skills 仓库](https://github.com/anthropics/skills)明确区分：部分 Skill 为 Apache-2.0，DOCX/PDF/PPTX/XLSX 文档 Skill 是 **source-available，非开源许可**。可研究设计，不将它们当作可无条件打包分发的开源全家桶。每个候选包及其脚本依赖需要分别核对。

知识组织本身优先由内置 Skill 调用现有目录、属性、正反链接、检索和笔记工具完成。当前没有足够理由为此引入额外知识图谱数据库；“组织得更好”与“能被检索到”分别验收。

## 6. 集成后必须满足的要求

这些是复用或集成方案的验证要求，不等于全部由 Ratel 自研。先核实现有组件能否满足，再决定适配与确需补齐的部分；产品需求以能力分册为准。

| 机制 | 外部工具可以提供什么 | 产品必须保证什么 | 关联故事 |
|---|---|---|---|
| 提取契约 | 文本、AST、格式元数据和部分告警 | 原件身份、版本、覆盖范围、失败反馈和稳定来源映射 | 001～003、009～010 |
| 检索衔接 | 词法与向量算法 | 同一授权范围、精确查找可用、按需读取、去掉派生文本重复身份 | 004～005 |
| 变更与发布 | 文件转换或单次 upsert | 事件＋重启补查、修改/移动/删除、旧任务不得覆盖新结果、未变片段复用 | 007 |
| 大批量处理 | 库的批处理或流式接口 | 队列、优先级、持久进度、取消与失败重试、解压/输出/资源限制 | 008、011 |
| 来源查看 | 第三方插件显示原件 | 授权准备环境、保存人工配置、实际定位或诚实降级 | 006 |
| 组织操作 | 原子笔记与链接工具 | Skill 编排局部建议，底层执行范围、真实链接与结果核查 | 012～016 |
| Skill 生命周期 | 格式、搜索目录、下载或更新算法 | 安装范围、路径校验、来源版本、兼容性、按需资源、权限、定制冲突与恢复 | 017～026 |

这些机制不能通过“让模型照着 Skill 做”取得一致性保证。尤其是文本缓存和向量索引需对应同一文件版本；派生内容也须遵循隐私范围，删除后不能继续被当作当前有效知识使用。

## 7. 收敛选型的最小验证

下一步适合做一个有边界的技术验证，再决定具体 spec。以下是比较标准，尚未执行，也不是实现计划。

| 验证对象 | 同一批样本需检查什么 | 决策出口 |
|---|---|---|
| PDF.js 宿主复用 | 中文、双栏、表格、扫描混合页；页位置、文字顺序、释放与编辑响应 | 能否承担首批文本 PDF；复杂材料的明确盲区 |
| officeParser 对照 MarkItDown | PPTX 顺序、标题、表格、备注、图片盲区与较大压缩包；锁定版本实际构建产物 | 是否采用统一 Office 解析；有无包体或运行环境障碍 |
| SheetJS / officeParser / ExcelJS / Xerj XLSX | 多表、表头单位、稀疏表、合并区域、显示值、公式有/无缓存与较大工作簿 | 哪个能可靠提供表区域；是否需要流式专用路线 |
| 现有 embedding 与索引 | 原词、同义问法、编号和数字、表格事实及无答案问题；片段数、召回质量、延迟、内存和磁盘 | 现有模型够不够用；什么时候需要全文索引或独立后端 |
| Xerj 整套检索服务 | 固定发布包；中文检索、带范围过滤的查询、PDF/PPTX/Excel 出处、摄取与查询峰值内存；增删改名与重启恢复；关闭反馈并核查外发 | 是否值得提供可选本地服务；原生提取可复用到什么程度，哪些格式需补充提取或保留基础路线 |
| 一个预览插件 | 在 Sandbox 打开同一文件，核查文字、图表降级、出处跳转、禁网和插件冲突 | 首个预览场景推荐对象及降级行为 |
| 一个第三方 Skill | 安装、发现、读参考文件、检查依赖、完成真实任务，再核查定制和失败恢复 | 真正可复用的能力范围；最小工程补齐点 |

样本使用虚构或明确授权材料，先不外发私人库。规模验证至少覆盖不同片段数量，预先约定设备与资源预算，不沿用上游宣传的速度或“支持大文件”作为验收证据。选定候选后再固定提交/发布版本、核对传递依赖与许可证；本次保留官方演进入口供继续查询。

关联：[整体需求](../../prd/2.0/README.md)、[用户故事](../../prd/2.0/stories/README.md)、[能力演进路线](../../roadmap/2.0.md)、[GitHub Project](https://github.com/users/golddream-y/projects/1)。目前保持需求文档审阅，未创建本轮 spec、实现分支或发布承诺。

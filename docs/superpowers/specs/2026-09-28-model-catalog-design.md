# S-MODEL-CATALOG — 按供应商和模型查窗口

> 日期: 2026-09-28
> 状态: Active
> Spec ID: **S-MODEL-CATALOG**
> 关联: [S-CHAT-SETUP](2026-09-27-chat-setup-design.md)（当前套展开与二级页，已在 `feat-chat-setup` 落地）、[ADR-007](../../adr/2026-06-28-model-context-window-registry.md)（LiteLLM 按模型名模糊查窗口）

---

## 1. 背景

S-CHAT-SETUP 把提供商、模型名、窗口收进当前这一套，并拿掉 128k / 256k / 1M 档位。查表仍走 ADR-007：按模型名在 LiteLLM 映射表里模糊匹配 `max_input_tokens`。

同一模型 id 在不同供应商下窗口不同。models.dev 里官方 DeepSeek 的 `deepseek-v4-flash` 是窗口 1,000,000、单次输出 393,216；别的转售方挂同一个 id，窗口可以是另一数。只按模型名查，会把别人的上限写到这一套上。

models.dev 的一条供应商记录含 `id`、`name`、`api`、`env`、`doc` 和 `models`。一条模型记录含 `limit.context` 与 `limit.output`。名单约 225 家，整份 JSON 约 4.7MB。本地 Ollama 不在这份名单里（`ollama-cloud` 是云端，不是本机）。

设置页顺序稿在 `docs/prototype/settings-chat-setup.html`。原型为了能点开，给 OpenAI、Anthropic 等写了地址。models.dev 里这些家的 `api` 是空的。本 spec 不采用那些手填地址。

## 2. 目标

1. 对话模型页的提供商来自 models.dev，再加「Ollama（本地）」和「自定义」。
2. 选中有名单的供应商后，模型是该供应商的下拉；名单外的 id 可以手填。
3. 窗口和单次输出按供应商 id + 模型 id 精确查。查到就各显示一行。
4. 用户把窗口改小的规则沿用 S-CHAT-SETUP 的 `windowUserSet`。换供应商或换模型 id 就清掉重查。

## 3. 非目标

- 不改 S-CHAT-SETUP 已经做完的页结构：当前套展开、五个顶栏、二级页、密钥只在展开的那一套上。
- 不把单次输出写成请求里的 `max_tokens`。它只在设置里说明这一条模型的上限。
- 不把 4.7MB 名单打进 `main.js`，也不在 `onload` 拉取。
- 不拉取各家自己的 `/v1/models`。下拉用缓存的名单，不表示该密钥在该地址上一定开通了这个 id。
- 不把本地 Ollama 和 `ollama-cloud` 当成同一家。本机模型仍手填。
- 不改嵌入、重排、顶栏菜单。
- 不在本 spec 里改 ADR-007 正文。查表键和数据源变了，发版收尾时再决定是否改那份 ADR。

## 4. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| MC-01 | 名单缓存 | 打开对话模型页时，若缓存超过 7 天或没有缓存，用 Obsidian `requestUrl` 拉 `https://models.dev/api.json`，存到插件目录。失败则继续用旧缓存。没有缓存时，提供商只剩本地 Ollama 和自定义，并提示名单没装上 |
| MC-02 | 提供商下拉 | 选项为名单里的全部供应商，加上本地 Ollama、自定义。显示 `name`。当前套记下 `providerId` |
| MC-03 | 地址 | 该供应商的 `api` 非空：地址写成这个值，只读展示。`api` 为空、本地 Ollama、自定义：显示可编辑地址。从一家换到另一家时，有 `api` 就写入；没有就清空，不沿用上一家的地址 |
| MC-04 | 模型下拉 | 该供应商下，`limit.context > 0` 且 `tool_call` 为真的模型进下拉，不因 `status` 隐藏。另有「手填」。本地 Ollama 和自定义没有下拉，只有手填 |
| MC-05 | 精确查表 | 键是 `providerId` + 模型 id，不走模型名模糊匹配。命中则窗口一行、单次输出一行。未命中则露出窗口数字框，清空上一模型的上限，并提示未查到 |
| MC-06 | 改小仍锁定 | 用户把窗口改得比查到的更小：`windowUserSet` 为真，数字不得大于本次查到的窗口。供应商和模型 id 都没变时，再次打开不覆盖。改了供应商或模型 id：标志清掉，按 MC-05 重查 |
| MC-07 | 旧套迁移 | 旧配置没有 `providerId`。地址是官方 DeepSeek 则为 `deepseek`；地址是本地 Ollama 则为 `ollama`；其余为 `custom`。不凭模型名猜测 OpenAI 或其他供应商 |

## 5. 详细设计

### 5.1 存什么

每一套 `ChatProfile` 增加 `providerId: string`。

- 名单中的供应商：存 models.dev 的 `id`（如 `deepseek`、`alibaba`）。
- 本地：`ollama`。
- 其余：`custom`。

请求仍用这一套的 `apiBase` 和 `model`。`providerId` 只决定下拉、地址是否可编辑、以及查表键。密钥槽位不变。

单次输出不进 `data.json`。打开设置时从缓存读出，只显示。

窗口仍写 `chatModelMaxTokens`。`windowUserSet` 的含义不变，清掉的条件从「模型名字符串变了」改成「`providerId` 或模型 id 变了」。

### 5.2 页上怎么排

顺序仍是 S-CHAT-SETUP：点中的那一行下面展开名称、提供商、模型、窗口。在窗口那一块加一行单次输出。

| 提供商 | 地址 | 模型 | 窗口 |
|---|---|---|---|
| 名单内且 `api` 非空 | 只读，等于 `api` | 下拉，可选手填 | 按 MC-05 |
| 名单内且 `api` 为空 | 可编辑，换供应商时清空 | 下拉，可选手填 | 按 MC-05。查表不看地址 |
| Ollama（本地） | 可编辑，默认 `http://localhost:11434/v1` | 手填 | 未查到，自己填 |
| 自定义 | 可编辑 | 手填 | 未查到，自己填 |

选「手填」且填入的 id 正好在该供应商名单里：按精确键查，查到就收起数字框。本地和自定义没有名单可对，一直手填窗口。

### 5.3 缓存

- 文件放在插件目录，与现有映射表缓存分开，避免和 LiteLLM JSON 混读。
- 元数据记下拉取时间和来源 URL。
- 超过 7 天，下次打开对话模型页再拉。拉取失败保留旧文件。
- 不在插件启动时拉。对话发送不拉。名单请求不带库内容、不带密钥。

下拉用缓存的子集（MC-04）。查窗口用同一份缓存的精确键；手填的 id 只要该供应商下有这条记录，即使 `tool_call` 为假，也显示窗口和单次输出。

### 5.4 和 ADR-007 的关系

对话模型的窗口不再用 LiteLLM 的模型名模糊匹配。高级里的「模型映射表」二级页本 spec 不动；对话页不再读那张表来填窗口。两套数据并存到收尾时再决定映射表页留不留。

百分比、自动压缩、状态条继续读 `chatModelMaxTokens`。各步 token 不加进这个数。

## 6. 影响面

| 区域 | 变化 |
|---|---|
| 对话模型页 | 提供商改为名单下拉；模型改为该供应商的下拉加手填；多一行单次输出 |
| `ChatProfile` | 增加 `providerId`。旧数据按地址迁移 |
| 网络 | 打开对话模型页时可能请求 models.dev。不带库内容、不带密钥 |
| 高级映射表页 | 本 spec 不改控件。对话窗口不再依赖它 |
| 顶栏、嵌入、重排、二级页 | 不改 |
| 测试 | 同一模型 id 两家供应商得到两个窗口；`api` 为空不写入编造地址；换供应商清空无 `api` 的地址；`windowUserSet` 在同供应商同 id 下保持；旧套无 `providerId` 时只推断 deepseek / ollama / custom |
| 文档 | 收尾时评估 README 隐私说明（多一条名单请求）和是否改 ADR-007 |

## 7. 参考

- 名单：`https://models.dev/api.json`。供应商字段 `id`、`name`、`api`、`env`、`models`。模型字段 `id`、`limit.context`、`limit.output`、`tool_call`、`status`
- 设置原型：`docs/prototype/settings-chat-setup.html`（视觉顺序）。原型里 OpenAI / Anthropic 等地址是占位，以本 spec MC-03 为准
- 已落地的当前套与 `windowUserSet`：S-CHAT-SETUP，分支 `feat-chat-setup`

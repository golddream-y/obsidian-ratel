# S-TOOL-CONTRACT — 统一工具调用契约、参数失败反馈与历史投影

> **ID:** S-TOOL-CONTRACT
> **状态:** Active
> **日期:** 2026-10-03
> **目标分支:** develop
> **关联:** [S-APPLY-PATCH](2026-10-03-apply-patch-design.md)、[S-NOTE-MOVE](2026-10-01-note-move-design.md)
> **阶段:** 实施计划 [P-TOOL-CONTRACT](../plans/2026-10-03-tool-contract.md) 已登记为 Pending，未启动代码修复。

## 1. 背景

用户提供的沙箱会话证据显示，两次 `apply_patch` 都没有修改文件。第一次参数原文是空补丁，结束标记写成 `*** End of Patch`；第二次是含 Update File 和两处修改的补丁正文，但没有放进 JSON 的 `patch` 字段。两次适配器都收成只有 `raw` 的对象，循环在工具执行前拒绝。

现有实现把 JSON 解析失败统一解释为输出截断，并建议使用 move/copy/write。这不能告诉模型怎样重新发起合法的 apply_patch，还可能改变原任务的操作类型。出站历史又把内部 `{ raw }` 包装序列化成 function arguments，使错误处理的内部对象进入模型调用历史。

2026-10-03 对 develop 工作区进行只读审查，并运行默认 Composer，确认以下问题。统计不含用户覆盖和动态 MCP，不代表当时会话的完整请求快照；本次未重放真实会话。

| 问题 | 证据 |
|---|---|
| 示例边界不清 | apply_patch 只有裸补丁示例，没有完整 JSON 参数示例；description 共 553 字 |
| 默认描述缺失 | 46 个内置工具中，6 个工具描述、29 个顶层参数描述为空 |
| 说明重复 | RAG system 将完整工具 description 再复制一次；默认描述合计 4,926 字符，RAG 主 system 7,766 字符 |
| 反馈失真 | 只有字符串 raw 就被称为截断，没有使用响应结束原因 |
| 示例漂移 | manage_goal 描述里的 update_app_config 速记漏了 updates 外壳 |
| 验证不足 | Composer 测试主要检查关键词存在，没有验证调用示例可解析、契约覆盖完整或失败后的再次出站内容 |

## 2. 目标

1. 模型能明确区分 function call 的 JSON 参数对象与其中的补丁、正文等字符串内容。
2. 每个默认内置工具都有选用边界、完整参数语义和对应执行结果说明；复杂工具提供可解析的调用示例。
3. 普通 JSON 格式错误、参数对象形状错误和有结束原因证据的输出截断分别处理；失败调用不进入执行、权限、副作用钩子和文件写入。
4. 错误反馈指向同一工具的合法重试，不擅自把编辑任务转换为移动、复制、删除或整篇重写。
5. 出站历史不把内部 raw 包装冒充合法工具参数；历史仍明确保留失败事实、工具名和纠错信息。
6. 保留模型端点兼容性、现有工具权限、Skill 指令、目录约束和正常工具调用历史配对。

## 3. 非目标

- 不重写 Agent Loop、Goal 状态机、检索管线或工具权限机制。
- 不把 apply_patch 改为原生自由文本工具，不扩展 Add/Delete/Move 或多文件补丁语法。
- 不自动把裸补丁包进 patch 后执行，不自动纠正结束标记，不从残缺 JSON 推断并补全写入正文。
- 不增加新的外部服务、遥测、提示词优化平台或通用 JSON Schema 验证依赖。
- 不全局开启 provider strict 模式，不假设所有兼容端点支持相同的严格 schema 子集。
- 不修改用户自定义提示词、Skill 和 MCP 服务端描述；不以默认检查强制拒绝这些扩展。
- 不把 46 个工具按任务动态裁剪；本次只收口描述职责与重复内容。

## 4. 详细设计

### 4.1 三种内容各负其责

| 层次 | 写什么 | 不承担什么 |
|---|---|---|
| system 选用指引 | 按任务选择工具，读取与写入边界，跨工具工作流和确认约定 | 不复制完整 description、参数示例和补丁文法 |
| tools.function 契约 | 能力、适用对象、参数、限制、完整示例、返回含义 | 不堆叠历史修复口号，不把内部 API 速记当示例 |
| 失败反馈 | 失败类别、未执行事实、具体纠错方式 | 不推测失败原因，不无条件推荐换工具 |

保留现有默认中文源和 section override。`formatToolGuideList` 改为生成简短选用摘要，不再默认复用完整 description。摘要须有明确默认来源；description 覆盖仍只改变工具契约，不机械复制进 system。摘要字段和可编辑性在 plan 中选用最小实现，不建立第二份参数文档。

direct 和 rag 请求的 function definitions 采用相同契约。rag 独有的是检索工作流，不能决定一个工具有没有参数说明。

### 4.2 默认工具契约与示例

补齐以下六个工具的描述：update_plugin、uninstall_plugin、configure_plugin、get_plugin_status、list_ecosystem_changes、restore_backup。检查所有顶层参数的语义说明；对复杂嵌套参数补充必要的子字段或整体结构说明。

`configure_plugin.op` 明确 inspect/apply、缺省 inspect；写配置必须传 apply 和对象 patch。`confirmedNewKeys` 解释为已向用户确认可新增的配置键，不能由模型为绕过检查随意填写。管理目标明确各 action 所需字段及 predicate、grant、maxRounds 的含义，避免模型从参数名猜测。

通过 schema 表达稳定的类型、required、枚举和可选性；枚举与执行端接受的动作一致。仅在已验证执行兼容性的工具上收紧额外字段，不用全局 strict 开关替代清楚的契约。默认描述与 schema 的字段名、条件要求和缺省行为须一致。

所有示例明确是“调用参数 JSON”或“某字段的内容”，两者不得混标。apply_patch 的规范示例：

```json
{"patch":"*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n*** End Patch"}
```

该例对应原文件 `甲\n乙\n`，成功结果为 `甲\n乙二\n`。仍要求一次修改一篇已存在笔记、精确匹配、所有修改成功后一次落盘。裸补丁只可作为已明确标注的 patch 字段内容补充展示。

补充一句明确的协议要求：function arguments 必须是 JSON 对象；补丁全文放在 patch 字符串，换行按 JSON 编码；不能直接把补丁写进参数通道。该规则对所有 function 工具成立，不宣称每次模型输出都可由提示词保证。

修正 manage_goal 中对 update_app_config 的示例，使用 `{"updates":{"goalMaxRounds":20}}`。四个正文工具保留共同统计契约，但描述只简短交代统计来自改后全文及汉字/拉丁词字段，避免统计说明压过调用格式。

### 4.3 参数解析与失败分类

在适配器共享解析步骤中保留工具名、原始 arguments 和解析结果。流式与 requestUrl 降级路径复用相同规则。异常信息通过独立元数据传递，不能混入业务 args。

| 输入及证据 | 处理 |
|---|---|
| 可解析的非空或空 JSON 对象 | 正常工具调用；具体字段和补丁语法仍由工具校验 |
| 合法 JSON，但为 null、数组、字符串、数字或布尔值 | 参数形状错误，拒绝执行，要求 JSON 对象 |
| 无法解析，响应 finishReason=length | 输出达到长度上限且参数不可解析；明确这是响应级结束证据，不证明每个调用都被截断 |
| 无法解析，finishReason 非 length 或缺失 | 参数格式错误；不声称长度截断 |
| 旧会话只有 raw，没有失败元数据 | 标为旧记录的未解析参数、原因未知；不从 raw 长短猜测截断 |

一批调用中的合法调用维持现有执行规则，单个非法调用不得污染其他调用。解析成功不能仅靠 TypeScript 类型断言认定其为对象。

失败类别采用集中声明的字符串联合或 as const 清单，不使用 enum。具体端口和会话字段在 plan 中明确；字段可选，旧会话仍能读取。原始 arguments 仅按现有会话持久化边界保存，不额外输出到日志、Notice 或新的诊断通道。

### 4.4 模型反馈与界面

反馈必须说明工具名、未执行和如何修正；不能声称已修改、已恢复或已完成。apply_patch 参数格式错误时，明确要求重新发送含 patch 字符串的 JSON 对象，并给出短小合法示例。响应长度上限的反馈才建议缩小单次补丁；局部编辑不无条件改用 write_note。

参数形状错误提示实际顶层类型。JSON 合法但补丁结束标记错误时，进入现有补丁解析失败反馈，不再套用 JSON 错误或截断说明。上下文不匹配与多处匹配也保持原有精确失败原因。

工具结果供模型消费的说明与 UI 文案分开管理：用户可见标题、状态和错误须在 zh/en 增加 i18n key；模型的规范参数示例沿用中文 prompt 源。界面没有可解析 patch 时只显示通用工具名和真实失败类别，不从 raw 中猜目标路径，不继续展示固定“输出被截断”。

### 4.5 失败历史的出站投影

正常 assistant tool_calls 与 tool 结果保持现有配对。非法参数记录不得再序列化为 `function.arguments={"raw":...}`。

本 spec 选择：会话保存原始失败证据；出站投影将非法调用及其对应失败结果转换为明确标记的失败说明文本，保留原有 assistant 正文、工具名和纠错信息，不生成该失败调用的 tool_calls 或孤立 role=tool。原始 malformed 参数不作为可模仿的业务调用示例重放，不包含整篇失败正文。

转换只作用于非法调用，不改变相邻合法调用，也不能丢失用户消息、有效 reasoning 或目标完成标准。投影发生在最终消息顺序清洗之前，确保不会被误当孤立 tool 消息静默删掉。旧 raw 记录采用相同保守投影，历史可浏览而不自动重执行。

这一投影属于有意的历史表达变更，须通过适配器真实 buildRequestBody 输出测试核对；不能只测试局部帮助函数。若某端点兼容性验证失败，先明确失败请求与证据，再调整投影，不回退到假造合法 raw 参数。

### 4.6 验收与回归

| 场景 | 验收结果 |
|---|---|
| 裸空补丁，结束为 End of Patch | 判为非 JSON，工具不执行、文件不变；反馈不称截断 |
| 含 Update File、两处 @@ 和正确结束的裸补丁 | 仍判非 JSON，不自动包裹执行；反馈要求 patch JSON |
| 上一例按 JSON 包装后重试 | 通过参数解析并执行真实补丁工具；只改预期位置 |
| 合法 JSON 内使用 End of Patch | 到达补丁解析错误，整次不落盘 |
| length 与非 length 两种结束原因 | 分类与反馈不同，缺失结束原因不推测截断 |
| null、数组和 JSON 字符串顶层 | 形状错误，不进入权限和执行 |
| 同一响应同时含合法、非法调用 | 合法调用行为不变，非法调用失败明确 |
| 失败后再次生成请求 | 无伪造 raw 参数、无孤立 tool；纠错信息仍存在 |
| 旧会话只有 raw | 可加载；按未知原因拒绝执行与投影 |
| 正常工具历史、含 reasoning 和多调用 | 配对和必要 reasoning 保留，消息清洗不误删 |
| 无覆盖的全部内置工具 | 描述与顶层参数说明完整；关键嵌套语义明确 |
| 调用参数示例 | 每份 JSON 可解析，字段符合对应 schema；apply_patch 示例能执行 |
| RAG/direct 请求 | 参数契约相同；RAG 不重复完整工具 description |
| 用户覆盖、Skill 与 MCP | 不自动改写；现有扩展入口与覆盖能力仍可用 |

测试用虚构库路径和内容，不提交真实会话、Vault 名称或本机路径。补足 Composer 契约覆盖、适配器双路径、循环拒绝、最终请求投影和真实工具执行的回归，不用关键词测试代替契约验证。

实施后运行相关定向测试，再运行 test、typecheck、lint、build；本地模型手动验证覆盖一次裸参数失败后成功重试。若未开展真实端点验证，只报告自动测试能证明的范围，不承诺消除所有模型格式错误。

## 5. 影响面

- `src/prompts/defaults/zh.ts`、`tool-schemas.ts`、`composer.ts`、`types.ts`、`sections.ts`：统一默认说明、摘要和示例，补齐覆盖。
- `src/adapters/llm-openai-compat.ts`、`src/ports/llm.ts`：解析结果与失败元数据、双路径一致性及最终请求。
- `src/core/truncated-tool-call.ts`、`agent-loop.ts`、`context-manager.ts`、工具消息配对模块：替换误判、反馈与失败历史投影；具体模块拆分由 plan 明确。
- `src/types.ts`、会话读写和消息水合相关模块：如需保存可选失败元数据，保证旧记录兼容。
- `src/ui/chat/format-tool-display.ts`、`src/i18n/zh.ts`、`en.ts`、`types.ts`：真实失败类别的界面表达。
- `tests/prompts/`、`tests/adapters/`、`tests/core/`、`tests/tools/`、相关同目录测试：调用契约与端到端组装验证。

与 S-APPLY-PATCH 的关系：保留工具和语法，只补充调用参数示例及失败边界。与 S-NOTE-MOVE 的关系：保留残缺参数不执行，替换“raw 等于截断”和无条件 move/copy 建议。这两份 spec 不因本次修复整体废弃。

端口与消息数据契约可能发生兼容性扩展。此 spec 只记录设计；架构文档不在本轮修改，实施收口时按项目规则确认同步范围。README 和用户手册仅在界面行为发生变化时评估，CHANGELOG 用用户能感知的语言说明局部修改失败后可正确重试。

## 6. 参考

- `src/prompts/defaults/zh.ts`：工具说明、patch 示例和目标工具的调用速记。
- `src/prompts/tool-schemas.ts`、`composer.ts`：schema、section 解析与 system 重复注入。
- `src/adapters/llm-openai-compat.ts`：JSON.parse 回退和历史参数序列化。
- `src/core/truncated-tool-call.ts`、`agent-loop.ts`：固定截断文案与执行前拒绝。
- `src/tools/apply-patch.ts`、`apply-patch-text.ts`：业务参数与补丁语法边界。
- 用户提供的两次失败调用及本轮只读审查；真实会话不进入仓库。

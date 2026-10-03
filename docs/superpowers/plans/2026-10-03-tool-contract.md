# 工具调用契约与失败恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 工具说明给出合法 JSON 调用契约；非法参数不执行，返回真实纠错信息，历史不再把 raw 包装当成合法调用。

**架构：** 默认契约、system 选用摘要、错误反馈分别管理。适配器通过共享解析函数产生可选失败元数据；循环先拒绝非法参数，再沿原路径执行合法调用。最终请求前投影失败历史，持久层与 UI 保留失败证据。

**技术栈：** TypeScript strict、Vitest、Svelte 5、现有 OpenAI 兼容适配器、JSON 会话存储、现有 i18n。不新增运行依赖。

**ID：** P-TOOL-CONTRACT
**所属 spec：** [S-TOOL-CONTRACT](../specs/2026-10-03-tool-contract-design.md)
**状态：** In Progress
**日期：** 2026-10-03
**实施基线：** develop 当前工作区，包含尚未提交的 apply_patch、目录约束与移动复制实现；不能只从旧提交检出后假设这些文件存在。

## 1. 全局约束

- 本计划已进入实施阶段。执行结果见第 6 节；未完成提交与收口前保持 In Progress。
- apply_patch 保持 `patch: string`、单篇 Update File、精确匹配和原子落盘；不自动包装裸补丁或补齐正文。
- 不改 Goal、权限、AGENTS.md 确认、检索算法及模型选择。非法参数必须在权限、钩子和执行前拒绝。
- 不全局启用 strict 或 additionalProperties=false，不改变 MCP schema；合法 JSON 对象仍由各工具校验字段。
- 新失败信息不放进 args。新调用的成功解析显式标记 null，以区分合法 `{ raw: ... }` 与旧记录的解析失败包装。
- UI 新字符串走 zh/en i18n；模型反馈沿用中文。源码注释和测试名用中文，测试名采用“行为 - 条件 - 期望结果”。新文件完整文件头，导出函数补 JSDoc。
- 原始 arguments 只按会话现有边界持久化，不扩展日志、诊断或 Notice 的正文收集。不提交真实会话与本机路径。
- 每任务使用新 subagent，先规范审查再质量审查；任务内按 RED → GREEN → 自审 → 提交推进。步骤目标 2–5 分钟，较大的代码块按文件顺序完成，不一次堆全部修改。
- develop 有其他未提交工作。执行前记录 status、保存必要的本地备份，隔离任务变更；不能 `git add .`、整体 stash、reset 或把其他工作带进提交。任务提交仅包含本任务增量和状态记录。
- 架构文档在收口时按项目要求确认后同步。本计划不把“全量通过”写成未经运行的结论。

## 2. 文件结构与执行顺序

| 文件 | 职责 | Task |
|---|---|---|
| `src/prompts/defaults/tool-contracts.ts` | 可执行示例、缺失语义和正文工具契约 | 1 |
| `src/prompts/defaults/zh.ts`、`tool-schemas.ts` | 合并默认契约，稳定枚举 | 1 |
| `src/prompts/tool-guides.ts`、`composer.ts` | 简短选用摘要，保留扩展与覆盖 | 2 |
| `src/ports/llm.ts`、`src/core/tool-args.ts` | 可选失败类型、参数解析、旧记录识别和模型反馈 | 3 |
| `src/adapters/llm-openai-compat.ts` | 两条响应路径共享解析 | 4 |
| `src/core/agent-loop.ts`、`context-manager.ts` | 拒绝与会话元数据 | 5 |
| `src/core/tool-args-history.ts` | 失败调用出站投影 | 6 |
| `src/types.ts`、`src/i18n/types.ts`、`zh.ts`、`en.ts` | UI 事件与翻译 | 7 |
| `src/ui/chat/tool-args-error.ts`、`ChatView.svelte`、消息流 types/appender/hydrate | 即时与重载后的失败状态一致 | 7 |
| `tests/prompts/tool-contracts.test.ts`、`tool-guides.test.ts` | 契约完整、示例与去重 | 1–2 |
| `tests/core/tool-args.test.ts`、`tool-args-history.test.ts`、`agent-loop.test.ts` | 分类、历史与拒绝 | 3、5–6 |
| `tests/adapters/llm-openai-compat.test.ts` | 流式、降级及真实请求体 | 4、6 |
| `tests/tools/tool-contract-recovery.test.ts` | 两处补丁失败后正确重试 | 8 |
| `tests/ui/chat/tool-args-error.test.ts`、消息流现有测试 | UI 与旧会话 | 7 |

依赖：Task 1 → 2；Task 3 → 4 → 5 → 6 → 7；Task 8 汇合两条路径。整体是一条调用契约链，允许先交付默认说明，再交付运行时恢复；未完成 Task 8 前不宣布修复完成。

## 3. 任务清单

### Task 1：默认工具契约和可执行示例

**Files：** 新建 `src/prompts/defaults/tool-contracts.ts`、`tests/prompts/tool-contracts.test.ts`；修改 `src/prompts/defaults/zh.ts`、`src/prompts/tool-schemas.ts`、`tests/prompts/composer.test.ts`。

**Interfaces：** 产出 `APPLY_PATCH_EXAMPLE: { patch: string }`、`TOOL_CALL_EXAMPLES`、`TOOL_CONTRACT_DEFAULTS`；消费现有 `composeToolDefinitions`、`ALL_TOOL_NAMES` 和真实补丁工具。

- [x] **Step 1：写失败测试。** 新测试文件使用下面的完整核心测试；文件头按项目模板添加。

```typescript
import { expect, it } from 'vitest';
import { composeToolDefinitions } from '../../src/prompts/composer';
import { ALL_TOOL_NAMES } from '../../src/prompts/tool-schemas';
import { APPLY_PATCH_EXAMPLE, TOOL_CALL_EXAMPLES } from '../../src/prompts/defaults/tool-contracts';
import { createApplyPatchTool } from '../../src/tools/apply-patch';
import { createMockVaultPort } from '../helpers/mock-vault-port';

it('默认工具契约 - 全部内置工具 - 描述和顶层参数说明完整', () => {
  const defs = composeToolDefinitions({}, ALL_TOOL_NAMES);
  for (const def of defs) {
    expect(def.description.trim(), def.name).not.toBe('');
    const schema = def.parameters as { properties: Record<string, { description?: string }> };
    for (const [key, value] of Object.entries(schema.properties)) {
      expect(value.description?.trim(), `${def.name}.${key}`).toBeTruthy();
    }
  }
});

it('调用示例 - 序列化再解析 - 必填字段和顶层类型符合契约', () => {
  const defs = composeToolDefinitions({}, Object.keys(TOOL_CALL_EXAMPLES));
  for (const def of defs) {
    const args = JSON.parse(JSON.stringify(TOOL_CALL_EXAMPLES[def.name as keyof typeof TOOL_CALL_EXAMPLES]));
    const schema = def.parameters as {
      required?: string[];
      properties: Record<string, { type?: string; enum?: unknown[] }>;
    };
    for (const key of schema.required ?? []) expect(args).toHaveProperty(key);
    for (const [key, value] of Object.entries(args)) {
      const property = schema.properties[key];
      expect(property, `${def.name}.${key}`).toBeDefined();
      if (property.type) {
        const kind = Array.isArray(value) ? 'array' : typeof value;
        expect(kind).toBe(property.type);
      }
      if (property.enum) expect(property.enum).toContain(value);
    }
  }
});

it('apply_patch 示例 - 原文甲乙 - 执行后只替换乙', async () => {
  const vault = createMockVaultPort({ files: { 'notes/a.md': '甲\n乙\n' } });
  const definition = composeToolDefinitions({}, ['apply_patch'])[0]!;
  const tool = createApplyPatchTool(vault, definition);
  await tool.execute(JSON.parse(JSON.stringify(APPLY_PATCH_EXAMPLE)));
  expect(await vault.readFile('notes/a.md')).toBe('甲\n乙二\n');
  expect(definition.description).toContain(JSON.stringify(APPLY_PATCH_EXAMPLE));
});
```

- [x] **Step 2：运行 RED。** `npx vitest run tests/prompts/tool-contracts.test.ts`。预期新模块不存在，随后覆盖测试暴露六个描述和参数缺失。不要先修改断言使其接受空描述。
- [x] **Step 3：实现完整契约补充源。** `tool-contracts.ts` 正文如下，添加中文文件头和导出文档；在 `ZH_DEFAULTS` 对象末尾加入 `...TOOL_CONTRACT_DEFAULTS`，文件顶部导入它。现有用户 overrides 仍优先于默认源。

```typescript
export const APPLY_PATCH_EXAMPLE = {
  patch: '*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n*** End Patch',
};
export const TOOL_CALL_EXAMPLES = {
  apply_patch: APPLY_PATCH_EXAMPLE,
  update_app_config: { updates: { goalMaxRounds: 20 } },
  configure_plugin: { pluginId: 'dataview', op: 'inspect' },
  manage_goal: { action: 'list' },
};
const TEXT_RESULT = '成功返回 { path, text }；text 是改后全文的统计。中文字数读 text.length.han，拉丁词数读 text.words.latin，codePoints 不是字数。';
export const TOOL_CONTRACT_DEFAULTS = {
  'tool.write_note.description': `创建笔记或覆盖全文。参数是 JSON 对象，path 与字符串 content 同时必填。已有笔记局部修改优先 apply_patch；仅移动或复制用 move_note/copy_note。${TEXT_RESULT}`,
  'tool.append_note.description': `向文件末尾追加，文件不存在则创建。参数是 JSON 对象，path 与字符串 content 同时必填。${TEXT_RESULT}`,
  'tool.edit_note.description': `在已有笔记里替换唯一出现的一段。参数是 JSON 对象，path、old_string、new_string 同时必填且都是字符串；原文按缩进精确匹配。多处修改优先 apply_patch。${TEXT_RESULT}`,
  'tool.apply_patch.description': `局部修改一篇已存在笔记。function arguments 必须是 JSON 对象，补丁全文放在 patch 字符串，不能把裸补丁直接填进参数通道；不另传 path。一次只接受一个 Update File，不新建文件。调用参数 JSON 示例：${JSON.stringify(APPLY_PATCH_EXAMPLE)}。patch 以 *** Begin Patch 开头、*** End Patch 结尾；@@ 开始一处修改，其同行文字不参与匹配。下一行起，空格表示精确上下文，- 删除，+ 插入；标记后的文本原样比较，不 trim。可有多处修改，每处至少一行增删。上下文缺失、多处匹配或 End of File 不在末尾，整次不写。Add File 用 write_note，Delete File 用 delete_note，Move to 用 move_note；大部分正文更换用 write_note。${TEXT_RESULT}`,
  'tool.apply_patch.param.patch': '补丁全文字符串，必填。调用必须是 {"patch":"补丁全文"}；字符串里的换行使用 JSON 编码。路径只写在唯一的 *** Update File: 库内相对路径中。结束标记必须是 *** End Patch。',
  'tool.update_plugin.description': '更新已安装的社区插件，保留已有设置，按权限执行并记录变更和备份。pluginId 是官方清单中的插件 ID。检查返回结果，热启用失败时说明需要重载。',
  'tool.uninstall_plugin.description': '卸载已安装社区插件，按权限执行并记录变更和恢复备份。结果不表示整个库或所有相关模板都已清理。',
  'tool.configure_plugin.description': '读取或按字段修改插件配置。op 省略或为 inspect 时只读取；修改必须明确 op=apply 并提供对象 patch。仅改点名字段，不整份覆盖，不代填密钥。confirmedNewKeys 只能包含已向用户确认可新增的键。返回实际检查或修改结果。',
  'tool.get_plugin_status.description': '查询已安装插件或某个插件的状态；省略 pluginId 时列出已安装插件。可选择返回配置键和检查更新，不修改插件。',
  'tool.list_ecosystem_changes.description': '列出插件环境变更记录，可按 pluginId 筛选；用结果中的变更 ID 选择恢复对象，不猜 ID。',
  'tool.restore_backup.description': '按变更记录 ID 恢复对应插件快照，按权限执行。后续修改可能被覆盖，过期备份不能恢复；不是恢复整个库或整个场景。',
  'tool.grep.param.is_regex': '是否将 pattern 视为正则表达式；否则按字面搜索。',
  'tool.grep.param.include': '限定匹配的文件 glob 模式。',
  'tool.grep.param.path': '限定搜索目录，库内相对路径。',
  'tool.grep.param.ignore_case': '是否忽略大小写。',
  'tool.grep.param.context_lines': '每个匹配前后返回的上下文行数。',
  'tool.grep.param.max_results': '最多返回的匹配结果数。',
  'tool.glob.param.path': '搜索起始目录，库内相对路径。',
  'tool.list_files.param.path': '要列出的库内目录路径，省略时列库根。',
  'tool.delete_note.param.path': '要移到回收站的库内笔记路径。',
  'tool.run_skill_script.param.continueRun': '已有挂起脚本继续等待时传 true；不与 killRun 同时启用。',
  'tool.run_skill_script.param.killRun': '终止当前挂起脚本时传 true；不与 continueRun 同时启用。',
  'tool.manage_goal.param.goalId': '目标记录的 ID；更新或状态动作使用已有目标 ID，不自行编造。',
  'tool.manage_goal.param.predicate': '可选自动完成条件对象，kind=frontmatter-all，pathGlob 为库内文件匹配模式，property 为要求存在的属性名。',
  'tool.manage_goal.param.maxRounds': '目标回合上限；给当前目标加轮时必须高于当前值，不用它代改全局默认。',
  'tool.manage_goal.param.grant': '可选已获用户同意的库内目录授权模式数组；默认省略，不自行扩大范围。',
  'tool.manage_goal.param.progressNote': '本条目标的进度说明，不替代完成证据。',
  'tool.manage_goal.param.usage': '目标用量统计对象，包含 inputTokens 和 outputTokens 数值；只记录已知用量，不估算为真实统计。',
  'tool.update_plugin.param.pluginId': '已安装插件的官方 ID。',
  'tool.uninstall_plugin.param.pluginId': '要卸载的已安装插件 ID。',
  'tool.configure_plugin.param.pluginId': '要读取或修改配置的插件 ID。',
  'tool.configure_plugin.param.op': 'inspect 或 apply；缺省 inspect。写配置必须明确传 apply。',
  'tool.configure_plugin.param.patch': 'op=apply 必填对象，只有本次点名要修改的配置键和值。',
  'tool.configure_plugin.param.confirmedNewKeys': '用户已确认允许新增的配置键数组，不包含未获确认的键。',
  'tool.get_plugin_status.param.pluginId': '指定插件 ID；省略时列出已安装插件。',
  'tool.get_plugin_status.param.includeKeys': '是否返回配置键清单。',
  'tool.get_plugin_status.param.checkUpdate': '是否查询可用更新，可能访问插件发布来源。',
  'tool.list_ecosystem_changes.param.pluginId': '只列该插件的变更；省略不限定插件。',
  'tool.list_ecosystem_changes.param.limit': '返回条数，默认 20，范围 1–100。',
  'tool.restore_backup.param.changeId': 'list_ecosystem_changes 返回的具体变更 ID。',
} as const;
```

manage_goal 的原有完整状态约束保留，只把描述中的 `update_app_config({ goalMaxRounds })` 改成 `update_app_config({"updates":{"goalMaxRounds":20}})`。不要用短新描述覆盖整个状态机说明。

configure_plugin 的 op schema 替换成 `op: { type: 'string', enum: ['inspect', 'apply'] }`；其余 required 与默认执行保持不变。复杂对象中的字段保持原名；本任务不修改执行器。

- [x] **Step 4：运行 GREEN。** `npx vitest run tests/prompts/tool-contracts.test.ts tests/prompts/composer.test.ts tests/tools/apply-patch.test.ts`。把旧的“必须包含裸换行示例/不能省略”文案断言替换为解析 JSON 示例、schema 必填字段和执行结果断言，不能同时保留冲突的示例要求。
- [ ] **Step 5：审查并提交。** 核对默认说明与各工具真实缺省值；确认没有 secret 值、额外权限或语法扩张。提交消息 `fix: 补齐工具契约并给出合法调用示例`，仅暂存上述文件本任务增量。

### Task 2：system 只保留工具选用摘要

**Files：** 新建 `src/prompts/tool-guides.ts`、`tests/prompts/tool-guides.test.ts`；修改 `src/prompts/composer.ts`、`tests/prompts/composer.test.ts`。

**Interfaces：** 消费 `ALL_TOOL_NAMES`；产出 `getToolGuide(name: string, description: string): string`。默认摘要不可单独覆盖；用户可继续覆盖 `agent.rag.toolGuide` 整段，description override 只影响 function 契约。

- [x] **Step 1：写 RED。**

```typescript
import { expect, it } from 'vitest';
import { composeAgentSystem, composeToolDefinitions, formatToolGuideList } from '../../src/prompts/composer';
import { ALL_TOOL_NAMES } from '../../src/prompts/tool-schemas';
import { BUILTIN_TOOL_GUIDES, getToolGuide } from '../../src/prompts/tool-guides';

it('工具指引 - 默认全部工具 - 摘要非空且不复制完整补丁说明', () => {
  const defs = composeToolDefinitions({}, ALL_TOOL_NAMES);
  expect(Object.keys(BUILTIN_TOOL_GUIDES).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  for (const def of defs) expect(BUILTIN_TOOL_GUIDES[def.name]?.trim()).toBeTruthy();
  const system = composeAgentSystem('rag', { tools: defs }, {});
  const patch = defs.find((d) => d.name === 'apply_patch')!;
  expect(system).not.toContain(patch.description);
  expect(system).not.toContain('*** Begin Patch');
  expect(system).toContain('apply_patch');
});
it('工具指引 - 用户覆盖 description - 工具契约生效但 system 不复制', () => {
  const overrides = { 'tool.apply_patch.description': '自定义长契约' };
  const defs = composeToolDefinitions(overrides, ['apply_patch']);
  expect(defs[0]!.description).toBe('自定义长契约');
  expect(formatToolGuideList(defs, overrides)).not.toContain('自定义长契约');
});
it('工具指引 - MCP 无内置摘要 - 保留外部简介而不改 schema', () => {
  expect(getToolGuide('mcp__web__search', '搜索网页。\n返回来源')).toBe('搜索网页。');
});
```

- [x] **Step 2：运行。** `npx vitest run tests/prompts/tool-guides.test.ts`。预期模块不存在或 RAG 重复完整说明。
- [x] **Step 3：实现摘要模块与 Composer 完整替换函数。**

```typescript
export const BUILTIN_TOOL_GUIDES: Record<string, string> = {
  read_note: '已知路径时读取全文与元数据。', search_vault: '按主题语义查找笔记。',
  grep: '搜索精确文字或正则。', glob: '按文件名模式查找。', list_files: '列目录的一层内容。',
  write_note: '新建笔记或覆盖全文。', append_note: '追加到笔记末尾。',
  edit_note: '唯一原文片段精确替换。', apply_patch: '对已有笔记做一处或多处局部修改。',
  delete_note: '把笔记移到回收站。', move_note: '移动或重命名已有文件。', copy_note: '原文件保留，复制到新路径。',
  search_memory: '查询主题记忆。', remember: '记录偏好或工作约定。', forget_memory: '删除匹配的记忆。',
  activate_skill: '读取并激活匹配的技能。', deactivate_skill: '移除已激活技能。',
  read_skill_reference: '读取技能参考资料。', run_skill_script: '运行技能沙箱脚本或处理挂起状态。',
  get_datetime: '需要精确时间或相对日期时查询。', get_active_note: '定位当前笔记和选区。',
  get_daily_note: '探测指定日期的日记，不自动创建。', list_recent_notes: '列出最近修改的笔记。',
  get_note_outline: '读取标题大纲。', get_links: '查询出链、反链和未解析链接。',
  search_by_tag: '按标签过滤。', search_by_property: '按属性过滤。', get_vault_structure: '查看目录、标签和孤儿笔记概览。',
  open_note: '打开笔记并定位标题或块。', open_settings: '打开对应设置页。',
  get_app_config: '读取配置与诊断状态。', update_app_config: '修改白名单内设置。',
  manage_goal: '管理已确认完成标准的长期目标。', search_plugins: '在官方社区清单里找插件。',
  install_plugin: '安装官方清单中的插件。', update_plugin: '更新已安装插件。',
  uninstall_plugin: '卸载插件。', configure_plugin: '读取或按字段修改插件配置。',
  get_plugin_status: '查询安装与更新状态。', list_ecosystem_changes: '查看插件变更记录。',
  restore_backup: '恢复选定的插件变更快照。', apply_diary_host: '配置已确认的日记宿主设置。',
  list_host_dir: '列库外目录。', read_host_file: '读库外文本。',
  import_host_file: '原样导入库外文件。', run_host_command: '执行本机命令，可能有副作用。',
};
export function getToolGuide(name: string, description: string): string {
  return BUILTIN_TOOL_GUIDES[name] ?? description.split(/\r?\n/, 1)[0]!.slice(0, 160);
}
```

```typescript
export function formatToolGuideList(
  tools: Array<{ name: string; description: string }>,
  _overrides: OverrideMap,
): string {
  return tools.map((tool) => `- ${tool.name}: ${getToolGuide(tool.name, tool.description)}`).join('\n');
}
```

Composer 顶部导入 getToolGuide；保留参数签名避免调用者改动。为新导出函数写中文 JSDoc。MCP 只缩短 system 展示摘要，实际 function description/schema 原样。

- [x] **Step 4：运行 GREEN。** `npx vitest run tests/prompts/tool-guides.test.ts tests/prompts/composer.test.ts tests/prompts/tool-contracts.test.ts`。更新现有“description 覆盖必须复制进指引”的旧断言，新增整段 agent.rag.toolGuide override 生效断言。
- [ ] **Step 5：提交。** 消息 `refactor: system 工具指引改为简短选用摘要`。不添加第二份参数表或 46 个新可编辑 section。

### Task 3：参数结果类型、解析器、旧记录和模型反馈

**Files：** 修改 `src/ports/llm.ts`；新建 `src/core/tool-args.ts`、`tests/core/tool-args.test.ts`。

**Interfaces：** ToolCall 增加 `argsIssue?: ToolArgsIssue | null`；ChatMessage 增加 `toolArgsIssue?: ToolArgsIssue | null`。成功新调用显式 null；旧字段缺失可兼容。以下函数是后续任务唯一分类出口。

- [x] **Step 1：RED 测试。**

```typescript
import { expect, it } from 'vitest';
import { parseToolArguments, getToolArgsIssue, formatToolArgsModelError } from '../../src/core/tool-args';
it('参数解析 - 裸补丁正常结束 - 格式错误且不叫截断', () => {
  const parsed = parseToolArguments('*** Begin Patch\n*** End of Patch', 'tool_calls');
  expect(parsed.args).toEqual({});
  expect(parsed.argsIssue?.kind).toBe('invalid-json');
  const error = formatToolArgsModelError('apply_patch', parsed.argsIssue!);
  expect(error).toContain('未执行');
  expect(error).toContain('patch');
  expect(error).not.toContain('move_note');
  expect(error).not.toContain('输出长度');
});
it('参数解析 - 响应 length - 保留结束证据', () => {
  expect(parseToolArguments('{"patch":', 'length').argsIssue?.kind).toBe('output-limit');
  expect(parseToolArguments('{"patch":').argsIssue?.kind).toBe('invalid-json');
});
it.each(['null', '[]', '"abc"', '1', 'true'])('参数解析 - 顶层 %s - 形状错误', (raw) => {
  expect(parseToolArguments(raw, 'length').argsIssue?.kind).toBe('invalid-shape');
});
it('旧 raw 识别 - 新调用显式成功 - 合法 raw 不误判', () => {
  const parsed = parseToolArguments('{"raw":"合法 MCP 参数"}');
  expect(parsed.argsIssue).toBeNull();
  expect(getToolArgsIssue(parsed.args, parsed.argsIssue)).toBeNull();
  expect(getToolArgsIssue({ raw: '旧原文' }, undefined)?.kind).toBe('legacy-unparsed');
});
```

- [x] **Step 2：运行。** `npx vitest run tests/core/tool-args.test.ts`，预期模块不存在。
- [x] **Step 3：新增完整类型与解析模块。** 在 ports/llm.ts 加以下类型，分别向 ToolCall 和 ChatMessage 加上前述可选字段，其他定义不变。

```typescript
export const TOOL_ARGS_ISSUE_KINDS = ['invalid-json', 'invalid-shape', 'output-limit', 'legacy-unparsed'] as const;
export type ToolArgsIssueKind = (typeof TOOL_ARGS_ISSUE_KINDS)[number];
export interface ToolArgsIssue {
  kind: ToolArgsIssueKind;
  raw: string;
  actualType?: string;
}
```

`src/core/tool-args.ts` 的完整行为代码：

```typescript
import type { ToolArgsIssue } from '../ports/llm';
import { APPLY_PATCH_EXAMPLE } from '../prompts/defaults/tool-contracts';
export function parseToolArguments(raw: string, finishReason?: string | null): {
  args: Record<string, unknown>; argsIssue: ToolArgsIssue | null;
} {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    return { args: {}, argsIssue: { kind: finishReason === 'length' ? 'output-limit' : 'invalid-json', raw } };
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return { args: {}, argsIssue: { kind: 'invalid-shape', raw, actualType } };
  }
  return { args: value as Record<string, unknown>, argsIssue: null };
}
export function getToolArgsIssue(args: Record<string, unknown>, issue?: ToolArgsIssue | null): ToolArgsIssue | null {
  if (issue !== undefined) return issue;
  if (typeof args.raw === 'string' && Object.keys(args).length === 1) {
    return { kind: 'legacy-unparsed', raw: args.raw };
  }
  return null;
}
export function formatToolArgsModelError(name: string, issue: ToolArgsIssue): string {
  const reason = {
    'invalid-json': '参数不是合法 JSON 对象',
    'invalid-shape': `参数顶层类型为 ${issue.actualType ?? 'unknown'}，必须是 JSON 对象`,
    'output-limit': '响应因输出长度上限结束，参数同时无法解析；这是响应级证据',
    'legacy-unparsed': '旧记录参数未解析，无法确认失败原因',
  }[issue.kind];
  const retry = name === 'apply_patch'
    ? `请用同一工具重新发送含 patch 字符串的 JSON 对象。合法参数示例：${JSON.stringify(APPLY_PATCH_EXAMPLE)}`
    : '请按该工具 schema 重新发送完整 JSON 参数对象。';
  const shorter = issue.kind === 'output-limit' ? '可减小本次参数内容；不要推断任何文件已修改。' : '';
  return `${name} 未执行：${reason}。${retry}${shorter}`;
}
```

成功解析只验证顶层对象，不在这里猜 required 字段、自动修复补丁或验证通用 MCP schema。为每个导出补文件头与中文 JSDoc，类型断言加说明。

- [x] **Step 4：GREEN。** `npx vitest run tests/core/tool-args.test.ts`。新增合法空对象、包含额外 raw 与业务字段的对象用例；无 raw 正文进入反馈。
- [ ] **Step 5：提交。** `fix: 区分工具参数格式形状与输出上限`。

### Task 4：流式与降级响应统一解析

**Files：** 修改 `src/adapters/llm-openai-compat.ts`、`tests/adapters/llm-openai-compat.test.ts`。

- [x] **Step 1：RED。** 扩展现有 HTTP mock，使其可以返回 `PassThrough` SSE；保留原 error、pending、headers-then-hang 行为。`beforeEach` 清空新增 SSE 缓冲，防止串用例。分别从真正的流式入口和 requestUrl 降级入口送入以下样本，每组都收集 `llm.chat()` 的公开迭代输出：

```typescript
const cases = [
  { raw: '*** Begin Patch\n*** End of Patch', finish: 'tool_calls', kind: 'invalid-json' },
  { raw: '*** Begin Patch\n*** Update File: notes/a.md\n@@\n-乙\n+乙二\n*** End Patch', finish: 'tool_calls', kind: 'invalid-json' },
  { raw: '{"patch":', finish: 'length', kind: 'output-limit' },
  { raw: '[]', finish: 'tool_calls', kind: 'invalid-shape' },
  { raw: '{"patch":"text"}', finish: 'tool_calls', kind: null },
  { raw: '{"raw":"MCP business input"}', finish: 'tool_calls', kind: null },
] as const;
function responseText(raw: string, finish: string): string {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function',
      function: { name: 'apply_patch', arguments: raw } }] } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ];
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}
```

额外测试将 arguments 分两块传入，必须拼接后再解析；无 finish_reason 的裸补丁仍为 invalid-json。两条路径各跑同一数据集，不直接调用 private 解析方法。

- [x] **Step 2：确认失败。** `npx vitest run tests/adapters/llm-openai-compat.test.ts`，看到分类/显式 null 缺失，记录失败点。
- [x] **Step 3：GREEN。** 导入 `parseToolArguments`。两处最终 accumulator 循环都用下面代码替换 JSON.parse/raw 降级；保持原发送顺序、ID、正文、reasoning、取消和超时行为。解析函数的 finishReason 入参改为 `string | null | undefined`，仅比较 `length`，兼容供应商其它结束字符串，不做类型断言。

```typescript
for (const [, tc] of toolCallAccumulators) {
  const parsed = parseToolArguments(tc.arguments, finishReason);
  yield {
    text: '',
    toolCall: { id: tc.id, name: tc.name, args: parsed.args, argsIssue: parsed.argsIssue },
  };
}
```

- [ ] **Step 4：验证并提交。** 重跑适配器测试与 Task 3 测试。检查没有新增 raw 控制台输出。提交 `fix: 统一兼容适配器的工具参数解析`。

### Task 5：循环拒绝非法参数，保存真实失败证据

**Files：** 修改 `src/core/agent-loop.ts`、`src/core/context-manager.ts`、`src/types.ts`、`tests/core/agent-loop.test.ts`、`tests/core/context-manager.test.ts`；删除被完全替代的 `src/core/truncated-tool-call.ts` 与对应测试前，先确认所有引用迁移完毕。

- [x] **Step 1：RED。** 使用现有 mock Persistence/LLM/ToolRegistry helpers。同批返回一个非法 apply_patch 和一个合法 read_note；注册权限检查、pre/post tool hooks 与 execute spies。断言非法调用的这些 spy 全部为零，正常调用各运行一次；失败反馈含同一工具的合法 JSON 示例，不含 move/copy/write 建议。补 reasoning 与 assistant 正文保留、显式 null 的合法 raw 参数、legacy raw 参数、会话保存载入用例。
- [x] **Step 2：确认失败。** `npx vitest run tests/core/agent-loop.test.ts tests/core/context-manager.test.ts`。不接受仅“execute 没调用”作为完整证据。
- [x] **Step 3：GREEN。** `AgentEvent` 的 tool.call 与 tool.result payload 都增加可选 `argsIssue?: ToolArgsIssue | null`。循环在 tool.call 事件之前分类，在权限/钩子之前使用下面分支；正常分支沿用现有顺序。

```typescript
const argsIssue = getToolArgsIssue(tc.args, tc.argsIssue);
const checkedCall = { ...tc, argsIssue };
yield { type: 'tool.call', payload: { name: tc.name, args: tc.args, argsIssue } };
if (argsIssue) {
  const result = `Error: ${formatToolArgsModelError(tc.name, argsIssue)}`;
  ctx.addAssistantToolCall(checkedCall, accumulatedText, turnReasoning);
  ctx.addToolResult(tc.id, result);
  yield { type: 'tool.result', payload: { name: tc.name, result, argsIssue } };
  accumulatedText = '';
  continue;
}
```

接入时使用当前循环中的 reasoning 变量名，不能另造第二份缓冲。所有正常 `addAssistantToolCall` 也传 `checkedCall`，从而存下成功的 null 标记。`ContextManager.addAssistantToolCall` 的消息对象增加：

```typescript
toolArgsIssue: toolCall.argsIssue,
```

保持原 toolArgs、toolCallId、toolName、content、reasoning 与 createdAt 字段。JSON persistence 可选字段自然兼容；不另设会话版本、不回写旧记录。检查 compact/裁剪的对象 spread 是否保留元数据，增加经过裁剪后的验证。

- [ ] **Step 4：GREEN 与清理。** `rg 'isTruncatedToolArgs|TRUNCATED_TOOL_ARGS_ERROR|truncated-tool-call' src tests` 确认迁移后无残留，才删除旧分类模块和旧测试。重跑上述测试、Task 3–4 测试。提交 `fix: 在工具执行前拒绝非法参数并保留原因`。

### Task 6：最终出站请求投影失败调用

**Files：** 新建 `src/core/tool-args-history.ts`、`tests/core/tool-args-history.test.ts`；修改 `src/adapters/llm-openai-compat.ts`、`tests/adapters/llm-openai-compat.test.ts`。

- [x] **Step 1：RED。** 建立原始消息序列：user、带正文/reasoning 的失败 assistant、对应 tool 错误、正常 assistant call/tool result、最终 assistant。分别覆盖新元数据、旧 raw、合法 raw/null、混合批次。断言原数组深度不变；失败原始 arguments 不进入投影；正常 call/result ID 配对、正文和 reasoning 保留；第二次投影结果一致。
- [x] **Step 2：确认失败。** `npx vitest run tests/core/tool-args-history.test.ts tests/adapters/llm-openai-compat.test.ts`。
- [x] **Step 3：实现投影。** 新文件的行为代码如下，按项目规范补中文文件头与导出 JSDoc：

```typescript
import type { ChatMessage } from '../ports/llm';
import { getToolArgsIssue, formatToolArgsModelError } from './tool-args';
export function projectToolArgsFailures(messages: readonly ChatMessage[]): ChatMessage[] {
  const failedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCallId &&
        getToolArgsIssue(m.toolArgs ?? {}, m.toolArgsIssue)) failedIds.add(m.toolCallId);
  }
  return messages.flatMap(m => {
    if (m.role === 'tool' && m.toolCallId && failedIds.has(m.toolCallId)) return [];
    if (m.role !== 'assistant' || !m.toolCallId || !failedIds.has(m.toolCallId)) return [m];
    const issue = getToolArgsIssue(m.toolArgs ?? {}, m.toolArgsIssue);
    if (!issue) return [m];
    const { toolCallId, toolName, toolArgs, toolArgsIssue, ...rest } = m;
    void toolCallId; void toolArgs; void toolArgsIssue;
    const feedback = `[工具调用未执行] ${formatToolArgsModelError(toolName ?? 'unknown', issue)}`;
    return [{ ...rest, content: [m.content, feedback].filter(Boolean).join('\n') }];
  });
}
```

适配器组装 request 的首步改为：

```typescript
const safeMessages = sanitizeToolMessageOrder(projectToolArgsFailures(req.messages));
```

不修改 sanitize 的正常配对规则；不修改落盘历史。其它适配器是否需要同样投影，以它们是否实际消费这些历史字段为准：若存在独立发送入口，复用同一投影并增加公开入口请求测试，不能只修一个已知 serializer 后留下另一出口。

- [x] **Step 4：验证最终请求体。** 通过公开 `llm.chat()` 触发发送，捕获 HTTP/requestUrl mock 参数并 JSON.parse body。断言 messages 中失败 ID 不存在，既无它的 tool_calls，也无它的 role=tool；正文/reasoning 保留，正常调用 arguments 仍为正常 JSON。模拟 reload 后的同一持久化序列再次捕获。不得只测辅助函数。
- [ ] **Step 5：验证并提交。** 重跑历史、适配器、循环、compact/context 测试。提交 `fix: 防止失败参数包装污染模型调用历史`。

### Task 7：即时与重载 UI 显示一致的错误

**Files：** 修改 `src/ui/chat/message-stream/types.ts`、`segment-appender.ts`、`hydrate-session-messages.ts`、`src/ui/chat/ChatView.svelte`、`src/i18n/types.ts`、`zh.ts`、`en.ts`；新建 `src/ui/chat/tool-args-error.ts`、`tests/ui/chat/tool-args-error.test.ts`；扩展现有 segment-appender/hydrate 测试。

- [x] **Step 1：RED。** 四种失败分类各测 live 事件与 `await hydrateSessionMessages(messages)`。断言 tool 状态 failed、错误文字一致；旧 raw 记录显示原因未知；正常工具、正常失败、MCP raw/null 与 apply_patch 友好路径名称维持现有行为。无 patch 的失败只显示 apply_patch，不从 raw 猜路径。
- [x] **Step 2：确认失败。** 运行消息流现有测试与新 helper 测试。
- [x] **Step 3：补 i18n 与公共 helper。** 在 Strings 接口加入下面 namespace；zh/en 各用带类型的对象 spread 合并。以下是完整新增字符串：

```typescript
export interface ToolArgsStrings {
  'toolArgs.invalidJson': string;
  'toolArgs.invalidShape': string;
  'toolArgs.outputLimit': string;
  'toolArgs.legacyUnparsed': string;
}
const toolArgsZh: ToolArgsStrings = {
  'toolArgs.invalidJson': '工具参数不是合法 JSON，未执行。',
  'toolArgs.invalidShape': '工具参数顶层是 {type}，必须是 JSON 对象，未执行。',
  'toolArgs.outputLimit': '响应达到输出长度上限，参数无法解析，未执行。',
  'toolArgs.legacyUnparsed': '旧调用的参数未解析，原因未知，未执行。',
};
const toolArgsEn: ToolArgsStrings = {
  'toolArgs.invalidJson': 'Tool arguments are invalid JSON. The tool was not executed.',
  'toolArgs.invalidShape': 'Tool arguments are {type}; a JSON object is required. The tool was not executed.',
  'toolArgs.outputLimit': 'The response reached its output limit and its arguments could not be parsed. The tool was not executed.',
  'toolArgs.legacyUnparsed': 'Arguments in this older call were not parsed; the cause is unknown. The tool was not executed.',
};
```

helper 使用现有 `tNow(key, params)` 插值接口，不引入第二套翻译设施：

```typescript
import type { ToolArgsIssue } from '../../../ports/llm';
import { tNow } from '../../../i18n';
export function formatToolArgsUserError(issue: ToolArgsIssue): string {
  switch (issue.kind) {
    case 'invalid-json': return tNow('toolArgs.invalidJson');
    case 'invalid-shape': return tNow('toolArgs.invalidShape', { type: issue.actualType ?? 'unknown' });
    case 'output-limit': return tNow('toolArgs.outputLimit');
    case 'legacy-unparsed': return tNow('toolArgs.legacyUnparsed');
  }
}
```

- [x] **Step 4：接入 UI。** ToolCallEntry 增加 `argsIssue?: ToolArgsIssue | null`。live tool.call 保存 payload 元数据；issue 存在时 displayName 用原工具名、status 为 failed、errorMessage 用 helper。`attachToolResult` 增加第四个可选参数 argsIssue，匹配规则不变；只有提供元数据时覆盖 entry.argsIssue，失败时 UI result/errorMessage 用本地化文案，正常路径保留旧处理。tool.result 事件转发元数据。

hydrate 对每个 assistant call 使用 `getToolArgsIssue(toolArgs, cur.toolArgsIssue)`；构建相同 entry 字段，对配对 tool result 使用本地化失败文案，避免展开旧结果仍出现“输出被截断/改用移动复制”的旧提示。原会话内容不回写。无 issue 的消息使用原 display/status/result 构建逻辑。

- [ ] **Step 5：验证并提交。** 跑 helper、appender、hydrate 测试和 `npm run typecheck`；切换 zh/en 检查全部新 key，保留现有 Error 前缀协议。提交 `fix: 对齐工具参数失败的即时与历史展示`。

### Task 8：恢复闭环与收口验证

**Files：** 新建 `tests/tools/tool-contract-recovery.test.ts`；按必要性补前述测试，不扩大产品范围。更新本 plan 与 `docs/superpowers/STATUS.md` 的执行记录。

- [x] **Step 1：RED。** 使用现有 mock-vault-port 与 Persistence/ContextManager 测试替身。虚拟文件 `notes/a.md` 内容为 `甲\n乙\n丙\n丁\n`。真实 ToolRegistry 注册真实 apply_patch 工具；MockLLM 第一轮返回 `parseToolArguments` 产生的裸补丁失败，第二轮读取请求 messages 并返回下面合法参数，第三轮回复完成：

```typescript
const retryArgs = {
  patch: '*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n@@\n 丙\n-丁\n+丁二\n*** End Patch',
};
```

记录每一轮文件内容、write 调用次数与送进 LLM 的消息。第一轮不写；合法重试只成功落盘一次，最终为 `甲\n乙二\n丙\n丁二\n`，text 统计来自真实工具结果。不拿 MockLLM 的成功响应代替实际文件写入断言。另跑 invalid-shape、output-limit 与旧 raw 分类，无自动补全。此用例验证解析→循环→真实工具；Task 4/6 独立验证真实适配器的入站与最终出站边界，不能将 MockLLM 结果称作真实端点重放。
- [x] **Step 2：确认失败后完成最小修正。** `npx vitest run tests/tools/tool-contract-recovery.test.ts`。若新发现契约边界问题，先加失败用例再修正对应模块，不改权限或 Goal 来迁就测试。
- [x] **Step 3：全量检查。** 依次执行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。保存命令、退出码及任何基线失败；不能通过只排除失败测试宣称全量通过。新改动后只重跑受影响检查，最终保留一次完整验证。
- [x] **Step 4：隐私与范围自审。** `git diff --check`；检查任务 diff 无本机路径、密钥、真实会话、额外 raw 日志、硬编码 UI 字符串。核对 i18n、46 工具摘要覆盖、六个描述及29个参数描述补齐，示例确实通过执行测试。
- [ ] **Step 5：收口。** 提交 `test: 验证工具参数失败后的同工具恢复`。按 finishing 工作流评估用户文档/架构文档并向用户确认需要同步的项；未获确认不修改架构文档。写明是否实际验证 Sandbox、哪些端点未测。只在所有必需任务和检查完成后将 plan 标 Completed，登记实际合并信息；未合并仍保持 In Progress。依项目规则单独询问归档，不自动归档。

## 4. 自审与验收依据

| Spec 要求 | 实施位置 | 直接证据 |
|---|---|---|
| 默认工具契约完整，合法 JSON 示例 | Task 1 | 非空覆盖、枚举、示例 JSON 与真实补丁执行 |
| system 摘要去重，扩展与覆盖不丢 | Task 2 | 内置 guide 键集合、默认 prompt 无裸补丁、覆盖回归 |
| 失败分类有证据，旧记录不冒称截断 | Task 3–4 | 两条公开适配器路径同数据集 |
| 权限/钩子/执行前拒绝，正常调用不受影响 | Task 5 | 混合批次 spies 与保存/载入 |
| 历史不伪装合法调用、不产生孤立 tool result | Task 6 | 最终请求体、reload、幂等投影、reasoning 保留 |
| 即时和旧会话错误一致，zh/en 完整 | Task 7 | live/hydrate 对照、正常工具回归 |
| 正确重试真的改文件 | Task 8 | 首轮零写入，后续真实补丁原子写入与统计 |

计划已经将 argsIssue（入站调用/事件）和 toolArgsIssue（持久化消息）分开，成功显式 null，旧记录字段缺失才做 legacy 判断。响应级 length 只能说明达到输出上限，不能证明每一段非法参数都是被截断，文案与测试必须保留这一区别。

本计划不承诺真实供应商测试通过，不运行实现，也不修改用户 prompt 覆盖。任务代码片段是行为实现依据，落地时补项目要求的文件头和中文 JSDoc；对既有文件只修改指定逻辑，保持正在开发的 apply_patch、移动复制和目录约束功能。

## 5. 参考

- [S-TOOL-CONTRACT](../specs/2026-10-03-tool-contract-design.md)
- [S-APPLY-PATCH](../specs/2026-10-03-apply-patch-design.md)
- [S-NOTE-MOVE](../specs/2026-10-01-note-move-design.md)
- [项目状态表](../STATUS.md)

## 6. 执行记录

2026-10-03：按用户要求合并为三个工作包，由 subagent 实施并独立审查。目标为 develop 当前工作区，启动时已有 apply_patch、移动复制、目录约束、模型配置等未提交修改，已保存基线用于比对。本次仅修改修复范围及三个测试基线，不暂存其他工作。

| 工作包 | 任务 | 实施与审查 | 证据 |
|---|---|---|---|
| A | Task 1–2 | 实现完成，规范与质量审查通过 | 全部 46 个工具契约与摘要覆盖；8 文件 57 测试通过；移除重复默认源和新增类型错误 |
| B | Task 3–6 | 实现完成，规范与质量审查通过 | 双响应路径、权限/钩子前拒绝、保存/载入、真实请求投影；7 文件 183 测试通过；生产增量 lint 通过 |
| C | Task 7–8 | 实现完成，规范、质量及整体审查通过 | zh/en 即时与历史一致；真实补丁原子重试；合法 JSON 内错误结束标记走业务错误，零写入 |

### 最终验证

- `npm test`：271 文件、2003 测试通过，退出码 0。
- `npm run build`：成功，退出码 0；仍有既有构建警告。
- `npm run typecheck`：退出码 2。真实基线 245 条 TS 诊断，当前 241；按文件与消息归一比较没有新增，减少 4 条旧 Composer 测试诊断。未宣称全仓类型检查通过。
- `npm run svelte-check`：退出码 1。基线 257 个错误、21 警告；当前 253 个错误、21 警告；归一比较没有新增。
- `npm run lint`：退出码 1。基线 9 个错误、当前 6 个既有错误，17 个警告；本次增量没有新增错误，修正既有 pathHint 类型收窄和 ChatView case 作用域问题。
- `git diff --check` 通过；本次增量未发现本机路径、真实会话、密钥或额外原文日志。

### 偏差与未完成事项

- 用户要求合并派发，因此使用 A/B/C 三个工作包，而非为八个小任务各派实现者；保留独立规范和质量审查。
- 计划示例 import 路径及 grep 缺省值按实际代码修正；固定默认源避免 spread 重复声明。
- 三个既有失败仅修正测试：宿主 app mock、发送时间开销隔离、心跳 fake timers。没有为测试改变产品行为。
- Task 8 是已完成运行时实现后的汇合回归；最初测试搭建失败不是生产缺陷 RED。生产行为 RED 已由 A/B 及 C 消息流测试记录，不虚构链路 RED。
- 未调用真实模型端点、未写真实 Vault、未操作 Sandbox 或手动验证 Obsidian 画面；自动测试不保证模型永不再输出非法格式。
- 实现仍保留在 develop 工作区，未提交。提交范围需区分本次修复及相关未提交前置工具实现；不把其他功能工作带入提交。
- 实现提交后启动 finishing 工作流，按 AGENTS.md 确认文档同步范围；未提前改架构文档。既有类型/lint 失败与提交收口完成前保持 In Progress，不标 Completed，不归档。

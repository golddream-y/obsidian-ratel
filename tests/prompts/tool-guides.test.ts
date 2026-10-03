/**
 * @file tests/prompts/tool-guides.test.ts
 * @description 工具调用契约与选用摘要的回归验证
 * @module prompts/tool-contract
 */
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

it('工具指引 - 整段覆盖 - 自定义 system 指引生效', () => {
  const system = composeAgentSystem('rag', { tools: composeToolDefinitions({}, ['apply_patch']) }, {
    'agent.rag.toolGuide': '自定义选择规则：{{toolList}}',
  });
  expect(system).toContain('自定义选择规则：- apply_patch:');
});
it('工具指引 - MCP 多行长简介 - 保留定义且仅截短 system 展示', () => {
  const tool = { name: 'mcp__web__search', description: '甲'.repeat(200) + '\n第二行', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
  const before = JSON.stringify(tool);
  expect(formatToolGuideList([tool], {})).toBe('- mcp__web__search: ' + '甲'.repeat(160));
  expect(JSON.stringify(tool)).toBe(before);
});

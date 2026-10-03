/**
 * @file tests/prompts/tool-contracts.test.ts
 * @description 工具调用契约与选用摘要的回归验证
 * @module prompts/tool-contract
 */
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
      if (property?.type) {
        const kind = Array.isArray(value) ? 'array' : typeof value;
        expect(kind).toBe(property.type);
      }
      if (property?.enum) expect(property.enum).toContain(value);
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

it('复杂调用示例 - 默认工具描述 - 展示完整 JSON 参数', () => {
  for (const def of composeToolDefinitions({}, ['apply_patch', 'update_app_config', 'configure_plugin'])) {
    expect(def.description).toContain(JSON.stringify(TOOL_CALL_EXAMPLES[def.name as keyof typeof TOOL_CALL_EXAMPLES]));
  }
});
it('插件配置动作 - 默认 schema - 保留检查与应用枚举', () => {
  const schema = composeToolDefinitions({}, ['configure_plugin'])[0]!.parameters as { properties: { op: { enum: string[] } } };
  expect(schema.properties.op.enum).toEqual(['inspect', 'apply']);
});

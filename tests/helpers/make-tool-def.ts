/**
 * @file tests/helpers/make-tool-def.ts
 * @description 测试 helper — 按工具名生成 ToolDefinition,消除 7 个 test 文件重复
 * @module tests/helpers/make-tool-def
 * @depends ../../src/prompts/composer, ../../src/ports/llm
 */

import { composeToolDefinitions } from '../../src/prompts/composer';
import type { ToolDefinition } from '../../src/ports/llm';

/**
 * 测试 helper:按工具名生成 ToolDefinition。
 *
 * @param name - 工具名(如 'read_note')
 * @returns ToolDefinition 实例
 */
export function makeToolDef(name: string): ToolDefinition {
	return composeToolDefinitions({}, [name])[0]!;
}

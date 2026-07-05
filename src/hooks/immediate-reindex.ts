/**
 * @file src/hooks/immediate-reindex.ts
 * @description post-tool-use 钩子 - 写工具执行后立即触发索引刷新,绕过 FolderWatcher 5s 去抖
 * @module hooks/immediate-reindex
 * @depends ../ports/llm
 */

import type { ToolCall } from '../ports/llm';

/**
 * 触发立即索引刷新的写工具集合。
 */
const WRITE_TOOLS = new Set(['write_note', 'append_note', 'edit_note', 'delete_note']);

/**
 * 从 toolCall.args 提取目标 path。
 *
 * @param toolCall - 工具调用对象
 * @returns path 字符串;若非写工具或 args 无 path 字段或 path 非字符串/空字符串则返回 null
 */
export function extractToolTargetPath(toolCall: ToolCall): string | null {
  if (!WRITE_TOOLS.has(toolCall.name)) return null;
  const path = toolCall.args.path;
  if (typeof path !== 'string' || path.length === 0) return null;
  return path;
}

/**
 * 判断是否为删除类工具(用于 IndexController 决定 upsert vs delete)。
 *
 * @param toolName - 工具名
 * @returns true 表示删除(dequeue delete),false 表示 upsert
 */
export function isDeleteTool(toolName: string): boolean {
  return toolName === 'delete_note';
}

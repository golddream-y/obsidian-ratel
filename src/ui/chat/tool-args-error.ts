/**
 * @file src/ui/chat/tool-args-error.ts
 * @description 将工具参数失败证据转换为不含原文的本地化用户提示
 * @module ui/chat/tool-args-error
 * @depends ports/llm, i18n
 */
import type { ToolArgsIssue } from '../../ports/llm';
import { tNow } from '../../i18n';

/**
 * 按真实失败分类生成用户文案，原始参数只留在会话证据中。
 *
 * @param issue - 工具参数失败证据
 * @returns 当前语言的未执行原因
 * @example
 *   formatToolArgsUserError({ kind: 'invalid-json', raw: '' });
 */
export function formatToolArgsUserError(issue: ToolArgsIssue): string {
  switch (issue.kind) {
    case 'invalid-json': return tNow('toolArgs.invalidJson');
    case 'invalid-shape': return tNow('toolArgs.invalidShape', { type: issue.actualType ?? 'unknown' });
    case 'output-limit': return tNow('toolArgs.outputLimit');
    case 'legacy-unparsed': return tNow('toolArgs.legacyUnparsed');
  }
}

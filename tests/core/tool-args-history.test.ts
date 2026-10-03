/**
 * @file tests/core/tool-args-history.test.ts
 * @description 验证失败历史的非破坏出站投影
 * @module tests/core/tool-args-history
 */
import { expect,it } from 'vitest';
import type { ChatMessage } from '../../src/ports/llm';
import { projectToolArgsFailures } from '../../src/core/tool-args-history';
it.each([true,false])('历史投影 - 新元数据 %s 与混合正常调用 - 仅移除失败协议节点',modern => {
	const messages: ChatMessage[]=[
		{ role: 'user',content: '修改' },
		{ role: 'assistant',content: '准备修改',reasoning: '推理全文',toolCallId: 'bad',toolName: 'apply_patch',toolArgs: modern? {}:{ raw: '私有原文' },...(modern? { toolArgsIssue: { kind: 'invalid-json' as const,raw: '私有原文' } }:{}) },
		{ role: 'tool',content: 'Error: 失败',toolCallId: 'bad' },
		{ role: 'assistant',content: '读取',toolCallId: 'good',toolName: 'mcp',toolArgs: { raw: '合法业务参数' },toolArgsIssue: null },
		{ role: 'tool',content: '成功',toolCallId: 'good' },{ role: 'assistant',content: '完成' },
	];
	const before=JSON.stringify(messages); const projected=projectToolArgsFailures(messages);
	expect(JSON.stringify(messages)).toBe(before); expect(JSON.stringify(projected)).not.toContain('私有原文');
	expect(projected).toHaveLength(5); expect(projected[1]?.content).toContain('准备修改');
	expect(projected[1]?.content).toContain('未执行'); expect(projected[1]?.reasoning).toBe('推理全文');
	expect(projected[1]?.toolCallId).toBeUndefined(); expect(projected[2]).toEqual(messages[3]);
	expect(projected[3]).toEqual(messages[4]); expect(projectToolArgsFailures(projected)).toEqual(projected);
});

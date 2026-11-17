/**
 * @file tests/core/tool-args.test.ts
 * @description 验证参数分类及同工具重试反馈
 * @module tests/core/tool-args
 */
import { expect,it } from 'vitest';
import { parseToolArguments,getToolArgsIssue,formatToolArgsModelError } from '../../src/core/tool-args';
it.each(['*** Begin Patch\n*** End of Patch','*** Begin Patch\n*** Update File: notes/a.md\n@@\n-乙\n+乙二\n*** End Patch'])('参数解析 - 裸补丁 %s - 格式错误且不推测截断',raw => {
	const parsed=parseToolArguments(raw,'tool_calls');
	expect(parsed.args).toEqual({});
	expect(parsed.argsIssue?.kind).toBe('invalid-json');
	const error=formatToolArgsModelError('apply_patch',parsed.argsIssue!);
	expect(error).toContain('未执行'); expect(error).toContain('patch');
	expect(error).not.toMatch(/move_note|copy_note|write_note|输出长度/);
	expect(error).not.toContain(raw);
});
it('参数解析 - 仅 length 结束证据 - 区分输出上限',() => {
	expect(parseToolArguments('{"patch":','length').argsIssue?.kind).toBe('output-limit');
	expect(parseToolArguments('{"patch":').argsIssue?.kind).toBe('invalid-json');
});
it.each([['null','null'],['[]','array'],['"abc"','string'],['1','number'],['true','boolean']])('参数解析 - 顶层 %s - 形状错误优先',(raw,actualType) => {
	expect(parseToolArguments(raw,'length')).toEqual({ args: {},argsIssue: { kind: 'invalid-shape',raw,actualType } });
});
it.each(['{}','{"raw":"合法 MCP 参数"}','{"raw":"业务", "path":"a.md"}'])('参数解析 - 对象 %s - 显式成功',raw => {
	const parsed=parseToolArguments(raw); expect(parsed.argsIssue).toBeNull();
	expect(getToolArgsIssue(parsed.args,parsed.argsIssue)).toBeNull();
});
it('旧 raw 识别 - 没有元数据 - 原因未知且不泄露正文',() => {
	const issue=getToolArgsIssue({ raw: '私有正文' });
	expect(issue?.kind).toBe('legacy-unparsed');
	expect(getToolArgsIssue({ raw: '业务',path: 'a.md' })).toBeNull();
	expect(formatToolArgsModelError('read_note',issue!)).not.toContain('私有正文');
});

it('写入类工具被截断 - 反馈指向分段提交 - 不提固定字数',() => {
	for(const name of ['write_note','append_note']) {
		const error=formatToolArgsModelError(name,{ kind:'output-limit',raw:'{"path":' });
		expect(error).toMatch(/apply_patch/);
		expect(error).toMatch(/没有写入任何文件/);
		expect(error).not.toMatch(/\d[\d,]*\s*(tokens?|字|字符)/);
	}
});

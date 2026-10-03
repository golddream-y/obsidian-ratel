/**
 * @file src/core/tool-args.ts
 * @description 分类工具参数解析结果并生成同工具重试反馈
 * @module core/tool-args
 * @depends ports/llm, prompts/defaults/tool-contracts
 */
import type { ToolArgsIssue } from '../ports/llm';
import { APPLY_PATCH_EXAMPLE } from '../prompts/defaults/tool-contracts';

/**
 * 解析完整参数字符串，仅接受 JSON 对象，不猜测或修复业务字段。
 *
 * @param raw - 供应商累积的完整 arguments 原文
 * @param finishReason - 响应级结束证据，仅 length 支持输出上限分类
 * @returns 业务参数及独立失败证据；成功显式返回 null
 * @example
 *   const parsed = parseToolArguments('{"path":"a.md"}', 'tool_calls');
 */
export function parseToolArguments(raw: string,finishReason?: string|null): {
	args: Record<string,unknown>; argsIssue: ToolArgsIssue|null;
} {
	let value: unknown;
	try { value=JSON.parse(raw); }
	catch {
		// 修复:没有 length 结束证据时不能把普通 JSON 格式错误称为截断。
		return { args: {},argsIssue: { kind: finishReason==='length'? 'output-limit':'invalid-json',raw } };
	}
	if(value===null||Array.isArray(value)||typeof value!=='object') {
		const actualType=value===null? 'null':Array.isArray(value)? 'array':typeof value;
		return { args: {},argsIssue: { kind: 'invalid-shape',raw,actualType } };
	}
	// 关键路径:完成非空、非数组对象检查后才能将未知 JSON 值视为业务参数字典。
	return { args: value as Record<string,unknown>,argsIssue: null };
}

/**
 * 优先使用解析元数据，仅对缺少元数据的旧 raw 包装进行保守识别。
 *
 * @param args - 工具业务参数
 * @param issue - 显式成功或失败元数据，缺省表示旧调用
 * @returns 失败证据或 null；合法 MCP raw 参数不被误判
 * @example
 *   getToolArgsIssue({ raw: '业务内容' }, null);
 */
export function getToolArgsIssue(args: Record<string,unknown>,issue?: ToolArgsIssue|null): ToolArgsIssue|null {
	if(issue!==undefined) return issue;
	if(typeof args.raw==='string'&&Object.keys(args).length===1) {
		return { kind: 'legacy-unparsed',raw: args.raw };
	}
	return null;
}

/**
 * 给模型说明未执行原因与同一工具的合法重试，不回放失败原文。
 *
 * @param name - 调用工具名
 * @param issue - 参数解析失败证据
 * @returns 中文模型反馈，非用户界面文案
 * @example
 *   formatToolArgsModelError('apply_patch', { kind: 'invalid-json', raw: '' });
 */
export function formatToolArgsModelError(name: string,issue: ToolArgsIssue): string {
	const reason={
		'invalid-json': '参数不是合法 JSON 对象',
		'invalid-shape': `参数顶层类型为 ${issue.actualType??'unknown'}，必须是 JSON 对象`,
		'output-limit': '响应因输出长度上限结束，参数同时无法解析；这是响应级证据',
		'legacy-unparsed': '旧记录参数未解析，无法确认失败原因',
	}[issue.kind];
	const retry=name==='apply_patch'
		? `请用同一工具重新发送含 patch 字符串的 JSON 对象。合法参数示例：${JSON.stringify(APPLY_PATCH_EXAMPLE)}`
		:'请按该工具 schema 重新发送完整 JSON 参数对象。';
	const shorter=issue.kind==='output-limit'? '可减小本次参数内容；不要推断任何文件已修改。':'';
	return `${name} 未执行：${reason}。${retry}${shorter}`;
}

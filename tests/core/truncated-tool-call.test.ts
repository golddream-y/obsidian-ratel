/**
 * @file tests/core/truncated-tool-call.test.ts
 * @description 残缺工具参数不执行
 * @module tests/core/truncated-tool-call
 */
import { describe, expect, it } from 'vitest';
import { isTruncatedToolArgs, TRUNCATED_TOOL_ARGS_ERROR } from '../../src/core/truncated-tool-call';

describe('isTruncatedToolArgs', () => {
	it('isTruncatedToolArgs - 只有 raw - 视为截断', () => {
		expect(isTruncatedToolArgs({ raw: '{"path":' })).toBe(true);
	});

	it('isTruncatedToolArgs - JSON 已解析出 path - 不是截断', () => {
		expect(isTruncatedToolArgs({ path: 'a.md', content: 'x' })).toBe(false);
	});

	it('TRUNCATED_TOOL_ARGS_ERROR - 文案 - 指向移动和复制', () => {
		expect(TRUNCATED_TOOL_ARGS_ERROR).toContain('move_note');
		expect(TRUNCATED_TOOL_ARGS_ERROR).toContain('copy_note');
	});
});

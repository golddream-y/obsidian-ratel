/**
 * @file tests/ui/chat/format-tool-display-mcp.test.ts
 * @description MCP 工具展示名 — formatToolDisplayName
 * @module tests/ui/chat/format-tool-display-mcp
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { formatToolDisplayName } from '../../../src/ui/chat/format-tool-display';
import { setLang } from '../../../src/i18n';

describe('formatToolDisplayName — MCP', () => {
	beforeEach(() => {
		setLang('zh');
	});

	it('formatToolDisplayName - mcp__ 注册名 - 展示含 server 与 tool', () => {
		const text = formatToolDisplayName('mcp__tavily__search', {});
		expect(text).toContain('tavily');
		expect(text).toContain('search');
	});

	it('formatToolDisplayName - resolveMcpServerLabel - 用 label 替换 serverId', () => {
		const text = formatToolDisplayName(
			'mcp__tavily__search',
			{},
			{ resolveMcpServerLabel: () => 'Tavily Search' },
		);
		expect(text).toContain('Tavily Search');
		expect(text).not.toContain('tavily');
		expect(text).toContain('search');
	});
});

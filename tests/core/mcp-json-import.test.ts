/**
 * @file tests/core/mcp-json-import.test.ts
 * @description Claude/Cursor MCP JSON 导入解析
 * @module tests/core/mcp-json-import
 */

import { describe, it, expect } from 'vitest';
import { normalizeMcpServerId, normalizeMcpServerConfig, parseMcpServersJson } from '../../src/core/mcp-config';

describe('normalizeMcpServerId', () => {
	it('normalizeMcpServerId - 大写与下划线 - 转为合法 id', () => {
		expect(normalizeMcpServerId('Brave_Search')).toBe('brave-search');
	});

	it('normalizeMcpServerId - 非法开头 - 返回 null', () => {
		expect(normalizeMcpServerId('123bad')).toBeNull();
	});
});

describe('normalizeMcpServerConfig', () => {
	it('normalizeMcpServerConfig - command 含空格且 args 空 - 自动拆分', () => {
		const n = normalizeMcpServerConfig({
			id: 'local',
			label: 't',
			enabled: true,
			transport: 'stdio',
			command: 'npx -y some-local-mcp',
			args: [],
		});
		expect(n.transport).toBe('stdio');
		expect(n.command).toBe('npx');
		expect(n.args).toEqual(['-y', 'some-local-mcp']);
	});

	it('normalizeMcpServerConfig - npx mcp-remote https - 改写为 HTTP', () => {
		const n = normalizeMcpServerConfig({
			id: 'tavily',
			label: 't',
			enabled: true,
			transport: 'stdio',
			command: 'npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=x',
			args: [],
		});
		expect(n).toMatchObject({
			transport: 'http',
			url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=x',
		});
	});

	it('normalizeMcpServerConfig - 已有 args - 不拆 command', () => {
		const n = normalizeMcpServerConfig({
			id: 'tavily',
			label: 't',
			enabled: true,
			transport: 'stdio',
			command: 'npx',
			args: ['-y', 'pkg'],
		});
		expect(n.command).toBe('npx');
		expect(n.args).toEqual(['-y', 'pkg']);
	});
});

describe('parseMcpServersJson', () => {
	it('parseMcpServersJson - Claude mcpServers stdio - 解析成功', () => {
		const text = JSON.stringify({
			mcpServers: {
				filesystem: {
					command: 'npx',
					args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
					env: { FOO: 'secret' },
				},
			},
		});
		const r = parseMcpServersJson(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.result.servers).toEqual([
			{
				id: 'filesystem',
				label: 'filesystem',
				enabled: true,
				transport: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
				envKeys: ['FOO'],
			},
		]);
		expect(r.result.envKeysNoted).toEqual(['FOO']);
	});

	it('parseMcpServersJson - HTTP url - 解析为 http transport', () => {
		const text = JSON.stringify({
			mcpServers: {
				tavily: { url: 'https://mcp.tavily.com/mcp' },
			},
		});
		const r = parseMcpServersJson(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.result.servers[0]).toMatchObject({
			id: 'tavily',
			transport: 'http',
			url: 'https://mcp.tavily.com/mcp',
		});
	});

	it('parseMcpServersJson - VS Code servers 键 - 可解析', () => {
		const text = JSON.stringify({
			servers: {
				local: { command: 'node', args: ['server.js'] },
			},
		});
		const r = parseMcpServersJson(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.result.servers[0]?.id).toBe('local');
	});

	it('parseMcpServersJson - 非法 JSON - 返回 invalid_json', () => {
		expect(parseMcpServersJson('{')).toEqual({ ok: false, error: 'invalid_json' });
	});

	it('parseMcpServersJson - 空 mcpServers - 返回 no_servers', () => {
		expect(parseMcpServersJson(JSON.stringify({ mcpServers: {} }))).toEqual({
			ok: false,
			error: 'no_servers',
		});
	});

	it('parseMcpServersJson - 缺 command/url - 记入 skipped', () => {
		const text = JSON.stringify({
			mcpServers: {
				broken: { args: ['x'] },
				ok: { command: 'npx', args: ['-y', 'pkg'] },
			},
		});
		const r = parseMcpServersJson(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.result.servers).toHaveLength(1);
		expect(r.result.skipped).toEqual([{ key: 'broken', reason: 'missing_endpoint' }]);
	});
});

/**
 * @file src/core/mcp-config.ts
 * @description MCP Server 配置校验与 Claude/Cursor JSON 导入解析
 * @module core/mcp-config
 * @depends ../ports/mcp
 */

import type { McpServerConfig } from '../ports/mcp';
import { isValidMcpServerId } from '../ports/mcp';

export type McpConfigErrorCode =
	| 'invalid_id'
	| 'missing_url'
	| 'missing_command'
	| 'duplicate_id';

/**
 * 校验单条 MCP Server 配置。
 *
 * @param cfg - 待校验配置
 * @returns 错误码；合法返回 null
 */
export function validateMcpServerConfig(cfg: McpServerConfig): McpConfigErrorCode | null {
	if (!isValidMcpServerId(cfg.id)) return 'invalid_id';
	if (cfg.transport === 'http' && !cfg.url?.trim()) return 'missing_url';
	if (cfg.transport === 'stdio' && !cfg.command?.trim()) return 'missing_command';
	return null;
}

/**
 * 规范化配置：
 * 1. 把误塞进 command 的整行 shell 拆成 command + args
 * 2. 识别 `npx … mcp-remote <https://…>`（Claude/Cursor 配 Tavily Remote 常见写法）并改写为 HTTP
 *
 * @param cfg - 原始配置
 * @returns 新对象（可能与输入同内容）
 */
export function normalizeMcpServerConfig(cfg: McpServerConfig): McpServerConfig {
	if (cfg.transport === 'http') {
		return { ...cfg, url: cfg.url?.trim() };
	}

	let command = cfg.command?.trim() ?? '';
	let args = [...(cfg.args ?? [])];
	if (command.includes(' ') && args.length === 0) {
		const parts = command.split(/\s+/).filter(Boolean);
		command = parts[0] ?? '';
		args = parts.slice(1);
	}

	// 契约:Obsidian 桌面进程 PATH 常无 nvm/npx；Tavily Remote 用 HTTP 更稳
	const remoteUrl = extractMcpRemoteUrl(command, args);
	if (remoteUrl) {
		return {
			id: cfg.id,
			label: cfg.label,
			enabled: cfg.enabled,
			transport: 'http',
			url: remoteUrl,
			timeoutMs: cfg.timeoutMs,
		};
	}

	return {
		...cfg,
		command,
		args,
	};
}

/**
 * 从 npx mcp-remote 形态中抽出远端 URL。
 *
 * @param command - 可执行文件
 * @param args - 参数
 * @returns https URL 或 null
 */
function extractMcpRemoteUrl(command: string, args: string[]): string | null {
	const tokens = [command, ...args].filter(Boolean);
	const idx = tokens.findIndex((t) => t === 'mcp-remote');
	if (idx === -1) return null;
	for (let i = idx + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === undefined) continue;
		if (t.startsWith('http://') || t.startsWith('https://')) return t;
	}
	return null;
}

/** JSON 导入失败码 */
export type McpJsonImportErrorCode = 'invalid_json' | 'no_servers';

/** 单条导入跳过原因 */
export type McpJsonSkipReason = 'invalid_id' | 'missing_endpoint' | 'unsupported';

/**
 * Claude Desktop / Cursor / VS Code 风格 MCP JSON 的解析结果。
 */
export interface McpJsonImportResult {
	/** 可写入 settings 的服务器（不含密钥明文） */
	servers: McpServerConfig[];
	/** 跳过的原始 key 与原因 */
	skipped: Array<{ key: string; reason: McpJsonSkipReason }>;
	/** 出现过的 env 键名（值不入库，仅提示用户自行配置） */
	envKeysNoted: string[];
}

/**
 * 把外部配置 key 规范成合法 server id。
 *
 * @param raw - Claude/Cursor JSON 里的对象键
 * @returns 合法 id；无法规范则 null
 */
export function normalizeMcpServerId(raw: string): string | null {
	const id = raw
		.trim()
		.toLowerCase()
		.replace(/_/g, '-')
		.replace(/[^a-z0-9-]/g, '');
	return isValidMcpServerId(id) ? id : null;
}

/**
 * 解析 Claude Desktop / Cursor（`mcpServers`）或 VS Code（`servers`）JSON 文本。
 *
 * 设计要点:
 * - 只提取连接信息；`env` 的**值**不写入 settings，仅收集键名提示
 * - 同时支持 url（HTTP）与 command/args（stdio）
 * - 顶层也可直接是 servers 映射对象（无包装键）
 *
 * @param text - 用户粘贴的 JSON 字符串
 * @returns 成功时含 servers；失败时 error 码
 * @example
 * const r = parseMcpServersJson('{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}');
 */
export function parseMcpServersJson(
	text: string,
): { ok: true; result: McpJsonImportResult } | { ok: false; error: McpJsonImportErrorCode } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: 'invalid_json' };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, error: 'no_servers' };
	}

	const root = parsed as Record<string, unknown>;
	const mapCandidate = extractServerMap(root);
	if (!mapCandidate) {
		return { ok: false, error: 'no_servers' };
	}

	const servers: McpServerConfig[] = [];
	const skipped: McpJsonImportResult['skipped'] = [];
	const envKeysNoted: string[] = [];
	const seenIds = new Set<string>();

	for (const [rawKey, rawEntry] of Object.entries(mapCandidate)) {
		if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
			skipped.push({ key: rawKey, reason: 'unsupported' });
			continue;
		}
		const entry = rawEntry as Record<string, unknown>;
		const id = normalizeMcpServerId(rawKey);
		if (!id || seenIds.has(id)) {
			skipped.push({ key: rawKey, reason: 'invalid_id' });
			continue;
		}

		const url = typeof entry.url === 'string' ? entry.url.trim() : '';
		const command = typeof entry.command === 'string' ? entry.command.trim() : '';
		const args = Array.isArray(entry.args)
			? entry.args.filter((a): a is string => typeof a === 'string')
			: [];

		let cfg: McpServerConfig | null = null;
		if (url) {
			cfg = {
				id,
				label: rawKey,
				enabled: true,
				transport: 'http',
				url,
			};
		} else if (command) {
			cfg = {
				id,
				label: rawKey,
				enabled: true,
				transport: 'stdio',
				command,
				args,
			};
		} else {
			skipped.push({ key: rawKey, reason: 'missing_endpoint' });
			continue;
		}

		if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
			const keys = Object.keys(entry.env as Record<string, unknown>).filter(Boolean);
			if (keys.length > 0) {
				cfg.envKeys = keys;
				for (const k of keys) {
					if (!envKeysNoted.includes(k)) envKeysNoted.push(k);
				}
			}
		}

		const err = validateMcpServerConfig(cfg);
		if (err) {
			skipped.push({
				key: rawKey,
				reason: err === 'invalid_id' ? 'invalid_id' : 'missing_endpoint',
			});
			continue;
		}

		seenIds.add(id);
		servers.push(cfg);
	}

	if (servers.length === 0 && skipped.length === 0) {
		return { ok: false, error: 'no_servers' };
	}

	return { ok: true, result: { servers, skipped, envKeysNoted } };
}

/**
 * 从 JSON 根对象取出 server 映射。
 *
 * 优先 `mcpServers` / `servers`；否则若顶层本身是「id → {command|url}」也接受。
 *
 * @param root - 已 parse 的对象
 * @returns 映射或 null
 */
function extractServerMap(root: Record<string, unknown>): Record<string, unknown> | null {
	const wrapped = asEntryMap(root.mcpServers) ?? asEntryMap(root.servers);
	if (wrapped) return wrapped;
	// 关键路径:勿把 { mcpServers: {} } 空包装当成「mcpServers 是一台 server」
	if ('mcpServers' in root || 'servers' in root) return null;
	return asEntryMap(root);
}

/**
 * 判断是否为非空「serverId → 配置对象」映射。
 *
 * @param value - 候选值
 * @returns 映射或 null
 */
function asEntryMap(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length === 0) return null;
	const looksLikeEntries = keys.some((k) => {
		const v = obj[k];
		return v !== null && typeof v === 'object' && !Array.isArray(v);
	});
	return looksLikeEntries ? obj : null;
}

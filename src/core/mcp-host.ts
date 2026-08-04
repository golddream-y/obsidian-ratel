/**
 * @file src/core/mcp-host.ts
 * @description 多 MCP Server 编排：差分 sync、入册出册、熔断、dispose
 * @module core/mcp-host
 * @depends ../ports/mcp, ../adapters/mcp-client, ./mcp-tool-bridge, ./tool-registry
 */

import type {
	McpHostPort,
	McpServerConfig,
	McpServerStatus,
	McpTransport,
} from '../ports/mcp';
import {
	MCP_CIRCUIT_FAILURE_THRESHOLD,
	MCP_DEFAULT_TIMEOUT_MS,
	isValidMcpServerId,
	mcpToolPrefix,
} from '../ports/mcp';
import { McpClient } from '../adapters/mcp-client';
import { createMcpTool } from './mcp-tool-bridge';
import type { ToolRegistry } from './tool-registry';
import { devLogger } from '../logging/dev-logger';

export interface McpHostDeps {
	tools: ToolRegistry;
	/** 可注入：测试假 Transport；生产由 main 组装 http/stdio */
	createTransport: (cfg: McpServerConfig) => McpTransport;
	/** stdio 首次确认；HTTP 可直接 true */
	confirmSpawn: (cfg: McpServerConfig) => Promise<boolean>;
	getApiKey: (serverId: string) => string | null;
	getEnvValue: (key: string) => string;
}

interface Slot {
	config: McpServerConfig;
	status: McpServerStatus;
	client: McpClient | null;
	failures: number;
}

/**
 * MCP Host：按 settings 差分启停 Server，工具入 ToolRegistry。
 */
export class McpHost implements McpHostPort {
	private readonly deps: McpHostDeps;
	private slots = new Map<string, Slot>();

	constructor(deps: McpHostDeps) {
		this.deps = deps;
	}

	getStatus(serverId: string): McpServerStatus {
		return this.slots.get(serverId)?.status ?? 'offline';
	}

	/**
	 * 幂等同步：移除消失的、停用的下线、配置变更则重建。
	 */
	async sync(servers: McpServerConfig[]): Promise<void> {
		const wanted = new Map<string, McpServerConfig>();
		for (const s of servers) {
			if (!isValidMcpServerId(s.id)) {
				devLogger.warn('mcp', `忽略非法 server id: ${s.id}`);
				continue;
			}
			wanted.set(s.id, s);
		}

		for (const id of [...this.slots.keys()]) {
			if (!wanted.has(id)) await this.teardown(id);
		}

		for (const cfg of wanted.values()) {
			const prev = this.slots.get(cfg.id);
			if (!cfg.enabled) {
				if (prev) await this.teardown(cfg.id);
				this.slots.set(cfg.id, {
					config: cfg,
					status: 'offline',
					client: null,
					failures: 0,
				});
				continue;
			}
			if (prev && prev.status === 'online' && sameRuntimeConfig(prev.config, cfg)) {
				prev.config = cfg;
				continue;
			}
			await this.teardown(cfg.id);
			await this.bringUp(cfg);
		}
	}

	async stop(serverId: string): Promise<void> {
		const slot = this.slots.get(serverId);
		if (!slot) return;
		await this.teardown(serverId);
		this.slots.set(serverId, {
			config: { ...slot.config, enabled: false },
			status: 'offline',
			client: null,
			failures: 0,
		});
	}

	async dispose(): Promise<void> {
		for (const id of [...this.slots.keys()]) {
			await this.teardown(id);
		}
		this.slots.clear();
	}

	private async bringUp(cfg: McpServerConfig): Promise<void> {
		this.slots.set(cfg.id, {
			config: cfg,
			status: 'connecting',
			client: null,
			failures: 0,
		});
		try {
			if (cfg.transport === 'stdio') {
				const ok = await this.deps.confirmSpawn(cfg);
				if (!ok) {
					this.slots.set(cfg.id, {
						config: cfg,
						status: 'offline',
						client: null,
						failures: 0,
					});
					return;
				}
			}
			if (cfg.transport === 'http' && !cfg.url) {
				throw new Error(`MCP ${cfg.id} 缺少 url`);
			}
			if (cfg.transport === 'stdio' && !cfg.command) {
				throw new Error(`MCP ${cfg.id} 缺少 command`);
			}

			const transport = this.deps.createTransport(cfg);
			const client = new McpClient(cfg.id, transport);
			await client.initialize();
			const listed = await client.listTools();
			this.deps.tools.unregisterByPrefix(mcpToolPrefix(cfg.id));
			for (const info of listed) {
				const tool = createMcpTool(client, cfg.id, cfg.label, info);
				const original = tool.execute.bind(tool);
				tool.execute = async (args) => {
					const slot = this.slots.get(cfg.id);
					try {
						const r = await original(args);
						if (slot) slot.failures = 0;
						return r;
					} catch (e) {
						if (slot) {
							slot.failures++;
							if (slot.failures >= MCP_CIRCUIT_FAILURE_THRESHOLD) {
								devLogger.warn('mcp', `Server ${cfg.id} 熔断下线`);
								await this.teardown(cfg.id);
								this.slots.set(cfg.id, {
									config: cfg,
									status: 'error',
									client: null,
									failures: slot.failures,
								});
							}
						}
						throw e;
					}
				};
				this.deps.tools.register(tool);
			}
			this.slots.set(cfg.id, {
				config: cfg,
				status: 'online',
				client,
				failures: 0,
			});
		} catch (err) {
			devLogger.error('mcp', `Server ${cfg.id} 启动失败`, err);
			this.deps.tools.unregisterByPrefix(mcpToolPrefix(cfg.id));
			this.slots.set(cfg.id, {
				config: cfg,
				status: 'error',
				client: null,
				failures: 0,
			});
		}
	}

	private async teardown(serverId: string): Promise<void> {
		const slot = this.slots.get(serverId);
		this.deps.tools.unregisterByPrefix(mcpToolPrefix(serverId));
		if (slot?.client) {
			try {
				await slot.client.close();
			} catch (err) {
				devLogger.warn('mcp', `关闭 ${serverId} 失败`, err);
			}
		}
		this.slots.delete(serverId);
	}
}

function sameRuntimeConfig(a: McpServerConfig, b: McpServerConfig): boolean {
	return (
		a.transport === b.transport &&
		a.url === b.url &&
		a.command === b.command &&
		JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
		JSON.stringify(a.envKeys ?? []) === JSON.stringify(b.envKeys ?? []) &&
		(a.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS) === (b.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS)
	);
}

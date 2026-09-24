/**
 * @file src/tools/host-access.ts
 * @description 库外文件与本机命令。总闸默认关，开后走现有工具确认。
 * @module tools/host-access
 * @depends node:fs, utils/path-safety
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';
import { validateVaultPath } from '../utils/path-safety';

const MAX_READ_BYTES = 256 * 1024;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

async function canonicalPath(target: string): Promise<string> {
	const abs = path.resolve(target);
	try {
		return await realpath(abs);
	} catch {
		// 文件还不存在时，父目录的真实路径仍要用来判断是否在库内。
		const parent = path.dirname(abs);
		try {
			return path.join(await realpath(parent), path.basename(abs));
		} catch {
			return abs;
		}
	}
}

/**
 * 确认绝对路径落在当前库之外。符号链接按真实路径判断。
 *
 * @param absPath - 用户或模型给出的本机路径
 * @param vaultRoot - 当前库根
 * @returns 真实绝对路径
 * @throws 路径在库内时抛错
 */
export async function resolveOutsideVault(absPath: string, vaultRoot: string): Promise<string> {
	const root = await canonicalPath(vaultRoot);
	const real = await canonicalPath(absPath);
	if (real === root || real.startsWith(root + path.sep)) {
		throw new Error(tNow('error.tool.hostPathInsideVault'));
	}
	return real;
}

function requireEnabled(enabled: boolean): void {
	if (!enabled) throw new Error(tNow('error.tool.hostAccessOff'));
}

function gate(enabled: () => boolean): Pick<Tool, 'listed'> {
	return { listed: () => enabled() };
}

/**
 * 列出库外目录的一层条目。
 *
 * @param definition - 模型看到的 schema
 * @param deps - 总闸与库根
 */
export function createListHostDirTool(
	definition: ToolDefinition,
	deps: { enabled: () => boolean; vaultRoot: () => string },
): Tool {
	return {
		definition,
		readOnly: true,
		...gate(deps.enabled),
		async execute(args) {
			requireEnabled(deps.enabled());
			const raw = typeof args.path === 'string' ? args.path : '';
			const dir = await resolveOutsideVault(raw, deps.vaultRoot());
			const entries = await readdir(dir, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
		},
	};
}

/**
 * 读取库外文本文件。超过 256KB 拒绝。
 *
 * @param definition - 模型看到的 schema
 * @param deps - 总闸与库根
 */
export function createReadHostFileTool(
	definition: ToolDefinition,
	deps: { enabled: () => boolean; vaultRoot: () => string },
): Tool {
	return {
		definition,
		readOnly: true,
		...gate(deps.enabled),
		async execute(args) {
			requireEnabled(deps.enabled());
			const raw = typeof args.path === 'string' ? args.path : '';
			const file = await resolveOutsideVault(raw, deps.vaultRoot());
			const info = await stat(file);
			if (info.size > MAX_READ_BYTES) throw new Error(tNow('error.tool.hostFileTooLarge'));
			return { path: file, text: await readFile(file, 'utf-8') };
		},
	};
}

/**
 * 把库外文件原样拷进当前库。目标路径仍走库内校验。不改库外原文件。
 *
 * @param definition - 模型看到的 schema
 * @param deps - 总闸、库根、写入实现
 */
export function createImportHostFileTool(
	definition: ToolDefinition,
	deps: {
		enabled: () => boolean;
		vaultRoot: () => string;
		writeBinary: (vaultPath: string, data: Uint8Array) => Promise<void>;
	},
): Tool {
	return {
		definition,
		readOnly: false,
		...gate(deps.enabled),
		async execute(args) {
			requireEnabled(deps.enabled());
			const raw = typeof args.path === 'string' ? args.path : '';
			const dest = validateVaultPath(typeof args.dest === 'string' ? args.dest : '');
			const file = await resolveOutsideVault(raw, deps.vaultRoot());
			const info = await stat(file);
			if (info.size > MAX_IMPORT_BYTES) throw new Error(tNow('error.tool.hostFileTooLarge'));
			const data = await readFile(file);
			await deps.writeBinary(dest, data);
			return { dest, bytes: data.byteLength };
		},
	};
}

/**
 * 在本机执行一条 shell 命令。超时 30 秒。
 *
 * @param definition - 模型看到的 schema
 * @param deps - 总闸
 */
export function createRunHostCommandTool(
	definition: ToolDefinition,
	deps: { enabled: () => boolean },
): Tool {
	return {
		definition,
		readOnly: false,
		...gate(deps.enabled),
		async execute(args) {
			requireEnabled(deps.enabled());
			const command = typeof args.command === 'string' ? args.command.trim() : '';
			if (!command) throw new Error(tNow('error.tool.invalidArg', { label: 'command', type: 'empty' }));
			const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
				execFile('/bin/sh', ['-c', command], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, out, errOut) => {
					if (err) reject(err instanceof Error ? err : new Error('host command failed'));
					else resolve({ stdout: out, stderr: errOut });
				});
			});
			return { stdout, stderr };
		},
	};
}

/**
 * @file src/adapters/ecosystem-vault.ts
 * @description 通道 B IO — 每条路径先 validateEcosystemPath,不走 ObsidianVault
 * @module adapters/ecosystem-vault
 * @depends utils/path-safety
 */

import type { DataAdapter } from 'obsidian';
import { validateEcosystemPath, type EcosystemPathContext } from '../utils/path-safety';

/**
 * 生态通道文件系统。实现必须先校验路径;禁止 catch 通道 A 再放行。
 */
export interface EcosystemIo {
	exists(rel: string): Promise<boolean>;
	mkdir(rel: string): Promise<void>;
	writeText(rel: string, data: string): Promise<void>;
	writeBinary(rel: string, data: ArrayBuffer): Promise<void>;
	readText(rel: string): Promise<string>;
	removeRecursive(rel: string): Promise<void>;
}

/**
 * 基于 Obsidian DataAdapter 的通道 B 实现(BRAT 同款写盘路径)。
 */
export class AdapterEcosystemIo implements EcosystemIo {
	constructor(
		private adapter: DataAdapter,
		private ctx: () => EcosystemPathContext,
	) {}

	private gate(rel: string): string {
		return validateEcosystemPath(rel, this.ctx());
	}

	async exists(rel: string): Promise<boolean> {
		return this.adapter.exists(this.gate(rel));
	}

	async mkdir(rel: string): Promise<void> {
		await this.adapter.mkdir(this.gate(rel));
	}

	async writeText(rel: string, data: string): Promise<void> {
		await this.adapter.write(this.gate(rel), data);
	}

	async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
		const bin = this.adapter as DataAdapter & {
			writeBinary?: (p: string, data: ArrayBuffer) => Promise<void>;
		};
		const p = this.gate(rel);
		if (typeof bin.writeBinary === 'function') {
			await bin.writeBinary(p, data);
			return;
		}
		await this.adapter.write(p, new TextDecoder().decode(data));
	}

	async readText(rel: string): Promise<string> {
		return this.adapter.read(this.gate(rel));
	}

	async removeRecursive(rel: string): Promise<void> {
		const p = this.gate(rel);
		const ad = this.adapter as DataAdapter & { rmdir?: (path: string, recursive?: boolean) => Promise<void> };
		if (typeof ad.rmdir === 'function') {
			await ad.rmdir(p, true);
			return;
		}
		await this.adapter.remove(p);
	}
}

/**
 * 测试用内存盘 — 键为通道 B 校验后的相对路径。
 */
export class MemoryEcosystemIo implements EcosystemIo {
	readonly files = new Map<string, string>();

	constructor(private ctx: () => EcosystemPathContext) {}

	private gate(rel: string): string {
		return validateEcosystemPath(rel, this.ctx());
	}

	async exists(rel: string): Promise<boolean> {
		const p = this.gate(rel);
		if (this.files.has(p)) return true;
		const prefix = p.endsWith('/') ? p : `${p}/`;
		for (const k of this.files.keys()) {
			if (k.startsWith(prefix) || k === p) return true;
		}
		return false;
	}

	async mkdir(rel: string): Promise<void> {
		this.gate(rel);
	}

	async writeText(rel: string, data: string): Promise<void> {
		this.files.set(this.gate(rel), data);
	}

	async writeBinary(rel: string, data: ArrayBuffer): Promise<void> {
		this.files.set(this.gate(rel), new TextDecoder().decode(data));
	}

	async readText(rel: string): Promise<string> {
		const p = this.gate(rel);
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`missing ${p}`);
		return v;
	}

	async removeRecursive(rel: string): Promise<void> {
		const p = this.gate(rel);
		for (const k of [...this.files.keys()]) {
			if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
		}
	}
}

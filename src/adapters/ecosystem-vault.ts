/**
 * @file src/adapters/ecosystem-vault.ts
 * @description 通道 B IO — 每条路径先 validateEcosystemPath,不走 ObsidianVault
 * @module adapters/ecosystem-vault
 * @depends utils/path-safety
 */

import type { DataAdapter } from 'obsidian';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
	listPluginIds(configDir: string): Promise<string[]>;
	copyTree(srcRel: string, dstAbs: string): Promise<void>;
	restoreTree(srcAbs: string, dstRel: string): Promise<void>;
	rename(fromRel: string, toRel: string): Promise<void>;
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

	async listPluginIds(configDir: string): Promise<string[]> {
		const pluginsRel = `${configDir.replace(/\/$/, '')}/plugins`;
		const listing = await this.adapter.list(pluginsRel);
		return listing.folders.filter((name) => name !== 'ratel-vault');
	}

	async copyTree(srcRel: string, dstAbs: string): Promise<void> {
		const src = this.gate(srcRel);
		const walk = async (rel: string, dst: string): Promise<void> => {
			await mkdir(dst, { recursive: true });
			const listing = await this.adapter.list(rel);
			for (const file of listing.files) {
				const fileRel = rel ? `${rel}/${file}` : file;
				const content = await this.adapter.read(fileRel);
				const dest = path.join(dst, file);
				await mkdir(path.dirname(dest), { recursive: true });
				await writeFile(dest, content, 'utf-8');
			}
			for (const folder of listing.folders) {
				const childRel = rel ? `${rel}/${folder}` : folder;
				await walk(childRel, path.join(dst, folder));
			}
		};
		await walk(src, dstAbs);
	}

	async restoreTree(srcAbs: string, dstRel: string): Promise<void> {
		const dst = this.gate(dstRel);
		await this.removeRecursive(dstRel);
		const walk = async (dir: string, rel: string): Promise<void> => {
			for (const name of await readdir(dir)) {
				const p = path.join(dir, name);
				const r = rel ? `${rel}/${name}` : name;
				if ((await stat(p)).isDirectory()) {
					await walk(p, r);
				} else {
					const content = await readFile(p, 'utf-8');
					await this.adapter.write(`${dst}/${r}`, content);
				}
			}
		};
		await walk(srcAbs, '');
	}

	async rename(fromRel: string, toRel: string): Promise<void> {
		const from = this.gate(fromRel);
		const to = this.gate(toRel);
		const ad = this.adapter as DataAdapter & { rename?: (from: string, to: string) => Promise<void> };
		if (typeof ad.rename === 'function') {
			await ad.rename(from, to);
			return;
		}
		const data = await this.adapter.read(from);
		await this.adapter.write(to, data);
		await this.adapter.remove(from);
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

	async listPluginIds(configDir: string): Promise<string[]> {
		const ids = new Set<string>();
		const prefix = `${configDir}/plugins/`;
		for (const k of this.files.keys()) {
			if (!k.startsWith(prefix)) continue;
			const id = k.slice(prefix.length).split('/')[0];
			if (id && id !== 'ratel-vault') ids.add(id);
		}
		return [...ids];
	}

	async copyTree(srcRel: string, dstAbs: string): Promise<void> {
		const src = this.gate(srcRel);
		await mkdir(dstAbs, { recursive: true });
		for (const [k, v] of this.files) {
			if (k !== src && !k.startsWith(`${src}/`)) continue;
			const rel = k === src ? '_root' : k.slice(src.length + 1);
			const dest = path.join(dstAbs, rel);
			await mkdir(path.dirname(dest), { recursive: true });
			await writeFile(dest, v, 'utf-8');
		}
	}

	async restoreTree(srcAbs: string, dstRel: string): Promise<void> {
		const dst = this.gate(dstRel);
		await this.removeRecursive(dstRel);
		const walk = async (dir: string, rel: string): Promise<void> => {
			for (const name of await readdir(dir)) {
				const p = path.join(dir, name);
				const r = rel ? `${rel}/${name}` : name;
				if ((await stat(p)).isDirectory()) await walk(p, r);
				else this.files.set(`${dst}/${r}`, await readFile(p, 'utf-8'));
			}
		};
		await walk(srcAbs, '');
	}

	async rename(fromRel: string, toRel: string): Promise<void> {
		const from = this.gate(fromRel);
		const to = this.gate(toRel);
		const v = this.files.get(from);
		if (v === undefined) throw new Error(`missing ${from}`);
		this.files.set(to, v);
		this.files.delete(from);
	}
}

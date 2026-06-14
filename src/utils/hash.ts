/**
 * @file src/utils/hash.ts
 * @description SHA-256 工具 — 包装 Web Crypto API,Obsidian/Electron/Node 18+ 均可用
 * @module utils/hash
 */

/**
 * 计算字符串的 SHA-256 摘要,返回 64 位小写 hex 字符串。
 *
 * 关键路径:走 `crypto.subtle.digest` 不引入第三方加密库,减小主包体积。
 * Obsidian / Electron / Node 18+ 都内置了 `globalThis.crypto`,无需 polyfill。
 *
 * @param content - 任意 UTF-8 字符串。
 * @returns 64 字符的小写 hex 摘要。
 * @throws 在不支持 `crypto.subtle` 的环境(老旧 Node)上抛出。
 *
 * @example
 *   const hash = await sha256('hello');
 *   // => '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 */
export async function sha256(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

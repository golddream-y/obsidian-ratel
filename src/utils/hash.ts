/**
 * Compute SHA-256 hex digest of a string.
 * Uses Web Crypto API (available in Obsidian / Electron / Node 18+).
 */
export async function sha256(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

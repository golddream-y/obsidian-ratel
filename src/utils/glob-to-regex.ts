/**
 * @file src/utils/glob-to-regex.ts
 * @description 轻量 glob 子集转正则 — 支持 *、**、?(不含 {a,b})
 * @module utils/glob-to-regex
 */

const REGEX_SPECIAL = new Set(['\\', '.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']']);

/**
 * 将 glob 模式转为匹配 vault 相对路径的 RegExp。
 * 支持: `*`(单层)、`**`(跨层)、`?`(单字符)。不支持 `{a,b}` brace 扩展(v1)。
 */
export function globToRegex(glob: string): RegExp {
	let regex = '';
	let i = 0;
	while (i < glob.length) {
		const c = glob[i]!;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					regex += '(?:.*/)?';
					i += 3;
				} else {
					regex += '.*';
					i += 2;
				}
			} else {
				regex += '[^/]*';
				i += 1;
			}
		} else if (c === '?') {
			regex += '[^/]';
			i += 1;
		} else if (REGEX_SPECIAL.has(c)) {
			regex += `\\${c}`;
			i += 1;
		} else {
			regex += c;
			i += 1;
		}
	}
	return new RegExp(`^${regex}$`);
}

/** grep is_regex=false 时把 pattern 当字面量 */
export function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @file src/tools/grep.ts
 * @description grep 工具 — vault 全文精确/正则搜索
 * @module tools/grep
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { globToRegex, escapeRegExp } from '../utils/glob-to-regex';
import { isExcludedVaultPath, isUnderDirectory } from '../utils/path-safety';
import { optionalBoolean, optionalNumber, optionalString, requireString } from './validate-args';

export interface GrepMatch {
	file: string;
	line: number;
	column: number;
	match: string;
	before: string[];
	after: string[];
}

export function createGrepTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args) {
			const pattern = requireString(args, 'pattern', 'pattern');
			const isRegex = optionalBoolean(args, 'is_regex', true);
			const include = optionalString(args, 'include') ?? '**/*.md';
			const searchPath = optionalString(args, 'path') ?? '';
			const ignoreCase = optionalBoolean(args, 'ignore_case', true);
			const contextLines = optionalNumber(args, 'context_lines', 2);
			const maxResults = optionalNumber(args, 'max_results', 50);

			const includeRe = globToRegex(include);
			const regexSource = isRegex ? pattern : escapeRegExp(pattern);
			const flags = ignoreCase ? 'i' : '';
			const lineRe = new RegExp(regexSource, flags);

			const candidates = vault
				.listMarkdownFiles()
				.filter((f) => !isExcludedVaultPath(f))
				.filter((f) => isUnderDirectory(f, searchPath))
				.filter((f) => includeRe.test(f));

			const matches: GrepMatch[] = [];

			for (const file of candidates) {
				if (matches.length >= maxResults) break;
				const text = await vault.cachedRead(file);
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (matches.length >= maxResults) break;
					const lineText = lines[i]!;
					const m = lineRe.exec(lineText);
					if (!m) continue;
					const before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.trimEnd());
					const after = lines.slice(i + 1, i + 1 + contextLines).map((l) => l.trimEnd());
					matches.push({
						file,
						line: i + 1,
						column: m.index + 1,
						match: lineText.trimEnd(),
						before,
						after,
					});
				}
			}
			return matches;
		},
	};
}

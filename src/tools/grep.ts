/**
 * @file src/tools/grep.ts
 * @description grep 工具 — vault 全文精确/正则搜索
 * @module tools/grep
 */

import type { Tool } from '../core/tool-registry';
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

export function createGrepTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'grep',
			description:
				'在 vault 所有笔记中做精确文本或正则搜索。适用于查找特定汉字、代码片段、固定字符串;语义相关请用 search_vault。',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: '搜索模式(正则或字面量)' },
					is_regex: { type: 'boolean', description: '默认 true;false 时按字面量匹配' },
					include: { type: 'string', description: 'glob 过滤,默认 "**/*.md"' },
					path: { type: 'string', description: '限定搜索目录(相对 vault 根)' },
					ignore_case: { type: 'boolean', description: '默认 true' },
					context_lines: { type: 'number', description: '上下文行数,默认 2' },
					max_results: { type: 'number', description: '最大匹配数,默认 50' },
				},
				required: ['pattern'],
			},
		},
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

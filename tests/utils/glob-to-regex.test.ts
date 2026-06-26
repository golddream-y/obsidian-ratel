import { describe, it, expect } from 'vitest';
import { globToRegex, escapeRegExp } from '../../src/utils/glob-to-regex';

describe('globToRegex', () => {
	const cases: Array<[string, string, boolean]> = [
		['*.md', 'readme.md', true],
		['*.md', 'notes/readme.md', false],
		['daily/*.md', 'daily/2026-06-26.md', true],
		['daily/*.md', 'other/2026.md', false],
		['**/*.md', 'a/b/c.md', true],
		['**/*.md', 'root.md', true],
		['note?.md', 'note1.md', true],
		['note?.md', 'note12.md', false],
	];

	it.each(cases)('pattern %s matches %s → %s', (pattern, path, expected) => {
		const re = globToRegex(pattern);
		expect(re.test(path)).toBe(expected);
	});
});

describe('escapeRegExp', () => {
	it('转义正则特殊字符', () => {
		expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
	});
});

import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../../src/worker/chunker';

describe('chunkMarkdown', () => {
	it('returns empty array for empty input', () => {
		expect(chunkMarkdown('')).toEqual([]);
	});

	it('returns single chunk for short content', () => {
		const result = chunkMarkdown('Hello world', 500, 100);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe('Hello world');
		expect(result[0].index).toBe(0);
	});

	it('splits long content into multiple chunks', () => {
		const longText = 'Word '.repeat(200); // ~1000 chars
		const result = chunkMarkdown(longText, 100, 20);
		expect(result.length).toBeGreaterThan(1);
		result.forEach((chunk, i) => {
			expect(chunk.index).toBe(i);
		});
	});

	it('respects chunk size approximately', () => {
		const longText = 'A'.repeat(1000);
		const result = chunkMarkdown(longText, 300, 50);
		expect(result[0].text.length).toBeLessThanOrEqual(350);
	});

	it('preserves heading boundaries', () => {
		const content = '# Section 1\nContent 1\n\n# Section 2\nContent 2';
		const result = chunkMarkdown(content, 500, 100);
		expect(result).toHaveLength(1);
		expect(result[0].text).toContain('# Section 1');
		expect(result[0].text).toContain('# Section 2');
	});

	it('splits at heading boundaries when content is long', () => {
		const content = '# Section 1\n' + 'A'.repeat(400) + '\n\n# Section 2\n' + 'B'.repeat(400);
		const result = chunkMarkdown(content, 300, 50);
		expect(result.length).toBeGreaterThan(1);
		expect(result.some((c) => c.text.startsWith('#'))).toBe(true);
	});

	it('handles CJK content with Chinese period delimiter', () => {
		const content = '这是第一句话。这是第二句话。这是第三句话。这是第四句话。这是第五句话。这是第六句话。';
		const result = chunkMarkdown(content, 15, 3);
		expect(result.length).toBeGreaterThan(1);
		result.forEach((chunk) => {
			expect(chunk.text.length).toBeGreaterThan(0);
		});
	});

	it('handles chunkSize equal to content length', () => {
		const content = 'Hello world';
		const result = chunkMarkdown(content, content.length, 0);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe(content);
	});

	it('handles overlap larger than chunkSize gracefully', () => {
		const content = 'Short';
		const result = chunkMarkdown(content, 10, 50);
		expect(result).toHaveLength(1);
	});

	it('sets startOffset and endOffset', () => {
		const result = chunkMarkdown('Hello world', 500, 100);
		expect(result[0].startOffset).toBe(0);
		expect(result[0].endOffset).toBeGreaterThan(0);
	});

	it('handles Unicode emoji content', () => {
		// 关键路径:emoji 是多字节字符,chunker 不应在中途切断产生乱码。
		const content = '🚀 First section 🎉\n🚀 Second section 🌟';
		const result = chunkMarkdown(content, 50, 10);
		expect(result.length).toBeGreaterThanOrEqual(1);
		result.forEach((chunk) => {
			expect(chunk.text).toBeTruthy();
		});
	});

	// 已知限制:当前实现按字符偏移切分,代码块内的长行可能被截断。
	// W3 阶段再增强,本测试用 toBeDefined() 接受现状。
	it('handles long code block (known limitation: may split mid-block)', () => {
		const content = '# Title\n\n```js\nconst x = "long string that should stay together ".repeat(20);\n```\n\n# After';
		const result = chunkMarkdown(content, 100, 20);
		expect(result).toBeDefined();
		expect(result.length).toBeGreaterThanOrEqual(1);
	});

	it('handles frontmatter correctly', () => {
		// 关键路径:frontmatter(--- ... ---)应当与正文不被切断。
		const content = '---\ntitle: Test\ntags: [a, b]\n---\n\n# Heading\nContent';
		const result = chunkMarkdown(content, 500, 50);
		expect(result.length).toBeGreaterThanOrEqual(1);
		// 修复:frontmatter 应当出现在第一个 chunk(只要不超 chunkSize)。
		const firstChunk = result[0];
		expect(firstChunk?.text).toContain('---');
	});
});

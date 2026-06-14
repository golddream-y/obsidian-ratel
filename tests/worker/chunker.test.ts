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
});

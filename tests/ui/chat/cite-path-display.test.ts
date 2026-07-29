/**
 * @file tests/ui/chat/cite-path-display.test.ts
 * @description cite path 可读截断
 */
import { describe, it, expect } from 'vitest';
import { formatCitePath } from '../../../src/ui/chat/cite-path-display';

describe('formatCitePath', () => {
	it('formatCitePath - 短路径 - 原样返回', () => {
		expect(formatCitePath('a/b.md')).toBe('a/b.md');
	});

	it('formatCitePath - 长路径 - 保留文件名', () => {
		const p = 'Work/技术资料/AIGC方向/模型推理/很长的目录/密码本.md';
		const out = formatCitePath(p, 28);
		expect(out.endsWith('密码本.md') || out.includes('密码本.md')).toBe(true);
		expect(out.length).toBeLessThanOrEqual(30);
	});

	it('formatCitePath - 末段接近 maxLen - 不超过 maxLen', () => {
		// file 长 26, …/file 为 28, maxLen=27 → 应回退到 …+截断文件名
		const file = 'abcdefghijabcdefghijabcdef.md'; // 28
		const p = `dir/${file}`;
		const out = formatCitePath(p, 27);
		expect(out.length).toBeLessThanOrEqual(27);
		expect(out.includes('.md') || out.endsWith('f')).toBe(true);
	});
});

/**
 * @file tests/ui/motion/fade-align-contract.test.ts
 * @description FadeIn 源码须保持 flex 列，否则用户 align-self:flex-end 失效
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('fade-align-contract', () => {
	it('FadeIn.svelte - 样式 - 含 flex column 与 width 100%', () => {
		const src = readFileSync(
			resolve(__dirname, '../../../src/ui/motion/enter/FadeIn.svelte'),
			'utf8',
		);
		expect(src).toMatch(/display:\s*flex/);
		expect(src).toMatch(/flex-direction:\s*column/);
		expect(src).toMatch(/width:\s*100%/);
	});
});

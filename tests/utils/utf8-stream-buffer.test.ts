/**
 * @file tests/utils/utf8-stream-buffer.test.ts
 * @description 流式 UTF-8 拼接:半截汉字不得变成三个替换符
 * @module tests/utils/utf8-stream-buffer
 */

import { describe, it, expect } from 'vitest';
import { Utf8StreamBuffer, utf8IncompleteTailBytes } from '../../src/utils/utf8-stream-buffer';

describe('utf8IncompleteTailBytes', () => {
	it('完整汉字 - 三字节就 - 尾部不保留', () => {
		expect(utf8IncompleteTailBytes(Buffer.from('就', 'utf8'))).toBe(0);
	});

	it('半截汉字 - 只收到首字节 - 保留 1', () => {
		const full = Buffer.from('就', 'utf8');
		expect(utf8IncompleteTailBytes(full.subarray(0, 1))).toBe(1);
	});

	it('半截汉字 - 只收到前两字节 - 保留 2', () => {
		const full = Buffer.from('就', 'utf8');
		expect(utf8IncompleteTailBytes(full.subarray(0, 2))).toBe(2);
	});
});

describe('Utf8StreamBuffer', () => {
	it('push - 把就拆成两包 - 拼回就而不是三个替换符', () => {
		const full = Buffer.from('活跃市值不走强，就不出手', 'utf8');
		const jiou = Buffer.from('就', 'utf8');
		const idx = full.indexOf(jiou);
		expect(idx).toBeGreaterThan(0);

		const decoder = new Utf8StreamBuffer();
		const a = decoder.push(full.subarray(0, idx + 1));
		const b = decoder.push(full.subarray(idx + 1));
		const c = decoder.flush();
		const text = a + b + c;

		expect(text).toBe('活跃市值不走强，就不出手');
		expect(text).not.toContain('\uFFFD');
	});

	it('push - 逐包 toString 对照 - 拆包会产生三个替换符', () => {
		const jiou = Buffer.from('就', 'utf8');
		const naive = jiou.subarray(0, 1).toString('utf8') + jiou.subarray(1).toString('utf8');
		expect(naive).toBe('\uFFFD'.repeat(3));
	});
});

import { describe, it, expect } from 'vitest';
import { interpolate, validatePlaceholders } from '../../src/prompts/interpolate';

describe('interpolate', () => {
	it('替换已知占位符 - 正常替换', () => {
		expect(interpolate('你好 {{name}}', { name: 'Ratel' })).toBe('你好 Ratel');
	});

	it('未知占位符 - 保留原样', () => {
		expect(interpolate('{{missing}}', {})).toBe('{{missing}}');
	});
});

describe('validatePlaceholders', () => {
	it('全部存在 - 返回空数组', () => {
		expect(validatePlaceholders('{{a}} {{b}}', ['a', 'b'])).toEqual([]);
	});

	it('缺失占位符 - 返回缺失列表', () => {
		expect(validatePlaceholders('只有 {{a}}', ['a', 'toolList'])).toEqual(['toolList']);
	});
});

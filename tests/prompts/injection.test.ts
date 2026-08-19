import { describe, it, expect } from 'vitest';
import { INJECTION_SOURCE_IDS } from '../../src/prompts/injection/ids';
import { PromptInjector, truncateUtf8Bytes } from '../../src/prompts/injection/injector';

describe('INJECTION_SOURCE_IDS', () => {
	it('登记表 - 含 env/memory/skills 三源且无重复', () => {
		expect([...INJECTION_SOURCE_IDS]).toEqual(['env', 'memory', 'skills']);
		expect(new Set(INJECTION_SOURCE_IDS).size).toBe(INJECTION_SOURCE_IDS.length);
	});
});

describe('PromptInjector', () => {
	it('buildSections - 按注册序组装且跳过 null 段', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'env', build: () => '现在时间 10:00' });
		inj.register({ id: 'memory', build: () => null });
		inj.register({ id: 'skills', build: () => '## 可用技能' });
		const secs = inj.buildSections();
		expect(secs.map((s) => s.id)).toEqual(['env', 'skills']);
		expect(secs[0]!.content).toContain('10:00');
	});

	it('register - 重复 id 抛错', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'env', build: () => 'a' });
		expect(() => inj.register({ id: 'env', build: () => 'b' })).toThrow();
	});

	it('ownBudgetBytes - 超预算尾部截断', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'memory', build: () => 'x'.repeat(3000), ownBudgetBytes: 1024 });
		const [sec] = inj.buildSections();
		expect(Buffer.byteLength(sec!.content, 'utf-8')).toBe(1024);
	});

	it('buildSections - 空串段跳过不注入', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'env', build: () => '' });
		inj.register({ id: 'skills', build: () => '有内容' });
		const secs = inj.buildSections();
		expect(secs.map((s) => s.id)).toEqual(['skills']);
	});
});

describe('truncateUtf8Bytes', () => {
	it('中文按 UTF-8 字节截断 - 不超过上限', () => {
		const text = '忆'.repeat(2000); // 每字 3 字节,共 6000
		const out = truncateUtf8Bytes(text, 3000);
		expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(3000);
	});

	it('未超限 - 原样返回', () => {
		expect(truncateUtf8Bytes('abc', 100)).toBe('abc');
	});

	it('上限为 0 - 返回空串', () => {
		expect(truncateUtf8Bytes('abc', 0)).toBe('');
	});

	it('上限为负 - 返回空串(防御 subarray 尾部计数)', () => {
		expect(truncateUtf8Bytes('abcdef', -3)).toBe('');
	});
});

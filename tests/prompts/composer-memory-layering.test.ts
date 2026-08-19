// tests/prompts/composer-memory-layering.test.ts
import { describe, it, expect } from 'vitest';
import { composeMemorySystemPrompt } from '../../src/prompts/composer';
import { splitGlobalSections } from '../../src/core/memory-store';

const GLOBAL = `---
memory_type: global
updated: 2026-08-19T00:00:00.000Z
---

## 偏好 [pinned]
- 日记在 03_Daily/

## 当前项目
- ${'很长的项目说明。'.repeat(2000)}

## 关键决策 [pinned]
- 用 Obsidian`;
const KB = 1024;

describe('splitGlobalSections', () => {
	it('pinned 标记 - 段落完整进 pinned 桶', () => {
		const { pinned, normal } = splitGlobalSections(GLOBAL);
		expect(pinned).toContain('## 偏好');
		expect(pinned).toContain('日记在 03_Daily');
		expect(pinned).toContain('## 关键决策');
		expect(pinned).not.toContain('当前项目');
		expect(normal).toContain('当前项目');
	});

	it('无 pinned 标记 - 全部进 normal(向后兼容)', () => {
		const { pinned } = splitGlobalSections('## 偏好\n- 内容');
		expect(pinned).toBe('');
	});

	it('pinned 段内代码块 - 围栏中的 # 行不切断 pinned(修复回归)', () => {
		const content = [
			'## 输出风格 [pinned]',
			'回答用代码块示意:',
			'```bash',
			'# 这是 shell 注释,不是标题',
			'echo hi',
			'```',
			'- 先给结论',
		].join('\n');
		const { pinned, normal } = splitGlobalSections(content);
		// 围栏内的 # 行不得把后续正文误判出 pinned 桶。
		expect(pinned).toContain('# 这是 shell 注释,不是标题');
		expect(pinned).toContain('- 先给结论');
		expect(normal).toBe('');
	});
});

describe('composeMemorySystemPrompt 分层', () => {
	it('pinned 段 - 超预算也完整保留', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 1 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).toContain('日记在 03_Daily');
		expect(text).toContain('用 Obsidian');
	});

	it('normal 段 - 超 injectLimitBytes 截断', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 2 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).not.toContain('很长的项目说明。'.repeat(2000));
	});

	it('relatedTopics 非空 - 注入相关记忆块', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [{ name: 'obsidian', summary: '用户的 Obsidian 偏好' }],
		});
		expect(text).toContain('与当前问题可能相关');
		expect(text).toContain('obsidian');
		expect(text).toContain('用户的 Obsidian 偏好');
	});

	it('relatedTopics 为空 - 不出现空标题', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).not.toContain('与当前问题可能相关');
	});

	it('总预算超限 - 先砍 related 尾条再缩 normal,pinned 不动', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 2 * KB, // 极小总预算
			relatedTopics: [
				{ name: 't1', summary: 's1' },
				{ name: 't2', summary: 's2' },
			],
		});
		expect(text).toContain('日记在 03_Daily'); // pinned 永不砍
		expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(2 * KB + 2 * KB); // 总长受控(允许 wrapper 模板开销)
		expect(text).not.toContain('s2'); // related 尾条先被砍
	});

	it('总预算超限 - 砍掉尾条后即回预算内,head 条与 normal 保留', () => {
		// 动态构造预算:headOnly 大小 + 4B 余量;尾条 t2 摘要做大(远超 wrapper 开销)→
		// 带 t1+t2 时 body 必超限,砍 t2 后恰好回预算。
		// 断言产物与仅含 t1 时逐字一致 — 证明裁剪顺序是"先砍尾条、未波及 normal",而非全砍。
		const bigTail = 's2'.repeat(200); // ~600B,大于 wrapper 模板开销
		const headOnly = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 1024 * KB,
			relatedTopics: [{ name: 't1', summary: 's1' }],
		});
		const budget = Buffer.byteLength(headOnly, 'utf-8') + 4;
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: budget,
			relatedTopics: [
				{ name: 't1', summary: 's1' },
				{ name: 't2', summary: bigTail },
			],
		});
		expect(text).toContain('日记在 03_Daily'); // pinned 永不砍
		expect(text).toContain('t1'); // head 条保留 — 只砍了尾条
		expect(text).not.toContain('s2'); // 尾条先被砍
		expect(text).toBe(headOnly); // normal 未被波及,产物与仅含 t1 完全一致
	});

	it('不传 options - 兼容旧行为(20KB 截断全文)', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {});
		expect(text).toContain('## 偏好');
	});
});

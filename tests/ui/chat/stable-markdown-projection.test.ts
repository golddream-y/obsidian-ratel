/**
 * @file tests/ui/chat/stable-markdown-projection.test.ts
 * @description 流式尾部提升为稳定 Markdown 块的增量投影
 * @module tests/ui/chat/stable-markdown-projection
 */
import { describe, expect, it, vi } from 'vitest';
import {
	StableMarkdownProjection,
	type MarkdownSplitter,
} from '../../../src/ui/chat/stable-markdown-projection';

describe('StableMarkdownProjection', () => {
	it('update - 新段落出现 - 冻结前段且 block id 保持稳定', () => {
		const projection = new StableMarkdownProjection();
		let snapshot = projection.update('第一段。\n\n第二');
		expect(snapshot.blocks).toHaveLength(1);
		const firstId = snapshot.blocks[0]!.id;
		snapshot = projection.update('第一段。\n\n第二段继续');
		expect(snapshot.blocks[0]!.id).toBe(firstId);
		expect(snapshot.tail).toBe('第二段继续');
	});

	it('update - 纯单行 200 次追加 - 不调用 splitter', () => {
		const splitter: MarkdownSplitter = vi.fn(() => ({
			stableBlocks: [], tail: '', hasCrossBlockDependency: false,
		}));
		const projection = new StableMarkdownProjection(splitter);
		let content = '';
		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(80);
			projection.update(content);
		}
		expect(content).toHaveLength(16_000);
		expect(splitter).not.toHaveBeenCalled();
	});

	it('finish - 已有稳定块 - 只完成剩余尾部', () => {
		const projection = new StableMarkdownProjection();
		projection.update('第一段。\n\n第二');
		const before = projection.snapshot().blocks[0];
		const final = projection.finish('第一段。\n\n第二段。');
		expect(final.tail).toBe('');
		expect(final.blocks[0]).toEqual(before);
		expect(final.blocks.map((b) => b.source).join('')).toBe('第一段。\n\n第二段。');
	});

	it('update - 内容不再保持前缀 - 清空旧块并从新文本重建', () => {
		const projection = new StableMarkdownProjection();
		projection.update('旧一。\n\n旧二');
		const reset = projection.update('新内容');
		expect(reset.blocks).toEqual([]);
		expect(reset.tail).toBe('新内容');
	});

	it('update - 未解析引用使用 - 定义到达前不冻结前文', () => {
		const projection = new StableMarkdownProjection();
		const snapshot = projection.update('参考 [文档][ref]。\n\n下一段');
		expect(snapshot.blocks).toEqual([]);
		expect(snapshot.tail).toContain('[文档][ref]');
	});

	it('update - CRLF 输入 - 块偏移与归一化文本一致且 id 稳定', () => {
		const projection = new StableMarkdownProjection();
		const snapshot = projection.update('第一段。\r\n\r\n第二');
		expect(snapshot.blocks).toHaveLength(1);
		expect(snapshot.blocks[0]!.source).toBe('第一段。\n\n');
		expect(snapshot.blocks[0]!.end).toBe('第一段。\n\n'.length);
		const firstId = snapshot.blocks[0]!.id;
		const next = projection.update('第一段。\r\n\r\n第二段继续');
		expect(next.blocks[0]!.id).toBe(firstId);
		expect(next.tail).toBe('第二段继续');
	});

	it('snapshot - 块对象已冻结 - 外部修改被拒绝', () => {
		const projection = new StableMarkdownProjection();
		const snapshot = projection.update('第一段。\n\n第二');
		expect(Object.isFrozen(snapshot.blocks[0])).toBe(true);
		expect(() => {
			(snapshot.blocks[0] as { source?: string }).source = '篡改';
		}).toThrow(TypeError);
	});

	it('finish - 两次调用相同终态 - 不追加重复块', () => {
		const projection = new StableMarkdownProjection();
		const first = projection.finish('第一段。\n\n第二段。');
		const second = projection.finish('第一段。\n\n第二段。');
		expect(second.blocks).toEqual(first.blocks);
	});
});

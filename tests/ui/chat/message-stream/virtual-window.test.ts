/**
 * @file tests/ui/chat/message-stream/virtual-window.test.ts
 * @description 变量高度虚拟窗口、overscan、保留单元和高度补偿
 * @module tests/ui/chat/message-stream/virtual-window
 */
import { describe, expect, it } from 'vitest';
import {
	buildVirtualLayout,
	computeVirtualRange,
	compensateMeasuredHeight,
	offsetForUnit,
} from '../../../../src/ui/chat/message-stream/virtual-window';

const items = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` }));

describe('virtual window', () => {
	it('buildVirtualLayout - 混合实测与估算 - 生成连续前缀位置', () => {
		const layout = buildVirtualLayout(items, new Map([['u0', 120]]), () => 80);
		expect(layout.items[0]).toMatchObject({ top: 0, height: 120, bottom: 120 });
		expect(layout.items[1]).toMatchObject({ top: 120, height: 80, bottom: 200 });
		expect(layout.totalHeight).toBe(8040);
	});

	it('computeVirtualRange - 500px 视口与一屏 overscan - 只返回附近单元', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 500, 500, new Set());
		expect(range.start).toBeLessThanOrEqual(40);
		expect(range.end - range.start).toBeLessThanOrEqual(16);
		expect(range.paddingTop + range.paddingBottom).toBeGreaterThan(8000);
	});

	it('computeVirtualRange - 焦点单元在窗口外 - 扩展范围保留该单元', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 0, 500, 100, new Set(['u20']));
		expect(range.end).toBeGreaterThan(20);
	});

	it('compensateMeasuredHeight - 视口上方单元变高 - scrollTop 同量补偿', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		expect(compensateMeasuredHeight(layout, 'u2', 140, 1000)).toBe(1040);
		expect(compensateMeasuredHeight(layout, 'u20', 140, 1000)).toBe(1000);
	});

	it('offsetForUnit - 未挂载目标 - 仍按完整布局返回位置', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		expect(offsetForUnit(layout, 'u75')).toBe(7500);
		expect(offsetForUnit(layout, 'missing')).toBeNull();
	});

	it('computeVirtualRange - 两个选择端点 - 挂载两端之间连续范围', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 500, 100, new Set(['u10', 'u60']));
		expect(range.start).toBeLessThanOrEqual(10);
		expect(range.end).toBeGreaterThan(60);
	});

	it('offsetForUnit - 同消息多个单元 - 首单元 id 可作为消息锚点', () => {
		const layout = buildVirtualLayout([
			{ id: 'a:first' }, { id: 'a:middle' }, { id: 'a:last' },
		], new Map(), () => 100);
		expect(offsetForUnit(layout, 'a:first')).toBe(0);
	});
});

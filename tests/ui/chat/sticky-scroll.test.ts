/**
 * @file tests/ui/chat/sticky-scroll.test.ts
 * @description sticky-to-bottom 距离判定与瞬时滚底行为测试
 * @module tests/ui/chat/sticky-scroll
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isNearBottom, SCROLL_SNAP_CLASS, snapScrollToBottom } from '../../../src/ui/chat/sticky-scroll';

describe('isNearBottom', () => {
	it('isNearBottom - 距底部不超过默认阈值 - 返回 true', () => {
		expect(isNearBottom(820, 1000, 100)).toBe(true);
		expect(isNearBottom(819, 1000, 100)).toBe(false);
	});

	it('isNearBottom - 自定义阈值与内容未溢出 - 正确判定', () => {
		expect(isNearBottom(850, 1000, 100, 50)).toBe(true);
		expect(isNearBottom(0, 80, 100)).toBe(true);
	});
});

describe('snapScrollToBottom', () => {
	it('snapScrollToBottom - 滚底瞬间挂 class - 写完 scrollTop 后去掉', () => {
		const classes = new Set<string>();
		let classWhenScrolled = false;
		let scrollTop = 0;
		const el = {
			scrollHeight: 1200,
			classList: {
				add(name: string) {
					classes.add(name);
				},
				remove(name: string) {
					classes.delete(name);
				},
			},
			get scrollTop() {
				return scrollTop;
			},
			set scrollTop(value: number) {
				classWhenScrolled = classes.has(SCROLL_SNAP_CLASS);
				scrollTop = value;
			},
		} as unknown as HTMLElement;

		snapScrollToBottom(el);

		expect(scrollTop).toBe(1200);
		expect(classWhenScrolled).toBe(true);
		expect(classes.has(SCROLL_SNAP_CLASS)).toBe(false);
	});

	it('sticky-scroll - 源码不写 element.style - 满足商店 no-static-styles-assignment', () => {
		const path = fileURLToPath(new URL('../../../src/ui/chat/sticky-scroll.ts', import.meta.url));
		const source = readFileSync(path, 'utf8');
		expect(source).not.toMatch(/\.style\s*\./);
		expect(source).toContain(SCROLL_SNAP_CLASS);
	});
});

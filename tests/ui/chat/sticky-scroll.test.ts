/**
 * @file tests/ui/chat/sticky-scroll.test.ts
 * @description sticky-to-bottom 距离判定与瞬时滚底行为测试
 * @module tests/ui/chat/sticky-scroll
 */
import { describe, expect, it } from 'vitest';
import { isNearBottom, snapScrollToBottom } from '../../../src/ui/chat/sticky-scroll';

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
	it('snapScrollToBottom - 容器启用 smooth - 临时切 auto 后瞬时滚底并恢复', () => {
		let behavior = 'smooth';
		let behaviorWhenScrolled = '';
		let scrollTop = 0;
		const el = {
			scrollHeight: 1200,
			style: {
				get scrollBehavior() {
					return behavior;
				},
				set scrollBehavior(value: string) {
					behavior = value;
				},
			},
			get scrollTop() {
				return scrollTop;
			},
			set scrollTop(value: number) {
				behaviorWhenScrolled = behavior;
				scrollTop = value;
			},
		} as unknown as HTMLElement;

		snapScrollToBottom(el);

		expect(scrollTop).toBe(1200);
		expect(behaviorWhenScrolled).toBe('auto');
		expect(behavior).toBe('smooth');
	});
});

/**
 * @file tests/ui/components/secret-hint.test.ts
 * @description secret hint 重复渲染不得追加 DOM
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setLang } from '../../../src/i18n';
import { renderSecretHint, renderNoKeyNeeded } from '../../../src/ui/components/secret-hint';

function makeEl(): HTMLElement & { emptyCalls: number; childCount: number } {
	const el = {
		emptyCalls: 0,
		childCount: 0,
		empty() {
			this.emptyCalls += 1;
			this.childCount = 0;
		},
		createDiv(_opts?: unknown) {
			this.childCount += 1;
			return makeEl();
		},
		createEl(_tag: string, _opts?: unknown) {
			this.childCount += 1;
			return makeEl();
		},
		appendText(_t: string) {},
	};
	return el as unknown as HTMLElement & { emptyCalls: number; childCount: number };
}

describe('renderSecretHint', () => {
	beforeEach(() => setLang('zh'));

	it('renderSecretHint - 连续调用两次 - 每次先 empty 且子节点不累加', () => {
		const el = makeEl();
		const opts = { secretId: 'ratel-chat-openai-compatible', hasKey: false };
		renderSecretHint(el, opts);
		const after1 = el.childCount;
		renderSecretHint(el, opts);
		expect(el.emptyCalls).toBe(2);
		expect(el.childCount).toBe(after1);
		expect(after1).toBeGreaterThan(0);
	});

	it('renderNoKeyNeeded - 连续调用两次 - 每次先 empty', () => {
		const el = makeEl();
		renderNoKeyNeeded(el, '本地无需 Key');
		renderNoKeyNeeded(el, '本地无需 Key');
		expect(el.emptyCalls).toBe(2);
	});
});

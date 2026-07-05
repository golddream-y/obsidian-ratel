/**
 * @file tests/ui/confirm-modal.test.ts
 * @description confirm-modal 单元测试 — 危险操作确认 Modal 基本导出验证
 */

import { describe, it, expect, vi } from 'vitest';
// 关键路径:mock obsidian — Modal/Setting 用最小 stub,不依赖 DOM(document),
// 避免 node 环境下 document 未定义;mock 只为让 import 'obsidian' 可解析。
vi.mock('obsidian', () => ({
	Modal: class {
		contentEl = {};
		titleEl = { setText: () => {} };
		constructor(_app: unknown) {}
		open() {}
		close() {}
	},
	App: class {},
	Setting: class {
		constructor(_el: unknown) {}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText(cb: any) {
			// 关键路径:setValue/onChange 链式返回 text 自身(非 Setting),匹配实现 text.setValue('').onChange(...)
			const text: any = {
				setValue: () => text,
				onChange: () => text,
				inputEl: {},
			};
			cb(text);
			return this;
		}
		addButton(cb: any) {
			// 关键路径:setButtonText/setCta/setWarning/setDisabled/onClick 链式返回 btn 自身
			const btn: any = {
				setButtonText: () => btn,
				setCta: () => btn,
				setWarning: () => btn,
				setDisabled: () => btn,
				onClick: () => btn,
				buttonEl: {},
			};
			cb(btn);
			return this;
		}
	},
}));

import { showReindexConfirm, showDropIndexConfirm } from '../../src/ui/confirm-modal';

describe('showReindexConfirm', () => {
	it('导出为函数 - 不抛错', () => {
		const onConfirm = vi.fn();
		const app = {} as any;
		expect(typeof showReindexConfirm).toBe('function');
		// 调用不应抛错(mock obsidian 已接管 Modal)
		showReindexConfirm(app, onConfirm);
	});
});

describe('showDropIndexConfirm', () => {
	it('导出为函数 - 不抛错', () => {
		const onConfirm = vi.fn();
		const app = {} as any;
		expect(typeof showDropIndexConfirm).toBe('function');
		showDropIndexConfirm(app, onConfirm);
	});
});

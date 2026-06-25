import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 确保 NoticeMock 在 vi.mock 提升前完成初始化。
const { hide, setMessage, NoticeMock } = vi.hoisted(() => {
	const hide = vi.fn();
	const setMessage = vi.fn();
	const NoticeMock = vi.fn().mockImplementation(function (this: { hide: typeof hide; setMessage: typeof setMessage }, _msg: string) {
		this.hide = hide;
		this.setMessage = setMessage;
		return this;
	});
	return { hide, setMessage, NoticeMock };
});

vi.mock('obsidian', () => ({ Notice: NoticeMock }));

import { UserNotice } from '../../src/user-feedback/user-notice';

describe('UserNotice', () => {
	let notice: UserNotice;

	beforeEach(() => {
		vi.clearAllMocks();
		notice = new UserNotice();
	});

	it('toast - 创建 Notice', () => {
		notice.toast('你好');
		expect(NoticeMock).toHaveBeenCalledWith('你好', 4000);
	});

	it('toastProgress - update 调 setMessage', () => {
		const handle = notice.toastProgress('下载中 0%');
		handle.update('下载中 50%');
		expect(setMessage).toHaveBeenCalledWith('下载中 50%');
		handle.hide();
		expect(hide).toHaveBeenCalled();
	});
});

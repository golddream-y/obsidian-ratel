import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { UserStatus, DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('UserStatus', () => {
	let status: UserStatus;

	beforeEach(() => {
		status = new UserStatus();
	});

	it('初始 - 默认值', () => {
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});

	it('patch - 浅合并字段', () => {
		status.patch({ model: 'ready', indexDocCount: 42 });
		expect(get(status.statusBar$).model).toBe('ready');
		expect(get(status.statusBar$).indexDocCount).toBe(42);
		expect(get(status.statusBar$).embedding).toBe('loading');
	});

	it('reset - 恢复默认', () => {
		status.patch({ model: 'failed' });
		status.reset();
		expect(get(status.statusBar$)).toEqual(DEFAULT_USER_STATUS);
	});
});

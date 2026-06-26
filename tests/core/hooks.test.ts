import { describe, it, expect } from 'vitest';
import { HookRegistry } from '../../src/core/hooks';

describe('HookRegistry', () => {
	it('registers and runs hooks', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			calls.push('pre');
		});
		hooks.register('post-tool-use', async () => {
			calls.push('post');
		});

		await hooks.runVoid('pre-tool-use', { id: 'tc1', name: 'test', args: {} });
		await hooks.runVoid('post-tool-use', { id: 'tc1', name: 'test', args: {} });

		expect(calls).toEqual(['pre', 'post']);
	});

	it('runs multiple hooks in order', async () => {
		const hooks = new HookRegistry();
		const order: number[] = [];
		hooks.register('pre-tool-use', async () => {
			order.push(1);
		});
		hooks.register('pre-tool-use', async () => {
			order.push(2);
		});

		await hooks.runVoid('pre-tool-use', { id: 'tc1', name: 'test', args: {} });
		expect(order).toEqual([1, 2]);
	});

	it('continues running hooks after one throws', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			calls.push('first');
		});
		hooks.register('pre-tool-use', async () => {
			throw new Error('boom');
		});
		hooks.register('pre-tool-use', async () => {
			calls.push('third');
		});

		await hooks.runVoid('pre-tool-use', { id: 'tc1', name: 'test', args: {} });
		expect(calls).toEqual(['first', 'third']);
	});

	it('does nothing for unregistered phases', async () => {
		const hooks = new HookRegistry();
		await hooks.runVoid('nonexistent', { id: 'tc1', name: 'test', args: {} });
	});

	it('pre-tool-use - deny 阻断并返回原因', async () => {
		const hooks = new HookRegistry();
		hooks.register('pre-tool-use', async () => ({ allow: false, reason: 'blocked' }));
		const decision = await hooks.run('pre-tool-use', { id: '1', name: 'write_note', args: {} });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe('blocked');
	});

	it('pre-tool-use - deny 后不再执行后续 hook', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			calls.push('first');
			return { allow: false, reason: 'no' };
		});
		hooks.register('pre-tool-use', async () => {
			calls.push('second');
		});
		await hooks.run('pre-tool-use', { id: '1', name: 'x', args: {} });
		expect(calls).toEqual(['first']);
	});

	it('pre-tool-use - hook 抛错不阻断', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-tool-use', async () => {
			throw new Error('boom');
		});
		hooks.register('pre-tool-use', async () => {
			calls.push('ok');
		});
		const decision = await hooks.run('pre-tool-use', { id: '1', name: 'x', args: {} });
		expect(decision.allowed).toBe(true);
		expect(calls).toEqual(['ok']);
	});
});

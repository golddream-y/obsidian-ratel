import { describe, it, expect } from 'vitest';
import { HookRegistry } from '../../src/core/hooks';
import type { ToolCall } from '../../src/ports/llm';

describe('HookRegistry', () => {
	it('registers and runs hooks', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-write', async () => { calls.push('pre'); });
		hooks.register('post-write', async () => { calls.push('post'); });

		await hooks.run('pre-write', { id: 'tc1', name: 'test', args: {} });
		await hooks.run('post-write', { id: 'tc1', name: 'test', args: {} });

		expect(calls).toEqual(['pre', 'post']);
	});

	it('runs multiple hooks in order', async () => {
		const hooks = new HookRegistry();
		const order: number[] = [];
		hooks.register('pre-write', async () => { order.push(1); });
		hooks.register('pre-write', async () => { order.push(2); });

		await hooks.run('pre-write', { id: 'tc1', name: 'test', args: {} });
		expect(order).toEqual([1, 2]);
	});

	it('continues running hooks after one throws', async () => {
		const hooks = new HookRegistry();
		const calls: string[] = [];
		hooks.register('pre-write', async () => { calls.push('first'); });
		hooks.register('pre-write', async () => { throw new Error('boom'); });
		hooks.register('pre-write', async () => { calls.push('third'); });

		// Should not throw, and third hook should still run
		await hooks.run('pre-write', { id: 'tc1', name: 'test', args: {} });
		expect(calls).toEqual(['first', 'third']);
	});

	it('does nothing for unregistered phases', async () => {
		const hooks = new HookRegistry();
		// Should not throw
		await hooks.run('nonexistent', { id: 'tc1', name: 'test', args: {} });
	});
});

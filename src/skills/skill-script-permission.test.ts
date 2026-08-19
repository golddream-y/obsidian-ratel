/**
 * @file src/skills/skill-script-permission.test.ts
 * @description ScriptTrustGate 测试 — 白名单直行 / once / always 持久化 / deny
 * @module skills/skill-script-permission.test
 */

import { describe, it, expect } from 'vitest';
import { ScriptTrustGate, type TrustConfirmDecision } from './skill-script-permission';

function makeGate(opts: {
	trusted?: string[];
	decision?: TrustConfirmDecision;
} = {}) {
	const persisted: string[] = [];
	const gate = new ScriptTrustGate({
		isTrusted: (id) => opts.trusted?.includes(id) ?? false,
		confirm: async () => opts.decision ?? 'deny',
		persistTrust: (id) => persisted.push(id),
	});
	return { gate, persisted };
}

describe('ScriptTrustGate', () => {
	it('白名单内 - 直接放行 - 不弹确认不持久化', async () => {
		const { gate, persisted } = makeGate({ trusted: ['a/b.js'], decision: 'deny' });
		await expect(gate.check('a/b.js')).resolves.toBe('run');
		expect(persisted).toEqual([]);
	});

	it('白名单外选 once - 本次放行 - 不写入白名单', async () => {
		const { gate, persisted } = makeGate({ decision: 'once' });
		await expect(gate.check('x/y.js')).resolves.toBe('run');
		expect(persisted).toEqual([]);
	});

	it('白名单外选 always - 放行并持久化', async () => {
		const { gate, persisted } = makeGate({ decision: 'always' });
		await expect(gate.check('x/y.js')).resolves.toBe('run');
		expect(persisted).toEqual(['x/y.js']);
	});

	it('用户拒绝 - 返回 deny', async () => {
		const { gate } = makeGate({ decision: 'deny' });
		await expect(gate.check('x/y.js')).resolves.toBe('deny');
	});
});

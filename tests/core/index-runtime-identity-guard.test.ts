/**
 * @file tests/core/index-runtime-identity-guard.test.ts
 * @description 写运行时身份守卫 — 同指纹幂等、异指纹拒绝、释放语义
 * @module tests/core/index-runtime-identity-guard
 */

import { describe, expect, it, vi } from 'vitest';
import { IndexRuntimeIdentityError, IndexRuntimeIdentityGuard } from '../../src/core/index-runtime-identity-guard';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('写运行时身份守卫', () => {
	it('登记后 - 指纹可查 - 重复登记同指纹幂等', () => {
		const guard = new IndexRuntimeIdentityGuard();
		const first = vi.fn();
		guard.register(A, first);
		guard.register(A, first);
		expect(guard.activeFingerprint).toBe(A);
		expect(guard.busy).toBe(true);
	});

	it('异指纹登记 - 立即以专用错误码拒绝 - 不撤销旧运行时', () => {
		const guard = new IndexRuntimeIdentityGuard();
		const release = vi.fn();
		guard.register(A, release);
		expect(() => guard.register(B)).toThrow(IndexRuntimeIdentityError);
		try {
			guard.register(B);
		} catch (error) {
			expect(error).toMatchObject({ code: 'config-identity-conflict', activeFingerprint: A, requestedFingerprint: B });
		}
		expect(release).not.toHaveBeenCalled();
		expect(guard.activeFingerprint).toBe(A);
	});

	it('释放后 - 位置空出 - 允许新配置登记', () => {
		const guard = new IndexRuntimeIdentityGuard();
		const releaseA = vi.fn();
		guard.register(A, releaseA);
		guard.release(A);
		expect(releaseA).toHaveBeenCalledTimes(1);
		expect(guard.busy).toBe(false);
		expect(() => guard.register(B)).not.toThrow();
		expect(guard.activeFingerprint).toBe(B);
	});

	it('指纹不符的释放 - 被忽略 - 不误清他人运行时', () => {
		const guard = new IndexRuntimeIdentityGuard();
		const release = vi.fn();
		guard.register(A, release);
		guard.release(B);
		expect(guard.activeFingerprint).toBe(A);
		expect(release).not.toHaveBeenCalled();
	});

	it('空指纹 - 拒绝登记 - 不制造无法释放的占用', () => {
		const guard = new IndexRuntimeIdentityGuard();
		expect(() => guard.register('')).toThrow('配置指纹不能为空');
		expect(guard.busy).toBe(false);
	});
});

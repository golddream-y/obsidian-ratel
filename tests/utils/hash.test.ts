import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/utils/hash';

describe('sha256', () => {
	it('produces correct SHA-256 hex digest for "hello"', async () => {
		const result = await sha256('hello');
		expect(result).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
	});

	it('produces different digests for different inputs', async () => {
		const a = await sha256('foo');
		const b = await sha256('bar');
		expect(a).not.toBe(b);
	});

	it('produces same digest for same input (idempotent)', async () => {
		const a = await sha256('test content');
		const b = await sha256('test content');
		expect(a).toBe(b);
	});

	it('handles empty string', async () => {
		const result = await sha256('');
		expect(result).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('produces 64-character hex string', async () => {
		const result = await sha256('any input');
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});
});

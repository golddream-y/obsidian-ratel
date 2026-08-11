/**
 * @file tests/ui/orbs/map-orb-state.test.ts
 * @description Ratel 忙态 → OrbState 映射与预设尺寸回退单测
 * @module tests/ui/orbs/map-orb-state
 */

import { describe, expect, it } from 'vitest';
import { mapOrbState } from '../../../src/ui/orbs/map-orb-state';
import { coerceOrbSize, resolvePreset } from '../../../src/ui/orbs/presets';

describe('mapOrbState', () => {
	it('mapOrbState - thinking - 映射为 composing', () => {
		expect(mapOrbState('thinking')).toBe('composing');
	});

	it('mapOrbState - tool - 映射为 working', () => {
		expect(mapOrbState('tool')).toBe('working');
	});

	it('mapOrbState - search - 映射为 searching', () => {
		expect(mapOrbState('search')).toBe('searching');
	});

	it('mapOrbState - index - 映射为 connecting', () => {
		expect(mapOrbState('index')).toBe('connecting');
	});

	it('mapOrbState - compact - 映射为 weaving', () => {
		expect(mapOrbState('compact')).toBe('weaving');
	});

	it('mapOrbState - idle - 映射为 breathing', () => {
		expect(mapOrbState('idle')).toBe('breathing');
	});
});

describe('coerceOrbSize / resolvePreset', () => {
	it('coerceOrbSize - 行内小尺寸 - 回退到 20', () => {
		expect(coerceOrbSize(12)).toBe(20);
		expect(coerceOrbSize(14)).toBe(20);
		expect(coerceOrbSize(20)).toBe(20);
	});

	it('coerceOrbSize - 大尺寸 - 回退到 64', () => {
		expect(coerceOrbSize(42)).toBe(64);
		expect(coerceOrbSize(64)).toBe(64);
	});

	it('resolvePreset - 非标定尺寸 14 - 不抛错', () => {
		expect(() => resolvePreset('composing', 14)).not.toThrow();
		expect(resolvePreset('working', 12).mode).toBe('orbits');
	});
});

/**
 * @file tests/ui/motion/soft-aurora-fallback.test.ts
 * @description SoftAurora 降级策略与空态挂载配置
 * @module tests/ui/motion/soft-aurora-fallback
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shouldUseAuroraFallback } from '../../../src/ui/motion/empty/aurora-fallback';

describe('soft-aurora-fallback', () => {
	it('shouldUseAuroraFallback - enabled 且无 webgl2 - true', () => {
		expect(shouldUseAuroraFallback(true, false)).toBe(true);
	});

	it('shouldUseAuroraFallback - enabled 且有 webgl2 - false', () => {
		expect(shouldUseAuroraFallback(true, true)).toBe(false);
	});

	it('shouldUseAuroraFallback - 关闭动效 - true（走静态，不挂 GL）', () => {
		expect(shouldUseAuroraFallback(false, true)).toBe(true);
	});

	it('EmptyStage - motionOn - 挂载 SoftAurora 而非旧 Aurora', () => {
		const emptyStagePath = fileURLToPath(
			new URL('../../../src/ui/motion/empty/EmptyStage.svelte', import.meta.url),
		);
		const source = readFileSync(emptyStagePath, 'utf8');

		expect(source).toContain("import SoftAuroraBackdrop from './SoftAuroraBackdrop.svelte'");
		expect(source).toContain('<SoftAuroraBackdrop');
		expect(source).not.toContain('<AuroraBackdrop');
	});
});

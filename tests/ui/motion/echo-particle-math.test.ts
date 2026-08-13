/**
 * @file tests/ui/motion/echo-particle-math.test.ts
 * @description Echo / Particle 文字动效纯函数
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { echoDirectionDelta, echoEase, echoLayerStyle } from '../../../src/ui/motion/title/echo-math';
import {
	cssAlphabeticBaseline,
	gatherProgress,
	glyphSampleLayout,
	hash01,
	lerp,
	particleCanvasOffset,
	particleStart,
} from '../../../src/ui/motion/title/particle-math';

describe('echo-math', () => {
	it('echoDirectionDelta - down - 向下位移', () => {
		expect(echoDirectionDelta('down')).toEqual({ x: 0, y: 1 });
	});

	it('echoEase - ease-out - 中点大于线性', () => {
		expect(echoEase('ease-out', 0.5)).toBeGreaterThan(0.5);
	});

	it('echoLayerStyle - 入场结束 - 位移收拢到 0', () => {
		const layer = echoLayerStyle(0, 8, 1, 24, 0.24, 0.72, 3, 'down', 'ease-out');
		expect(layer.x).toBe(0);
		expect(layer.y).toBe(0);
	});

	it('echoLayerStyle - 入场开始 - 深层比浅层位移更大', () => {
		const near = echoLayerStyle(0, 8, 0, 24, 0.24, 0.72, 3, 'down', 'linear');
		const deep = echoLayerStyle(7, 8, 0, 24, 0.24, 0.72, 3, 'down', 'linear');
		expect(Math.abs(deep.y)).toBeGreaterThan(Math.abs(near.y));
		expect(deep.opacity).toBeLessThan(near.opacity);
	});
});

describe('particle-math', () => {
	it('hash01 - 同输入 - 同输出且落在 0-1', () => {
		expect(hash01(3)).toBe(hash01(3));
		expect(hash01(3)).toBeGreaterThanOrEqual(0);
		expect(hash01(3)).toBeLessThan(1);
	});

	it('particleStart - 散射点落在 scatter 半径内且不贴目标', () => {
		const start = particleStart(4, 10, 10, 20);
		const dist = Math.hypot(start.x - 10, start.y - 10);
		expect(dist).toBeGreaterThanOrEqual(20 * 0.68 - 1e-6);
		expect(dist).toBeLessThanOrEqual(20 + 1e-6);
	});

	it('particleStart - 指定中心 - 从远处飞向目标', () => {
		const start = particleStart(2, 40, 12, 80, 20, 10, 0.7);
		const dist = Math.hypot(start.x - 20, start.y - 10);
		expect(dist).toBeGreaterThanOrEqual(80 * 0.7 - 1e-6);
		expect(dist).toBeLessThanOrEqual(80 + 1e-6);
	});

	it('gatherProgress - 延迟内为 0，结束后为 1', () => {
		expect(gatherProgress(50, 100, 400)).toBe(0);
		expect(gatherProgress(600, 100, 400)).toBe(1);
	});

	it('gatherProgress - 中段 - cubic-out 快于线性', () => {
		expect(gatherProgress(300, 100, 400)).toBeGreaterThan(0.5);
	});

	it('lerp - 中点 - 取两端平均', () => {
		expect(lerp(0, 10, 0.5)).toBe(5);
	});

	it('cssAlphabeticBaseline - line-height 等于 ascent+descent - 基线即 ascent', () => {
		expect(cssAlphabeticBaseline(28, 22, 6)).toBe(22);
	});

	it('cssAlphabeticBaseline - 行框矮于字身 - 负 leading 仍给出 CSS 基线', () => {
		expect(cssAlphabeticBaseline(28, 26, 8)).toBe(23);
	});

	it('glyphSampleLayout - 用真实 ink box 而非 0.8em 魔数', () => {
		const layout = glyphSampleLayout({
			width: 80,
			actualBoundingBoxLeft: 2.2,
			actualBoundingBoxRight: 78,
			actualBoundingBoxAscent: 21.4,
			actualBoundingBoxDescent: 6.1,
		});
		expect(layout.originX).toBe(3);
		expect(layout.originY).toBe(22);
		expect(layout.width).toBe(81);
		expect(layout.height).toBe(29);
	});

	it('particleCanvasOffset - 采样原点映射到 CSS 基线 - 与明文重合', () => {
		expect(particleCanvasOffset(140, 0, 0, 22, 0, 22)).toEqual({ left: -140, top: -140 });
		expect(particleCanvasOffset(140, 0, 0, 22, 4, 22).left).toBe(-144);
		expect(particleCanvasOffset(140, 0, 0, 22, 0, 18).top).toBe(-136);
	});
});

describe('ParticleText 采样契约', () => {
	it('ParticleText - 用 DOM 基线探针叠层，收束后同画布写字', () => {
		const path = fileURLToPath(
			new URL('../../../src/ui/motion/title/ParticleText.svelte', import.meta.url),
		);
		const source = readFileSync(path, 'utf8');
		expect(source).toContain('letterSpacing');
		expect(source).toContain('glyphSampleLayout');
		expect(source).toContain('measureCssAlphabeticBaseline');
		expect(source).toContain('ratel-particle-baseline-probe');
		expect(source).toContain('particleCanvasOffset');
		expect(source).toContain('display: inline-block');
		expect(source).toContain('fillText');
		expect(source).not.toContain('cssAlphabeticBaseline(');
		expect(source).not.toContain('fontSizePx * 0.8');
	});
});

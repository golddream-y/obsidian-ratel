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

	it('Orb shader - 含能量球与顶角圆', () => {
		const path = fileURLToPath(
			new URL('../../../src/ui/motion/empty/orb-shaders.ts', import.meta.url),
		);
		const source = readFileSync(path, 'utf8');
		expect(source).toContain('extractAlpha');
		expect(source).toContain('yFromTop');
		expect(source).toContain('fragColor = vec4(col.rgb, col.a)');
		expect(source).toContain('min(iResolution.x, iResolution.y)');
	});

	it('Orb canvas - 非预乘 alpha', () => {
		const path = fileURLToPath(
			new URL('../../../src/ui/motion/empty/OrbBackdrop.svelte', import.meta.url),
		);
		const source = readFileSync(path, 'utf8');
		expect(source).toContain('premultipliedAlpha: false');
		expect(source).toContain('SRC_ALPHA');
		expect(source).not.toContain('mask-image');
	});

	it('ChatView - 空会话 - Orb 铺舞台且词标在 EmptyStage', () => {
		const chatViewPath = fileURLToPath(
			new URL('../../../src/ui/chat/ChatView.svelte', import.meta.url),
		);
		const emptyStagePath = fileURLToPath(
			new URL('../../../src/ui/motion/empty/EmptyStage.svelte', import.meta.url),
		);
		const stylesPath = fileURLToPath(new URL('../../../styles.css', import.meta.url));
		const viewPath = fileURLToPath(new URL('../../../src/ui/chat/ChatView.ts', import.meta.url));
		const chatSource = readFileSync(chatViewPath, 'utf8');
		const emptySource = readFileSync(emptyStagePath, 'utf8');
		const stylesSource = readFileSync(stylesPath, 'utf8');
		const viewSource = readFileSync(viewPath, 'utf8');

		expect(chatSource).toContain('is-empty-session');
		expect(chatSource).toContain('has-empty-motion');
		expect(chatSource).toContain('position: absolute');
		expect(chatSource).toContain('OrbBackdrop');
		expect(chatSource).not.toContain('LineWavesBackdrop');
		expect(chatSource).toContain('#e8c49a');
		expect(chatSource).toContain('backgroundColor="#000000"');
		expect(chatSource).toContain('ratel-empty-aurora');
		expect(emptySource).toContain('ParticleText');
		expect(emptySource).toContain('ratel-empty-brand');
		expect(emptySource).toContain('justify-content: center');
		expect(emptySource).toContain('gap: 14px');
		expect(emptySource).toContain('padding-right: 0.18em');
		expect(emptySource).not.toContain('EchoText');
		expect(emptySource).not.toContain('SoftAuroraBackdrop');
		expect(emptySource).not.toContain('LineWavesBackdrop');
		expect(emptySource).not.toContain('OrbBackdrop');
		expect(emptySource).not.toContain('<AuroraBackdrop');
		expect(viewSource).toContain('this.contentEl');
		expect(stylesSource).not.toContain('ratel-empty-wash');
		expect(stylesSource).not.toContain(':has(.ratel-chat.is-empty-session)::before');
		expect(chatSource).toContain('EchoText');
		expect(chatSource).not.toContain('ParticleText');
		expect(chatSource).toContain('echoEnterToken');
		expect(chatSource).not.toContain('particleEnterToken');
		expect(chatSource).not.toContain('chipAnim');
		expect(stylesSource).toContain('.view-header');
		expect(stylesSource).toContain('background: transparent !important');
	});

	it('EmptyStage - 玻璃托盘 - 强模糊铜边而非实色灰底', () => {
		const path = fileURLToPath(
			new URL('../../../src/ui/motion/empty/EmptyStage.svelte', import.meta.url),
		);
		const source = readFileSync(path, 'utf8');
		expect(source).toContain('-webkit-backdrop-filter');
		expect(source).toContain('blur(28px)');
		expect(source).toContain('saturate(');
		expect(source).toContain('#e8c49a');
		expect(source).not.toContain('blur(12px)');
		expect(source).not.toMatch(/background-primary\) 72%/);
	});

	it('RotateHint - 网格叠层给满宽 - 窄侧栏折行且不竖排', () => {
		const path = fileURLToPath(
			new URL('../../../src/ui/motion/empty/RotateHint.svelte', import.meta.url),
		);
		const source = readFileSync(path, 'utf8');
		expect(source).toContain('display: grid');
		expect(source).toContain('grid-area: 1 / 1');
		expect(source).toContain('width: 100%');
		expect(source).not.toContain('width: 18rem');
		expect(source).not.toContain('white-space: nowrap');
	});

	it('EmptyStage / WelcomeBlurText - 随侧栏变宽而不锁死 18rem 单行', () => {
		const emptyPath = fileURLToPath(
			new URL('../../../src/ui/motion/empty/EmptyStage.svelte', import.meta.url),
		);
		const welcomePath = fileURLToPath(
			new URL('../../../src/ui/motion/empty/WelcomeBlurText.svelte', import.meta.url),
		);
		const emptySource = readFileSync(emptyPath, 'utf8');
		const welcomeSource = readFileSync(welcomePath, 'utf8');
		expect(emptySource).toContain('width: min(22rem, 100%)');
		expect(emptySource).toContain('flex-wrap: wrap');
		expect(welcomeSource).toContain('max-width: 100%');
		expect(welcomeSource).toContain('is-word-gap');
		expect(welcomeSource).toContain('margin-right: 0.33em');
		expect(welcomeSource).not.toContain('white-space: nowrap');
		expect(welcomeSource).not.toContain('&nbsp;');
	});
});

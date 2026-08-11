/**
 * @file src/ui/orbs/types.ts
 * @description Thinking Orb 公开类型（移植自 thinking-orbs，无 React）
 * @module ui/orbs/types
 */

/**
 * 九种 agent 忙碌态动画。
 */
export type OrbState =
	| 'working'
	| 'searching'
	| 'solving'
	| 'listening'
	| 'connecting'
	| 'weaving'
	| 'composing'
	| 'breathing'
	| 'shaping';

/** 调好的两档尺寸：64 头像级 / 20 行内级（不是简单缩放）。 */
export type OrbSize = 64 | 20;

/** 主题：auto 跟 Obsidian 明暗；也可钉死。 */
export type OrbTheme = 'auto' | 'dark' | 'light';

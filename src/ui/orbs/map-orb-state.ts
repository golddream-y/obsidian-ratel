/**
 * @file src/ui/orbs/map-orb-state.ts
 * @description Ratel 忙态 → OrbState 映射
 * @module ui/orbs/map-orb-state
 * @depends ./types
 */

import type { OrbState } from './types';

export type RatelOrbBusyKind =
	| 'thinking'
	| 'tool'
	| 'search'
	| 'index'
	| 'compact'
	| 'idle';

/**
 * 把 Ratel UI 忙态映射到 orb 动画动词。
 *
 * @param kind - 忙态种类
 */
export function mapOrbState(kind: RatelOrbBusyKind): OrbState {
	switch (kind) {
		case 'search':
			return 'searching';
		case 'tool':
			return 'working';
		case 'index':
			return 'connecting';
		case 'compact':
			return 'weaving';
		case 'thinking':
			return 'composing';
		case 'idle':
		default:
			return 'breathing';
	}
}

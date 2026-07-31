/**
 * @file tests/ui/memory-panel/open-memory-modal.test.ts
 * @description openMemoryModal 单例判定
 */
import { describe, it, expect, vi } from 'vitest';

// 关键路径:MemoryModal import MemoryPanel.svelte,vitest 没配 svelte 解析器,需 stub
vi.mock('../../../src/ui/memory-panel/MemoryPanel.svelte', () => ({
	default: class {},
}));

import { shouldCreateMemoryModal } from '../../../src/ui/memory-panel/MemoryModal';

describe('shouldCreateMemoryModal', () => {
	it('shouldCreateMemoryModal - 无实例 - 允许新建', () => {
		expect(shouldCreateMemoryModal(null)).toBe(true);
	});

	it('shouldCreateMemoryModal - 已有实例 - 不再新建', () => {
		expect(shouldCreateMemoryModal({} as never)).toBe(false);
	});

	it('shouldCreateMemoryModal - onClosed 清引用后 - 允许再次新建', () => {
		// 模拟 openMemoryModal 的 onClosed：关窗后 plugin.memoryModal = null
		let current: object | null = {};
		expect(shouldCreateMemoryModal(current as never)).toBe(false);
		current = null;
		expect(shouldCreateMemoryModal(current)).toBe(true);
	});
});

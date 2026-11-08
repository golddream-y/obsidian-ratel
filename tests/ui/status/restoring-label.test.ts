/**
 * @file tests/ui/status/restoring-label.test.ts
 * @description 恢复进度文案 — 抽屉左侧大字必须显示已核对/总数
 * @module tests/ui/status/restoring-label
 */

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/i18n/zh';
import { en } from '../../../src/i18n/en';

describe('恢复进度文案', () => {
	it('中文带已核对数与总数，能替换掉普通索引文案', () => {
		expect(zh['status.drawer.restoring']).toContain('正在恢复');
		expect(zh['status.drawer.restoring']).toContain('{done}');
		expect(zh['status.drawer.restoring']).toContain('{total}');
	});

	it('英文同样带进度占位符', () => {
		expect(en['status.drawer.restoring']).toContain('Restoring');
		expect(en['status.drawer.restoring']).toContain('{done}');
		expect(en['status.drawer.restoring']).toContain('{total}');
	});

	it('提示行说明已核对的笔记可直接搜索', () => {
		expect(zh['status.drawer.restoringHint']).toContain('搜索');
	});
});

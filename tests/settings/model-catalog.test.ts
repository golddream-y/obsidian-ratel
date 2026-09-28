/**
 * @file tests/settings/model-catalog.test.ts
 * @description models.dev 名单纯函数：精确查表、下拉过滤
 * @module tests/settings/model-catalog
 */
import { describe, expect, it } from 'vitest';
import {
	listCatalogModels,
	listCatalogProviders,
	lookupCatalogLimits,
	type ModelsDevCatalog,
} from '../../src/settings/model-catalog';

const catalog: ModelsDevCatalog = {
	deepseek: {
		id: 'deepseek',
		name: 'DeepSeek',
		api: 'https://api.deepseek.com',
		models: {
			'deepseek-v4-flash': {
				id: 'deepseek-v4-flash',
				limit: { context: 1_000_000, output: 393_216 },
				tool_call: true,
				status: 'deprecated',
			},
			'image-only': {
				id: 'image-only',
				limit: { context: 0, output: 0 },
				tool_call: false,
			},
		},
	},
	reseller: {
		id: 'reseller',
		name: 'Reseller',
		api: 'https://reseller.example/v1',
		models: {
			'deepseek-v4-flash': {
				id: 'deepseek-v4-flash',
				limit: { context: 524_288, output: 8_192 },
				tool_call: true,
			},
		},
	},
	openai: {
		id: 'openai',
		name: 'OpenAI',
		api: '',
		models: {
			'gpt-5.4': {
				id: 'gpt-5.4',
				limit: { context: 1_050_000, output: 128_000 },
				tool_call: true,
			},
		},
	},
};

describe('lookupCatalogLimits', () => {
	it('lookupCatalogLimits - 同一模型 id 两家供应商 - 窗口不同', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'deepseek-v4-flash')).toEqual({
			context: 1_000_000,
			output: 393_216,
		});
		expect(lookupCatalogLimits(catalog, 'reseller', 'deepseek-v4-flash')?.context).toBe(524_288);
	});

	it('lookupCatalogLimits - 供应商或模型不存在 - 返回 undefined', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'missing')).toBeUndefined();
		expect(lookupCatalogLimits(catalog, 'nope', 'deepseek-v4-flash')).toBeUndefined();
	});

	it('lookupCatalogLimits - context 为 0 - 视为未命中', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'image-only')).toBeUndefined();
	});
});

describe('listCatalogModels', () => {
	it('listCatalogModels - deprecated 且 tool_call - 仍列出', () => {
		expect(listCatalogModels(catalog, 'deepseek')).toEqual(['deepseek-v4-flash']);
	});

	it('listCatalogModels - context 为 0 或不能调工具 - 不列出', () => {
		expect(listCatalogModels(catalog, 'deepseek')).not.toContain('image-only');
	});
});

describe('listCatalogProviders', () => {
	it('listCatalogProviders - api 空串 - api 为 null', () => {
		const openai = listCatalogProviders(catalog).find((row) => row.id === 'openai');
		expect(openai).toEqual({ id: 'openai', name: 'OpenAI', api: null });
	});

	it('listCatalogProviders - 按 name 排序 - DeepSeek 在 OpenAI 前', () => {
		const ids = listCatalogProviders(catalog).map((row) => row.id);
		expect(ids.indexOf('deepseek')).toBeLessThan(ids.indexOf('openai'));
	});
});

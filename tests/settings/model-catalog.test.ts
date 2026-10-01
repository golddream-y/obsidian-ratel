/**
 * @file tests/settings/model-catalog.test.ts
 * @description models.dev 名单纯函数：精确查表、下拉过滤
 * @module tests/settings/model-catalog
 */
import { describe, expect, it } from 'vitest';
import {
	filterCatalogProviders,
	listCatalogModels,
	listCatalogProviders,
	lookupCatalogLimits,
	modelPickValue,
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
	volcengine: {
		id: 'volcengine',
		name: 'Volcengine Ark',
		api: 'https://ark.cn-beijing.volces.com/api/v3',
		models: {},
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
		expect(openai).toEqual({ id: 'openai', name: 'OpenAI', api: null, doc: null });
	});

	it('listCatalogProviders - 按 name 排序 - DeepSeek 在 OpenAI 前', () => {
		const ids = listCatalogProviders(catalog).map((row) => row.id);
		expect(ids.indexOf('deepseek')).toBeLessThan(ids.indexOf('openai'));
	});
});

describe('filterCatalogProviders', () => {
	const rows = listCatalogProviders(catalog);

	it('filterCatalogProviders - 空白检索 - 只留短名单且 Reseller 不在其中', () => {
		const ids = filterCatalogProviders(rows, '').map((row) => row.id);
		expect(ids).toEqual(['deepseek', 'volcengine', 'openai']);
		expect(ids).not.toContain('reseller');
	});

	it('filterCatalogProviders - 中文别名火山 - 命中 Volcengine Ark', () => {
		expect(filterCatalogProviders(rows, '火山').map((row) => row.id)).toEqual(['volcengine']);
	});

	it('filterCatalogProviders - 名称片段 - 命中 Reseller', () => {
		expect(filterCatalogProviders(rows, 'resell').map((row) => row.id)).toEqual(['reseller']);
	});

	it('filterCatalogProviders - id 片段 - 不区分大小写', () => {
		expect(filterCatalogProviders(rows, 'OPEN').map((row) => row.id)).toEqual(['openai']);
	});
});

describe('modelPickValue', () => {
	it('modelPickValue - 不在过滤列表 - 返回手填标记', () => {
		expect(modelPickValue(['deepseek-v4-flash'], 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
		expect(modelPickValue(['deepseek-v4-flash'], 'my-model')).toBe('__hand');
		expect(modelPickValue([], 'llama3.2')).toBe('__hand');
	});
});

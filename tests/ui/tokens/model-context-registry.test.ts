/**
 * @file tests/ui/tokens/model-context-registry.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('obsidian', () => ({
	requestUrl: vi.fn(),
}));

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	ModelContextRegistry,
	lookupContextLengthInRegistry,
	REGISTRY_CACHE_FILENAME,
	REGISTRY_META_FILENAME,
} from '../../../src/ui/tokens/model-context-registry';

const SAMPLE_REGISTRY = {
	sample_spec: { max_input_tokens: 1 },
	'deepseek-chat': { max_input_tokens: 131_072 },
	'deepseek/deepseek-chat': { max_input_tokens: 131_072 },
	'openai/gpt-4o': { max_input_tokens: 128_000 },
};

describe('lookupContextLengthInRegistry', () => {
	it('精确匹配 deepseek-chat', () => {
		expect(lookupContextLengthInRegistry('deepseek-chat', SAMPLE_REGISTRY)).toBe(131_072);
	});

	it('后缀匹配 deepseek/deepseek-chat', () => {
		expect(lookupContextLengthInRegistry('deepseek-chat', SAMPLE_REGISTRY)).toBe(131_072);
	});

	it('未命中返回 undefined', () => {
		expect(lookupContextLengthInRegistry('unknown', SAMPLE_REGISTRY)).toBeUndefined();
	});

	it('跳过 sample_spec', () => {
		expect(lookupContextLengthInRegistry('sample_spec', SAMPLE_REGISTRY)).toBeUndefined();
	});
});

describe('ModelContextRegistry', () => {
	let tmpDir: string;
	const mockRequestUrl = vi.fn();

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ratel-registry-'));
		mockRequestUrl.mockReset();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('ensureRegistry - 缓存未过期时跳过网络', async () => {
		const meta = {
			fetchedAt: Date.now(),
			sourceUrl: 'https://example.com/map.json',
			modelCount: 2,
		};
		await writeFile(
			path.join(tmpDir, REGISTRY_CACHE_FILENAME),
			JSON.stringify(SAMPLE_REGISTRY),
			'utf-8',
		);
		await writeFile(
			path.join(tmpDir, REGISTRY_META_FILENAME),
			JSON.stringify(meta),
			'utf-8',
		);

		const registry = new ModelContextRegistry(tmpDir, mockRequestUrl);
		const map = await registry.ensureRegistry('https://example.com/map.json');
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(map?.['deepseek-chat']?.max_input_tokens).toBe(131_072);
	});

	it('ensureRegistry - 拉取成功并写入缓存', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: JSON.stringify(SAMPLE_REGISTRY),
		});

		const registry = new ModelContextRegistry(tmpDir, mockRequestUrl);
		const map = await registry.ensureRegistry('https://example.com/map.json');
		expect(map).not.toBeNull();
		expect(lookupContextLengthInRegistry('gpt-4o', map!)).toBe(128_000);

		const cached = await readFile(path.join(tmpDir, REGISTRY_CACHE_FILENAME), 'utf-8');
		expect(JSON.parse(cached)['deepseek-chat']).toBeDefined();
	});
});

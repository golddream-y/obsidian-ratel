/**
 * @file tests/ui/tokens/probe-model.test.ts
 * @description probe-model 单元测试 — 测试连接 + 映射表推断
 * @module tests/ui/tokens/probe-model
 * @depends src/ui/tokens/probe-model
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 确保 mockRequestUrl 在 vi.mock 提升前完成初始化。
const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));

vi.mock('obsidian', () => ({ requestUrl: mockRequestUrl }));

import { probeModelContextLength } from '../../../src/ui/tokens/probe-model';

describe('probeModelContextLength', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('连接成功 + 映射表命中 - 返回 contextLength', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { model: 'deepseek-chat' } });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat',
		});
		expect(result.contextLength).toBe(64000);
		expect(result.error).toBeUndefined();
	});

	it('连接失败 - 返回 error', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'unauthorized' });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-bad', model: 'deepseek-chat',
		});
		expect(result.contextLength).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	it('映射表未命中 - contextLength 为 undefined', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { model: 'unknown-model' } });
		const result = await probeModelContextLength({
			apiBase: 'https://api.example.com', apiKey: 'sk-test', model: 'unknown-model',
		});
		expect(result.contextLength).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it('模型名前缀匹配 - deepseek-reasoner 匹配 deepseek-reasoner', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-reasoner',
		});
		expect(result.contextLength).toBe(64000);
	});

	it('claude-3-5-sonnet 匹配 - 200000', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const result = await probeModelContextLength({
			apiBase: 'https://api.anthropic.com', apiKey: 'sk-test', model: 'claude-3-5-sonnet-20241022',
		});
		expect(result.contextLength).toBe(200000);
	});
});

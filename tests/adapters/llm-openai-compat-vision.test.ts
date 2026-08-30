/**
 * @file tests/adapters/llm-openai-compat-vision.test.ts
 * @description 适配器图片支持测试 — localhost 透传 images;远端开视觉走 OpenAI image_url(S-VISION)
 * @module tests/adapters/llm-openai-compat-vision
 */
import { describe, it, expect } from 'vitest';
import { OpenAICompatLLM } from '../../src/adapters/llm-openai-compat';

describe('OpenAICompatLLM 图片支持', () => {
	it('localhost 端点 - supportsImages 为 true', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		expect(llm.supportsImages).toBe(true);
	});

	it('远端端点 - supportsImages 为 false', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' });
		expect(llm.supportsImages).toBe(false);
	});

	it('buildRequestBody - user 消息带附件 - localhost 时透传 images 数组', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(Array.isArray(messages[0]!.images)).toBe(true);
		expect((messages[0]!.images as string[])[0]).toBe('aGk=');
	});

	it('远端端点 + visionEnabled 显式开关 - supportsImages 为 true(S-VISION v1.4 用户声明)', () => {
		const llm = new OpenAICompatLLM({
			apiBase: 'https://openrouter.ai/api/v1',
			apiKey: 'sk-x',
			model: 'dots-studio/dots-3-note-preview:free',
			visionEnabled: true,
		});
		expect(llm.supportsImages).toBe(true);
	});

	it('buildRequestBody - 远端端点开视觉开关 - 走 OpenAI image_url 不走 Ollama images', () => {
		const llm = new OpenAICompatLLM({
			apiBase: 'https://openrouter.ai/api/v1',
			apiKey: 'sk-x',
			model: 'dots-studio/dots-3-note-preview:free',
			visionEnabled: true,
		});
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
		expect(messages[0]!.content).toEqual([
			{ type: 'text', text: '看图' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
		]);
	});

	it('buildRequestBody - 无附件 - 不出现 images 字段', () => {
		const llm = new OpenAICompatLLM({ apiBase: 'http://localhost:11434/v1', apiKey: '', model: 'llava' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [{ role: 'user', content: '纯文本' }],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
	});

	it('buildRequestBody - 远端端点 + 历史含图消息 - 不透传 images(防跨模型会话污染)', () => {
		// 场景:用户先在 Ollama(llava)下发了带图消息,之后切回 DeepSeek 续聊同一会话。
		// 本轮无新图,agent-loop 探测放行,但历史含图消息仍会进 buildRequestBody —
		// 远端必须剥掉 images,否则 DeepSeek API 收到未知字段报 400。
		const llm = new OpenAICompatLLM({ apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' });
		const body = (llm as unknown as { buildRequestBody(req: unknown): Record<string, unknown> }).buildRequestBody({
			messages: [
				{ role: 'user', content: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
			],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		expect(messages[0]!.images).toBeUndefined();
	});
});

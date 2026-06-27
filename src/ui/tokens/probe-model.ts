/**
 * @file src/ui/tokens/probe-model.ts
 * @description 测试连接 + 内置映射表推断模型 context length
 * @module ui/tokens/probe-model
 * @depends obsidian(requestUrl)
 */

import { requestUrl } from 'obsidian';

/** 内置模型 context length 映射表(常用模型) */
const MODEL_CONTEXT_MAP: Record<string, number> = {
	// DeepSeek
	'deepseek-chat': 64000,
	'deepseek-reasoner': 64000,
	// Claude
	'claude-3-5-sonnet-20241022': 200000,
	'claude-3-5-haiku-20241022': 200000,
	'claude-3-opus-20240229': 200000,
	// Ollama 常见本地模型
	'llama3.1': 128000,
	'qwen2.5': 32768,
	// OpenAI 兼容端点常见模型
	'gpt-4o': 128000,
	'gpt-4o-mini': 128000,
};

/**
 * 从映射表按前缀匹配推断 context length。
 *
 * @param model - 模型名(大小写不敏感,前缀匹配)
 * @returns 匹配到的 context length;未命中返回 undefined
 */
function lookupModelContext(model: string): number | undefined {
	const lower = model.toLowerCase();
	// 精确匹配优先
	if (MODEL_CONTEXT_MAP[lower] != null) return MODEL_CONTEXT_MAP[lower];
	// 前缀匹配(如 deepseek-chat-0628 匹配 deepseek-chat)
	for (const key of Object.keys(MODEL_CONTEXT_MAP)) {
		if (lower.startsWith(key)) return MODEL_CONTEXT_MAP[key];
	}
	return undefined;
}

/**
 * 测试连接并推断模型 context length。
 *
 * 策略:
 * 1. 发送极短请求(max_tokens=1)验证连接 + 模型有效性
 * 2. 从内置映射表按前缀匹配推断 context length
 * 3. 映射表未命中,返回 undefined,UI 提示用户手动填写
 *
 * @param config - LLM 配置(apiBase / apiKey / model)
 * @returns 推断结果:成功含 contextLength;连接失败含 error;映射未命中两者皆无
 */
export async function probeModelContextLength(config: {
	apiBase: string;
	apiKey: string;
	model: string;
}): Promise<{ contextLength?: number; error?: string }> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	try {
		const response = await requestUrl({
			url: `${config.apiBase}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1,
				stream: false,
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			return { error: `API 返回 ${response.status}:连接失败或模型名无效` };
		}

		// 连接成功,查映射表
		const contextLength = lookupModelContext(config.model);
		return contextLength != null ? { contextLength } : {};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `请求失败:${message}` };
	}
}

/**
 * @file src/ui/settings/connection-test.ts
 * @description 配置编辑页「测试连接」— 用待保存配置临时构造 LLM 客户端发最小请求,分类反馈错误原因
 * @module ui/settings/connection-test
 * @depends ../../adapters/llm-openai-compat, ../../secrets/ratel-secrets, ../diagnostics/diag-utils, ../../i18n
 */

import type { App } from "obsidian";
import { OpenAICompatLLM } from "../../adapters/llm-openai-compat";
import type { ChatProfile } from "../../settings/chat-profiles";
import {
	readChatProfileSecret,
	requiresChatApiKey,
} from "../../secrets/ratel-secrets";
import { formatError, type DiagError } from "../diagnostics/diag-utils";
import { tNow } from "../../i18n";
import type { StringKey } from "../../i18n/types";

/** 测试请求超时:连通性检查不该长时间挂起。 */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** 测试前置校验结果:ok 放行,否则返回缺失项的 i18n key。 */
export type ConnectionCheck =
	{ ok: true } | { ok: false; reasonKey: StringKey };

/**
 * 发请求前的静态校验:地址、模型、密钥缺一不可。
 *
 * 关键路径:密钥只读钥匙串,不接收 UI 暂存值——编辑页密钥输入框 change 即落钥匙串,
 * 所以「未点别处直接测试」时刚输入未失焦的值本来就不在任何存储里,这里如实报缺失。
 *
 * @param app - Obsidian App,用于读这套配置的钥匙串密钥
 * @param profile - 正在编辑的那一套(字段已落盘)
 */
export function validateConnectionInput(
	app: App,
	profile: ChatProfile,
): ConnectionCheck {
	if (!profile.apiBase.trim()) {
		return {
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingBase",
		};
	}
	if (!profile.model.trim()) {
		return {
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingModel",
		};
	}
	if (
		requiresChatApiKey({ chatApiBase: profile.apiBase }) &&
		!readChatProfileSecret(app, profile)
	) {
		return {
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingKey",
		};
	}
	return { ok: true };
}

/** 连接测试结果。 */
export type ConnectionResult =
	{ ok: true; elapsedMs: number } | { ok: false; error: DiagError };

/**
 * 对一套配置发起一次最小对话请求,只验证「地址通、密钥对、模型存在」。
 *
 * 设计要点:
 * - 临时 new 一个客户端,绝不碰 plugin.llm 与全局当前套;
 * - 不包 wrapLlmChatRetry:测试要立刻看到真实错误(401/404),退避只会拖慢反馈;
 * - maxTokens=1,收到响应头/首个 chunk 即成功,不关心正文;
 * - 超时统一翻译为可操作的配置提示,不抛裸 AbortError。
 *
 * @param app - Obsidian App(读密钥)
 * @param profile - 待测配置
 */
export async function runConnectionTest(
	app: App,
	profile: ChatProfile,
): Promise<ConnectionResult> {
	const precheck = validateConnectionInput(app, profile);
	if (!precheck.ok) {
		return {
			ok: false,
			error: { type: "config", message: tNow(precheck.reasonKey) },
		};
	}

	const apiKey = readChatProfileSecret(app, profile) ?? "";
	const client = new OpenAICompatLLM({
		apiBase: profile.apiBase.trim(),
		apiKey,
		model: profile.model.trim(),
	});

	const controller = new AbortController();
	const timer = window.setTimeout(
		() => controller.abort(),
		CONNECTION_TEST_TIMEOUT_MS,
	);
	const started = performance.now();
	try {
		// 收到首个增量即证明鉴权通过且模型存在,立即中止(break 触发迭代器 return)。
		for await (const _delta of client.chat({
			messages: [{ role: "user", content: "hi" }],
			options: { maxTokens: 1 },
			signal: controller.signal,
		})) {
			break;
		}
		return { ok: true, elapsedMs: Math.round(performance.now() - started) };
	} catch (err) {
		const error = controller.signal.aborted
			? {
					type: "network" as const,
					message: tNow("settings.chatProfiles.connection.timeout"),
				}
			: formatError(err);
		return { ok: false, error };
	} finally {
		window.clearTimeout(timer);
	}
}

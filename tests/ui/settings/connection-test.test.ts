/**
 * @file tests/ui/settings/connection-test.test.ts
 * @description 连接测试前置校验:地址/模型/密钥缺失分类,本地端点免钥,失败结果不落网络
 * @module tests/ui/settings/connection-test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import type { ChatProfile } from "../../../src/settings/chat-profiles";

// 密钥读写走 Obsidian 钥匙串,测试中按「localhost 免钥、远端需钥」的规则模拟。
const mocks = vi.hoisted(() => ({
	requiresKey: vi.fn(),
	readSecret: vi.fn(),
}));

vi.mock("../../../src/secrets/ratel-secrets", () => ({
	requiresChatApiKey: mocks.requiresKey,
	readChatProfileSecret: mocks.readSecret,
}));

const { validateConnectionInput, runConnectionTest } =
	await import("../../../src/ui/settings/connection-test");

/** 造一套可编辑字段的配置。 */
function makeProfile(partial: Partial<ChatProfile> = {}): ChatProfile {
	return {
		id: "p1",
		name: "测试套",
		apiBase: "",
		model: "",
		providerId: "custom",
		contextLengthPreset: "custom",
		chatModelMaxTokens: 4096,
		keySerial: 0,
		allowLegacyKeyFallback: false,
		...partial,
	} as ChatProfile;
}

const app = {} as App;

beforeEach(() => {
	mocks.requiresKey.mockReset();
	mocks.readSecret.mockReset();
	// 默认:远端需要密钥,本地不需要。
	mocks.requiresKey.mockImplementation(
		(s: { chatApiBase?: string }) => !s.chatApiBase?.includes("localhost"),
	);
});

describe("validateConnectionInput - 发请求前静态校验", () => {
	it("地址为空 - 返回 missingBase - 不读密钥", () => {
		const result = validateConnectionInput(
			app,
			makeProfile({ model: "gpt-x" }),
		);
		expect(result).toEqual({
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingBase",
		});
		expect(mocks.readSecret).not.toHaveBeenCalled();
	});

	it("有地址无模型 - 返回 missingModel", () => {
		const result = validateConnectionInput(
			app,
			makeProfile({ apiBase: "https://api.x.com/v1" }),
		);
		expect(result).toEqual({
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingModel",
		});
	});

	it("远端供应商但密钥串为空 - 返回 missingKey", () => {
		mocks.readSecret.mockReturnValue(null);
		const result = validateConnectionInput(
			app,
			makeProfile({ apiBase: "https://api.x.com/v1", model: "gpt-x" }),
		);
		expect(result).toEqual({
			ok: false,
			reasonKey: "settings.chatProfiles.connection.missingKey",
		});
	});

	it("本地 Ollama 免钥 - 地址模型齐全 - 放行", () => {
		mocks.readSecret.mockReturnValue(null);
		const result = validateConnectionInput(
			app,
			makeProfile({
				apiBase: "http://localhost:11434/v1",
				model: "qwen2",
			}),
		);
		expect(result).toEqual({ ok: true });
	});

	it("远端供应商且有密钥 - 放行", () => {
		mocks.readSecret.mockReturnValue("sk-xxx");
		const result = validateConnectionInput(
			app,
			makeProfile({ apiBase: "https://api.x.com/v1", model: "gpt-x" }),
		);
		expect(result).toEqual({ ok: true });
	});
});

describe("runConnectionTest - 前置失败不触网", () => {
	it("缺地址 - 直接返回 config 类错误 - 不构造 HTTP 请求", async () => {
		const result = await runConnectionTest(
			app,
			makeProfile({ model: "gpt-x" }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("config");
			expect(result.error.message).toBeTruthy();
		}
	});
});

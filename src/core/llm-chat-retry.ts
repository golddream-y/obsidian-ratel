/**
 * @file src/core/llm-chat-retry.ts
 * @description 对话模型 chat 网络/网关错误退避重试（S-LLM-RETRY）
 * @module core/llm-chat-retry
 * @depends ports/llm
 */

import type { ChatDelta, ChatRequest, LLMClient, LlmRetryWait } from '../ports/llm';

/** 首次 + 最多两次重试 */
const MAX_ATTEMPTS = 3;
/** 第 2、第 3 次尝试前的默认等待 */
const DEFAULT_DELAYS_MS = [500, 1500] as const;
const RETRY_AFTER_CAP_MS = 30_000;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * 是否应对这次 chat 失败再发一枪。
 *
 * @param err - inner.chat 抛出的错误
 * @param ctx.yielded - 本次尝试是否已经向调用方 yield 过 delta
 * @param ctx.aborted - 用户是否已停止
 */
export function isRetryableLlmFailure(
	err: unknown,
	ctx: { yielded: boolean; aborted: boolean },
): boolean {
	if (ctx.yielded || ctx.aborted) return false;
	const msg = errorMessage(err);
	if (msg.includes('请求已取消')) return false;
	if (err instanceof Error && err.name === 'AbortError') return false;
	const lower = msg.toLowerCase();
	if (lower.includes('context_overflow') || lower.includes('prompt too long')) return false;
	if (msg.includes('VISION_UNSUPPORTED')) return false;

	const status = httpStatus(err);
	if (status !== undefined) return RETRYABLE_STATUS.has(status);

	const code = errorCode(err);
	if (RETRYABLE_CODES.has(code)) return true;
	if (/socket hang up/i.test(msg) || /fetch failed/i.test(msg)) return true;
	return false;
}

/**
 * 包一层 LLMClient：首次 yield 前的可恢复失败按指数间隔重试。
 *
 * @param inner - 真实适配器（含其自身的 requestUrl 降级）
 */
export function wrapLlmChatRetry(inner: LLMClient): LLMClient {
	return {
		get supportsImages() {
			return inner.supportsImages;
		},
		countTokens(text: string) {
			return inner.countTokens(text);
		},
		async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
			const onRetryWait = req.onRetryWait;
			let waitActive = false;

			const emitWait = (state: LlmRetryWait): void => {
				onRetryWait?.(state);
				waitActive = true;
			};

			const clearWait = (): void => {
				if (!waitActive) return;
				onRetryWait?.(null);
				waitActive = false;
			};

			let lastErr: unknown;
			try {
				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
					if (req.signal?.aborted) {
						clearWait();
						throw new Error('请求已取消');
					}
					if (attempt > 0) {
						emitWait({ phase: 'request', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS });
					}
					let yielded = false;
					try {
						for await (const delta of inner.chat(req)) {
							if (!yielded) {
								clearWait();
							}
							yielded = true;
							yield delta;
						}
						clearWait();
						return;
					} catch (err) {
						lastErr = err;
						const aborted = !!req.signal?.aborted;
						if (!isRetryableLlmFailure(err, { yielded, aborted })) {
							clearWait();
							throw err;
						}
						if (attempt >= MAX_ATTEMPTS - 1) {
							clearWait();
							throw err;
						}
						const delayMs = retryDelayMs(attempt, err);
						emitWait({
							phase: 'backoff',
							attempt: attempt + 2,
							maxAttempts: MAX_ATTEMPTS,
							delayMs,
						});
						try {
							await sleepMs(delayMs, req.signal);
						} catch (sleepErr) {
							clearWait();
							throw sleepErr;
						}
					}
				}
				clearWait();
				throw lastErr;
			} finally {
				clearWait();
			}
		},
	};
}

function httpStatus(err: unknown): number | undefined {
	if (!err || typeof err !== 'object') return undefined;
	const rec = err as { status?: unknown; message?: unknown };
	if (typeof rec.status === 'number') return rec.status;
	const msg = typeof rec.message === 'string' ? rec.message : '';
	const m = msg.match(/LLM API error:\s*(\d+)/i);
	return m ? Number(m[1]) : undefined;
}

function errorCode(err: unknown): string {
	if (!err || typeof err !== 'object') return '';
	const code = (err as { code?: unknown }).code;
	return typeof code === 'string' ? code : '';
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
		return err.message;
	}
	return '';
}

function retryAfterHeader(err: unknown): string | undefined {
	if (!err || typeof err !== 'object') return undefined;
	const v = (err as { retryAfter?: unknown }).retryAfter;
	return typeof v === 'string' ? v : undefined;
}

/**
 * 第 failedAttemptIndex 次失败之后、下一次尝试之前等多久。
 */
function retryDelayMs(failedAttemptIndex: number, err: unknown): number {
	const fromHeader = parseRetryAfterMs(retryAfterHeader(err));
	if (fromHeader !== undefined) return fromHeader;
	return DEFAULT_DELAYS_MS[Math.min(failedAttemptIndex, DEFAULT_DELAYS_MS.length - 1)] ?? 1500;
}

function parseRetryAfterMs(header: string | undefined): number | undefined {
	if (!header) return undefined;
	const sec = Number(header);
	if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, RETRY_AFTER_CAP_MS);
	const at = Date.parse(header);
	if (Number.isNaN(at)) return undefined;
	return Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS);
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('请求已取消'));
			return;
		}
		const timer = window.setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			window.clearTimeout(timer);
			reject(new Error('请求已取消'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

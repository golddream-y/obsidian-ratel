/**
 * @file src/core/loop-stability.ts
 * @description 一轮对话的收束、空步续写与工具截止判断
 * @module core/loop-stability
 */

/** 剩余这么多步时提醒模型收束 */
export const WRAP_UP_REMAINING_STEPS = 5;

/** 没有自带超时的工具，最多等这么久 */
export const TOOL_DEADLINE_MS = 60_000;

/**
 * 这一步是否该在出站请求末尾追加收束说明。
 *
 * @param step - 当前步，从 0 起
 * @param maxSteps - 本轮步数上限
 * @returns 剩余步数不超过 5 且还没到顶时为 true
 */
export function shouldAppendWrapUp(step: number, maxSteps: number): boolean {
	return step >= maxSteps - WRAP_UP_REMAINING_STEPS && step < maxSteps;
}

/**
 * 模型这一步是否什么都没产出。
 *
 * @param text - 可见正文
 * @param reasoning - 思考
 * @param toolCallCount - 工具调用条数
 * @returns 三者都空时为 true
 */
export function isEmptyModelStep(text: string, reasoning: string, toolCallCount: number): boolean {
	return text.trim() === '' && reasoning.trim() === '' && toolCallCount === 0;
}

/**
 * 空步是否再请求一次。
 *
 * @param input.step - 当前步
 * @param input.sawTool - 本轮前面是否执行过工具
 * @param input.alreadyContinued - 是否已经续过空步
 * @returns 第二步以后的空步，或前面有过工具的空步，且还没续过
 */
export function shouldContinueEmptyStep(input: {
	step: number;
	sawTool: boolean;
	alreadyContinued: boolean;
	text: string;
	reasoning: string;
	toolCallCount: number;
}): boolean {
	if (input.alreadyContinued) return false;
	if (!isEmptyModelStep(input.text, input.reasoning, input.toolCallCount)) return false;
	return input.step > 0 || input.sawTool;
}

/**
 * 给工具执行加截止时间。取消优先于超时。
 *
 * @param work - 工具 Promise
 * @param ms - 截止毫秒
 * @param signal - 用户停止
 * @param timeoutMessage - 超时文案，交给模型
 * @returns 工具结果
 * @throws code 为 CANCELLED 或 TOOL_TIMEOUT 的 Error
 */
export function withToolDeadline<T>(
	work: Promise<T>,
	ms: number,
	signal: AbortSignal | undefined,
	timeoutMessage: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		// 超时后原 Promise 再拒绝时不要变成未处理拒绝
		work.catch(() => {});
		if (signal?.aborted) {
			reject(Object.assign(new Error('用户取消'), { code: 'CANCELLED' }));
			return;
		}
		const timer = setTimeout(() => {
			reject(Object.assign(new Error(timeoutMessage), { code: 'TOOL_TIMEOUT' }));
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(Object.assign(new Error('用户取消'), { code: 'CANCELLED' }));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		work.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

/**
 * @file src/ui/chat/frame-coalescer.ts
 * @description 把同一动画帧内的重复布局请求合并为一次回调
 * @module ui/chat/frame-coalescer
 */

/**
 * 每帧最多执行一次 task,并支持组件销毁时取消。
 *
 * 设计要点:
 * - 同一帧内重复请求只保留一次回调。
 * - 组件销毁时显式取消尚未执行的帧任务。
 *
 * @example
 *   const coalescer = new FrameCoalescer(() => updateScroll());
 *   coalescer.request();
 */
export class FrameCoalescer {
	private frameId: number | null = null;

	constructor(
		private readonly task: () => void,
		// 修复:默认参数必须用箭头包装 — 直接提取 requestAnimationFrame 会脱离 window receiver,
		// 以 this.requestFrame(...) 调用时 Chromium 抛 Illegal invocation,打断所有滚动/发送流程
		private readonly requestFrame: (cb: FrameRequestCallback) => number = (cb) =>
			window.requestAnimationFrame(cb),
		private readonly cancelFrame: (id: number) => void = (id) =>
			window.cancelAnimationFrame(id),
	) {}

	/**
	 * 请求下一帧;已有请求时不重复排队。
	 *
	 * @returns 无返回值
	 * @example
	 *   coalescer.request();
	 */
	request(): void {
		if (this.frameId !== null) return;
		this.frameId = this.requestFrame(() => {
			this.frameId = null;
			this.task();
		});
	}

	/**
	 * 取消尚未执行的帧。
	 *
	 * @returns 无返回值
	 * @example
	 *   coalescer.cancel();
	 */
	cancel(): void {
		if (this.frameId === null) return;
		this.cancelFrame(this.frameId);
		this.frameId = null;
	}
}

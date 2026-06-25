/**
 * @file src/logging/dev-logger.ts
 * @description 开发者专用日志 — 仅 console,禁止 Notice / 用户 UI
 * @module logging/dev-logger
 */

export type LogModule = 'index' | 'model' | 'worker' | 'agent' | 'vectra' | 'hooks' | 'vault' | 'main';

export interface DevLoggerOptions {
	debugEnabled?: boolean;
}

/**
 * 开发者专用日志器 — 仅输出到 console,不触发任何用户可见 UI。
 *
 * 设计要点:
 * - debug 级受 debugEnabled 开关控制
 * - 统一 [Ratel:module] 前缀便于过滤
 * - Error 对象单独作为第二参数传递以保留 stack
 *
 * @example
 * devLogger.info('index', '全量索引开始');
 * devLogger.error('agent', '工具失败', err);
 */
export class DevLogger {
	private debugEnabled: boolean;

	constructor(options: DevLoggerOptions = {}) {
		this.debugEnabled = options.debugEnabled ?? false;
	}

	/**
	 * 切换 debug 级输出开关。
	 *
	 * @param enabled - true 时 debug 方法会输出到 console
	 */
	setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	/**
	 * 输出 debug 级日志,仅 debugEnabled 为 true 时生效。
	 *
	 * @param module - 业务模块标识
	 * @param message - 日志消息
	 * @param data - 可选附加数据
	 */
	debug(module: LogModule, message: string, data?: unknown): void {
		if (!this.debugEnabled) return;
		this.write('info', module, message, data);
	}

	/**
	 * 输出 info 级日志。
	 *
	 * @param module - 业务模块标识
	 * @param message - 日志消息
	 * @param data - 可选附加数据
	 */
	info(module: LogModule, message: string, data?: unknown): void {
		this.write('info', module, message, data);
	}

	/**
	 * 输出 warn 级日志。
	 *
	 * @param module - 业务模块标识
	 * @param message - 日志消息
	 * @param data - 可选附加数据
	 */
	warn(module: LogModule, message: string, data?: unknown): void {
		this.write('warn', module, message, data);
	}

	/**
	 * 输出 error 级日志;若 data 为 Error 则附带 stack。
	 *
	 * @param module - 业务模块标识
	 * @param message - 日志消息
	 * @param data - 可选 Error 或上下文对象
	 */
	error(module: LogModule, message: string, data?: unknown): void {
		this.write('error', module, message, data);
	}

	private write(level: 'info' | 'warn' | 'error', module: LogModule, message: string, data?: unknown): void {
		const prefix = `[Ratel:${module}] ${message}`;
		const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
		if (data instanceof Error) {
			fn(prefix, data);
		} else if (data !== undefined) {
			fn(prefix, data);
		} else {
			fn(prefix);
		}
	}
}

/** 插件级单例 — settings.debugLog 变更时调 setDebugEnabled */
export const devLogger = new DevLogger();

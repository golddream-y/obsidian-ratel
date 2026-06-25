import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DevLogger } from '../../src/logging/dev-logger';

describe('DevLogger', () => {
	let logger: DevLogger;

	beforeEach(() => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		logger = new DevLogger({ debugEnabled: false });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('info - 输出带 [Ratel:module] 前缀', () => {
		logger.info('index', '全量索引开始');
		expect(console.info).toHaveBeenCalledWith('[Ratel:index] 全量索引开始');
	});

	it('debug - debugEnabled=false 时不输出', () => {
		logger.debug('worker', 'message');
		expect(console.info).not.toHaveBeenCalled();
	});

	it('debug - debugEnabled=true 时输出', () => {
		logger.setDebugEnabled(true);
		logger.debug('worker', 'ping');
		expect(console.info).toHaveBeenCalledWith('[Ratel:worker] ping');
	});

	it('error - 附带 Error 时打印 stack', () => {
		const err = new Error('boom');
		logger.error('agent', '工具失败', err);
		expect(console.error).toHaveBeenCalled();
	});
});

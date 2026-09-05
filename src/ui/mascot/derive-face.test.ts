/**
 * @file src/ui/mascot/derive-face.test.ts
 * @description 捣蛋鬼脸派生优先级测试
 * @module ui/mascot/derive-face.test
 */
import { describe, it, expect } from 'vitest';
import { deriveMascotFace } from './derive-face';
import type { MessageSegment } from '../chat/message-stream/types';

const empty: MessageSegment[] = [];
const rest = { cancelled: false, errorHoldActive: false, segments: empty, userTyping: false };

describe('deriveMascotFace', () => {
	it('报错保持激活 - 优先 error - 即使正在跑', () => {
		expect(deriveMascotFace({ ...rest, isRunning: true, errorHoldActive: true })).toBe('error');
	});
	it('已停止且不在跑 - cancelled - stopped', () => {
		expect(deriveMascotFace({ ...rest, isRunning: false, cancelled: true })).toBe('stopped');
	});
	it('在跑且无段 - waiting', () => {
		expect(deriveMascotFace({ ...rest, isRunning: true })).toBe('waiting');
	});
	it('在跑且末段 think - thinking', () => {
		expect(deriveMascotFace({
			...rest,
			isRunning: true,
			segments: [{ type: 'think', text: 'hmm' }],
		})).toBe('thinking');
	});
	it('在跑且末段 tool calling - working', () => {
		expect(deriveMascotFace({
			...rest,
			isRunning: true,
			segments: [{ type: 'tool', toolCall: { name: 'grep', displayName: 'g', args: {}, status: 'calling', startAt: 0 } }],
		})).toBe('working');
	});
	it('在跑且末段 text - speaking', () => {
		expect(deriveMascotFace({
			...rest,
			isRunning: true,
			segments: [{ type: 'text', text: '你好' }],
		})).toBe('speaking');
	});
	it('不在跑无取消无报错 - idle', () => {
		expect(deriveMascotFace({ ...rest, isRunning: false })).toBe('idle');
	});
	it('报错保持结束且仍在跑 - 回到 waiting/thinking 而非卡 error', () => {
		expect(deriveMascotFace({
			...rest,
			isRunning: true,
			segments: [{ type: 'think', text: 'x' }],
		})).toBe('thinking');
	});
	it('用户在输入框打字且不在跑 - listening', () => {
		expect(deriveMascotFace({ ...rest, isRunning: false, userTyping: true })).toBe('listening');
	});
	it('用户打字但 Agent 在跑 - 仍 waiting 不抢忙态', () => {
		expect(deriveMascotFace({ ...rest, isRunning: true, userTyping: true })).toBe('waiting');
	});
	it('用户打字但本轮已停止 - 仍 stopped', () => {
		expect(deriveMascotFace({ ...rest, isRunning: false, cancelled: true, userTyping: true })).toBe('stopped');
	});
});

/**
 * @file src/ui/mascot/derive-face.test.ts
 * @description 吉祥物脸派生优先级测试
 * @module ui/mascot/derive-face.test
 */
import { describe, it, expect } from 'vitest';
import { deriveMascotFace } from './derive-face';
import type { MessageSegment } from '../chat/message-stream/types';

const empty: MessageSegment[] = [];

describe('deriveMascotFace', () => {
	it('报错保持激活 - 优先 error - 即使正在跑', () => {
		expect(deriveMascotFace({ isRunning: true, cancelled: false, errorHoldActive: true, segments: empty })).toBe('error');
	});
	it('已停止且不在跑 - cancelled - stopped', () => {
		expect(deriveMascotFace({ isRunning: false, cancelled: true, errorHoldActive: false, segments: empty })).toBe('stopped');
	});
	it('在跑且无段 - waiting', () => {
		expect(deriveMascotFace({ isRunning: true, cancelled: false, errorHoldActive: false, segments: empty })).toBe('waiting');
	});
	it('在跑且末段 think - thinking', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'think', text: 'hmm' }],
		})).toBe('thinking');
	});
	it('在跑且末段 tool calling - working', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'tool', toolCall: { name: 'grep', displayName: 'g', args: {}, status: 'calling', startAt: 0 } }],
		})).toBe('working');
	});
	it('在跑且末段 text - speaking', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'text', text: '你好' }],
		})).toBe('speaking');
	});
	it('不在跑无取消无报错 - idle', () => {
		expect(deriveMascotFace({ isRunning: false, cancelled: false, errorHoldActive: false, segments: empty })).toBe('idle');
	});
	it('报错保持结束且仍在跑 - 回到 waiting/thinking 而非卡 error', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'think', text: 'x' }],
		})).toBe('thinking');
	});
});

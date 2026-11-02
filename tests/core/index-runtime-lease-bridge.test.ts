/**
 * @file tests/core/index-runtime-lease-bridge.test.ts
 * @description 提交票据桥 — 授予、嵌套复用、撤销与幂等结算
 * @module tests/core/index-runtime-lease-bridge
 */

import { describe, expect, it, vi } from 'vitest';
import {
	CommitTicketBroker,
	CommitTicketError,
	type CommitTicketTransport,
} from '../../src/core/index-runtime-lease-bridge';

/** 记录调用的传输层。 */
function makeTransport(delay = false): {
	transport: CommitTicketTransport;
	settled: string[];
	requested: string[];
	release: () => void;
} {
	const settled: string[] = [];
	const requested: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let seq = 0;
	const transport: CommitTicketTransport = {
		async requestTicket(scopeId) {
			requested.push(scopeId);
			if (delay) await gate;
			seq += 1;
			return { ticketId: `t-${seq}` };
		},
		async notifySettled(ticketId) {
			settled.push(ticketId);
		},
	};
	return { transport, settled, requested, release: () => release() };
}

describe('提交票据桥', () => {
	it('授予后进入临界区 - 最外层结算恰好通知一次', async () => {
		const { transport, settled } = makeTransport();
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('a.md');
		ticket.begin();
		expect(ticket.nesting).toBe(1);
		ticket.settle();
		expect(ticket.isSettled).toBe(true);
		expect(settled).toEqual(['t-1']);
		expect(broker.openTickets).toBe(0);
	});

	it('嵌套临界区 - 只有最外层归零才通知宿主', async () => {
		const { transport, settled } = makeTransport();
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('restore');
		ticket.begin();
		ticket.begin();
		ticket.settle();
		expect(settled).toEqual([]);
		expect(broker.openTickets).toBe(1);
		ticket.settle();
		expect(settled).toEqual(['t-1']);
	});

	it('重复结算 - 幂等 - 不重复通知', async () => {
		const { transport, settled } = makeTransport();
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('a.md');
		ticket.begin();
		ticket.settle();
		ticket.settle();
		expect(settled).toEqual(['t-1']);
	});

	it('撤销 - 禁止新票据 - 已打开票据被强制结算', async () => {
		const { transport, settled } = makeTransport();
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('a.md');
		ticket.begin();
		await broker.revoke('用户暂停');
		expect(broker.revoked).toBe(true);
		expect(ticket.isSettled).toBe(true);
		expect(settled).toEqual(['t-1']);
		await expect(broker.acquire('b.md')).rejects.toBeInstanceOf(CommitTicketError);
	});

	it('授权在撤销后才返回 - 不放行新写 - 立即结算该票据', async () => {
		const { transport, settled, release } = makeTransport(true);
		const broker = new CommitTicketBroker(transport);
		const acquiring = broker.acquire('a.md');
		await broker.revoke('切换配置');
		release();
		await expect(acquiring).rejects.toMatchObject({ code: 'revoked' });
		expect(settled).toEqual(['t-1']);
	});

	it('已结算票据再 begin - 拒绝 - 不产生第二段写窗口', async () => {
		const { transport } = makeTransport();
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('a.md');
		ticket.begin();
		ticket.settle();
		expect(() => ticket.begin()).toThrow(CommitTicketError);
	});

	it('结算通知失败 - 本地状态仍收敛 - 不抛未处理拒绝', async () => {
		const transport: CommitTicketTransport = {
			requestTicket: async () => ({ ticketId: 't-9' }),
			notifySettled: vi.fn(async () => { throw new Error('disk'); }),
		};
		const broker = new CommitTicketBroker(transport);
		const ticket = await broker.acquire('a.md');
		ticket.begin();
		ticket.settle();
		expect(transport.notifySettled).toHaveBeenCalledTimes(1);
		expect(broker.openTickets).toBe(0);
	});
});

/**
 * @file src/core/index-runtime-lease-bridge.ts
 * @description 索引运行时写权桥 — 宿主 lease 与 Worker 同步提交契约之间的 ticket 桥接
 * @module src/core/index-runtime-lease-bridge
 *
 * 关键路径:
 * - 既有日志的 beginCommit/settle 是**同步**契约,不能直接改成远端 Promise;
 *   因此在异步写入口外先申请 ticket,再交给同步适配器。
 * - 同一 mutation scope 内嵌套恢复/清理复用最外层 ticket:内层只增加引用,只有最外层归零才通知宿主结算。
 * - 撤销立即禁止新 ticket;已授予但尚未开始的票据也不能再开始新写,避免旧 epoch 迟到授权。
 * - 未确认终态的票据会阻止 lease 转交;本模块只负责登记与结算,不自行释放 owner。
 */

/** 宿主侧提交登记端口。 */
export interface CommitTicketTransport {
	/** 申请一张提交票据;返回 ticket 标识。 */
	requestTicket(scopeId: string): Promise<{ ticketId: string }>;
	/** 通知宿主某张票据已完全结算。 */
	notifySettled(ticketId: string): Promise<void>;
}

/** 票据状态错误。 */
export class CommitTicketError extends Error {
	constructor(readonly code: 'revoked' | 'not-granted' | 'scope-closed', message: string) {
		super(message);
		this.name = 'CommitTicketError';
	}
}

/** 一张提交票据的同步适配器。 */
export class CommitTicket {
	private depth = 0;
	private settled = false;

	constructor(
		readonly ticketId: string,
		readonly scopeId: string,
		private readonly broker: CommitTicketBroker,
	) {}

	/** 是否已最终结算。 */
	get isSettled(): boolean {
		return this.settled;
	}

	/** 当前嵌套深度。 */
	get nesting(): number {
		return this.depth;
	}

	/**
	 * 进入一次写临界区(可嵌套)。
	 * @throws CommitTicketError 撤销或已结算后调用
	 */
	begin(): void {
		if (this.settled) throw new CommitTicketError('scope-closed', '提交票据已结算');
		this.broker.assertUsable(this);
		this.depth += 1;
	}

	/**
	 * 退出一次写临界区;最外层归零时才通知宿主结算。
	 */
	settle(): void {
		if (this.settled) return;
		if (this.depth === 0) return;
		this.depth -= 1;
		if (this.depth > 0) return;
		this.settled = true;
		this.broker.onSettled(this);
	}

	/** 强制结算(撤销或失败路径)。 */
	forceSettle(): void {
		if (this.settled) return;
		this.depth = 0;
		this.settled = true;
		this.broker.onSettled(this);
	}
}

/** 票据协调器。 */
export class CommitTicketBroker {
	private readonly open = new Map<string, CommitTicket>();
	private revokedReason: string | null = null;
	private sequence = 0;

	constructor(private readonly transport: CommitTicketTransport) {}

	/** 是否已撤销。 */
	get revoked(): boolean {
		return this.revokedReason !== null;
	}

	/** 未结算票据数;>0 时不得转交 lease。 */
	get openTickets(): number {
		return this.open.size;
	}

	/**
	 * 申请票据。
	 * @param scopeId 逻辑作用域标识(同一路径或同一恢复批次)
	 */
	async acquire(scopeId: string): Promise<CommitTicket> {
		const revokedBefore = this.revokedReason;
		if (revokedBefore !== null) {
			throw new CommitTicketError('revoked', `写入已撤销: ${revokedBefore}`);
		}
		const { ticketId } = await this.transport.requestTicket(scopeId);
		// 关键路径:授权可能在撤销之后才返回,此时不得放行新写。
		const revokedAfter = this.revokedReason;
		if (revokedAfter !== null) {
			await this.transport.notifySettled(ticketId);
			throw new CommitTicketError('revoked', `写入已撤销: ${revokedAfter}`);
		}
		const ticket = new CommitTicket(ticketId, scopeId, this);
		this.open.set(ticketId, ticket);
		this.sequence += 1;
		return ticket;
	}

	/**
	 * 撤销:禁止新票据,并结算所有已打开票据。
	 * @param reason 撤销原因
	 */
	async revoke(reason: string): Promise<void> {
		this.revokedReason ??= reason;
		for (const ticket of [...this.open.values()]) ticket.forceSettle();
	}

	/** 校验票据仍可用。 */
	assertUsable(ticket: CommitTicket): void {
		if (this.revokedReason !== null) {
			throw new CommitTicketError('revoked', `写入已撤销: ${this.revokedReason}`);
		}
		if (!this.open.has(ticket.ticketId)) {
			throw new CommitTicketError('not-granted', '提交票据不在有效集合内');
		}
	}

	/** 结算回调;幂等,重复调用不重复通知。 */
	onSettled(ticket: CommitTicket): void {
		if (!this.open.delete(ticket.ticketId)) return;
		void this.transport.notifySettled(ticket.ticketId).catch(() => {
			// 通知失败不改写本地状态:未确认终态会阻止交接,由上层如实报告。
		});
	}
}

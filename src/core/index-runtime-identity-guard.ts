/**
 * @file src/core/index-runtime-identity-guard.ts
 * @description 会话内写运行时身份守卫 — 同一时刻只允许一个配置指纹持有写运行时
 * @module src/core/index-runtime-identity-guard
 *
 * 关键路径:
 * - 此前同一会话内再次装配的「关闭点」是写所有权占用:要么等前任释放,要么阻塞到关闭超时,
 *   错误码只有占用语义,没有配置语义。用户改配置后重试会得到「被占用」而不是「配置已变」。
 * - 守卫把这件事变成显式判定:同指纹重复登记是幂等的;不同指纹直接以专用错误码拒绝,
 *   不进入等待、不撤销旧 epoch。
 * - 守卫只记录指纹与释放函数,不持有存储或日志;真正的资源由装配方在 release 时收尾。
 */

/** 守卫错误码。 */
export type IdentityGuardErrorCode = 'config-identity-conflict';

/** 守卫错误。 */
export class IndexRuntimeIdentityError extends Error {
	constructor(
		readonly code: IdentityGuardErrorCode,
		message: string,
		readonly activeFingerprint: string,
		readonly requestedFingerprint: string,
	) {
		super(message);
		this.name = 'IndexRuntimeIdentityError';
	}
}

/** 已登记的运行时。 */
interface RegisteredRuntime {
	fingerprint: string;
	release: () => void;
}

/** 写运行时身份守卫。 */
export class IndexRuntimeIdentityGuard {
	private active: RegisteredRuntime | null = null;

	/** 当前持有写运行时的配置指纹;空闲时为 null。 */
	get activeFingerprint(): string | null {
		return this.active?.fingerprint ?? null;
	}

	/** 是否有活动写运行时。 */
	get busy(): boolean {
		return this.active !== null;
	}

	/**
	 * 登记一个写运行时。
	 * @param fingerprint 当前配置指纹
	 * @param release 释放动作;守卫只负责调用一次
	 * @throws {IndexRuntimeIdentityError} 已有不同指纹的运行时
	 */
	register(fingerprint: string, release: () => void = () => {}): void {
		if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
			throw new Error('配置指纹不能为空');
		}
		const current = this.active;
		if (current !== null) {
			if (current.fingerprint === fingerprint) return;
			throw new IndexRuntimeIdentityError(
				'config-identity-conflict',
				'本次会话内已有另一套配置的索引运行时;请先释放或重新加载插件',
				current.fingerprint,
				fingerprint,
			);
		}
		this.active = { fingerprint, release };
	}

	/**
	 * 释放当前运行时;指纹不符时拒绝,避免误释放别人的运行时。
	 * @param fingerprint 调用方持有的指纹
	 */
	release(fingerprint?: string): void {
		const current = this.active;
		if (current === null) return;
		if (fingerprint !== undefined && current.fingerprint !== fingerprint) return;
		this.active = null;
		current.release();
	}
}

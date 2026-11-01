/**
 * @file src/core/persistent-index-backend.ts
 * @description 索引快照、差异更新与成功元数据提交
 * @module core/persistent-index-backend
 * @depends worker/manager, core/index-manifest, core/index-build-stamp
 *
 * 设计要点:
 * - 整批返回只汇总统计,不再承担唯一提交职责:文件级有效性由 T3 的文件完成记录决定,
 *   本模块负责启动期 hash diff、调用 Worker 与维护「清单 + 构建戳」这份派生视图。
 * - 不再有整库失效操作:任何一次写失败都不允许抹掉其他文件已提交的凭据。
 * - `isIndexComplete` 检查本轮扫描/队列/失败与持久凭据,注入文件记录端口后还要求记录覆盖清单;
 *   本轮失败计数只在扫描成功时清零(scan 级语义),单文件提交成功不得清零。
 * - 部分检索可用性读文件记录(排除 tombstone 与不可用路径),不读全量清单布尔值。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { VectraStore } from '../adapters/vector-vectra';
import type { WorkerManager, WorkerRequestOptions } from '../worker/manager';
import type { ChunkOptionsPayload, WorkerRequest, WorkerResponse } from '../types';
import type { CommittedIndexState, IndexBackend } from './index-manager';
import { IndexManifest, type IndexManifestData } from './index-manifest';
import { resolveBuildStampPath, readBuildStamp, isBuildStampCurrent, writeBuildStamp, type IndexBuildStamp } from './index-build-stamp';
import { sha256 } from '../utils/hash';
import { tNow } from '../i18n';
import { devLogger } from '../logging/dev-logger';
interface IndexSnapshot {
	path: string;
	content: string;
	mtime: number;
	hash: string;
}
interface IndexResult {
	indexed: number;
	errors: number;
}

/**
 * 已派发但调用方等待可能已经结束的写请求上下文。
 *
 * 关键路径:迟到终态必须能找回「提交什么」与「怎么提交」——
 * - `commit` 是正常路径(调用方还在等待)的提交动作,与调用方自己的收尾动作互补;
 * - `lateEffect` 是迟到路径专用的提交动作:它必须**从磁盘真值重新推导**本请求的效果再落盘,
 *   不能复用正常路径捕获的清单快照 —— 等待结束到终态到达之间可能有别的请求已提交,
 *   用旧快照覆盖等于抹掉那部分提交;
 * - `settlement` 是权威的 settle-once 标记:同一条终态(无论先走正常路径还是迟到路径)
 *   只执行一次提交,两条路径共享同一个结果。
 *
 * 每请求唯一键见 {@link PersistentIndexBackend.registerPendingWrite}:
 * 协调器的 `taskId` 轮内恒定,用它当键会让同轮第二个写请求静默覆盖第一个的上下文。
 */
interface PendingWriteState<T = unknown> {
	/** 每请求唯一键(`taskId` + 内部自增序号)。 */
	readonly key: string;
	/** 原请求类型(诊断用)。 */
	readonly requestType: WorkerRequest['type'];
	/** 任务标识(下发给 Worker 的稳定身份,轮内可能重复)。 */
	readonly taskId: string;
	/** 写所有权 epoch。 */
	readonly epoch: number;
	/** 正常路径的提交动作(与调用方自身的收尾动作互补)。 */
	readonly commit: (response: WorkerResponse) => T | Promise<T>;
	/** 迟到路径专用:从磁盘真值重新推导并落盘;缺省时复用 `commit`。 */
	readonly lateEffect: ((response: WorkerResponse) => T | Promise<T>) | undefined;
	/**
	 * 调用方的等待是否已经结束(正常 resolve 或停滞 reject)。
	 *
	 * 关键路径:真实契约保证 `onLateTerminal ⟹ 等待已结束`,此时迟到提交可以安全排在
	 * `this.tail` 之后(与后续操作串行);反之(只有替身会造出的逆序)若也入队,提交会排在
	 * 仍在等待本次提交的当前操作之后,双方互相等待 → 死锁。
	 */
	waiterSettled: boolean;
	/** settle-once:非 null 表示该终态已由某条路径处理,后续路径只能复用结果。 */
	settlement: Promise<T> | null;
}

/**
 * 索引目录归属断言失败 — 拒绝递归删除。
 *
 * 关键路径:抛错发生在调用 `VectraStore.dropIndex()` **之前**,因此不会删除任何文件;
 * 稳定错误码供装配层/告警识别,不依赖文案。
 */
export class IndexDirectoryNotOwnedError extends Error {
	/** 稳定错误码。 */
	readonly code = 'index-directory-not-owned';
	/** 被拒绝的索引目录(规范化绝对路径)。 */
	readonly indexDir: string;
	/** 判定原因。 */
	readonly reason: string;

	constructor(indexDir: string, reason: string) {
		super(`索引目录归属断言未通过,拒绝清库:${reason}(${indexDir})`);
		this.name = 'IndexDirectoryNotOwnedError';
		this.indexDir = indexDir;
		this.reason = reason;
	}
}

/** 代际目录集合名 — 与 `core/index-generations` 的目录布局契约一致。 */
const INDEX_GENERATIONS_DIRNAME = 'generations';
/** 代际目录名 — 由配置指纹派生(`gen-` + 16 位小写十六进制)。 */
const INDEX_GENERATION_DIR_PATTERN = /^gen-[0-9a-f]{16}$/;
/** Vectra 索引文件 — 普通索引目录的标志性索引特征。 */
const INDEX_VECTRA_INDEX_FILENAME = 'index.json';
/** `.index/` 根下的受保护文件 — 命中任一即说明目标是根而不是代际目录。 */
const INDEX_ROOT_PROTECTED_FILENAMES = ['control.json', 'owner.lock', 'owner.recovery.lock'] as const;
/** `pendingWrites` 缺省容量上限 — 超限按插入顺序淘汰最旧,防止停滞请求永久驻留。 */
const DEFAULT_PENDING_WRITE_LIMIT = 32;

/**
 * 缺省归属判定 — 返回拒绝原因,返回 null 表示允许删除。
 *
 * 判定目标(纵深防御,与适配器内的硬守卫互补):
 * 1. 目录名等于 `generations` → 聚合目录;
 * 2. 内含 `control.json` / `owner.lock` / `owner.recovery.lock` → `.index/` 根;
 * 3. 内含 `generations/` 子目录 → `.index/` 根;
 * 4. 父目录名为 `generations` 时,目录名必须匹配 `gen-<16hex>`,否则是代际树里的异形目录;
 * 5. **形状白名单**:目标必须「看起来像一个索引目录」—— 目录不存在、为空,或内含索引特征
 *    (`index.json` / `generations/` / `control.json`)任一,才允许递归删除;非空且不含任何
 *    索引特征的一律拒绝。pluginDir 形状(内含 `main.js` / `data.json` / `attachments` 等
 *    插件产物但**没有**索引特征)必须被拒 —— 否则一次装配错误就会静默递归删掉整个插件目录。
 *
 * 为什么第 4 条只在 `generations/` 树内强制:T7 之前的装配(`src/main.ts`)把 `.index/` 根
 * 直接当索引目录使用,若要求任意索引目录都必须是 `gen-<16hex>`,清库与参数变更重建会在
 * 迁移完成前全部失败;而真正的危险目标(根/聚合目录/根内受保护文件)已由 1–3 覆盖。
 * 第 5 条是「形状白名单」而不是「代际白名单」:它只要求目标含索引特征,合法的普通索引目录
 * (`index.json` 存在)照常可删,不误伤今天未接线时的全量重建。
 *
 * 严格版(要求 basename 必须是本索引根 `generations/` 下的 `gen-[0-9a-f]{16}`)不在缺省实现里:
 * T7 装配代际目录后**必须**注入 `assertDropOwnership` 收紧为「必须是本索引根下的代际目录」。
 *
 * @param indexDir - 待删除的索引目录(调用方已解析为绝对路径)。
 * @returns 拒绝原因;允许删除时为 null。
 */
function describeForeignIndexDir(indexDir: string): string | null {
	const base = path.basename(indexDir);
	if (base === INDEX_GENERATIONS_DIRNAME) return '目标是代际聚合目录 generations/';
	for (const name of INDEX_ROOT_PROTECTED_FILENAMES) {
		if (fs.existsSync(path.join(indexDir, name))) return `目标内含受保护文件 ${name}`;
	}
	const generationsPath = path.join(indexDir, INDEX_GENERATIONS_DIRNAME);
	if (fs.existsSync(generationsPath) && fs.statSync(generationsPath).isDirectory()) {
		return '目标是 .index 根(内含 generations/ 聚合目录)';
	}
	if (path.basename(path.dirname(indexDir)) === INDEX_GENERATIONS_DIRNAME && !INDEX_GENERATION_DIR_PATTERN.test(base)) {
		return `目标是 generations/ 下的非代际目录(${base})`;
	}
	// 关键路径:第 5 条形状白名单 —— 不存在或空目录没有可删的东西,允许;非空目录必须含索引特征。
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(indexDir, { withFileTypes: true });
	}
	catch {
		// 读不到按「不存在」处理:递归删除本身对不存在的目标是无操作,不值得在这里升级成拒绝。
		return null;
	}
	if (entries.length === 0) return null;
	const indexFeatures = [
		INDEX_VECTRA_INDEX_FILENAME,
		INDEX_GENERATIONS_DIRNAME,
		...INDEX_ROOT_PROTECTED_FILENAMES,
	];
	if (indexFeatures.some(name => fs.existsSync(path.join(indexDir, name)))) return null;
	return `目标不含任何索引特征(${indexFeatures.join(' / ')}),拒绝递归删除非索引目录`;
}

/**
 * 完成记录的最小结构视图 — 与 T1/T3 的 `FileCommit` 结构兼容。
 *
 * 关键路径:结构化端口避免把日志实现绑进后端,同时保证 `IndexFileJournal` 可直接注入。
 */
export interface CommittedFileRecord {
	/** vault 规范化相对路径。 */
	path: string;
	/** 版本状态。 */
	state: 'present' | 'deleted';
	/** 同路径单调递增版本号。 */
	revision: number;
	/** 输入内容 hash;删除记录为 null。 */
	inputHash: string | null;
	/** 块数量。 */
	chunkCount: number;
}

/**
 * 文件完成记录读取端口 — 由 T3 的 `IndexFileJournal` 实现。
 *
 * 关键路径:部分检索可用性与完整性判定必须读文件记录,不能只凭全量清单布尔值。
 * 端口语义与 `IndexFileJournal` 一一对应,是明确的二分,不允许互相混入:
 * - `listReceipts` 只返回 `state === 'present'` 的完成记录,删除路径一律不在其中;
 * - `listTombstones` 是删除凭据(tombstone)的唯一出口;
 * - `listSearchableReceipts` 再扣除隔离/不可用路径。
 *
 * 为什么必须二分:把 tombstone 当作「已提交」会让可见性门放过已删除路径(T7),
 * 而把删除凭据从 present 集里漏掉又会读空集,两者都会造出错误的「已完成」结论。
 */
export interface FileRecordReader {
	/** 全部可信的 present 完成记录(不含删除凭据)。 */
	listReceipts(): Promise<ReadonlyArray<CommittedFileRecord>>;
	/** 全部可信的删除凭据(tombstone);与 `listReceipts` 互斥,同一路径当前只出现在一侧。 */
	listTombstones(): Promise<ReadonlyArray<CommittedFileRecord>>;
	/** 可检索的完成记录 — 已排除 tombstone 与不可用路径。 */
	listSearchableReceipts(): Promise<ReadonlyArray<CommittedFileRecord>>;
}

/** 部分检索可用性视图。 */
export interface SearchableFileRecords {
	/** 可检索文件总数。 */
	total: number;
	/** 可检索文件记录。 */
	records: ReadonlyArray<CommittedFileRecord>;
}

/** 本轮索引运行的实时状态 — 判定「全库完成」不能只看持久凭据。 */
export interface IndexRoundState {
	/** 本轮扫描是否已结束。 */
	scanComplete: boolean;
	/** 待处理队列长度。 */
	queued: number;
	/** 在途提交数。 */
	active: number;
	/** 未决事务数。 */
	pendingTransactions: number;
	/** 本轮未清除的失败数。 */
	failures: number;
	/**
	 * 本轮写请求是否缺少 epoch 保护(fail-open 的结构化暴露)。
	 *
	 * 关键路径:缺省 `getEpoch` 时下发的 `epoch` 被省略,管理器按 0 处理,而 `updateActivity`
	 * 只在 `epoch !== 0` 时校验 —— 也就是旧实例的活动不会被拒绝。这是**可查询的事实**,不能
	 * 只靠告警(`devLogger.warn` 受 `debugLog` 门控,缺省不输出):T7 用本字段在状态里显示
	 * 「本轮缺少 epoch 保护」。
	 * 判定:未注入 `getEpoch` 恒为 true;注入了但某次返回 `undefined` 同样置 true。
	 */
	epochSourceMissing: boolean;
}

/**
 * 协调器提供的队列/在途/未决事务计数。
 *
 * 关键路径:协调器模式下本轮扫描不由 `runScan` 驱动,若这里只给队列计数,
 * `round.scanComplete` 会恒为 false(`isIndexComplete()` 恒假);因此把协调器的
 * 扫描完成与失败计数一并作为可选信号接入。`IndexTaskCounters` 结构上直接满足本端口,
 * 装配层可以直接 `getRoundCounters: () => coordinator.counters()`。
 */
export interface IndexRoundCounters {
	/** 待处理队列长度。 */
	queued: number;
	/** 在途提交数。 */
	active: number;
	/** 未决事务数。 */
	pendingTransactions: number;
	/** 协调器视角的本轮扫描是否已结束;缺失时沿用后端自身的扫描状态。 */
	scanComplete?: boolean;
	/** 协调器视角的本轮未清除失败数;缺失时沿用后端自身的失败计数。 */
	failures?: number;
}

/** 装配端口通过 getter 读取，兼容模型就绪后替换 VectraStore 的生命周期。 */
export interface PersistentIndexBackendOptions {
	indexDir: string;
	manifest: IndexManifest;
	worker: WorkerManager;
	getStore: () => VectraStore;
	vault: {
		listMarkdownFiles(): string[];
		readFile(path: string): Promise<string>;
		stat(path: string): {
			mtime: number;
		} | null;
	};
	getBuildStamp: () => IndexBuildStamp;
	getChunkOptions: () => ChunkOptionsPayload;
	/**
	 * 可选:文件完成记录端口;注入后完整性判定与部分可用性读取文件记录。
	 *
	 * 关键路径(T7 已收紧):**未注入时视为不可判定**,`isIndexComplete()` 与
	 * `fileRecordsCoverManifest()` 返回 false,不再按旧凭据语义乐观返回 true。
	 * 生产装配已在 `main.ts` 注入 `IndexFileJournal`(装配守卫强制),缺端口只应出现在
	 * 测试或错误装配中,而错误装配必须失败关闭、不能声称全库完成。
	 */
	fileRecords?: FileRecordReader | null;
	/**
	 * 可选:本轮队列/在途/未决事务计数,以及协调器视角的扫描完成与失败计数;未注入时按 0 计。
	 *
	 * 缺省风险(T7 待办):计数缺失时会得到「队列已空、无在途、无未决事务、扫描未完成」的结论
	 * —— 协调器模式下 `scanComplete` 只能来自本端口,不注入时 `isIndexComplete()` 恒为 false;
	 * 装配点必须保证协调器计数器注入(`() => coordinator.counters()` 结构兼容)。
	 */
	getRoundCounters?: () => IndexRoundCounters;
	/**
	 * 可选:写请求的任务标识与写所有权 epoch(T6 登记 T5 的迟到终态通道)。
	 *
	 * 关键路径:T5 的 `onLateTerminal` 只有拿到「稳定任务身份」才有意义 —— Worker 侧按
	 * `taskId` 给活动盖章,前台按 `epoch` 拒绝旧实例的活动。
	 *
	 * 装配事实:`IndexTaskCoordinator` **没有** `currentTaskId()` 之类的 getter,
	 * 它的 `taskId` 是私有字段、每轮 `start()` 只增一次(轮内恒定),只在 `counters().taskId` 上暴露
	 * 一个数字。因此这里接受的是调用方自己维护的稳定字符串身份(缺省由本模块自增生成),
	 * 不要写成并不存在的 `() => coordinator.currentTaskId()`。
	 *
	 * 关键路径:本模块内部**不再**用 `taskId` 当 `pendingWrites` 的键 —— 轮内恒定会让同轮第二个
	 * 写请求覆盖第一个的上下文(见 {@link PersistentIndexBackend.registerPendingWrite})。
	 */
	getTaskId?: () => string;
	/**
	 * 可选:写所有权 epoch 提供者。
	 *
	 * 缺省风险(fail-open):缺省时下发的 `epoch` 被省略,管理器按 0 处理,而
	 * `updateActivity` 只在 `epoch !== 0` 时校验 → 旧实例的活动不会被拒绝。
	 * 本模块在缺省时**明确告警一次**(`devLogger.warn`),并把事实结构化暴露在
	 * `roundState().epochSourceMissing`,不静默放过。
	 *
	 * **T7 必须注入 `() => owner.epoch`** 才能关闭这条 fail-open(注入后标记恒为 false)。
	 */
	getEpoch?: () => number;
	/**
	 * 可选:清库前的索引目录归属断言 — 不通过即拒绝调用 `store.dropIndex()`,不删除任何文件。
	 *
	 * 缺省按 {@link describeForeignIndexDir} 的「规范化路径 + 内容探测 + 形状白名单」判定:
	 * 拒绝 `generations/` 聚合目录、`.index/` 根(内含控制指针/owner 锁/`generations/`)、
	 * `generations/` 下不符合 `gen-<16hex>` 的异形目录,以及**不含任何索引特征的非空目录**
	 * (例如 pluginDir 形状的插件产物目录)。
	 *
	 * 严格版(**T7 必须注入**):本端口存在即**优先替代**缺省判定(见
	 * {@link PersistentIndexBackend.assertStoreOwnership})。T7 装配代际目录后必须注入
	 * 「basename 是本索引根 `generations/` 下的 `gen-[0-9a-f]{16}` 才允许删除」的严格版本,
	 * 把「形状白名单」收紧成「代际白名单」;缺省实现只做到形状白名单,不承担代际归属语义。
	 */
	assertDropOwnership?: (indexDir: string) => void;
	/**
	 * 可选:`pendingWrites` 容量上限(缺省 32)。
	 *
	 * 关键路径:等待结束但终态永不投递的请求(取消/运行时重置)会留下提交闭包
	 * (`index.batch` 的闭包 captured 整批文件正文),必须按容量有界淘汰最旧条目。
	 */
	pendingWriteLimit?: number;
	/**
	 * 可选:迟到终态被后端接收后的诊断回调(不含正文、路径与向量)。
	 *
	 * 缺省行为不依赖本回调:迟到终态**一定会**被接收并完成清单/构建戳提交,
	 * 否则 T5 的提交路径在生产等于零收益。本回调只用于观测与测试断言,不改变提交语义;
	 * 它在提交动作(含落盘)**返回之后**才触发 —— 回调看到的一定是已落盘状态。
	 */
	onLateTerminalCommitted?: (info: { requestType: string; taskId: string; epoch: number; indexed: number }) => void;
}
/**
 * 统一持久化入口:输入快照决定向量与清单;整批结果只汇总统计,不再承担唯一提交职责。
 *
 * 关键路径:文件级有效性由文件完成记录决定,本模块的清单与构建戳只是可重建的派生视图;
 * 任一写失败都不得抹掉其他文件已提交的凭据(整库失效操作已移除)。
 */
export class PersistentIndexBackend implements IndexBackend {
	private tail: Promise<unknown> = Promise.resolve();
	/** 本轮扫描/失败状态 — 完整性判定必须看本轮状态,不只看持久凭据。 */
	private round = { scanComplete: false, failures: 0 };
	/** 自增任务号 — 未注入 `getTaskId` 时使用,保证每次写请求都有稳定可归属的身份。 */
	private taskCounter = 0;
	/** 自增写请求序号 — 与 `taskId` 拼成每请求唯一键,轮内重复的 taskId 不会再互相顶替。 */
	private writeSequence = 0;
	/** epoch 缺省告警只发一次,避免每个写请求刷屏。 */
	private epochWarningEmitted = false;
	/**
	 * 是否已经发生过「写请求拿不到 epoch」—— 未注入 `getEpoch`,或注入了但某次返回 `undefined`。
	 *
	 * 关键路径:这是 fail-open 的**结构化**暴露面(见 {@link IndexRoundState.epochSourceMissing}),
	 * 与只发一次的告警互补:告警受 `debugLog` 门控、默认不可见,状态字段始终可查。
	 */
	private epochSourceMissing = false;
	/**
	 * 尚未由调用方等待结算的写请求(停滞/超时/取消)。
	 *
	 * 关键路径:
	 * - 迟到终态到达时,调用方的等待已经结束,提交动作只能在这里找到上下文;
	 *   没有它,T5 的「迟到终态仍走提交路径」在装配后等于零收益;
	 * - 键是**每请求唯一键**,不是 `taskId` —— 协调器的 taskId 轮内恒定,用它当键会让
	 *   同轮第二个写请求覆盖第一个的上下文,造成终态错配与提交丢失;
	 * - 容量有界(见 `pendingWriteLimit`),并在清库/重建时由 `clearPendingWrites()` 清空。
	 */
	private pendingWrites = new Map<string, PendingWriteState>();
	constructor(private deps: PersistentIndexBackendOptions) {}

	/** 启动时对已成功提交的清单做 hash diff；未知完整性的旧索引保守重建一次。 */
	smartReindex(): Promise<IndexResult & {
		skipped: number;
	}> {
		return this.serialize(() => this.runScan(async () => {
			const stamp = this.deps.getBuildStamp();
			const chunkOptions = this.deps.getChunkOptions();
			const manifest = await this.deps.manifest.load();
			const exists = await this.isIndexCreated();
			if (!exists || !manifest || this.deps.manifest.shouldFullRebuild(manifest, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)) {
				// 关键路径:只在缺少有效清单或参数不兼容时重建，不把运行失败当作损坏。
				if (exists)
					await this.dropStore();
				return { ...await this.full(), skipped: 0 };
			}
			const files = await this.snapshot();
			const diff = this.deps.manifest.diff(manifest, files);
			const changed = new Set([...diff.toAdd, ...diff.toUpdate].map(file => file.path));
			const toEmbed = files.filter(file => changed.has(file.path));
			if (toEmbed.length === 0 && diff.toDelete.length === 0) {
				await this.commit(manifest, stamp);
				return { indexed: 0, errors: 0, skipped: diff.unchanged.length };
			}
			// 关键路径:本轮清单的工作副本 —— 批量提交与删除都改它,末尾一次性落盘。
			// 之所以是 `let`:逆序投递防御下需要整体换成磁盘真值(见下面的批量分支)。
			let roundManifest: IndexManifestData = manifest;
			/** 本批是否已由迟到路径落盘、且工作副本因此改从磁盘真值重建。 */
			let batchSettledLate = false;
			// 关键路径:这里不再删除全库清单与构建戳 —— 已提交文件的凭据必须跨本次失败保留。
			let indexed = 0;
			if (toEmbed.length > 0) {
				// 关键路径(B2):正常路径的闭包只改内存,本方法末尾的 `commit` 才是这次提交的落盘点;
				// 迟到路径没有调用方收尾,必须给出 `lateEffect` —— 它从磁盘真值重新推导本批效果再落盘,
				// 否则 `onLateTerminalCommitted` 会报告一个磁盘上并不存在的成功。
				indexed = await this.dispatchWrite(
					{ type: 'index.batch', payload: { files: toEmbed, chunkOptions } },
					(result) => this.applyBatchEntries(roundManifest, toEmbed, result),
					async (result) => {
						const fresh = await this.deps.manifest.load() ?? this.blankManifest(stamp);
						const count = this.applyBatchEntries(fresh, toEmbed, result);
						await this.commit(fresh, stamp);
						return count;
					},
				);
				// 关键路径(settle-once 的逆序防御,见 `settlePending`):真实 `WorkerManager` 保证
				// `onLateTerminal ⟹ 调用方等待已结束`,但替身/异常投递可能让**迟到回调先到**。此时
				// 本请求的结算已由 `lateEffect` 完成,`commit` 闭包被跳过 —— 调用方手里的工作副本
				// 没有本批条目。若照它走到末尾 `commit`,就会用陈旧快照覆盖磁盘上刚落盘的本批
				// (实测:磁盘清单被写成空)。所以提交前核对「本批是否真落在工作副本上」,
				// 没有就改从磁盘真值重建,使逆序与正序落到同一份磁盘结果。
				if (!toEmbed.every(file => roundManifest.entries[file.path]?.hash === file.hash)) {
					roundManifest = await this.deps.manifest.load() ?? this.blankManifest(stamp);
					batchSettledLate = true;
				}
			}
			// 关键路径(镜像代价,与删除侧并列):本轮**既有批量新增又有删除**时,先把批量新增落盘
			// 一次再进入删除循环。否则「批量成功 → 随后某个删除停滞」时调用方永远走不到末尾
			// `commit`,迟到删除只从磁盘真值移除目标条目 —— 磁盘会丢掉本轮全部批量新增(实测 keys=[])。
			// 写盘次数:混合轮 2 次(批量一次 + 循环末尾一次),仍是常数而不是 N+1;只有删除的轮次
			// 仍保持 1 次(不进入本分支),单文件路径不受影响。
			if (toEmbed.length > 0 && diff.toDelete.length > 0) await this.commit(roundManifest, stamp);
			for (const filePath of diff.toDelete) {
				// 关键路径:删除的清单变更由调用方在循环末尾一次性落盘(N 个删除 = 1 次写盘);
				// 迟到终态由 `deleteVectors` 的 `lateEffect` 自己完成同一事务,不重复写盘。
				await this.deleteVectors(filePath, stamp);
				this.deps.manifest.removeEntry(roundManifest, filePath);
			}
			// 关键路径:迟到路径已用磁盘真值把本批落盘,且本轮没有删除要合并时,末尾这次
			// `commit` 只会重复同一次提交 —— 跳过它,逆序与正序的写盘次数因此一致(都只提交一次)。
			const needsRoundCommit = !batchSettledLate || diff.toDelete.length > 0;
			if (needsRoundCommit) await this.commit(roundManifest, stamp);
			return { indexed, errors: 0, skipped: diff.unchanged.length };
		}));
	}

	/** 手动全量入口；只有所有输入文件与元数据都写成功才返回。 */
	fullReindex(): Promise<IndexResult> {
		return this.serialize(() => this.runScan(() => this.full()));
	}

	/** 单文件更新与清单提交使用相同输入内容；失败后清单保持无效。 */
	incrementalIndex(file: {
		path: string;
		content: string;
	}): Promise<IndexResult> {
		return this.serialize(() => this.runUnit(async () => {
			const stamp = this.deps.getBuildStamp();
			const chunkOptions = this.deps.getChunkOptions();
			const contentHash = await sha256(file.content);
			return this.dispatchWrite({
				type: 'index.incremental', payload: { file, chunkOptions },
			}, async (result) => {
				this.requireSuccess(result);
				if (result.type !== 'index.done')
					throw this.unexpectedResponse();
				// 关键路径(阻断 B1 的深层成因):清单必须在**提交时刻**重新读取,不能沿用派发前的快照 ——
				// 等待结束到迟到终态到达之间可能有别的请求已提交,旧快照会把那部分提交整个覆盖掉。
				const data = await this.deps.manifest.load();
				if (data) {
					// 关键路径:事件内容可能早于当前 stat；mtime=0 强制下次启动用 hash 核实。
					this.deps.manifest.recordEntry(data, file.path, contentHash, 0, result.payload.chunkCount ?? 0);
					await this.commit(data, stamp);
				}
				return result.payload;
			});
		}));
	}

	/** 删除向量成功后再移除清单条目。 */
	deleteFile(filePath: string): Promise<number> {
		return this.serialize(() => this.runUnit(async () => {
			const stamp = this.deps.getBuildStamp();
			const count = await this.deleteVectors(filePath, stamp);
			const data = await this.deps.manifest.load();
			if (data) {
				this.deps.manifest.removeEntry(data, filePath);
				await this.commit(data, stamp);
			}
			return count;
		}));
	}

	/**
	 * 清库同样经过 WorkerManager 写通道，超时仍在运行的旧任务不能与之重叠。
	 *
	 * 关键路径:
	 * - 这里重置的是**整轮**状态(含 `scanComplete=false`),不是「提交成功」信号 ——
	 *   清库后任何文件都不再有可信凭据,`isIndexComplete` 仍会因扫描未完成而返回 false;
	 * - 真正删除之前先过归属断言(见 `assertStoreOwnership`):目录被判定为 `.index/` 根、
	 *   `generations/` 聚合目录或代际树里的异形目录时**拒绝删除**,不触碰任何文件;
	 * - 未结算的写请求上下文一并清空(等待已被清库作废,旧终态不再有提交意义)。
	 */
	dropIndex(): Promise<void> {
		return this.serialize(async () => {
			this.round.scanComplete = false;
			this.round.failures = 0;
			await this.dropStore();
		});
	}

	/** 查询当前向量目录。 */
	isIndexCreated(): Promise<boolean> {
		return this.deps.getStore().isIndexCreated();
	}

	/**
	 * 本轮索引状态 — 完整性判定与展示读取同一份状态。
	 *
	 * 关键路径:
	 * - 未注入协调器计数器时按 0 计(队列空、无在途、无未决事务),扫描状态沿用后端自身;
	 * - 注入协调器计数器时,`scanComplete`/`failures` 由协调器提供(它才是本轮扫描的驱动方),
	 *   缺失这两个字段才回落到后端自身的 `runScan` 状态 —— 协调器模式下后端从不跑
	 *   `runScan`,`round.scanComplete` 恒为 false,必须靠协调器信号才能反映真实收敛。
	 *
	 * @returns 本轮扫描/失败状态与协调器计数器,以及「缺少 epoch 保护」的结构化标记。
	 */
	roundState(): IndexRoundState {
		const counters = this.deps.getRoundCounters?.() ?? { queued: 0, active: 0, pendingTransactions: 0 };
		return {
			scanComplete: counters.scanComplete ?? this.round.scanComplete,
			failures: counters.failures ?? this.round.failures,
			queued: counters.queued,
			active: counters.active,
			pendingTransactions: counters.pendingTransactions,
			// 关键路径:未注入提供者时恒 true —— 不能等第一次写请求才暴露,状态查询要先能看见。
			epochSourceMissing: this.epochSourceMissing || this.deps.getEpoch === undefined,
		};
	}

	/**
	 * 检查本轮索引是否真的完成 — 本轮扫描/队列/失败与持久凭据共同决定。
	 *
	 * 关键路径:全量清单布尔值不能替代本轮状态;注入文件记录端口后还要求
	 * 清单每个条目都能在文件记录里找到同 hash 的 present 版本。
	 * 本轮失败只有「扫描重跑成功」才清除,单文件提交成功不清零(见 `runScan` 语义边界)。
	 *
	 * @returns 本轮扫描结束、队列与在途清空、无失败、凭据可信且记录覆盖时为 true。
	 */
	async isIndexComplete(): Promise<boolean> {
		const round = this.roundState();
		if (!round.scanComplete || round.queued > 0 || round.active > 0 || round.pendingTransactions > 0 || round.failures > 0) {
			return false;
		}
		if (!await this.credentialsCurrent()) return false;
		return this.fileRecordsCoverManifest();
	}

	/**
	 * 部分检索可用性 — 只读文件记录,排除 tombstone 与不可用路径。
	 *
	 * @returns 可检索记录视图;未注入文件记录端口时为 null(不可判定,不能当作空集)。
	 */
	async searchableFileRecords(): Promise<SearchableFileRecords | null> {
		const reader = this.deps.fileRecords;
		if (!reader) return null;
		const records = await reader.listSearchableReceipts();
		return { total: records.length, records };
	}

    /** 只读验证已提交元数据与索引存在性，不初始化存储、不读取vault、不修写凭据。 */
    readCommittedState(): Promise<CommittedIndexState | null> {
        return this.serialize(() => this.deps.worker.runExclusive(async () => {
            const data = await this.deps.manifest.load();
            const stamp = this.deps.getBuildStamp();
            if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)
                || !Number.isFinite(data.lastIndexTime) || data.lastIndexTime < 0
                || this.deps.manifest.shouldFullRebuild(data, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)
                || !isBuildStampCurrent(await readBuildStamp(this.deps.indexDir), stamp)) return null;
            for (const [filePath, entry] of Object.entries(data.entries)) {
                if (!entry || entry.path !== filePath || typeof entry.hash !== 'string'
                    || !Number.isFinite(entry.mtime) || !Number.isInteger(entry.chunkCount) || entry.chunkCount < 0) return null;
            }
            try {
                // 关键路径:VectraStore.isIndexCreated会触发懒初始化；此处必须直接只读检查磁盘。
                if (!(await fs.promises.stat(path.join(this.deps.indexDir, 'index.json'))).isFile()) return null;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw err;
            }
            return { totalDocs: Object.keys(data.entries).length, lastIndexTime: data.lastIndexTime };
        }));
    }

	/** 读取用于索引的文件内容快照。 */
	async listMarkdownFiles(): Promise<Array<{
		path: string;
		content: string;
	}>> {
		return this.snapshot();
	}
	private async full(): Promise<IndexResult> {
		const stamp = this.deps.getBuildStamp();
		const chunkOptions = this.deps.getChunkOptions();
		const files = await this.snapshot();
		const data: IndexManifestData = this.blankManifest(stamp);
		// 关键路径:全量清单是自包含的(entries 由本次快照决定),因此正常路径与迟到路径
		// 共用同一个闭包即可,不存在被后续提交覆盖的旧快照问题。
		return this.dispatchWrite({
			type: 'index.full', payload: { files, chunkOptions },
		}, async (response) => {
			this.requireSuccess(response);
			if (response.type !== 'index.done')
				throw this.unexpectedResponse();
			for (const file of files)
				this.deps.manifest.recordEntry(data, file.path, file.hash, file.mtime, 0);
			await this.commit(data, stamp);
			return response.payload;
		});
	}

	/** 构造一份空清单数据 — 全量重建与迟到批量提交共用同一形状。 */
	private blankManifest(stamp: IndexBuildStamp): IndexManifestData {
		return { version: 1, ...stamp, entries: {}, lastIndexTime: Date.now() };
	}

	/**
	 * 把批量终态里的块数写进给定清单 — 正常路径与迟到路径共用同一份字段级语义。
	 *
	 * 关键路径:`target` 由调用方决定(正常路径是调用方持有的清单对象,迟到路径是从磁盘重载的对象),
	 * 这样「写什么」只有一份实现,不会两条路径悄悄分叉。
	 *
	 * @param target - 被写入的清单数据。
	 * @param files - 本批提交的文件快照。
	 * @param response - Worker 终态。
	 * @returns 本批处理的文件数。
	 */
	private applyBatchEntries(target: IndexManifestData, files: readonly IndexSnapshot[], response: WorkerResponse): number {
		this.requireSuccess(response);
		if (response.type !== 'index.batch.done')
			throw this.unexpectedResponse();
		for (const file of files) {
			const count = response.payload.chunkCounts[file.path];
			if (count === undefined)
				throw this.unexpectedResponse();
			this.deps.manifest.recordEntry(target, file.path, file.hash, file.mtime, count);
		}
		return response.payload.indexed;
	}
	private async snapshot(): Promise<IndexSnapshot[]> {
		const files: IndexSnapshot[] = [];
		for (const filePath of this.deps.vault.listMarkdownFiles()) {
			// 关键路径:先 stat 再读内容；索引期间的后续修改不能被标为本次已处理。
			const mtime = this.deps.vault.stat(filePath)?.mtime ?? 0;
			const content = await this.deps.vault.readFile(filePath);
			files.push({ path: filePath, content, mtime, hash: await sha256(content) });
		}
		return files;
	}
	/**
	 * 删除单个文件的向量 — 同样登记任务身份与迟到终态通道。
	 *
	 * 关键路径(删除路径写盘次数,取舍见 T6 报告):
	 * - **正常路径**:闭包只返回删除块数,清单的 `removeEntry` 与落盘由调用方完成 ——
	 *   `smartReindex` 的 N 个删除共用循环末尾的 1 次提交,`deleteFile` 每个文件提交 1 次。
	 *   取舍理由:删除是同一轮扫描的一部分,循环末尾一次性落盘既保证「本轮删除集合」原子可见,
	 *   也把 N+1 次写盘降为 1 次;代价是扫描中途失败时本轮已删除的条目要到迟到终态才落盘。
	 *   镜像代价(批量侧)与补偿见 {@link PersistentIndexBackend.smartReindex}:同轮「批量新增 +
	 *   删除」时批量先落盘一次,避免删除停滞把本轮批量新增一起丢掉。
	 * - **迟到路径**:调用方已经退出(停滞/超时),必须由 `lateEffect` 自己从磁盘真值完成
	 *   「重载清单 → removeEntry → 落盘」这条事务,且 `removeEntry` 只做一次。
	 *
	 * @param filePath - vault 相对路径。
	 * @param stamp - 构建戳;迟到提交需要它写「清单 + 戳」这份派生视图。
	 * @returns 实际删除的块数。
	 */
	private async deleteVectors(filePath: string, stamp: IndexBuildStamp): Promise<number> {
		return this.dispatchWrite(
			{ type: 'index.delete', payload: { filePath } },
			(response) => {
				if (response.type !== 'vector.delete.done')
					throw this.unexpectedResponse();
				return response.payload.count;
			},
			async (response) => {
				if (response.type !== 'vector.delete.done')
					throw this.unexpectedResponse();
				// 关键路径:迟到提交以磁盘真值为准;磁盘上没有清单就没有「派生视图」可提交
				// (与调用方 `if (data)` 同义),不凭空造一份清单出来。
				const fresh = await this.deps.manifest.load();
				if (fresh) {
					this.deps.manifest.removeEntry(fresh, filePath);
					await this.commit(fresh, stamp);
				}
				return response.payload.count;
			},
		);
	}

	/**
	 * 清库前的归属断言 + 有界回收,然后才走独占写通道调用 `store.dropIndex()`。
	 *
	 * 关键路径(B2 纵深防御):归属断言不通过时**不调用** `dropIndex()`,因此不删除任何文件;
	 * 适配器内的硬守卫是第二道防线(即使绕过这里也不会删 `.index/` 根、代际聚合目录
	 * 或内含控制指针/owner 锁的目录)。
	 */
	private async dropStore(): Promise<void> {
		this.assertStoreOwnership();
		// 关键路径:清库/重建之后旧任务的迟到终态不再有提交意义;顺带回收视图里的提交闭包。
		this.clearPendingWrites();
		await this.deps.worker.runExclusive(() => this.deps.getStore().dropIndex());
	}

	/**
	 * 索引目录归属断言 — 缺省按「规范化路径 + 内容探测 + 形状白名单」判定,可注入更严格的端口。
	 *
	 * 关键路径:注入的 `assertDropOwnership` **优先于**缺省判定,不是叠加 —— 注入方(严格版)
	 * 拥有最终裁决权,缺省实现只覆盖未接线时的安全边界。
	 *
	 * @throws {IndexDirectoryNotOwnedError} 归属未通过;抛出前不删除任何文件。
	 */
	private assertStoreOwnership(): void {
		const indexDir = path.resolve(this.deps.indexDir);
		const assertOwnership = this.deps.assertDropOwnership;
		if (assertOwnership) {
			assertOwnership(indexDir);
			return;
		}
		const reason = describeForeignIndexDir(indexDir);
		if (reason !== null)
			throw new IndexDirectoryNotOwnedError(indexDir, reason);
	}

	/**
	 * 清空未结算写请求的提交上下文 — 取消/运行时重置/清库后由调用方或本模块调用。
	 *
	 * 关键路径:被清空的条目其迟到终态将成为空操作 —— 这是有意的:等待已被取消/重置之后,
	 * 旧终态不再有提交意义,而闭包持有的正文必须立刻释放。
	 *
	 * @returns 被清空的条目数。
	 */
	clearPendingWrites(): number {
		const cleared = this.pendingWrites.size;
		this.pendingWrites.clear();
		return cleared;
	}

	/** 尚未结算的写请求数 — 诊断与用例断言用(容量上限生效时不会无限增长)。 */
	pendingWriteCount(): number {
		return this.pendingWrites.size;
	}
	/**
	 * 本轮扫描的状态跟踪 — 成功才标记扫描结束,失败按次累加。
	 *
	 * 语义边界(scan 级):`failures` 的**唯一清零点**在这里的成功分支 ——
	 * 只有「本轮扫描重跑并成功」才能证明全库被重新核实。`commit()` 属于单文件提交,
	 * 成功后不清零本轮失败计数,否则「A 文件失败 + B 文件成功」会被静默说成全库完成。
	 */
	private async runScan<T>(operation: () => Promise<T>): Promise<T> {
		this.round.scanComplete = false;
		try {
			const result = await operation();
			this.round.scanComplete = true;
			this.round.failures = 0;
			return result;
		} catch (error) {
			this.round.failures += 1;
			throw error;
		}
	}
	/**
	 * 单文件任务的状态跟踪(unit 级) — 失败计入本轮失败,不能被后续成功静默掩盖。
	 *
	 * 语义边界:这里只累加、不清零;清零只发生在 `runScan` 成功分支,
	 * 因此「本次扫描成功」与「某个文件后来补提交成功」在状态上是两件不同的事。
	 */
	private async runUnit<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.round.failures += 1;
			throw error;
		}
	}
	/** 持久凭据是否可信(清单存在、参数兼容、构建戳一致)。 */
	private async credentialsCurrent(): Promise<boolean> {
		const data = await this.deps.manifest.load();
		const stamp = this.deps.getBuildStamp();
		if (!data || this.deps.manifest.shouldFullRebuild(data, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)) return false;
		return isBuildStampCurrent(await readBuildStamp(this.deps.indexDir), stamp);
	}
	/**
	 * 清单条目是否都有对应的文件完成记录 — 清单是派生视图,文件记录才描述每个文件。
	 *
	 * 关键路径(T7 收紧):缺记录端口时返回 **false**,即「不可判定」—— 不再按旧凭据语义返回
	 * true。旧口径是过渡期的缺省乐观值,装配遗漏时会让 `isIndexComplete` 少一道核对,并把
	 * 「无法核验」说成「已核验」。生产装配由 `main.ts` 注入真实 `IndexFileJournal`
	 * (装配守卫会强制该注入),只读装配用 `createReadOnlyOwnerGuard` + 同一份日志。
	 * 这里只消费 present 集:tombstone 由 `listTombstones` 提供,不得当作「该路径已提交」。
	 */
	private async fileRecordsCoverManifest(): Promise<boolean> {
		const reader = this.deps.fileRecords;
		if (!reader) return false;
		const data = await this.deps.manifest.load();
		if (!data) return false;
		const records = await reader.listReceipts();
		const byPath = new Map<string, CommittedFileRecord>();
		for (const record of records) {
			// 端口语义是 present-only;这里仍按 state 过滤,防止实现把 tombstone 混进来。
			if (record.state === 'present') byPath.set(record.path, record);
		}
		for (const [filePath, entry] of Object.entries(data.entries)) {
			const record = byPath.get(filePath);
			if (!record || record.inputHash !== entry.hash) return false;
		}
		return true;
	}
	/**
	 * 提交「清单 + 构建戳」这份派生视图。
	 *
	 * 关键路径:
	 * - **不触碰本轮失败计数**:`commit` 是 `incrementalIndex` / `deleteFile` 的唯一提交出口,
	 *   单文件提交成功不能证明本轮失败已消除(清零只发生在 `runScan` 成功分支),
	 *   否则「A 文件失败 → B 文件成功」会被静默说成全库完成。
	 * - 清单最后提交,构建戳自身不能证明任何文件内容已索引;失败时只回滚本次已写的构建戳,
	 *   **必须恢复提交前的既有戳**,而不是一律删除 —— 既有「清单 + 戳」是有效凭据,
	 *   一次写失败不得抹掉其他文件已提交的凭据(整库失效操作已移除)。
	 */
	private async commit(data: IndexManifestData, stamp: IndexBuildStamp): Promise<void> {
		data.lastIndexTime = Date.now();
		// 关键路径:写戳前记录既有戳,失败回滚时按原样恢复(没有旧戳才删除)。
		const previousStamp = await readBuildStamp(this.deps.indexDir);
		let stampWritten = false;
		try {
			await writeBuildStamp(this.deps.indexDir, stamp);
			stampWritten = true;
			await this.deps.manifest.save(data);
		}
		catch (err) {
			if (stampWritten) {
				try {
					if (previousStamp) await writeBuildStamp(this.deps.indexDir, previousStamp);
					else await fs.promises.rm(resolveBuildStampPath(this.deps.indexDir), { force: true });
				}
				catch {
					// 回滚失败不遮蔽原始错误:无清单佐证的构建戳会在下次启动被判定为缺失。
				}
			}
			throw err;
		}
	}
	private requireSuccess(response: WorkerResponse): void {
		if (response.type !== 'index.done' && response.type !== 'index.batch.done')
			throw this.unexpectedResponse();
		if (response.payload.errors > 0)
			throw new Error(tNow('notice.indexPartialFailure', { count: response.payload.errors }));
	}
	private unexpectedResponse(): Error {
		return new Error(tNow('notice.indexResponseFailed'));
	}
	/**
	 * 派发一条写请求并登记 T5 的迟到终态通道。
	 *
	 * 关键路径(T5 证据 §5 登记债 / T6 阻断 B1、B2):
	 * - `taskId` / `epoch` 必须显式传给 Worker —— Worker 按它们给活动盖章,前台按 epoch 拒绝旧实例;
	 * - `onLateTerminal` 必须登记 —— 停滞/超时后调用方的等待已结束,真实终态只能经这条通道交回
	 *   「更新清单 + 构建戳」的提交动作。没有它,T5 的提交路径在生产等于零收益;
	 * - 挂起上下文用**每请求唯一键**(`taskId#序号`),不是 `taskId`:协调器的 `taskId` 轮内恒定,
	 *   用 taskId 当键会让同轮第二个写请求覆盖第一个的上下文 —— 旧终态就会执行**新请求的提交**
	 *   (错配)并顺带把新请求置为已处理(丢失它自己的终态);
	 * - settle-once 是权威的:正常等待与迟到回调共享同一个 `settlement`,同一条终态的提交效果
	 *   只执行一次。注意「只执行一次」不作「调用方收尾也只执行一次」解 —— 批量的迟到分支落盘后,
	 *   调用方仍会走到自己的末尾 `commit`,必须先从磁盘真值重建工作副本(见 `smartReindex`)。
	 *
	 * 提交动作的落盘职责按请求类型划分:全量/单文件增量自带落盘;批量与删除的正常路径只改内存
	 * (由调用方统一落盘),因此它们必须提供 `lateEffect` 在迟到路径自行落盘。
	 *
	 * @param request - Worker 请求体。
	 * @param commit - 正常路径的提交动作。
	 * @param lateEffect - 迟到路径专用提交动作(从磁盘真值重推导并落盘);省略时复用 `commit`。
	 * @returns 该终态的提交结果。
	 */
	private async dispatchWrite<T>(
		request: WorkerRequest,
		commit: (response: WorkerResponse) => T | Promise<T>,
		lateEffect?: (response: WorkerResponse) => T | Promise<T>,
	): Promise<T> {
		const taskId = this.nextTaskId();
		const epoch = this.resolveEpoch();
		const state: PendingWriteState<T> = {
			key: `${taskId}#${++this.writeSequence}`,
			requestType: request.type,
			taskId,
			epoch: epoch ?? 0,
			commit,
			lateEffect,
			waiterSettled: false,
			settlement: null,
		};
		const options: WorkerRequestOptions = {
			taskId,
			...(epoch === undefined ? {} : { epoch }),
			onLateTerminal: (response): void => {
				// 关键路径:终态是否已被处理以 `settlement` 为准 —— 正常等待已提交时,这里的迟到回调
				// 只能复用既有结果,不得二次提交;条目已被淘汰/清空时同样成为空操作。
				const pending = this.pendingWrites.get(state.key);
				if (pending) void this.settlePending(pending, response, 'late');
			},
		};
		this.registerPendingWrite(state);
		let pending: Promise<WorkerResponse>;
		try {
			pending = this.deps.worker.request(request, options);
		}
		catch (error) {
			// 关键路径:同步抛错时不留悬挂上下文(异步拒绝则必须保留,等迟到终态)。
			this.pendingWrites.delete(state.key);
			throw error;
		}
		// 关键路径:标记调用方等待结束的时刻 —— 迟到路径据此决定提交是否入队串行(见 settlePending)。
		pending.then(
			() => { state.waiterSettled = true; },
			() => { state.waiterSettled = true; },
		);
		const response = await pending;
		return this.settlePending(state, response, 'normal');
	}

	/**
	 * 登记挂起上下文 — 每请求唯一键、重复键显式抛错、容量超限按插入顺序淘汰最旧。
	 *
	 * 关键路径:
	 * - 唯一键由内部自增序号保证,`taskId` 轮内重复也不再互相顶替;
	 * - 重复键是装配/实现错误(同一 key 只能对应一条请求),必须显式抛错而不是静默覆盖;
	 * - 容量必须有界:`cancelIndex` / `resetRuntime` 之后终态永不投递,其提交闭包
	 *   (`index.batch` 的闭包 captured 整批文件正文)会永久驻留,最旧的条目最不可能再收到终态。
	 *
	 * @param state - 本次写请求的挂起上下文。
	 */
	private registerPendingWrite<T>(state: PendingWriteState<T>): void {
		if (this.pendingWrites.has(state.key))
			throw new Error(`索引写请求键重复,拒绝登记:${state.key}`);
		this.pendingWrites.set(state.key, state);
		const limit = Math.max(1, this.deps.pendingWriteLimit ?? DEFAULT_PENDING_WRITE_LIMIT);
		while (this.pendingWrites.size > limit) {
			const oldest = this.pendingWrites.keys().next();
			if (oldest.done) break;
			this.pendingWrites.delete(oldest.value);
		}
	}

	/**
	 * settle-once:同一条终态的**提交效果**只执行一次,正常路径与迟到路径共享同一结果。
	 *
	 * 关键路径:
	 * - `settlement` **同步**置位,因此「迟到回调先到、等待随后结算」的顺序也不会二次执行提交效果;
	 * - 但「只执行一次」约束的是**该终态的效果**,不是调用方的收尾动作:批量的迟到分支已经落盘时,
	 *   调用方仍会走自己的末尾 `commit` —— 它必须先从磁盘真值重建工作副本(见 `smartReindex`),
	 *   否则会用陈旧内存清单覆盖迟到落盘(实测磁盘被写成空清单);
	 * - 真实契约顺序(`onLateTerminal ⟹ 等待已结束`)下,迟到提交挂在 `this.tail` 之后串行执行,
	 *   不与后续操作重叠;逆序时直接执行,避免提交排在仍在等待它的当前操作之后造成死锁;
	 * - `onLateTerminalCommitted` 只在迟到提交动作(含落盘)**返回之后**触发 ——
	 *   回调看到的一定是已落盘的清单与构建戳,不允许「报告成功但磁盘没写」;
	 * - 正常路径的提交失败仍由调用方自己的 `runUnit` / `runScan` 计数,这里不重复计数。
	 *
	 * @param state - 该请求的挂起上下文(调用方持有引用,不依赖 map 是否已回收)。
	 * @param response - 真实终态。
	 * @param path - 触发路径:正常等待结算,或迟到终态回调。
	 * @returns 该终态的提交结果;已被处理时返回同一份结果。
	 */
	private settlePending<T>(state: PendingWriteState<T>, response: WorkerResponse, path: 'normal' | 'late'): Promise<T> {
		if (state.settlement !== null) return state.settlement;
		const effect = path === 'late' && state.lateEffect !== undefined ? state.lateEffect : state.commit;
		const run = async (): Promise<T> => {
			try {
				const committed = await effect(response);
				if (path === 'late') {
					this.deps.onLateTerminalCommitted?.({
						requestType: state.requestType,
						taskId: state.taskId,
						epoch: state.epoch,
						indexed: readIndexedCount(committed),
					});
				}
				return committed;
			}
			catch (error) {
				// 迟到提交失败不能吞掉:计入本轮失败,保留可定位的诊断。
				if (path === 'late') this.round.failures += 1;
				throw error;
			}
		};
		const settlement = path === 'late' && state.waiterSettled ? this.serialize(run) : run();
		state.settlement = settlement;
		this.pendingWrites.delete(state.key);
		// 关键路径:只为避免无人等待时的 unhandled rejection(迟到路径不 await 结果);
		// 拒绝仍原样传给 await 这份 settlement 的等待者。
		settlement.catch(() => undefined);
		return settlement;
	}

	/**
	 * 读取写所有权 epoch;缺省时明确告警一次并把事实结构化暴露(fail-open 不得静默)。
	 *
	 * 关键路径:缺省下发的请求省略 `epoch`,管理器按 0 处理,而 `updateActivity` 只在
	 * `epoch !== 0` 时校验 —— 也就是旧实例的活动不会被拒绝。这里不直接缺省拒绝:
	 * 本轮装配(`src/main.ts`)尚未注入 `getEpoch`,硬拒绝会让所有写请求失败;
	 * 因此保留缺省语义,并把「缺少 epoch 保护」暴露成**可查询状态**
	 * ({@link IndexRoundState.epochSourceMissing}),不是只靠受 `debugLog` 门控的告警。
	 *
	 * **T7 必须注入 `getEpoch: () => owner.epoch`** —— 只有这样才真正关闭这条 fail-open;
	 * 注入后本字段恒为 false,状态里的「缺少 epoch 保护」随之消失。
	 *
	 * @returns epoch;未注入或提供者返回 undefined 时为 undefined。
	 */
	private resolveEpoch(): number | undefined {
		const epoch = this.deps.getEpoch?.();
		if (epoch === undefined) {
			this.epochSourceMissing = true;
			if (!this.epochWarningEmitted) {
				this.epochWarningEmitted = true;
				devLogger.warn(
					'index',
					'写请求未注入 getEpoch:epoch 按 0 下发(不校验),旧实例活动不会被拒绝 — 装配层应注入 () => owner.epoch',
				);
			}
		}
		return epoch;
	}

	/** 取下一个任务标识 — 未注入提供者时本模块自增生成。 */
	private nextTaskId(): string {
		return this.deps.getTaskId?.() ?? `index_task_backend_${++this.taskCounter}`;
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.tail.then(operation);
		this.tail = task.catch(() => undefined);
		return task;
	}
}

/**
 * 从提交动作的返回值里读「本次处理了多少文件」— 只用于迟到终态的诊断回调。
 *
 * 关键路径:各请求的提交动作返回不同形状(批量为 `{ indexed, errors }`、单文件为 chunk 数),
 * 这里统一收敛成非负整数,不参与任何判定逻辑。
 *
 * @param committed - 提交动作的返回值。
 * @returns 文件数;无法判定时为 0。
 */
export function readIndexedCount(committed: unknown): number {
	if (typeof committed === 'number' && Number.isFinite(committed) && committed >= 0) return Math.floor(committed);
	if (typeof committed === 'object' && committed !== null) {
		const indexed = (committed as { indexed?: unknown }).indexed;
		if (typeof indexed === 'number' && Number.isFinite(indexed) && indexed >= 0) return Math.floor(indexed);
	}
	return 0;
}

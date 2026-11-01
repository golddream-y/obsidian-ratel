/**
 * @file tests/helpers/index-assembly-registry.ts
 * @description 索引装配的**唯一**登记账本 — 可见性门接线与文件记录端口注入的双向守卫共用
 * @module tests/helpers/index-assembly-registry
 *
 * 关键路径(T7 收口):此前「门接线」与「记录端口注入」各有一份平行清单,分散在两个测试文件里,
 * 只能发现「新增漏点」,发现不了「债已还但账还挂着」,守卫会随时间退化成恒真。
 * 这里合并为一份账本,两个守卫各自按**精确集合/计数**断言(多一个、少一个都失败)。
 *
 * 关键路径(T7 复审 S5):账本此前只记「哪些文件接了线」——**文件级布尔**。
 * 同一文件内新增第二处「接线门但未注入 `fileRecords`」时,该文件的布尔值不变,守卫不会变红。
 * 因此账本改为**按注入点计数**:每个文件记录每一类接线手法的实际点位数,
 * 断言写成「实际计数 === 账本计数」,任何新增/删除点位都会让某类计数漂移,必须显式改账本。
 * 账本在装配完成时应只包含真实接线点,不含任何「待注入」余项。
 */

/**
 * 单个文件内的可见性门接线点计数 — 按**接线手法**分类逐点统计。
 *
 * 关键路径:分类而不是只记总数 —— 只记总数时「删掉一处、再加一处」仍相等,
 * 双向断言会漏掉整类接线被替换的情形。
 */
export interface GateWiringPointCounts {
	/** `new ReadOnlySearchView(` 构造点数量。 */
	readonly readOnlySearchViews: number;
	/** `createJournalVisibilitySource(` 组装点数量。 */
	readonly journalVisibilitySources: number;
	/** `new IndexController(` 实参里带 `readOnlyView:` 的接线点数量。 */
	readonly controllerReadOnlyViews: number;
}

/** 生产装配登记账本。 */
export interface IndexAssemblyRegistry {
	/** 可见性门接线点计数 — 文件 → 该文件内各类接线手法的点位数量(不是布尔,同文件第二处必须能被发现)。 */
	readonly gateWiringPointCounts: Readonly<Record<string, GateWiringPointCounts>>;
	/** 后端构造点计数 — 文件 → `new PersistentIndexBackend(` 出现次数。 */
	readonly backendConstructionPointCounts: Readonly<Record<string, number>>;
	/**
	 * 尚未注入 `fileRecords` 的后端构造点计数 — 文件 → 未注入点位数量。
	 *
	 * T7 已把生产装配点全部注入,因此这里必须为空;为空是**结论**而不是白名单:
	 * 断言写的是「实际缺注入计数 == 本字段」,两边都必须为空,所以它不能长期留白。
	 * 逐点计数意味着同一文件里**第二个**后端构造点漏注入也会被计成 2,不会因为
	 * 「该文件另有一处注入了」而被文件级布尔吞掉。
	 */
	readonly pendingFileRecordsPointCounts: Readonly<Record<string, number>>;
}

/** 唯一账本 — 断言与实际装配点逐项相等。 */
export const REGISTERED_INDEX_ASSEMBLY: IndexAssemblyRegistry = {
	gateWiringPointCounts: {
		'src/main.ts': {
			// 只读装配 `setupReadOnlyIndexRuntime` 与写路径 `assembleIndexPipeline` 各构造一个视图。
			readOnlySearchViews: 2,
			// 两处视图来源 + 检索快照 `captureSearchVisibilitySnapshot` 的组装点。
			journalVisibilitySources: 3,
			// 写路径把只读视图交给 `IndexController`。
			controllerReadOnlyViews: 1,
		},
	},
	backendConstructionPointCounts: { 'src/main.ts': 1 },
	pendingFileRecordsPointCounts: {},
};
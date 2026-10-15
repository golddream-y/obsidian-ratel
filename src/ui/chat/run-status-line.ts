/**
 * @file src/ui/chat/run-status-line.ts
 * @description 消息球旁边一行状态：重试、工具名、本地准备/在途随机句、撰写中随机句、步数
 * @module ui/chat/run-status-line
 */

/** 在途（等首字）与撰写阶段的轮换间隔。 */
export const RUN_STATUS_ROTATE_MS = 8000;

/** 本地准备阶段的轮换间隔 — 该阶段通常 1~3 秒，用更短间隔让慢检索时也能看到切换。 */
export const PREPARE_ROTATE_MS = 4000;

/** 撰写中随机句的 i18n key，与中英文案同一下标。 */
export const COMPOSING_FLAVOR_KEYS = [
	'orb.run.flavor.01',
	'orb.run.flavor.02',
	'orb.run.flavor.03',
	'orb.run.flavor.04',
	'orb.run.flavor.05',
	'orb.run.flavor.06',
	'orb.run.flavor.07',
	'orb.run.flavor.08',
	'orb.run.flavor.09',
	'orb.run.flavor.10',
	'orb.run.flavor.11',
	'orb.run.flavor.12',
	'orb.run.flavor.13',
	'orb.run.flavor.14',
	'orb.run.flavor.15',
	'orb.run.flavor.16',
	'orb.run.flavor.17',
	'orb.run.flavor.18',
	'orb.run.flavor.19',
	'orb.run.flavor.20',
	'orb.run.flavor.21',
	'orb.run.flavor.22',
	'orb.run.flavor.23',
	'orb.run.flavor.24',
	'orb.run.flavor.25',
	'orb.run.flavor.26',
	'orb.run.flavor.27',
	'orb.run.flavor.28',
	'orb.run.flavor.29',
	'orb.run.flavor.30',
] as const;

/**
 * 本地准备池 i18n key（请求出站前：意图分类 + 上下文组装 + 检索）。
 * 意境：动笔前的书斋。每句一个独立画面，禁止同义换装。
 */
export const PREPARE_PHRASE_KEYS = [
	'orb.run.prepare.01',
	'orb.run.prepare.02',
	'orb.run.prepare.03',
	'orb.run.prepare.04',
	'orb.run.prepare.05',
	'orb.run.prepare.06',
] as const;

/**
 * 在途池 i18n key（请求已出站、等首个 token）。
 * 意境：话已出门，等远方回应。含 3 句古诗，情绪为闲适而非焦虑。
 */
export const AWAIT_PHRASE_KEYS = [
	'orb.run.await.01',
	'orb.run.await.02',
	'orb.run.await.03',
	'orb.run.await.04',
	'orb.run.await.05',
	'orb.run.await.06',
	'orb.run.await.07',
	'orb.run.await.08',
] as const;

/**
 * 按轮换拍选择池下标。相邻两拍不会落到同一句。
 *
 * @param tick - 从 0 开始的轮换计数
 * @param poolSize - 池大小
 * @param seed - 每次进入新阶段随机一次的起点偏移；缺省 0 保持确定性（供测试）
 * @returns 池下标
 */
export function pickRotatingIndex(tick: number, poolSize: number, seed = 0): number {
	if (poolSize <= 1) return 0;
	const at = (n: number) => Math.abs((seed + n * 17 + 5) % poolSize);
	const current = at(tick);
	if (tick <= 0) return current;
	const prev = at(tick - 1);
	return current === prev ? (current + 1) % poolSize : current;
}

/** 忙态行阶段：本地准备（出站前）/ 在途（已出站待首字）/ 撰写（已出字）。 */
export type RunStatusPhase = 'preparing' | 'awaiting' | 'composing';

export interface RunStatusPhrases {
	composing: string;
	prepare: readonly string[];
	awaiting: readonly string[];
	flavor: readonly string[];
	/** @param step - 从 1 计的本轮步数 */
	step: (step: number) => string;
}

export interface RunStatusInput {
	retryText: string | null;
	toolText: string | null;
	phase: RunStatusPhase;
	step: number;
	tick: number;
	/** 阶段内随机起点，避免每次开门句相同 */
	seed: number;
}

/**
 * 拼消息球旁边的一行。重试优先，其次工具名，再按阶段取句：
 * 撰写阶段拼「撰写中 · 随机句」，本地准备/在途阶段直接输出各自池中的随机句。
 * 第 2 步起在末尾加步数。重试句不加步数。目标文案留在状态条，不进这一行。
 *
 * @param input - 当前忙态
 * @param phrases - 已翻译的句子
 * @returns 展示用的一整行
 */
export function composeRunStatusLine(input: RunStatusInput, phrases: RunStatusPhrases): string {
	if (input.retryText) return input.retryText;

	let head: string;
	if (input.toolText) {
		head = input.toolText;
	} else if (input.phase === 'composing') {
		const flavor = phrases.flavor[pickRotatingIndex(input.tick, phrases.flavor.length, input.seed)] ?? '';
		head = flavor ? `${phrases.composing} · ${flavor}` : phrases.composing;
	} else {
		const pool = input.phase === 'awaiting' ? phrases.awaiting : phrases.prepare;
		head = pool[pickRotatingIndex(input.tick, pool.length, input.seed)] ?? pool[0] ?? '';
	}

	if (input.step >= 2) return `${head} · ${phrases.step(input.step)}`;
	return head;
}

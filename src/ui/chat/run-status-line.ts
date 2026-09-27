/**
 * @file src/ui/chat/run-status-line.ts
 * @description 消息球旁边一行状态：重试、工具名、撰写中随机句、等待句、步数
 * @module ui/chat/run-status-line
 */

/** 等待句与撰写随机句的轮换间隔。 */
export const RUN_STATUS_ROTATE_MS = 8000;

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

export const WAIT_LINE_KEYS = ['orb.run.wait.1', 'orb.run.wait.2', 'orb.run.wait.3'] as const;

/**
 * 按轮换拍选择池下标。相邻两拍不会落到同一句。
 *
 * @param tick - 从 0 开始的轮换计数
 * @param poolSize - 池大小
 * @returns 池下标
 */
export function pickRotatingIndex(tick: number, poolSize: number): number {
	if (poolSize <= 1) return 0;
	const at = (n: number) => Math.abs((n * 17 + 5) % poolSize);
	const current = at(tick);
	if (tick <= 0) return current;
	const prev = at(tick - 1);
	return current === prev ? (current + 1) % poolSize : current;
}

export interface RunStatusPhrases {
	composing: string;
	wait: readonly string[];
	flavor: readonly string[];
	/** @param step - 从 1 计的本轮步数 */
	step: (step: number) => string;
}

export interface RunStatusInput {
	retryText: string | null;
	toolText: string | null;
	streaming: boolean;
	step: number;
	tick: number;
}

/**
 * 拼消息球旁边的一行。重试优先，其次工具名，其次撰写中加随机句，否则等待句。
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
	} else if (input.streaming) {
		const flavor = phrases.flavor[pickRotatingIndex(input.tick, phrases.flavor.length)] ?? '';
		head = flavor ? `${phrases.composing} · ${flavor}` : phrases.composing;
	} else {
		const wait = phrases.wait[pickRotatingIndex(input.tick, phrases.wait.length)] ?? phrases.wait[0] ?? '';
		head = wait;
	}

	if (input.step >= 2) return `${head} · ${phrases.step(input.step)}`;
	return head;
}

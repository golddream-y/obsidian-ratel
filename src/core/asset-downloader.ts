/**
 * @file src/core/asset-downloader.ts
 * @description 运行时资产下载 — 多源回退、逐源重试、原子落盘
 * @module core/asset-downloader
 * @depends obsidian(requestUrl), node:fs/promises
 *
 * 关键路径:模型、CPU 引擎、GPU 引擎此前各写一套下载逻辑,
 * 差异导致真实风险 —— 模型下载不原子(中断留下损坏文件且被当成已存在)、
 * CPU 引擎只有单源无重试。这里收敛成一份实现,三种资产共用同一套保障。
 *
 * 设计要点:
 * - 每个资产声明「国内优先 + 国际兜底」的镜像列表,按顺序尝试。
 * - 每个镜像允许多次尝试,网络异常与 HTTP 状态码失败同等对待。
 * - 先写 `.downloading` 临时文件再 rename —— 中途失败不会污染正式文件。
 * - 只接受不小于最小字节数的结果,防止半截文件被当成完整资产。
 */

import { requestUrl } from 'obsidian';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProgressInfo } from './model-downloader';

/**
 * 后台计时器宿主 — 镜像探测超时跟随本次下载,不绑定某个 popout 焦点窗口;
 * renderer 内 globalThis 即主窗口全局,Node 测试中同样可用。
 */
const backgroundTimers = globalThis;

/** 下载响应 — 只暴露本模块实际用到的字段,与 fetch/requestUrl 解耦。 */
export interface DownloadResponse {
	status: number;
	arrayBuffer: ArrayBuffer;
}

/** 可注入的下载函数(测试 mock 用)。 */
export type FetchFn = (url: string, init?: FetchInit) => Promise<DownloadResponse>;

/** 可选的请求参数 —— 探测镜像速度时用 Range 只取开头一小段。 */
export interface FetchInit {
	headers?: Record<string, string>;
}

/** 一个下载镜像。 */
export interface DownloadMirror {
	/** 人类可读的来源名,仅用于日志与错误信息(如 `npmmirror`)。 */
	label: string;
	url: string;
}

/** 统一下载参数。 */
export interface DownloadWithMirrorsOptions {
	/** 资产名,用于错误信息(如 `ort-wasm-simd-threaded.wasm`)。 */
	assetName: string;
	/** 按优先级排列的镜像;前面的失败才尝试后面的。 */
	mirrors: DownloadMirror[];
	/** 最终落盘绝对路径。 */
	targetPath: string;
	/** 完整文件的最小字节数;小于它视为损坏或未完成。 */
	minBytes?: number;
	/** 每个镜像的尝试次数(默认 2)。 */
	attemptsPerMirror?: number;
	/** 进度回调,progress 为 0-1。 */
	onProgress?: (p: ProgressInfo) => void;
	/** 可注入下载函数,默认走 Obsidian requestUrl。 */
	fetchFn?: FetchFn;
	/** 失败时用于构造错误文案。 */
	makeError?: (detail: string) => Error;
}

/** 默认每个镜像尝试次数。 */
export const DEFAULT_ATTEMPTS_PER_MIRROR = 2;

/**
 * 构造默认下载函数 — 用 Obsidian 内置 requestUrl,处理 CORS/CSP 更稳。
 *
 * 关键路径:requestUrl 默认对非 2xx 抛错,这里设 throw:false 手动解析状态码;
 * 二进制内容用 .arrayBuffer 取。它不支持流式进度,进度只能按阶段上报。
 */
export function createDefaultFetch(): FetchFn {
	return async (url, init) => {
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: init?.headers,
			throw: false,
		});
		return { status: response.status, arrayBuffer: response.arrayBuffer };
	};
}

/**
 * 按镜像顺序下载并原子落盘。
 *
 * @param options - 镜像、目标路径、校验与进度配置
 * @throws Error 全部镜像与尝试都失败,或写入失败
 */
export async function downloadWithMirrors(options: DownloadWithMirrorsOptions): Promise<string> {
	const {
		assetName,
		mirrors,
		targetPath,
		minBytes = 0,
		attemptsPerMirror = DEFAULT_ATTEMPTS_PER_MIRROR,
		onProgress,
		fetchFn = createDefaultFetch(),
		makeError,
	} = options;

	if (mirrors.length === 0) {
		throw new Error(`没有可用的下载源: ${assetName}`);
	}

	await mkdir(path.dirname(targetPath), { recursive: true });
	const tmpPath = `${targetPath}.downloading`;
	const totalAttempts = mirrors.length * attemptsPerMirror;
	const failures: string[] = [];
	let attemptIndex = 0;

	for (const mirror of mirrors) {
		for (let attempt = 1; attempt <= attemptsPerMirror; attempt++) {
			onProgress?.({ file: assetName, progress: attemptIndex / totalAttempts });
			attemptIndex += 1;
			try {
				const response = await fetchFn(mirror.url);
				if (response.status < 200 || response.status >= 300) {
					failures.push(`${mirror.label} → HTTP ${response.status}`);
					continue;
				}
				const buffer = Buffer.from(response.arrayBuffer);
				if (buffer.byteLength < minBytes) {
					failures.push(`${mirror.label} → 文件过小(${buffer.byteLength} 字节)`);
					continue;
				}
				// 关键路径:先写临时文件再 rename,断电或抛错都不会留下半截正式文件。
				await writeFile(tmpPath, buffer);
				await rename(tmpPath, targetPath);
				onProgress?.({ file: assetName, progress: 1 });
				return mirror.label;
			} catch (error) {
				// 关键路径:超时/断连/DNS 与状态码失败一样处理 —— 换源重试。
				failures.push(`${mirror.label} → ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	const detail = failures.join(' | ');
	throw makeError === undefined ? new Error(`下载失败: ${assetName} ${detail}`) : makeError(detail);
}

/**
 * 镜像偏好 — 记住上次成功的下载源,下次优先使用。
 *
 * 关键路径:为什么不用语言/地区判断?用户可能在国外用中文界面,也可能在国内用英文界面,
 * 语言与实际网络位置没有稳定关系。用「上次谁成功」这个事实,能自动适应所在地:
 * 国内用户记住国内源,出国后失败一次即切到国际源并从此优先它。
 */
export class MirrorPreference {
	constructor(private readonly filePath: string) {}

	/**
	 * 按记忆中的成功源重排镜像列表。
	 *
	 * @param key - 资产类别(如 `ort` / `model`)
	 * @param mirrors - 声明的镜像顺序
	 * @returns 优先源在前、其余保持声明顺序
	 */
	async order(key: string, mirrors: DownloadMirror[]): Promise<DownloadMirror[]> {
		const preferred = await this.read(key);
		if (preferred === undefined) return mirrors;
		return this.putFirst(mirrors, preferred);
	}

	/**
	 * 决定本次的镜像顺序。
	 *
	 * 关键路径:优先级依次是 ——
	 * 1. 历史成功过的源(最可靠,直接反映这台机器的真实网络);
	 * 2. 没有历史时才并行测速,取响应最快的一个;
	 * 3. 测速也失败就按声明顺序(国内优先)。
	 *
	 * @param key - 资产类别
	 * @param mirrors - 声明的镜像顺序
	 * @param fetchFn - 下载函数,用于测速
	 */
	async rank(
		key: string,
		mirrors: DownloadMirror[],
		fetchFn?: FetchFn,
		probeTrace?: (line: string) => void,
	): Promise<DownloadMirror[]> {
		const remembered = await this.read(key);
		if (remembered !== undefined) return this.putFirst(mirrors, remembered);
		const fastest = await probeFastestMirror(mirrors, fetchFn, probeTrace);
		if (fastest === undefined) return mirrors;
		return this.putFirst(mirrors, fastest);
	}

	private putFirst(mirrors: DownloadMirror[], label: string): DownloadMirror[] {
		const first = mirrors.filter((mirror) => mirror.label === label);
		if (first.length === 0) return mirrors;
		return [...first, ...mirrors.filter((mirror) => mirror.label !== label)];
	}

	/**
	 * 记录某个类别实际成功的镜像。
	 *
	 * @param key - 资产类别
	 * @param label - 成功镜像名
	 */
	async remember(key: string, label: string): Promise<void> {
		if ((await this.read(key)) === label) return;
		const all = await this.readAll();
		all[key] = label;
		try {
			await writeFile(this.filePath, JSON.stringify(all), 'utf-8');
		} catch {
			// 关键路径:偏好只是优化,写失败不影响下载结果。
		}
	}

	private async read(key: string): Promise<string | undefined> {
		const all = await this.readAll();
		return all[key];
	}

	private async readAll(): Promise<Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf-8'));
			if (parsed === null || typeof parsed !== 'object') return {};
			const result: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === 'string') result[key] = value;
			}
			return result;
		} catch {
			return {};
		}
	}
}

/** 测速探测默认取多少字节 —— 足够反映首字节延迟与初始吞吐，又不至于浪费流量。 */
const PROBE_BYTES = 256 * 1024;

/** 单个镜像的测速超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * 换成更快镜像所需的最小优势倍数。
 *
 * 关键路径:256 KB 的测量仍有噪声,小优势不足以说明 23 MB 全程更快。
 * 只有明显更快(超过该倍数)才改变声明顺序,否则维持「国内优先」——
 * 否则一次抖动就会把后续下载整体切到国际源。
 */
const PROBE_ADVANTAGE_RATIO = 1.5;

/**
 * 并行测速，返回最快的镜像名。
 *
 * 关键路径:为什么不用 HEAD?HEAD 只有响应头，反映的是**首字节延迟**，与真实吞吐无关 ——
 * 一个就近的边缘节点可能延迟很低但限速严重。这里改取前 128 KB 的 Range 请求，
 * 同时体现延迟与初始吞吐，流量成本可忽略。
 *
 * 局限:128 KB 的吞吐未必等于 23 MB 全程吞吐(中途限速、跨洋抖动看不到)。
 * 因此它只在**没有历史记录**时用来决定首次顺序;一旦某源成功过，
 * 后续一律以「上次成功的源」为准,而不重复测速。
 *
 * @param mirrors - 候选镜像
 * @param fetchFn - 下载函数
 * @returns 最快镜像名;全部失败或超时返回 undefined(回落到声明顺序)
 */
export async function probeFastestMirror(
	mirrors: DownloadMirror[],
	fetchFn: FetchFn = createDefaultFetch(),
	probeTrace?: (line: string) => void,
): Promise<string | undefined> {
	if (mirrors.length < 2) return undefined;
	const results = await Promise.all(
		mirrors.map(async (mirror) => {
			const startedAt = Date.now();
			let probeTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const response = await Promise.race([
					fetchFn(mirror.url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } }),
					new Promise<DownloadResponse>((_, reject) => {
						probeTimer = backgroundTimers.setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
					}),
				]);
				if (response.status < 200 || response.status >= 400) return null;
				return { label: mirror.label, elapsedMs: Date.now() - startedAt };
			} catch {
				return null;
			} finally {
				// 关键路径:探测先完成时必须撤掉超时计时器,否则进程/测试会被悬挂定时器拖住。
				if (probeTimer !== undefined) backgroundTimers.clearTimeout(probeTimer);
			}
		}),
	);
	const usable = results.filter((item): item is { label: string; elapsedMs: number } => item !== null);
	if (usable.length === 0) return undefined;
	usable.sort((a, b) => a.elapsedMs - b.elapsedMs);
	const fastest = usable[0]!;
	// 关键路径:把每个镜像的实测耗时写出来,才能判断「维持国内优先」是否被噪声触发。
	for (const item of usable) {
		probeTrace?.(`${item.label} ${item.elapsedMs}ms`);
	}
	// 关键路径:首个镜像即声明优先级最高者;只有明显更快才换源,避免噪声决定结果。
	const declared = usable.find((item) => item.label === mirrors[0]!.label);
	if (declared === undefined) return fastest.label;
	if (fastest.label === declared.label) return fastest.label;
	const advantage = declared.elapsedMs / fastest.elapsedMs;
	return advantage >= PROBE_ADVANTAGE_RATIO ? fastest.label : declared.label;
}

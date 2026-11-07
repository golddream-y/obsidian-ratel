/**
 * @file tests/core/asset-downloader.test.ts
 * @description 统一下载器 — 多源回退、逐源重试、原子落盘、测速与偏好记忆
 * @module tests/core/asset-downloader
 * @depends src/core/asset-downloader
 *
 * 关键路径:全部使用临时目录与注入的下载函数,不触网、不写真实插件目录。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	downloadWithMirrors,
	MirrorPreference,
	probeFastestMirror,
} from '../../src/core/asset-downloader';
import type { DownloadMirror } from '../../src/core/asset-downloader';

const MIRRORS: DownloadMirror[] = [
	{ label: '国内源', url: 'https://domestic.invalid/a.bin' },
	{ label: '国际源', url: 'https://intl.invalid/a.bin' },
];

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ratel-asset-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('downloadWithMirrors 多源回退', () => {
	it('首选源成功 - 不访问备用源并原样落盘', async () => {
		const payload = new Uint8Array([1, 2, 3]).buffer;
		const fetchFn = vi.fn().mockResolvedValue({ status: 200, arrayBuffer: payload });
		const targetPath = path.join(tmpDir, 'asset.bin');

		const used = await downloadWithMirrors({
			assetName: 'asset.bin',
			mirrors: MIRRORS,
			targetPath,
			fetchFn,
		});

		expect(used).toBe('国内源');
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(new Uint8Array(await readFile(targetPath))).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('首选源 404 - 自动切换备用源', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 404, arrayBuffer: new ArrayBuffer(0) })
			.mockResolvedValueOnce({ status: 404, arrayBuffer: new ArrayBuffer(0) })
			.mockResolvedValue({ status: 200, arrayBuffer: new Uint8Array([9]).buffer });

		const used = await downloadWithMirrors({
			assetName: 'asset.bin',
			mirrors: MIRRORS,
			targetPath: path.join(tmpDir, 'asset.bin'),
			fetchFn,
			attemptsPerMirror: 2,
		});

		expect(used).toBe('国际源');
		// 国内源重试 2 次后才换源。
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it('网络异常与状态码失败同等处理', async () => {
		const fetchFn = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNRESET'))
			.mockResolvedValue({ status: 200, arrayBuffer: new Uint8Array([7]).buffer });

		const used = await downloadWithMirrors({
			assetName: 'asset.bin',
			mirrors: MIRRORS,
			targetPath: path.join(tmpDir, 'asset.bin'),
			fetchFn,
			attemptsPerMirror: 1,
		});

		expect(used).toBe('国际源');
	});

	it('文件小于最小字节 - 不当作成功,继续换源', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce({ status: 200, arrayBuffer: new Uint8Array(2).buffer })
			.mockResolvedValue({ status: 200, arrayBuffer: new Uint8Array(16).buffer });

		const used = await downloadWithMirrors({
			assetName: 'asset.bin',
			mirrors: MIRRORS,
			targetPath: path.join(tmpDir, 'asset.bin'),
			minBytes: 8,
			fetchFn,
			attemptsPerMirror: 1,
		});

		expect(used).toBe('国际源');
	});

	it('全部源失败 - 抛错且不留下半截正式文件', async () => {
		const fetchFn = vi.fn().mockResolvedValue({ status: 500, arrayBuffer: new ArrayBuffer(0) });
		const targetPath = path.join(tmpDir, 'asset.bin');

		await expect(
			downloadWithMirrors({ assetName: 'asset.bin', mirrors: MIRRORS, targetPath, fetchFn }),
		).rejects.toThrow();

		// 关键路径:目标文件不应出现,临时文件也不应残留。
		expect(await readdir(tmpDir)).toEqual([]);
	});

	it('没有可用镜像 - 直接抛错', async () => {
		await expect(
			downloadWithMirrors({ assetName: 'asset.bin', mirrors: [], targetPath: path.join(tmpDir, 'a.bin') }),
		).rejects.toThrow();
	});
});

describe('MirrorPreference 顺序决策', () => {
	it('没有历史记录且未测速 - 保持声明顺序(国内优先)', async () => {
		const preference = new MirrorPreference(path.join(tmpDir, 'pref.json'));
		expect(await preference.rank('ort', MIRRORS)).toEqual(MIRRORS);
	});

	it('记住成功的源 - 下次置顶', async () => {
		const preference = new MirrorPreference(path.join(tmpDir, 'pref.json'));
		await preference.remember('ort', '国际源');
		const ranked = await preference.rank('ort', MIRRORS);
		expect(ranked[0]!.label).toBe('国际源');
		expect(ranked).toHaveLength(2);
	});

	it('记录未知源 - 不改变顺序', async () => {
		const preference = new MirrorPreference(path.join(tmpDir, 'pref.json'));
		await preference.remember('ort', '不存在的源');
		expect(await preference.rank('ort', MIRRORS)).toEqual(MIRRORS);
	});

	it('偏好文件损坏 - 视为无记录而不是崩溃', async () => {
		const filePath = path.join(tmpDir, 'pref.json');
		await writeFile(filePath, 'not-json');
		const preference = new MirrorPreference(filePath);
		expect(await preference.rank('ort', MIRRORS)).toEqual(MIRRORS);
	});

	it('不同资产类别互不影响', async () => {
		const preference = new MirrorPreference(path.join(tmpDir, 'pref.json'));
		await preference.remember('ort', '国际源');
		expect(await preference.rank('model', MIRRORS)).toEqual(MIRRORS);
	});
});

describe('probeFastestMirror 测速', () => {
	it('取响应最快的源', async () => {
		// 关键路径:用明确的 150ms 差距制造顺序,避免机器负载高时两者被压到同一毫秒而抖动。
		const fetchFn = vi.fn(async (url: string) => {
			if (url.includes('domestic')) await new Promise((r) => setTimeout(r, 150));
			return { status: 206, arrayBuffer: new Uint8Array(4).buffer };
		});
		expect(await probeFastestMirror(MIRRORS, fetchFn)).toBe('国际源');
	});

	it('全部失败 - 返回 undefined,由调用方回落到声明顺序', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
		expect(await probeFastestMirror(MIRRORS, fetchFn)).toBeUndefined();
	});

	it('只有一个镜像 - 不测速', async () => {
		const fetchFn = vi.fn();
		expect(await probeFastestMirror([MIRRORS[0]!], fetchFn)).toBeUndefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('probeFastestMirror 优势门槛', () => {
	it('优势不足 1.5 倍 - 维持声明顺序，不因噪声换源', async () => {
		// 两个源都耗时，差距约 20%（60ms vs 50ms），不足以说明 23 MB 全程更快。
		const fetchFn = vi.fn(async (url: string) => {
			const wait = url.includes('domestic') ? 60 : 50;
			await new Promise((r) => setTimeout(r, wait));
			return { status: 206, arrayBuffer: new Uint8Array(4).buffer };
		});
		expect(await probeFastestMirror(MIRRORS, fetchFn)).toBe('国内源');
	});

	it('优势超过 1.5 倍 - 采纳更快的国际源', async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.includes('domestic')) await new Promise((r) => setTimeout(r, 240));
			return { status: 206, arrayBuffer: new Uint8Array(4).buffer };
		});
		expect(await probeFastestMirror(MIRRORS, fetchFn)).toBe('国际源');
	});
});

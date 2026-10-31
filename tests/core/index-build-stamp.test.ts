import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
	BUILD_STAMP_FILENAME,
	isBuildStampCurrent,
	readBuildStamp,
	resolveBuildStampPath,
	writeBuildStamp,
	readBuildStampOutcome,
	parseBuildStamp,
	type IndexBuildStamp,
} from '../../src/core/index-build-stamp';

const base: IndexBuildStamp = {
	chunkerVersion: 1,
	chunkSize: 448,
	chunkOverlap: 100,
	embedModelId: 'local:bge-small-zh-v1.5',
};

let dir = '';

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-stamp-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('index-build-stamp', () => {
	it('路径 - 落在索引目录下的固定文件名', () => {
		expect(resolveBuildStampPath(dir)).toBe(path.join(dir, BUILD_STAMP_FILENAME));
	});

	it('写入后读回 - 字段完整', async () => {
		await writeBuildStamp(dir, base);
		expect(await readBuildStamp(dir)).toEqual(base);
	});

	it('文件不存在 - 返回 null', async () => {
		expect(await readBuildStamp(dir)).toBeNull();
	});

	it('JSON 损坏或字段缺失 - 返回 null', async () => {
		fs.writeFileSync(resolveBuildStampPath(dir), '{ not json');
		expect(await readBuildStamp(dir)).toBeNull();
		fs.writeFileSync(resolveBuildStampPath(dir), JSON.stringify({ chunkSize: 448 }));
		expect(await readBuildStamp(dir)).toBeNull();
	});

	it('一致判定 - 四项全同才是 true', () => {
		expect(isBuildStampCurrent(base, base)).toBe(true);
		expect(isBuildStampCurrent({ ...base, chunkerVersion: 0 }, base)).toBe(false);
		expect(isBuildStampCurrent({ ...base, chunkSize: 320 }, base)).toBe(false);
		expect(isBuildStampCurrent({ ...base, chunkOverlap: 0 }, base)).toBe(false);
		expect(isBuildStampCurrent({ ...base, embedModelId: 'api:x' }, base)).toBe(false);
	});

	it('戳缺失 - 视为不一致（必须重建）', () => {
		expect(isBuildStampCurrent(null, base)).toBe(false);
	});

	describe('readBuildStampOutcome - 迁移需要区分「缺失」与「损坏」', () => {
		it('readBuildStampOutcome - 文件不存在 - 判为缺失而不是损坏', async () => {
			expect(await readBuildStampOutcome(dir)).toEqual({ result: 'missing', stamp: null });
			// 既有只读入口的语义不变:缺失仍返回 null。
			expect(await readBuildStamp(dir)).toBeNull();
		});

		it('readBuildStampOutcome - JSON 损坏或字段缺失 - 判为不可解析', async () => {
			fs.writeFileSync(resolveBuildStampPath(dir), '{ not json');
			expect(await readBuildStampOutcome(dir)).toEqual({ result: 'unreadable', stamp: null });
			fs.writeFileSync(resolveBuildStampPath(dir), JSON.stringify({ chunkSize: 448 }));
			expect(await readBuildStampOutcome(dir)).toEqual({ result: 'unreadable', stamp: null });
		});

		it('readBuildStampOutcome - 字段齐全 - 返回戳内容', async () => {
			await writeBuildStamp(dir, base);
			expect(await readBuildStampOutcome(dir)).toEqual({ result: 'present', stamp: base });
		});

		it('parseBuildStamp - 非对象输入 - 返回 null', () => {
			expect(parseBuildStamp('"a string"')).toBeNull();
			expect(parseBuildStamp('null')).toBeNull();
		});
	});
});
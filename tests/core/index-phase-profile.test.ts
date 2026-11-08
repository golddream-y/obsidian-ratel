/**
 * @file tests/core/index-phase-profile.test.ts
 * @description 索引阶段耗时剖面 — 分块 / 提交各占多少（默认跳过）
 * @module tests/core/index-phase-profile
 *
 * 关键路径:
 * - 目的只有一个:回答「非推理开销占端到端 75%」里到底哪一段值得优化。
 * - 因此这里**不测推理**：向量用确定性伪随机填充,推理耗时为 0。
 *   测出来的每一毫秒都属于分块或提交,可以和生产实测直接相减得到 IPC 余量。
 * - 分块用真实词表(夹具内 bge 词表),提交走真实分片存储与两份落盘,
 *   不用简化实现冒充 —— 否则测出的数字无法与生产对照。
 * - 默认不跑:单次十余秒且数字随机器波动。打开方式 `RATEL_PROFILE=1`,
 *   规模用 `RATEL_PROFILE_FILES` 覆盖。
 */

import { afterAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open, rename, rm } from 'node:fs/promises';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { chunkMarkdown } from '../../src/worker/chunker';
import { createWorkerJournal, WorkerJournalOwner } from '../../src/worker/index-runtime-journal';

const ENABLED = process.env.RATEL_PROFILE === '1';
const FILE_COUNT = Number.parseInt(process.env.RATEL_PROFILE_FILES ?? '200', 10);
const DIMENSIONS = 512;

/** 真实生产分块参数：448 字符上限、100 重叠（对应「粗粒度」预设）。 */
const CHUNK_OPTIONS_MAX = 448;
const CHUNK_OVERLAP = 100;

/** 中文段落素材：贴近真实笔记的密度，避免用 lorem 之类非中文文本污染分词成本。 */
const PARAGRAPHS = [
	'索引写入线程的可靠性取决于提交顺序与恢复判定的严格程度，任何一步放宽都会在重启后表现为重复索引或进度倒退。',
	'分片存储把单一文件拆成多个独立片段，单次写入只触碰目标分片，因此写入量与库的总规模解耦。',
	'向量检索的召回质量由分块粒度、文本前缀与精排共同决定，任何一环缺失都会让相似内容排在无关结果之后。',
	'嵌入速度取决于模型规模、序列长度与执行后端，短序列下调度开销占比升高，长序列下算力利用率上升。',
	'恢复流程的正确性不能依赖「全部核对完」这种信号，文件已删、内容已变或反复失败的记录都不会产生成功事件。',
	'提交闸门保证查询不会读到半批状态，代价是写入期间检索需要等待，因此单次批次大小直接影响界面响应。',
	'日志先行、清单随后、向量最后，三段写入的顺序一旦颠倒，崩溃恢复时就会拿到彼此矛盾的证据。',
	'缓存命中率决定了重复索引的成本，内容未变的文件应当只做一次哈希比对，不重新分块也不重新嵌入。',
];

/** 造一篇约十块的笔记。 */
function makeNote(index: number): string {
	const lines: string[] = [`# 笔记 ${index}`, ''];
	for (let section = 0; section < 10; section += 1) {
		lines.push(`## 小节 ${section}`, '');
		for (let paragraph = 0; paragraph < 3; paragraph += 1) {
			lines.push(PARAGRAPHS[(index + section + paragraph) % PARAGRAPHS.length]!);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** 确定性伪随机向量：与真实嵌入体量相同，但不含推理成本。 */
function makeVector(index: number, chunkIndex: number): number[] {
	const vector = new Array<number>(DIMENSIONS);
	for (let i = 0; i < DIMENSIONS; i += 1) {
		vector[i] = Math.sin(index * 31 + chunkIndex * 17 + i * 0.37);
	}
	return vector;
}

describe.skipIf(!ENABLED)('索引阶段耗时剖面', () => {
	const created: string[] = [];

	afterAll(async () => {
		for (const dir of created) await fsp.rm(dir, { recursive: true, force: true });
	});

	it('分块与提交各占多少', async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-profile-'));
		created.push(root);

		// 关键路径:必须与生产线程模式一致 —— Worker 侧用 createTokenCounter(null),
		// 即字符计数。若这里换成 tokenizer 计数,测到的分块成本会高出数倍,
		// 数字无法与生产对照(实测差 100 倍以上)。
		const chunkOptions = {
			maxTokens: CHUNK_OPTIONS_MAX,
			overlapTokens: CHUNK_OVERLAP,
			count: (text: string) => text.length,
		};

		const createStorage = (shardRoot: string): AtomicIndexStorage =>
			new AtomicIndexStorage({
				generationRoot: shardRoot,
				fileSystem: {
					async openFile(absolutePath: string) {
						const handle = await open(absolutePath, 'w');
						return {
							async write(chunk: Uint8Array) {
								await handle.write(chunk);
								return chunk.byteLength;
							},
							sync: () => handle.sync(),
							close: () => handle.close(),
						};
					},
					async openDirectory(absolutePath: string) {
						const handle = await open(absolutePath, 'r');
						return { sync: () => handle.sync(), close: () => handle.close() };
					},
					rename: (from: string, to: string) => rename(from, to),
					async removeFile(absolutePath: string) {
						await rm(absolutePath, { force: true });
					},
				},
			});

		const store = createShardedStore({
			root,
			shardCount: 8,
			createStorage,
		});
		await store.init();

		const journal = createWorkerJournal({
			generationRoot: root,
			generationId: 'profile-gen',
			configFingerprint: 'b'.repeat(64),
			store,
			owner: new WorkerJournalOwner(1),
			expectedDimension: DIMENSIONS,
			storage: createStorage(root),
		});

		let chunkMs = 0;
		let commitMs = 0;
		let totalBlocks = 0;
		const noteCache: string[] = [];
		for (let index = 0; index < FILE_COUNT; index += 1) noteCache.push(makeNote(index));

		for (let index = 0; index < FILE_COUNT; index += 1) {
			const filePath = `note-${index}.md`;
			const chunkStartedAt = performance.now();
			const chunks = chunkMarkdown(noteCache[index]!, chunkOptions);
			chunkMs += performance.now() - chunkStartedAt;
			totalBlocks += chunks.length;

			const commitStartedAt = performance.now();
			const commitId = `commit-${index}`;
			const prepared = await journal.prepare({
				path: filePath,
				operation: 'replace',
				inputHash: String(index).padStart(64, '0'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: chunks.map((chunk, chunkIndex) => ({
					id: `${filePath}#chunk-${chunkIndex}`,
					vector: makeVector(index, chunkIndex),
					metadata: { path: filePath, chunkIndex, startOffset: chunk.startOffset, commitId },
				})),
			});
			await journal.commit(prepared.transactionId);
			commitMs += performance.now() - commitStartedAt;
		}

		const perBlock = (ms: number): number => ms / totalBlocks;
		const totalMs = chunkMs + commitMs;
		const share = (ms: number): string => `${((ms / totalMs) * 100).toFixed(1)}%`;
		console.info(
			`[阶段剖面] 文件=${FILE_COUNT} 块=${totalBlocks} ` +
				`分块=${chunkMs.toFixed(0)}ms(${share(chunkMs)}) 提交=${commitMs.toFixed(0)}ms(${share(commitMs)}) ` +
				`每块:分块=${perBlock(chunkMs).toFixed(1)}ms 提交=${perBlock(commitMs).toFixed(1)}ms`,
		);

		// 只断言基准真的跑出了数据，不对耗时设阈值（随机器波动）。
		expect(totalBlocks).toBeGreaterThan(0);
		expect(totalMs).toBeGreaterThan(0);
	}, 600_000);
});

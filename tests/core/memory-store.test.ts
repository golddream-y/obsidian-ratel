/**
 * @file tests/core/memory-store.test.ts
 * @description MemoryStore 单元测试 — 覆盖目录管理 / 读写 / 索引解析 / 大小统计 / VectraStore 桥接
 * @module tests/core/memory-store
 * @depends core/memory-store, adapters/vector-vectra, types
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/core/memory-store';
import type { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/** 构造临时 baseDir,每个测试用例独立隔离。 */
function makeTempBaseDir(): string {
	return mkdtempSync(path.join(tmpdir(), 'ratel-memory-test-'));
}

/** 创建 VectraStore 的最小化 mock,记录 upsertItem / delete / hybridSearch 调用。 */
function createMockVectraStore(): VectraStore & {
	upsertItemCalls: Array<{ docId: string; vector: number[]; metadata?: Record<string, unknown> }>;
	deleteCalls: string[][];
	hybridSearchCalls: Array<{ query: string; queryVector: number[]; topK: number }>;
} {
	const upsertItemCalls: Array<{ docId: string; vector: number[]; metadata?: Record<string, unknown> }> = [];
	const deleteCalls: string[][] = [];
	const hybridSearchCalls: Array<{ query: string; queryVector: number[]; topK: number }> = [];
	const mock = {
		upsertItemCalls,
		deleteCalls,
		hybridSearchCalls,
		async upsert() {
			// 关键路径:C2 修复后不再使用 vectraStore.upsert(它依赖内部 embeddings),
			// 改用 upsertItem(预计算向量)。这里保留空实现以兼容可能的旧调用。
		},
		async search() {
			return [];
		},
		async delete(docIds: string[]) {
			deleteCalls.push(docIds);
			return docIds.length;
		},
		async status() {
			return { totalDocs: 0, lastIndexTime: 0, isIndexing: false };
		},
		async getDocumentText(uri: string) {
			// 关键路径:返回 URI 当作原文,便于断言 searchIndex 的回查行为。
			return `text-for-${uri}`;
		},
		async upsertItem(docId: string, vector: number[], metadata?: Record<string, unknown>) {
			upsertItemCalls.push({ docId, vector, metadata });
		},
		async beginFileUpdate() {},
		async endFileUpdate() {},
		async cancelFileUpdate() {},
		async hybridSearch(query: string, queryVector: number[], topK: number) {
			hybridSearchCalls.push({ query, queryVector, topK });
			// 返回两条假结果,供 searchIndex 回查原文。
			return [
				{ docId: 'topics/GraphQL.md', score: 0.95, metadata: { path: 'topics/GraphQL.md' } },
				{ docId: 'topics/React.md', score: 0.80, metadata: { path: 'topics/React.md' } },
			];
		},
		// 修复:VectraStore 还有 isIndexCreated / dropIndex / deleteByPath 等方法,
		// 此处测试不调用,提供空实现以满足类型断言。
	} as unknown as VectraStore;
	return Object.assign(mock, { upsertItemCalls, deleteCalls, hybridSearchCalls });
}

/**
 * 创建 EmbeddingPort mock — 把输入文本编码为定长向量,便于断言 upsertItem 收到的 vector。
 * 关键路径:C2 修复后 MemoryStore.upsertToIndex 调 embeddingPort.embed([text])[0] 拿预计算向量。
 */
function createMockEmbeddingPort(): EmbeddingPort & {
	embedCalls: string[][];
} {
	const embedCalls: string[][] = [];
	const mock = {
		embedCalls,
		async embed(texts: string[]): Promise<number[][]> {
			embedCalls.push(texts);
			// 返回每条文本一个 3 维向量,便于断言。
			return texts.map((t) => [t.length, t.length * 2, t.length * 3]);
		},
	} as unknown as EmbeddingPort;
	return Object.assign(mock, { embedCalls });
}

describe('MemoryStore', () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = makeTempBaseDir();
	});

	afterEach(() => {
		if (existsSync(baseDir)) {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	// ==================== ensureDir ====================

	describe('ensureDir', () => {
		it('ensureDir - 目录不存在 - 创建 memory/ + topics/ + 空 global.md + 空 index.md', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();

			// 关键路径:目录结构齐全。
			expect(existsSync(baseDir)).toBe(true);
			expect(existsSync(path.join(baseDir, 'topics'))).toBe(true);
			expect(existsSync(path.join(baseDir, 'global.md'))).toBe(true);
			expect(existsSync(path.join(baseDir, 'index.md'))).toBe(true);
		});

		it('ensureDir - global.md 模板含 frontmatter + 四个区块', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();

			const text = readFileSync(path.join(baseDir, 'global.md'), 'utf-8');
			// 关键路径:frontmatter 标记为 global 类型。
			expect(text).toContain('memory_type: global');
			expect(text).toContain('## 用户身份');
			expect(text).toContain('## 偏好');
			expect(text).toContain('## 当前项目');
			expect(text).toContain('## 关键决策');
		});

		it('ensureDir - index.md 模板含 frontmatter + 主题列表区块', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();

			const text = readFileSync(path.join(baseDir, 'index.md'), 'utf-8');
			expect(text).toContain('memory_type: index');
			expect(text).toContain('## 主题列表');
		});

		it('ensureDir - 已存在文件 - 不覆盖', () => {
			// 关键路径:首次创建后写入内容,第二次 ensureDir 不应清空已有内容。
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			writeFileSync(path.join(baseDir, 'global.md'), '## 已有内容', 'utf-8');

			store.ensureDir();
			const text = readFileSync(path.join(baseDir, 'global.md'), 'utf-8');
			expect(text).toBe('## 已有内容');
		});

		it('ensureDir - 幂等 - 多次调用无副作用', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.ensureDir();
			store.ensureDir();
			expect(existsSync(path.join(baseDir, 'global.md'))).toBe(true);
		});
	});

	// ==================== readGlobal / writeGlobal ====================

	describe('readGlobal / writeGlobal', () => {
		it('readGlobal - 文件不存在 - 返回空串', () => {
			const store = new MemoryStore(baseDir);
			expect(store.readGlobal()).toBe('');
		});

		it('writeGlobal - 写入并读回', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.writeGlobal('## 测试内容\n- 条目 1');
			expect(store.readGlobal()).toBe('## 测试内容\n- 条目 1');
		});

		it('writeGlobal - 覆盖已有内容', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.writeGlobal('旧内容');
			store.writeGlobal('新内容');
			expect(store.readGlobal()).toBe('新内容');
		});
	});

	// ==================== readIndex / addTopicToIndex / removeTopicFromIndex ====================

	describe('readIndex / addTopicToIndex / removeTopicFromIndex', () => {
		it('readIndex - 空 index.md - 返回空数组', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			expect(store.readIndex()).toEqual([]);
		});

		it('addTopicToIndex - 追加一行后 readIndex 解析返回该主题', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.addTopicToIndex('GraphQL', '性能优化、DataLoader、Schema 设计');

			const entries = store.readIndex();
			expect(entries).toHaveLength(1);
			expect(entries[0]).toEqual({
				name: 'GraphQL',
				summary: '性能优化、DataLoader、Schema 设计',
			});
		});

		it('addTopicToIndex - 多次追加 - 顺序保留', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.addTopicToIndex('GraphQL', '查询语言');
			store.addTopicToIndex('React', 'UI 库');

			const entries = store.readIndex();
			expect(entries.map((e) => e.name)).toEqual(['GraphQL', 'React']);
		});

		it('removeTopicFromIndex - 删除匹配主题行 - 仅剩其他主题', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.addTopicToIndex('GraphQL', '查询语言');
			store.addTopicToIndex('React', 'UI 库');
			store.addTopicToIndex('Vue', '渐进式框架');

			store.removeTopicFromIndex('React');

			const entries = store.readIndex();
			expect(entries.map((e) => e.name)).toEqual(['GraphQL', 'Vue']);
		});

		it('removeTopicFromIndex - 主题不存在 - 无副作用不抛错', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.addTopicToIndex('GraphQL', '查询语言');

			// 关键路径:不存在的主题不应抛错,且不影响已有条目。
			expect(() => store.removeTopicFromIndex('不存在的主题')).not.toThrow();
			expect(store.readIndex()).toHaveLength(1);
		});

		it('readIndex - summary 含特殊字符 - 正确解析', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:summary 含逗号、空格、连字符等,解析时不应被截断。
			store.addTopicToIndex('TypeScript', '类型推导、strict mode、泛型设计');

			const entries = store.readIndex();
			expect(entries[0]?.summary).toBe('类型推导、strict mode、泛型设计');
		});
	});

	// ==================== readTopic / writeTopic ====================

	describe('readTopic / writeTopic', () => {
		it('readTopic - 文件不存在 - 返回 null', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			expect(store.readTopic('不存在')).toBeNull();
		});

		it('writeTopic - 写入后 readTopic 读回全文', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			const content = '---\nmemory_type: topic\ntopic: GraphQL\n---\n\n## 关键决策\n- 缓存层用 DataLoader';
			store.writeTopic('GraphQL', content);

			expect(store.readTopic('GraphQL')).toBe(content);
		});

		it('writeTopic - 覆盖已有内容', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.writeTopic('GraphQL', '旧内容');
			store.writeTopic('GraphQL', '新内容');
			expect(store.readTopic('GraphQL')).toBe('新内容');
		});

		it('deleteTopic - 已存在的文件 - 删除后 readTopic 返回 null', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.writeTopic('GraphQL', '内容');
			expect(store.readTopic('GraphQL')).not.toBeNull();

			store.deleteTopic('GraphQL');
			expect(store.readTopic('GraphQL')).toBeNull();
		});

		it('deleteTopic - 文件不存在 - 不抛错(幂等)', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:forget_memory 清空后再次调用应幂等,不抛错。
			expect(() => store.deleteTopic('不存在')).not.toThrow();
		});

		// ==================== C1 修复:路径穿越防护 ====================

		it('readTopic - topic 含 ../ - 抛 invalidTopic 错(防穿越)', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:LLM 输出可能含 ../,校验后应抛错,避免越出 topics/ 目录。
			expect(() => store.readTopic('../escape')).toThrow();
			expect(() => store.readTopic('foo/bar')).toThrow();
			expect(() => store.readTopic('..')).toThrow();
		});

		it('writeTopic - topic 含路径分隔符 - 抛 invalidTopic 错', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:正反斜杠都应拒绝,防止子目录或父目录穿越。
			expect(() => store.writeTopic('../escape', '内容')).toThrow();
			expect(() => store.writeTopic('foo\\bar', '内容')).toThrow();
			expect(() => store.writeTopic('foo/bar', '内容')).toThrow();
		});

		it('deleteTopic - topic 含 ../ - 抛 invalidTopic 错(防 LLM 删除任意文件)', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:即使文件不存在,也应在校验阶段抛错,避免 LLM 用 deleteTopic 攻击。
			expect(() => store.deleteTopic('../../etc/passwd')).toThrow();
			expect(() => store.deleteTopic('CON')).toThrow(); // Windows 保留名
			expect(() => store.deleteTopic('')).toThrow(); // 空字符串
		});

		it('readTopic - 合法 topic 名 - 不抛错', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:正常主题名(中文、英文、数字、连字符、空格)应通过校验。
			expect(() => store.readTopic('GraphQL')).not.toThrow();
			expect(() => store.readTopic('React-19')).not.toThrow();
			expect(() => store.readTopic('前端框架对比')).not.toThrow();
			expect(() => store.readTopic('TypeScript vs JavaScript')).not.toThrow();
		});
	});

	// ==================== getTotalSize ====================

	describe('getTotalSize', () => {
		it('getTotalSize - 空目录 - 返回 0', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:只有空 global.md + index.md 时,size > 0 但应等于两文件大小之和。
			// 这里单独构造一个完全空的子目录验证 0 边界。
			const emptyDir = path.join(baseDir, 'empty-sub');
			mkdirSync(emptyDir, { recursive: true });
			const emptyStore = new MemoryStore(emptyDir);
			expect(emptyStore.getTotalSize()).toBe(0);
		});

		it('getTotalSize - 含多个文件 - 累加所有文件大小', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			store.writeGlobal('hello');
			store.writeTopic('GraphQL', 'topic content');

			const size = store.getTotalSize();
			// 关键路径:至少包含 global.md + index.md + topics/GraphQL.md 三个文件。
			expect(size).toBeGreaterThan(0);

			// 精确断言:等于目录下所有文件 stat.size 之和。
			const expected =
				readFileSync(path.join(baseDir, 'global.md')).byteLength +
				readFileSync(path.join(baseDir, 'index.md')).byteLength +
				readFileSync(path.join(baseDir, 'topics', 'GraphQL.md')).byteLength;
			expect(size).toBe(expected);
		});
	});

	// ==================== isWithinStorageLimit(I3) ====================

	describe('isWithinStorageLimit', () => {
		it('isWithinStorageLimit - 写入后未超 10MB - 返回 true', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:正常写入场景,1KB 远小于 10MB 上限(已减去已有 global.md + index.md 体积)。
			expect(store.isWithinStorageLimit(1024)).toBe(true);
			// 关键路径:9MB 也应在限内(已有文件 < 1MB,9MB + 已有 < 10MB)。
			expect(store.isWithinStorageLimit(9 * 1024 * 1024)).toBe(true);
		});

		it('isWithinStorageLimit - 写入后超 10MB - 返回 false', () => {
			const store = new MemoryStore(baseDir);
			store.ensureDir();
			// 关键路径:写入 11MB 必然超限(即使加上已有文件);返回 false 让 remember 工具拒绝写入。
			expect(store.isWithinStorageLimit(11 * 1024 * 1024)).toBe(false);
		});
	});

	// ==================== VectraStore 桥接 ====================

	describe('upsertToIndex', () => {
		it('upsertToIndex - 调 embeddingPort.embed + VectraStore.upsertItem 传 docId + vector + { path: docId }', async () => {
			// 关键路径(C2 修复):upsertToIndex 不再依赖 vectraStore.upsert(内部触发 embeddings),
			// 改用 embeddingPort.embed([text])[0] 拿预计算向量 + vectraStore.upsertItem 写入。
			const mockVectra = createMockVectraStore();
			const mockEmbed = createMockEmbeddingPort();
			const store = new MemoryStore(baseDir, mockVectra, mockEmbed);

			await store.upsertToIndex('topics/GraphQL.md', '记忆内容');

			// 关键路径:embeddingPort.embed 收到 [text] 单元素数组。
			expect(mockEmbed.embedCalls).toHaveLength(1);
			expect(mockEmbed.embedCalls[0]).toEqual(['记忆内容']);

			// 关键路径:upsertItem 收到 docId + 预计算向量 + { path: docId }。
			expect(mockVectra.upsertItemCalls).toHaveLength(1);
			expect(mockVectra.upsertItemCalls[0]?.docId).toBe('topics/GraphQL.md');
			expect(mockVectra.upsertItemCalls[0]?.vector).toEqual([4, 8, 12]); // '记忆内容' 长度 4
			expect(mockVectra.upsertItemCalls[0]?.metadata).toEqual({ path: 'topics/GraphQL.md' });
		});

		it('upsertToIndex - memoryIndex 为 null - 抛 storeNotInit 错', async () => {
			const mockEmbed = createMockEmbeddingPort();
			// 关键路径:不传 vectraStore → memoryIndex 为 null
			const store = new MemoryStore(baseDir, undefined, mockEmbed);
			await expect(store.upsertToIndex('topics/X.md', '内容')).rejects.toThrow();
		});

		it('upsertToIndex - embeddingPort 为 null - 抛 embeddingNotInit 错', async () => {
			const mockVectra = createMockVectraStore();
			// 关键路径:不传 embeddingPort → 无法编码向量,抛 embeddingNotInit
			const store = new MemoryStore(baseDir, mockVectra);
			await expect(store.upsertToIndex('topics/X.md', '内容')).rejects.toThrow();
		});
	});

	describe('searchIndex', () => {
		it('searchIndex - 调 hybridSearch 并回查 getDocumentText - 返回 index + docId + score + text', async () => {
			const mock = createMockVectraStore();
			const store = new MemoryStore(baseDir, mock);

			const queryVector = [0.1, 0.2, 0.3];
			const results = await store.searchIndex('查询', queryVector, 5);

			// 关键路径:hybridSearch 被调用,参数透传。
			expect(mock.hybridSearchCalls).toHaveLength(1);
			expect(mock.hybridSearchCalls[0]).toEqual({ query: '查询', queryVector, topK: 5 });

			// 关键路径:每条结果含 index(从 1)+ docId + score + text(由 getDocumentText 回查)。
			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({
				index: 1,
				docId: 'topics/GraphQL.md',
				score: 0.95,
				text: 'text-for-topics/GraphQL.md',
			});
			expect(results[1]).toEqual({
				index: 2,
				docId: 'topics/React.md',
				score: 0.80,
				text: 'text-for-topics/React.md',
			});
		});

		it('searchIndex - memoryIndex 为 null - 抛 storeNotInit 错', async () => {
			const store = new MemoryStore(baseDir);
			await expect(store.searchIndex('q', [0.1], 5)).rejects.toThrow();
		});
	});

	describe('removeTopicFromIndexStore', () => {
		it('removeTopicFromIndexStore - 调 VectraStore.delete 传 [topics/{name}.md]', async () => {
			const mock = createMockVectraStore();
			const store = new MemoryStore(baseDir, mock);

			await store.removeTopicFromIndexStore('GraphQL');

			expect(mock.deleteCalls).toHaveLength(1);
			expect(mock.deleteCalls[0]).toEqual(['topics/GraphQL.md']);
		});

		it('removeTopicFromIndexStore - memoryIndex 为 null - 抛 storeNotInit 错', async () => {
			const store = new MemoryStore(baseDir);
			await expect(store.removeTopicFromIndexStore('X')).rejects.toThrow();
		});
	});
});

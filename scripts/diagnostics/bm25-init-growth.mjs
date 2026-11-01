/**
 * @file scripts/diagnostics/bm25-init-growth.mjs
 * @description 在独立 Node 进程复现旧 BM25 初始化的模型字符串增长，并提供单变量对照
 * @module scripts/diagnostics/bm25-init-growth
 * @depends vectra, wink-eng-lite-web-model
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const model = require('wink-eng-lite-web-model');
const { LocalIndex } = require(path.join(path.dirname(require.resolve('vectra')), 'LocalIndex.js'));
const control = process.argv.includes('--control');
const load = model.metaCER;
let lastLength = 0;
let initialLength = 0;
// 关键路径:对照组只阻止重复序列化，BM25/NLP 的其他初始化流程保持相同。
const cached = control ? load() : null;
model.metaCER = () => {
	const result = cached ?? load();
	lastLength = result.machines.length;
	initialLength ||= lastLength;
	return result;
};

// 关键路径:用两条合成数据预置内存索引，真实查询入口不会读取或创建虚拟目录。
const index = new LocalIndex('unused-diagnostic-read-only');
index._data = { items: [
	{ id: 'a', vector: [1, 0], norm: 1, metadata: {} },
	{ id: 'b', vector: [0, 1], norm: 1, metadata: {} },
] };
const iterations = control ? 24 : 16;
if (typeof global.gc !== 'function') throw new Error('请使用 node --expose-gc 执行诊断');
console.log(JSON.stringify({ mode: control ? 'cached-serializer-control' : 'original', iterations }));
for (let call = 1; call <= iterations; call++) {
	let emptyCorpusError = false;
	try {
		await index.queryItems([1, 0], '诊断', 20, undefined, true);
	} catch (error) {
		if (!String(error).includes('too small for consolidation')) throw error;
		emptyCorpusError = true;
		// 关键路径:复现旧适配器的异常降级；降级成功不会撤销此前的模型全局变更。
		await index.queryItems([1, 0], '', 20);
	}
	await new Promise((resolve) => setImmediate(resolve));
	global.gc();
	const memory = process.memoryUsage();
	console.log(JSON.stringify({ call, modelChars: lastLength, emptyCorpusError,
		rssMB: Math.round(memory.rss / 1048576), heapMB: Math.round(memory.heapUsed / 1048576) }));
	// 关键路径:独立诊断设资源上限，不为复现缺陷刻意制造进程崩溃。
	assert.ok(memory.rss < 512 * 1048576, '达到诊断内存上限，停止执行');
}
if (control) assert.equal(lastLength, initialLength);
else assert.ok(lastLength > initialLength * 1000, '未复现已知的字符串指数增长');
console.log('诊断断言通过；本脚本不证明 Obsidian 的原生崩溃已修复。');

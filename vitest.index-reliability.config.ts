import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

/**
 * 索引可靠性专用 Vitest 配置(T8 checkbox 3)。
 *
 * 关键路径:
 * - **显式 include**:只跑崩溃/规模验收文件,不把默认套件卷进来;`passWithNoTests:false`
 *   让「路径写错/文件被删」变成硬失败,而不是静默 `exit 0` 的假绿。
 *   本配置的默认口径就是计划 checkbox 4 的采集口径:`RATEL_SCALE_SUITE=1` 打开重样本,
 *   规模用例里的 **100 篇档三臂 A/B** 也由它打开(不要求 `RATEL_SCALE=1`)。因此
 *   `npx vitest run --config vitest.index-reliability.config.ts` 会直接产出 `judgeGate` 判定;
 *   `RATEL_SCALE=1` 只额外打开 1000 / 3000 篇档与 512 维读数表。
 * - **继承基础别名、构建常量与 setupFiles**:`obsidian` / `onnxruntime-web` / `@ratel/*` 虚拟模块别名、
 *   构建期 `define` 与 `global-polyfill` 直接取 `vitest.config.ts` 的值,避免两处漂移。
 * - **不隐式下载模型**:本配置的 include 面**从不包含** `tests/adapters/embedding-onnx.test.ts`
 *   (它由基础配置的 `RATEL_ONNX=1` 门控,跑真实 ORT 推理)。这里的嵌入端口是确定性假实现。
 *   若将来要在此配置里跑真实 ONNX,必须显式加入该文件并显式设置 `RATEL_ONNX=1`。
 * - `fileParallelism:false`:崩溃用例要 fork 子进程并在真实磁盘上断言,串行执行避免把
 *   机器负载变成假失败。
 *
 * 实测耗时口径(2026-11-01,本机 10 核;数值取自同一次运行的 JSON 报告,汇总见证据文档第 7 节):
 * - 规模文件里**未被门控**的用例(512/768 维各 120 篇、连续编辑、隔离区回收、夹具自检)
 *   在串行口径下合计 **36.5 s**(28957.7 + 7194.2 + 306.0 + 2.4 ms);崩溃文件自身合计 **12.1 s**。
 * - 被门控的重样本单是 3000 篇 @64 维完整构建就实测 **587 s**,加上数百篇级写入行为用例
 *   (未结算上界 36.5 s、零变化写入 16.8 s、单文件事务 17.0 s、多次重启 26.8 s、队列探针 5.5 s)
 *   合计约 **690 s(≈11.5 分钟)**。若这些用例不门控,默认套件会从当前约 144 s 涨到约 12 分钟
 *   (默认配置按文件并行,实际墙钟基本由最长的 3000 篇用例决定)—— 这是保留 `RATEL_SCALE_SUITE`
 *   门控的理由,数字来自本轮实测而不是估计。
 */

interface BaseConfigShape {
	resolve?: { alias?: Record<string, string> };
	test?: { setupFiles?: string[] };
	define?: Record<string, string>;
}

const base = baseConfig as BaseConfigShape;
const alias = base.resolve?.alias;
const setupFiles = base.test?.setupFiles;
const define = base.define;
if (alias === undefined || setupFiles === undefined || define === undefined) {
	// 关键路径:继承来源缺失时必须硬失败 —— 静默用空别名会让 `obsidian` 解析失败被误读成产品缺陷;
	// 缺少 define 会让 `__RATEL_VECTRA_GPT_TOKENIZER__` 在运行期未定义。
	throw new Error(
		'vitest.index-reliability.config.ts 需要 vitest.config.ts 的 resolve.alias、test.setupFiles 与 define',
	);
}

export default defineConfig({
	resolve: { alias },
	// 关键路径:构建期常量(含 `__RATEL_VECTRA_GPT_TOKENIZER__`)必须与基础配置一致,
	// 否则崩溃/规模用例在装配 VectraStore 时会因常量未定义而失败。
	define,
	test: {
		include: [
			'tests/core/index-reliability-crash.test.ts',
			// 规模/性能验收文件(T8b):100 篇档 A/B 在默认口径下产出 checkbox 4 判定。
			'tests/core/index-reliability-scale.test.ts',
		],
		exclude: [
			// 与基础配置一致:`tests/integration` 会真实下载模型并跑 ONNX,不在此配置内。
			'tests/integration/**',
			...(process.env.RATEL_ONNX === '1' ? [] : ['tests/adapters/embedding-onnx.test.ts']),
		],
		environment: 'node',
		passWithNoTests: false,
		setupFiles,
		fileParallelism: false,
		// 关键路径(T8b):把「这是专用验收配置」告诉测试 —— 规模用例里的重样本
		// (3000 篇完整构建、数百篇级写入行为)与 100 篇档门槛 A/B 只在专用配置下默认执行。
		// 基础配置按 `tests/**/*.test.ts` 同样会收集 scale 文件,若无此门控,
		// 默认套件会从当前约 144 s 涨到约 12 分钟(重样本合计约 690 s,见文件头实测口径)。
		env: {
			RATEL_SCALE_SUITE: '1',
		},
		// 关键路径:esbuild 现场构建子进程入口 + 子进程真实崩溃恢复,必须在默认 5s 之外。
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
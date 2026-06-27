/**
 * @file src/adapters/bert-tokenizer.ts
 * @description 基于 vocab.txt 的 WordPiece tokenizer,专用于 bge-small-zh-v1.5
 * @module adapters/bert-tokenizer
 * @depends node:fs/promises (仅 loadVocab,动态 import,不污染 Web Worker bundle)
 *
 * 设计要点:
 * - 不解析完整 tokenizer.json,只依赖 vocab.txt(109KB),减小分发体积。
 * - 实现与 HuggingFace BertTokenizer 对齐的 BasicTokenizer + WordPieceTokenizer。
 * - 固定参数:do_lower_case=false, tokenize_chinese_chars=true, model_max_length=512。
 * - 输出 {inputIds, attentionMask, tokenTypeIds},可直接喂给 ONNX BERT 模型。
 * - parseVocab 为纯函数(无 fs 依赖),供 Web Worker 直接使用;
 *   loadVocab 仅供主线程使用,动态 import node:fs/promises,避免顶层依赖污染浏览器产物。
 */

/**
 * encode 输出结构。
 */
export interface TokenizerOutput {
	inputIds: number[];
	attentionMask: number[];
	tokenTypeIds: number[];
}

/**
 * 已加载的 tokenizer 实例。
 */
export interface BertTokenizer {
	/**
	 * 对单条文本做 tokenize,返回 token ID 序列(不含特殊 token)。
	 */
	tokenize(text: string): number[];

	/**
	 * 对单条文本做 encode,包含 [CLS] / [SEP] 与 padding/truncation。
	 */
	encode(text: string, maxLength?: number): TokenizerOutput;
}

// 特殊 token ID,按 bge-small-zh-v1.5 词表固定位置。
const CLS_TOKEN = '[CLS]';
const SEP_TOKEN = '[SEP]';
const PAD_TOKEN = '[PAD]';
const UNK_TOKEN = '[UNK]';

/**
 * 解析 vocab.txt 文本内容,生成 token → id 映射。
 *
 * 关键路径:纯函数,无 fs 依赖,供 Web Worker(浏览器环境)直接使用。
 * 主线程也可用此函数避免重复的文件读取逻辑。
 *
 * @param content - vocab.txt 的文本内容
 * @returns token 到 id 的只读 Map
 * @throws 内容为空或解析失败时抛错
 */
export function parseVocab(content: string): ReadonlyMap<string, number> {
	const vocab = new Map<string, number>();
	let index = 0;
	for (const line of content.split(/\r?\n/)) {
		// 关键路径:vocab.txt 每行对应一个 id,即使空行也要占一个 id,
		// 否则后续 token 的 id 会与 transformers 不一致。
		// 注意:不能调用 trim(),\u2028 等 Unicode 空白字符本身是有效 token。
		const token = line.replace(/\r$/, '');
		if (token.length > 0) {
			vocab.set(token, index);
		}
		index++;
	}
	if (vocab.size === 0) {
		throw new Error('vocab.txt 为空或解析失败');
	}
	return vocab;
}

/**
 * 读取 vocab.txt 并生成 token → id 映射。
 *
 * 关键路径:仅供主线程使用(Node 环境)。动态 import node:fs/promises,
 * 避免顶层静态 import 污染 Web Worker bundle(浏览器平台无法解析 node:fs)。
 *
 * @param vocabPath - vocab.txt 本地路径
 * @returns token 到 id 的只读 Map
 * @throws 文件读取失败或格式异常时抛错
 */
export async function loadVocab(vocabPath: string): Promise<ReadonlyMap<string, number>> {
	// 关键路径:动态 import — Web Worker bundle 中 loadVocab 不会被引用(Worker 用 parseVocab),
	// 经 tree-shaking 移除后,node:fs/promises 不会进入浏览器产物。
	const { readFile } = await import('node:fs/promises');
	const content = await readFile(vocabPath, 'utf-8');
	return parseVocab(content);
}

/**
 * 构造 BertTokenizer 实例。
 *
 * @param vocab - loadVocab 生成的词表
 * @returns BertTokenizer 实例
 */
export function createTokenizer(vocab: ReadonlyMap<string, number>): BertTokenizer {
	const basic = createBasicTokenizer();
	const wordpiece = createWordPieceTokenizer(vocab);

	return {
		tokenize(text: string): number[] {
			const tokens = basic(text);
			const ids: number[] = [];
			for (const token of tokens) {
				for (const sub of wordpiece(token)) {
					ids.push(sub);
				}
			}
			return ids;
		},
		encode(text: string, maxLength = 512): TokenizerOutput {
			const ids = this.tokenize(text);
			// 关键路径:保留 [CLS] 和 [SEP],剩余长度给正文 token。
			const maxContent = Math.max(0, maxLength - 2);
			const truncated = ids.slice(0, maxContent);

			const clsId = vocab.get(CLS_TOKEN) ?? 101;
			const sepId = vocab.get(SEP_TOKEN) ?? 102;
			const padId = vocab.get(PAD_TOKEN) ?? 0;

			const inputIds = [clsId, ...truncated, sepId];
			const seqLength = inputIds.length;

			// padding 到 maxLength,注意attention mask同步。
			while (inputIds.length < maxLength) {
				inputIds.push(padId);
			}

			const attentionMask = new Array(maxLength).fill(0);
			attentionMask.fill(1, 0, seqLength);

			const tokenTypeIds = new Array(maxLength).fill(0);

			return { inputIds, attentionMask, tokenTypeIds };
		},
	};
}

/**
 * BasicTokenizer — 对原始文本做初步切分。
 *
 * 关键路径:
 * - NFD normalization + 移除 combining accents:与 transformers BertBasicTokenizer 对齐。
 * - 中文字符按字切分:在前后加空格,确保后续 split 时每个汉字独立。
 * - 保留大小写(do_lower_case=false)。
 * - 按空白与标点拆分,去除空串。
 */
function createBasicTokenizer(): (text: string) => string[] {
	// 关键路径:中文字符范围覆盖 CJK Unified Ideographs 扩展区常用部分。
	const cjkPattern = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
	// 关键路径:保留中文字母数字,其余字符按空白拆分;与 BertTokenizer 行为近似。
	const splitPattern = /[^\u4e00-\u9fa5\u3400-\u4dbf\w]/g;

	return (text: string): string[] => {
		// NFD decomposition + 移除 combining accent marks。
		let normalized = text
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '');

		// 在中文字符前后加空格,使其按字切分。
		normalized = normalized
			.split('')
			.map((char) => (cjkPattern.test(char) ? ` ${char} ` : char))
			.join('');

		// 按非保留字符拆分并清理。
		return normalized
			.replace(splitPattern, ' ')
			.split(/\s+/)
			.filter((token) => token.length > 0);
	};
}

/**
 * WordPieceTokenizer — 贪心最长匹配子词。
 *
 * @param vocab - 完整词表
 * @returns 把单个基础 token 转成子词 id 列表的函数
 */
function createWordPieceTokenizer(vocab: ReadonlyMap<string, number>): (token: string) => number[] {
	const unkId = vocab.get(UNK_TOKEN) ?? 100;

	return (token: string): number[] => {
		const output: number[] = [];
		let start = 0;

		while (start < token.length) {
			let end = token.length;
			let matched: number | undefined;
			let matchedLen = 0;

			while (start < end) {
				const sub = token.slice(start, end);
				const prefix = start === 0 ? '' : '##';
				const candidate = start === 0 ? sub : `${prefix}${sub}`;
				const id = vocab.get(candidate);
				if (id !== undefined) {
					matched = id;
					matchedLen = end - start;
					break;
				}
				end--;
			}

			if (matched === undefined) {
				output.push(unkId);
				break;
			}

			output.push(matched);
			start += matchedLen;
		}

		return output;
	};
}

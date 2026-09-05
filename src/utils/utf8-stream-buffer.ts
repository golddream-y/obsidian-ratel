/**
 * @file src/utils/utf8-stream-buffer.ts
 * @description 流式 UTF-8 安全拼接:不完整多字节序列留到下一包再解码,避免变成 U+FFFD
 * @module utils/utf8-stream-buffer
 */

/**
 * 统计缓冲区末尾尚未凑齐的 UTF-8 字节数。
 *
 * 汉字如「就」是 3 字节(`E5 B0 B1`)。若按 HTTP chunk 逐包 `toString('utf8')`,
 * 拆在字符中间时每个残缺字节都会变成一个 U+FFFD,界面上就是三个替换符。
 *
 * @param buf - 已累积的原始字节
 * @returns 应保留到下一包的尾部字节数;0 表示末尾已是完整序列
 */
export function utf8IncompleteTailBytes(buf: Buffer): number {
	const n = buf.length;
	if (n === 0) return 0;

	let i = n - 1;
	let continuations = 0;
	while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
		continuations++;
		i--;
		if (continuations >= 3) break;
	}

	if (i < 0) {
		return n;
	}

	const lead = buf[i];
	let expected = 0;
	if ((lead & 0x80) === 0) expected = 1;
	else if ((lead & 0xe0) === 0xc0) expected = 2;
	else if ((lead & 0xf0) === 0xe0) expected = 3;
	else if ((lead & 0xf8) === 0xf0) expected = 4;
	else return 0;

	const have = n - i;
	return have < expected ? have : 0;
}

/**
 * 把 Node `IncomingMessage` 的 chunk 拼成字符串。
 *
 * 设计要点:
 * - 字节先进 Buffer,只对完整 UTF-8 序列 `toString`
 * - 半截多字节留在内部,下一包到来再拼
 */
export class Utf8StreamBuffer {
	private pending = Buffer.alloc(0);

	/**
	 * 追加一块流数据,返回本次新解码出的完整字符串(可能为空)。
	 *
	 * @param chunk - Node 流常见的 Buffer,或已是 UTF-8 的 string
	 */
	push(chunk: Buffer | string): string {
		const add = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		this.pending = this.pending.length === 0 ? Buffer.from(add) : Buffer.concat([this.pending, add]);
		const keep = utf8IncompleteTailBytes(this.pending);
		const complete = this.pending.subarray(0, this.pending.length - keep);
		this.pending = Buffer.from(this.pending.subarray(this.pending.length - keep));
		return complete.length === 0 ? '' : complete.toString('utf8');
	}

	/**
	 * 流结束时把剩余字节按 UTF-8 解完(真残缺才会变成替换符)。
	 */
	flush(): string {
		if (this.pending.length === 0) return '';
		const s = this.pending.toString('utf8');
		this.pending = Buffer.alloc(0);
		return s;
	}
}

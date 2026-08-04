/**
 * @file src/adapters/mcp-stdio-framing.ts
 * @description MCP stdio 分帧：Content-Length（优先）+ 换行 JSON 回退
 * @module adapters/mcp-stdio-framing
 */

/**
 * 将消息体编码为 LSP 风格 Content-Length 帧。
 *
 * @param body - UTF-8 消息字符串
 * @returns 含头与正文的完整帧
 */
export function encodeContentLengthMessage(body: string): string {
	const len = Buffer.byteLength(body, 'utf8');
	return `Content-Length: ${len}\r\n\r\n${body}`;
}

/**
 * 增量缓冲：优先解析 LSP 风格帧；若缓冲以 `{` 开头且含换行，按行尝试 JSON。
 */
export class StdioFramingBuffer {
	private buffer = Buffer.alloc(0);

	/**
	 * @param chunk - 新到的 stdout 字节
	 * @returns 本轮解析出的完整消息字符串列表
	 */
	push(chunk: Buffer): string[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const out: string[] = [];
		while (true) {
			const msg = this.tryReadOne();
			if (msg === null) break;
			out.push(msg);
		}
		return out;
	}

	private tryReadOne(): string | null {
		const headerEnd = indexOfHeaderEnd(this.buffer);
		if (headerEnd !== -1) {
			const header = this.buffer.subarray(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// 坏头：丢弃到 headerEnd 之后继续
				this.buffer = this.buffer.subarray(headerEnd + 4);
				return null;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4; // \r\n\r\n
			if (this.buffer.length < bodyStart + length) return null;
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
			this.buffer = this.buffer.subarray(bodyStart + length);
			return body;
		}

		// 回退：整行 JSON
		const nl = this.buffer.indexOf(0x0a);
		if (nl === -1) return null;
		const line = this.buffer.subarray(0, nl).toString('utf8').replace(/\r$/, '');
		this.buffer = this.buffer.subarray(nl + 1);
		const trimmed = line.trim();
		if (!trimmed) return this.tryReadOne();
		if (trimmed.startsWith('{')) return trimmed;
		return this.tryReadOne();
	}
}

/**
 * 在缓冲中定位 `\r\n\r\n`，返回头结束字节偏移；找不到返回 -1。
 * 关键路径:头为 ASCII，用 utf8 切片再换算字节偏移安全。
 */
function indexOfHeaderEnd(buf: Buffer): number {
	const s = buf.toString('utf8');
	const idx = s.indexOf('\r\n\r\n');
	return idx === -1 ? -1 : Buffer.byteLength(s.slice(0, idx), 'utf8');
}

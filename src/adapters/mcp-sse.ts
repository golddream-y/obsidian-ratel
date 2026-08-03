/**
 * @file src/adapters/mcp-sse.ts
 * @description 从 SSE 响应体提取 JSON-RPC 消息
 * @module adapters/mcp-sse
 */

/**
 * 取第一个含 data 的事件块，拼接 data 行后 JSON.parse。
 *
 * 关键路径:部分网关把 JSON 拆成多行 `data:`；按事件块（空行分隔）拼接后再解析。
 *
 * @param body - 原始 SSE 文本
 * @returns 解析后的对象（通常为 JSON-RPC Response）
 * @throws 无可用 data 或 JSON 非法
 */
export function extractJsonRpcFromSse(body: string): unknown {
	const blocks = body.replace(/\r\n/g, '\n').split('\n\n');
	for (const block of blocks) {
		const dataLines: string[] = [];
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).replace(/^ /, ''));
			}
		}
		if (dataLines.length === 0) continue;
		const text = dataLines.join('');
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error('MCP SSE data 不是合法 JSON');
		}
	}
	throw new Error('MCP SSE 响应无 data 事件');
}

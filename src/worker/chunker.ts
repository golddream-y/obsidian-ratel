// Markdown chunker — splits Markdown into ~500 token chunks with 100 overlap
// From ARCHITECTURE.md section 2.3: text chunking runs in Worker Thread

export interface Chunk {
	text: string;
	index: number;
	startOffset: number;
	endOffset: number;
}

/**
 * Split Markdown content into chunks.
 * Will implement: chunkMarkdown(content, chunkSize, overlap) → Chunk[]
 */
export function chunkMarkdown(
	_content: string,
	_chunkSize = 500,
	_overlap = 100,
): Chunk[] {
	// TODO: implement Markdown-aware chunking
	return [];
}

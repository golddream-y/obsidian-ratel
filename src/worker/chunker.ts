// Markdown chunker — splits Markdown into ~chunkSize char chunks with overlap
// Tries to split at heading boundaries first, then at paragraph boundaries

export interface Chunk {
	text: string;
	index: number;
	startOffset: number;
	endOffset: number;
}

/**
 * Split Markdown content into chunks.
 * Strategy: split at heading boundaries first, then paragraph boundaries,
 * then sentence boundaries if needed.
 */
export function chunkMarkdown(
	content: string,
	chunkSize = 500,
	overlap = 100,
): Chunk[] {
	if (!content.trim()) return [];

	// Split into sections by headings
	const sections = splitByHeadings(content);

	// Merge small sections and split large ones
	const chunks: Chunk[] = [];
	let currentText = '';
	let currentStart = 0;

	for (const section of sections) {
		if (currentText.length + section.text.length > chunkSize && currentText.length > 0) {
			// Current section would exceed chunk size — flush current chunk
			chunks.push({
				text: currentText.trim(),
				index: chunks.length,
				startOffset: currentStart,
				endOffset: currentStart + currentText.length,
			});

			// Start new chunk with overlap from previous
			const overlapText = getOverlapSuffix(currentText, overlap);
			currentText = overlapText + section.text;
			currentStart = section.startOffset - overlapText.length;
		} else {
			currentText += (currentText ? '\n\n' : '') + section.text;
			if (currentText === section.text) {
				currentStart = section.startOffset;
			}
		}

		// If current text is still too long, split further
		if (currentText.length > chunkSize * 1.5) {
			const subChunks = splitLongText(currentText, chunkSize, overlap);
			for (const sub of subChunks) {
				chunks.push({
					text: sub.trim(),
					index: chunks.length,
					startOffset: currentStart,
					endOffset: currentStart + sub.length,
				});
			}
			currentText = '';
		}
	}

	// Flush remaining
	if (currentText.trim()) {
		chunks.push({
			text: currentText.trim(),
			index: chunks.length,
			startOffset: currentStart,
			endOffset: currentStart + currentText.length,
		});
	}

	return chunks;
}

interface Section {
	text: string;
	startOffset: number;
}

function splitByHeadings(content: string): Section[] {
	const lines = content.split('\n');
	const sections: Section[] = [];
	let currentLines: string[] = [];
	let currentStart = 0;
	let charOffset = 0;

	for (const line of lines) {
		if (/^#{1,6}\s/.test(line) && currentLines.length > 0) {
			sections.push({
				text: currentLines.join('\n'),
				startOffset: currentStart,
			});
			currentStart = charOffset;
			currentLines = [line];
		} else {
			if (currentLines.length === 0) {
				currentStart = charOffset;
			}
			currentLines.push(line);
		}
		charOffset += line.length + 1; // +1 for \n
	}

	if (currentLines.length > 0) {
		sections.push({
			text: currentLines.join('\n'),
			startOffset: currentStart,
		});
	}

	return sections;
}

function splitLongText(text: string, chunkSize: number, overlap: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= chunkSize) {
			chunks.push(remaining);
			break;
		}

		// Try to split at paragraph boundary
		let splitPoint = remaining.lastIndexOf('\n\n', chunkSize);
		if (splitPoint < chunkSize * 0.3) {
			// Try sentence boundary
			splitPoint = remaining.lastIndexOf('。', chunkSize);
			if (splitPoint < chunkSize * 0.3) {
				splitPoint = remaining.lastIndexOf('. ', chunkSize);
			}
			if (splitPoint < chunkSize * 0.3) {
				// Force split at chunkSize
				splitPoint = chunkSize;
			}
		}

		chunks.push(remaining.slice(0, splitPoint + 1));
		remaining = remaining.slice(Math.max(splitPoint + 1 - overlap, 1));
	}

	return chunks;
}

function getOverlapSuffix(text: string, overlapSize: number): string {
	if (overlapSize <= 0 || text.length <= overlapSize) return '';
	const suffix = text.slice(-overlapSize);
	// Start from the next sentence/paragraph boundary
	const newlineIdx = suffix.indexOf('\n');
	if (newlineIdx >= 0 && newlineIdx < suffix.length - 1) {
		return suffix.slice(newlineIdx + 1);
	}
	return suffix;
}

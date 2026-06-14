import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';

export function createReadNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'read_note',
			description: 'Read the content and metadata of a note in the vault. Use this to look up information the user asks about.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Path to the note file (e.g. "notes/LangChain.md")',
					},
				},
				required: ['path'],
			},
		},
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const path = args.path as string;
			const content = await vault.readFile(path);
			const metadata = vault.getMetadata(path);
			const backlinks = vault.getBacklinks(path);

			const result: Record<string, unknown> = { content, path };

			if (metadata) {
				result.metadata = {
					frontmatter: metadata.frontmatter,
					tags: metadata.tags?.map((t) => t.tag),
					links: metadata.links?.map((l) => l.link),
				};
			}

			if (backlinks.size > 0) {
				result.backlinks = Array.from(backlinks.keys());
			}

			return result;
		},
	};
}

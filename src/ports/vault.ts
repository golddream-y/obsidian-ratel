// Vault Port — zero-implementation interface contract
// Decouples tools from the ObsidianVault adapter

export interface VaultMetadata {
	frontmatter?: Record<string, unknown>;
	tags?: Array<{ tag: string }>;
	links?: Array<{ link: string }>;
}

export interface VaultPort {
	/** Read file content */
	readFile(path: string): Promise<string>;

	/** Write file (modify if exists, create if not) */
	writeFile(path: string, content: string): Promise<void>;

	/** Get backlinks for a file */
	getBacklinks(path: string): Map<string, number>;

	/** Get file metadata */
	getMetadata(path: string): VaultMetadata | null;

	/** List all Markdown file paths */
	listMarkdownFiles(): string[];
}

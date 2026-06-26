import { describe, it, expect } from 'vitest';
import { createGlobTool } from '../../src/tools/glob';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('glob tool', () => {
	it('匹配 daily 目录下 md', async () => {
		const vault = createMockVaultPort({
			files: { 'daily/a.md': '', 'other/b.md': '', 'daily/x.txt': '' },
		});
		const tool = createGlobTool(vault);
		const paths = await tool.execute({ pattern: 'daily/*.md' }) as string[];
		expect(paths).toEqual(['daily/a.md']);
	});
});

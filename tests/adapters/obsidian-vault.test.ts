/**
 * @file tests/adapters/obsidian-vault.test.ts
 * @description ObsidianVault 适配器单元测试 — mock App.vault / metadataCache 验证薄包装行为
 * @module tests/adapters/obsidian-vault
 * @depends src/adapters/obsidian-vault, src/ports/vault
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 导出 TFile 类与 mock 工厂共享同一引用,
// 确保 obsidian-vault.ts 中 `instanceof TFile` 与测试构造的 mock file 一致。
const { mockTFile, mockApp } = vi.hoisted(() => {
	class MockTFile {}

	const eventListeners = new Map<string, Set<(file: unknown, oldPath?: string) => void>>();

	const app = {
		vault: {
			getAbstractFileByPath: vi.fn(),
			read: vi.fn(),
			cachedRead: vi.fn(),
			modify: vi.fn(),
			append: vi.fn(),
			create: vi.fn(),
			createFolder: vi.fn(),
			trash: vi.fn(),
			process: vi.fn(),
			getMarkdownFiles: vi.fn(),
			adapter: {
				list: vi.fn(),
				exists: vi.fn(),
			},
			on: vi.fn((event: string, cb: (file: unknown, oldPath?: string) => void) => {
				if (!eventListeners.has(event)) eventListeners.set(event, new Set());
				eventListeners.get(event)!.add(cb);
				return { event, cb };
			}),
			offref: vi.fn((ref: { event: string; cb: (file: unknown, oldPath?: string) => void }) => {
				eventListeners.get(ref.event)?.delete(ref.cb);
			}),
			_emit(event: string, file: unknown, oldPath?: string) {
				eventListeners.get(event)?.forEach((cb) => cb(file, oldPath));
			},
		},
		metadataCache: {
			resolvedLinks: {} as Record<string, Record<string, number>>,
			getFileCache: vi.fn(),
		},
	};

	return { mockTFile: MockTFile, mockApp: app };
});

vi.mock('obsidian', () => ({
	App: class {},
	TFile: mockTFile,
}));

import { ObsidianVault } from '../../src/adapters/obsidian-vault';

function mockFile(path: string): InstanceType<typeof mockTFile> & { path: string } {
	return Object.assign(new mockTFile(), { path });
}

describe('ObsidianVault', () => {
	let vault: ObsidianVault;

	beforeEach(() => {
		vi.clearAllMocks();
		vault = new ObsidianVault(mockApp as never);
	});

	it('readFile - 文件存在 - 返回文件内容', async () => {
		const file = mockFile('notes/foo.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.vault.read.mockResolvedValue('# Hello');

		const content = await vault.readFile('notes/foo.md');

		expect(content).toBe('# Hello');
		expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith('notes/foo.md');
		expect(mockApp.vault.read).toHaveBeenCalledWith(file);
	});

	it('readFile - 文件不存在 - 抛错', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await expect(vault.readFile('missing.md')).rejects.toThrow('File not found: missing.md');
		expect(mockApp.vault.read).not.toHaveBeenCalled();
	});

	it('readFile - 路径指向文件夹(非 TFile)- 抛错', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: 'folder' });

		await expect(vault.readFile('folder')).rejects.toThrow('File not found: folder');
	});

	it('readFile - 入口调用 validateVaultPath 拒绝 .obsidian', async () => {
		await expect(vault.readFile('.obsidian/config')).rejects.toThrow('.obsidian');
	});

	it('writeFile - 文件已存在 - 调用 modify 覆盖', async () => {
		const file = mockFile('notes/foo.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);

		await vault.writeFile('notes/foo.md', 'new content');

		expect(mockApp.vault.modify).toHaveBeenCalledWith(file, 'new content');
		expect(mockApp.vault.create).not.toHaveBeenCalled();
	});

	it('writeFile - 文件不存在 - 调用 create 创建', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await vault.writeFile('notes/new.md', 'content');

		expect(mockApp.vault.create).toHaveBeenCalledWith('notes/new.md', 'content');
		expect(mockApp.vault.modify).not.toHaveBeenCalled();
	});

	it('writeFile - 父目录不存在 - 先 createFolder 再 create', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await vault.writeFile('a/b/c.md', 'content');

		expect(mockApp.vault.createFolder).toHaveBeenCalledWith('a/b');
		expect(mockApp.vault.create).toHaveBeenCalledWith('a/b/c.md', 'content');
	});

	it('writeFile - 父目录已存在 - 不调用 createFolder', async () => {
		const dirFile = { path: 'notes' };
		mockApp.vault.getAbstractFileByPath
			.mockReturnValueOnce(null)
			.mockReturnValueOnce(dirFile);

		await vault.writeFile('notes/new.md', 'content');

		expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		expect(mockApp.vault.create).toHaveBeenCalledWith('notes/new.md', 'content');
	});

	it('writeFile - 根目录文件(无斜杠)- 不检查目录', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await vault.writeFile('root.md', 'content');

		expect(mockApp.vault.createFolder).not.toHaveBeenCalled();
		expect(mockApp.vault.create).toHaveBeenCalledWith('root.md', 'content');
	});

	it('getBacklinks - 有反链 - 返回 Map<源路径, 次数>', () => {
		mockApp.metadataCache.resolvedLinks = {
			'a.md': { 'target.md': 2 },
			'b.md': { 'target.md': 1, 'other.md': 3 },
			'c.md': { 'other.md': 1 },
		};

		const result = vault.getBacklinks('target.md');

		expect(result.size).toBe(2);
		expect(result.get('a.md')).toBe(2);
		expect(result.get('b.md')).toBe(1);
	});

	it('getBacklinks - 无反链 - 返回空 Map', () => {
		mockApp.metadataCache.resolvedLinks = {
			'a.md': { 'other.md': 1 },
		};

		const result = vault.getBacklinks('target.md');

		expect(result.size).toBe(0);
	});

	it('getMetadata - 文件存在且有缓存 - 返回结构化元数据', () => {
		const file = mockFile('notes/foo.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { title: 'Test', tags: ['foo'] },
			tags: [{ tag: '#bar' }, { tag: '#baz' }],
			links: [{ link: '[[target]]' }],
		});

		const meta = vault.getMetadata('notes/foo.md');

		expect(meta).not.toBeNull();
		expect(meta!.frontmatter).toEqual({ title: 'Test', tags: ['foo'] });
		expect(meta!.tags).toEqual([{ tag: '#bar' }, { tag: '#baz' }]);
		expect(meta!.links).toEqual([{ link: '[[target]]' }]);
	});

	it('getMetadata - 文件不存在 - 返回 null', () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		expect(vault.getMetadata('missing.md')).toBeNull();
		expect(mockApp.metadataCache.getFileCache).not.toHaveBeenCalled();
	});

	it('getMetadata - 缓存未就绪 - 返回 null', () => {
		const file = mockFile('notes/foo.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.metadataCache.getFileCache.mockReturnValue(null);

		expect(vault.getMetadata('notes/foo.md')).toBeNull();
	});

	it('onFileModify - 注册回调,事件触发时收到路径', () => {
		const cb = vi.fn();
		const unsub = vault.onFileModify(cb);

		mockApp.vault._emit('modify', { path: 'notes/foo.md' });

		expect(cb).toHaveBeenCalledWith('notes/foo.md');
		unsub();
		expect(mockApp.vault.offref).toHaveBeenCalled();
	});

	it('onFileCreate - 注册回调,事件触发时收到路径', () => {
		const cb = vi.fn();
		vault.onFileCreate(cb);

		mockApp.vault._emit('create', { path: 'new.md' });

		expect(cb).toHaveBeenCalledWith('new.md');
	});

	it('onFileDelete - 注册回调,事件触发时收到路径', () => {
		const cb = vi.fn();
		vault.onFileDelete(cb);

		mockApp.vault._emit('delete', { path: 'old.md' });

		expect(cb).toHaveBeenCalledWith('old.md');
	});

	it('onFileRename - 注册回调,事件触发时收到新路径和旧路径', () => {
		const cb = vi.fn();
		vault.onFileRename(cb);

		mockApp.vault._emit('rename', { path: 'new.md' }, 'old.md');

		expect(cb).toHaveBeenCalledWith('new.md', 'old.md');
	});

	it('listMarkdownFiles - 返回所有 Markdown 文件路径', () => {
		mockApp.vault.getMarkdownFiles.mockReturnValue([
			{ path: 'a.md' },
			{ path: 'b/c.md' },
		]);

		expect(vault.listMarkdownFiles()).toEqual(['a.md', 'b/c.md']);
	});

	// ==================== vault-tools 新方法 ====================

	it('appendFile - 已存在文件追加内容', async () => {
		const file = mockFile('notes/a.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.vault.read.mockResolvedValue('hello world');

		await vault.appendFile('notes/a.md', ' world');

		expect(mockApp.vault.append).toHaveBeenCalledWith(file, ' world');
	});

	it('appendFile - 不存在则 create', async () => {
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await vault.appendFile('new.md', '# New');

		expect(mockApp.vault.create).toHaveBeenCalledWith('new.md', '# New');
	});

	it('fileExists - 委托 adapter.exists', async () => {
		mockApp.vault.adapter.exists.mockResolvedValue(true);

		expect(await vault.fileExists('x.md')).toBe(true);
		expect(mockApp.vault.adapter.exists).toHaveBeenCalledWith('x.md');
	});

	it('processFile - 原子替换', async () => {
		const file = mockFile('notes/edit.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.vault.process.mockImplementation(async (_f, fn: (c: string) => string) => fn('foo bar'));

		const result = await vault.processFile('notes/edit.md', (c) => c.replace('bar', 'baz'));

		expect(result).toBe('foo baz');
	});

	it('trashFile - 优先系统回收站', async () => {
		const file = mockFile('del.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.vault.trash.mockResolvedValue(undefined);

		await vault.trashFile('del.md');

		expect(mockApp.vault.trash).toHaveBeenCalledWith(file, true);
	});

	it('trashFile - 系统回收站失败时降级本地 .trash', async () => {
		const file = mockFile('del.md');
		mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
		mockApp.vault.trash.mockRejectedValueOnce(new Error('no system trash')).mockResolvedValueOnce(undefined);

		await vault.trashFile('del.md');

		expect(mockApp.vault.trash).toHaveBeenNthCalledWith(1, file, true);
		expect(mockApp.vault.trash).toHaveBeenNthCalledWith(2, file, false);
	});
});

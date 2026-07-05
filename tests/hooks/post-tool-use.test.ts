/**
 * @file tests/hooks/post-tool-use.test.ts
 * @description post-tool-use 立即索引刷新 — IndexController.enqueue 行为测试
 * @module tests/hooks/post-tool-use
 * @depends core/index-controller
 */

import { describe, it, expect, vi } from 'vitest';
import { IndexController, type VaultEventListener } from '../../src/core/index-controller';

function createMockVault(readFileContent = 'mock content'): VaultEventListener {
    return {
        onFileCreate: () => () => {},
        onFileModify: () => () => {},
        onFileDelete: () => () => {},
        onFileRename: () => () => {},
        readFile: vi.fn().mockResolvedValue(readFileContent),
    };
}

function createMockBackend() {
    return {
        fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
        incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
        deleteFile: vi.fn().mockResolvedValue(0),
    };
}

describe('IndexController.enqueue(post-tool-use 入口)', () => {
    it('enqueue - upsert - 读文件内容后入队 indexManager', async () => {
        const vault = createMockVault('hello world');
        const ctl = new IndexController(vault, createMockBackend(), '/tmp');
        const spy = vi.spyOn(ctl.indexManager, 'enqueue');

        await ctl.enqueue('test.md', 'upsert');

        expect(vault.readFile).toHaveBeenCalledWith('test.md');
        expect(spy).toHaveBeenCalledWith('test.md', 'upsert', 'hello world');
    });

    it('enqueue - delete - 不读文件直接入队', async () => {
        const vault = createMockVault();
        const ctl = new IndexController(vault, createMockBackend(), '/tmp');
        const spy = vi.spyOn(ctl.indexManager, 'enqueue');

        await ctl.enqueue('gone.md', 'delete');

        expect(vault.readFile).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith('gone.md', 'delete');
    });

    it('enqueue - upsert - 读文件失败静默忽略不抛错', async () => {
        const vault: VaultEventListener = {
            onFileCreate: () => () => {},
            onFileModify: () => () => {},
            onFileDelete: () => () => {},
            onFileRename: () => () => {},
            readFile: vi.fn().mockRejectedValue(new Error('file gone')),
        };
        const ctl = new IndexController(vault, createMockBackend(), '/tmp');
        const spy = vi.spyOn(ctl.indexManager, 'enqueue');

        // 关键路径:readFile 抛错时不向上传播,避免阻塞 agent-loop
        await expect(ctl.enqueue('missing.md', 'upsert')).resolves.toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
    });
});

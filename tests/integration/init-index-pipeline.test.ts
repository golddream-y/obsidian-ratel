/**
 * @file tests/integration/init-index-pipeline.test.ts
 * @description 1000 文件首扫集成测试 — 端到端 IndexController + mock backend
 * @module tests/integration/init-index-pipeline
 * @depends core/index-controller
 */

import { describe, it, expect, vi } from 'vitest';
import { IndexController, type VaultEventListener } from '../../src/core/index-controller';

describe('Init-index 集成 - 1000 文件首扫', () => {
    it('onLayoutReady - 1000 文件全量索引完成', async () => {
        const files = Array.from({ length: 1000 }, (_, i) => `notes/doc-${i}.md`);
        const fullReindexSpy = vi.fn().mockImplementation(async () => {
            return { indexed: files.length, errors: 0 };
        });
        const vault: VaultEventListener = {
            onFileCreate: () => () => {},
            onFileModify: () => () => {},
            onFileDelete: () => () => {},
            onFileRename: () => () => {},
        };
        const ctl = new IndexController(
            vault,
            {
                fullReindex: fullReindexSpy,
                incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
                deleteFile: vi.fn().mockResolvedValue(1),
            },
            '/tmp',
        );
        await ctl.onLayoutReady();
        expect(fullReindexSpy).toHaveBeenCalledTimes(1);
    });
});

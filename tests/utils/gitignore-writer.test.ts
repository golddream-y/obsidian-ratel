/**
 * @file tests/utils/gitignore-writer.test.ts
 * @description ensurePluginGitignore 行为 — 首次写、二次幂等、保留用户行
 * @module tests/utils/gitignore-writer
 * @depends utils/gitignore-writer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensurePluginGitignore } from '../../src/utils/gitignore-writer';
import fs from 'fs';
import path from 'path';

const TMP_DIR = path.join(__dirname, '../tmp/gitignore-test');

describe('ensurePluginGitignore', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
    });

    it('首次调用 - 写入 .index/ 与 cache/ 行', () => {
        const gitignorePath = ensurePluginGitignore(TMP_DIR);
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        expect(content).toContain('.index/');
        expect(content).toContain('cache/');
    });

    it('二次调用 - 幂等(行已存在不重复写)', () => {
        const first = ensurePluginGitignore(TMP_DIR);
        const second = ensurePluginGitignore(TMP_DIR);
        expect(first).toBe(second);
        const content = fs.readFileSync(first, 'utf-8');
        // 关键路径:行只能出现一次,不能重复。
        expect(content.split('.index/').length - 1).toBe(1);
    });

    it('保留用户已写的其他行', () => {
        const userGitignore = path.join(TMP_DIR, '.gitignore');
        fs.writeFileSync(userGitignore, 'my-custom-thing/\n');
        const result = ensurePluginGitignore(TMP_DIR);
        const content = fs.readFileSync(result, 'utf-8');
        expect(content).toContain('my-custom-thing/');
        expect(content).toContain('.index/');
    });
});

/**
 * @file tests/utils/ratelignore-parser.test.ts
 * @description Ratelignore 解析 — 默认规则 / 通配符 / 语法错降级 / negation
 * @module tests/utils/ratelignore-parser
 * @depends utils/ratelignore-parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Ratelignore } from '../../src/utils/ratelignore-parser';
import fs from 'fs';
import path from 'path';

const TMP_DIR = path.join(__dirname, '../tmp/ratelignore-test');
const RATELIGNORE = path.join(TMP_DIR, '.ratelignore');

describe('Ratelignore', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
    });

    it('文件不存在 - 用默认规则', () => {
        const ri = new Ratelignore(TMP_DIR);
        expect(ri.ignores('.obsidian/plugins/foo.md')).toBe(true);
        expect(ri.ignores('notes/daily.md')).toBe(false);
    });

    it('解析 gitignore 语法 - 通配符', () => {
        fs.writeFileSync(RATELIGNORE, 'drafts/**\n');
        const ri = new Ratelignore(TMP_DIR);
        expect(ri.ignores('drafts/wip.md')).toBe(true);
        expect(ri.ignores('notes/draft.md')).toBe(false);
    });

    it('语法错 - 回退到默认规则 + 不抛', () => {
        fs.writeFileSync(RATELIGNORE, '['); // 非法 gitignore
        const ri = new Ratelignore(TMP_DIR);
        // 关键路径:语法错不应抛错,降级到默认行为。
        expect(() => ri.ignores('notes/foo.md')).not.toThrow();
    });

    it('negation 语法 - !pattern 重新包含', () => {
        fs.writeFileSync(RATELIGNORE, 'notes/**\n!notes/important.md\n');
        const ri = new Ratelignore(TMP_DIR);
        expect(ri.ignores('notes/daily.md')).toBe(true);
        expect(ri.ignores('notes/important.md')).toBe(false);
    });
});

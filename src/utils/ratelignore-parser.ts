/**
 * @file src/utils/ratelignore-parser.ts
 * @description `.ratelignore` 解析 — gitignore 语法的轻量包装,排除用户不想索引的文件
 * @module utils/ratelignore-parser
 * @depends ignore
 *
 * 设计要点:
 * - 单独文件而非复用 `.gitignore`:用户可能没 git 或只想 ignore git,语义清晰
 * - 文件不存在时用合理默认(忽略 .obsidian/ 等)
 * - 语法错时回退到默认规则 + 不抛,不让整个索引挂
 */

import fs from 'fs';
import path from 'path';
import ignore from 'ignore';
import { devLogger } from '../logging/dev-logger';

const DEFAULT_RATELIGNORE = `.obsidian/
.trash/
.augmented-canvas/
.obsidian-canvas/
.obsidian-snippets/
`;

/**
 * `.ratelignore` 解析器 — gitignore 兼容的轻量过滤。
 */
export class Ratelignore {
    private ig: ReturnType<typeof ignore>;

    constructor(vaultRoot: string) {
        this.ig = ignore().add(DEFAULT_RATELIGNORE);

        const ratelignorePath = path.join(vaultRoot, '.ratelignore');
        if (fs.existsSync(ratelignorePath)) {
            try {
                const content = fs.readFileSync(ratelignorePath, 'utf-8');
                this.ig.add(content);
            } catch (err) {
                // 关键路径:语法错降级到默认规则 + 警告,不让索引挂。
                devLogger.warn('vault', 'Ratelignore 解析失败,使用默认规则', err);
            }
        }
    }

    /**
     * 判断给定 vault 相对路径是否应被索引排除。
     *
     * @param vaultRelativePath - 相对于 vault 根的路径,如 `notes/daily.md`。
     * @returns `true` 表示忽略(不索引),`false` 表示纳入索引。
     */
    ignores(vaultRelativePath: string): boolean {
        return this.ig.ignores(vaultRelativePath);
    }
}

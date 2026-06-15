/**
 * @file src/utils/gitignore-writer.ts
 * @description 启动期自动写 `.obsidian/plugins/ratel-vault/.gitignore`,防止索引数据被提交
 * @module utils/gitignore-writer
 *
 * 设计要点:
 * - 幂等:已包含目标行就不重复写,避免每次启动都覆盖文件
 * - 保留用户已写的其他行,只追加缺失的 Ratel Vault 行
 */

import fs from 'fs';
import path from 'path';

const RATEL_GITIGNORE_MARKER = '# Ratel Vault';
const RATEL_GITIGNORE_LINES = ['.index/', 'cache/'];

/**
 * 确保插件目录下的 `.gitignore` 包含 Ratel Vault 索引相关行。
 *
 * @param pluginDir - 插件目录绝对路径(`.obsidian/plugins/ratel-vault/`)
 * @returns 写入或已存在的 `.gitignore` 绝对路径。
 */
export function ensurePluginGitignore(pluginDir: string): string {
    const gitignorePath = path.join(pluginDir, '.gitignore');
    const existing = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf-8')
        : '';

    // 关键路径:所有 Ratel 行都缺失时才追加 marker 块,避免每次启动都改文件 mtime。
    const missingLines = RATEL_GITIGNORE_LINES.filter(
        (line) => !existing.split('\n').some((l) => l.trim() === line),
    );

    if (missingLines.length === 0) {
        return gitignorePath;
    }

    const block = ['', RATEL_GITIGNORE_MARKER, ...missingLines, ''].join('\n');
    const next = existing.endsWith('\n') || existing === '' ? existing + block : existing + '\n' + block;
    fs.writeFileSync(gitignorePath, next, 'utf-8');
    return gitignorePath;
}

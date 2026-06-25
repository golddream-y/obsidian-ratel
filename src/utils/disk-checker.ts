/**
 * @file src/utils/disk-checker.ts
 * @description 跨平台磁盘空间检测
 * @module utils/disk-checker
 *
 * 设计要点:
 * - 1.2 倍缓冲:transformers 缓存会写中间文件,裸模型大小不够
 * - 检测失败时 fail-open(放行):Obsidian 渲染进程中 statfs 可能不可用,
 *   不能因为检测工具本身不可用就阻断下载;真没空间时写文件阶段自然会报错。
 */

import fs from 'fs';

/**
 * 判断给定目录所在文件系统是否有足够空间。
 *
 * @param dirPath - 任意路径(实际检查的是其所在文件系统)。
 * @param neededBytes - 预估需要字节数。
 * @returns 足够或无法检测时返回 true;明确不足时返回 false。
 */
export async function hasEnoughDiskSpace(dirPath: string, neededBytes: number): Promise<boolean> {
    try {
        // 关键路径:statfs 在 Node 18+ 跨平台可用,但 Obsidian 渲染进程中可能受限。
        const stats = await fs.promises.statfs(dirPath);
        // 修复:bavail 为 0 可能是 statfs 未正确填充,不轻易阻断;
        // 只有明确小于所需空间时才返回 false。
        if (stats.bavail === 0 || stats.bsize === 0) {
            return true;
        }
        const requiredWithBuffer = Math.ceil(neededBytes * 1.2);
        return stats.bavail * stats.bsize >= requiredWithBuffer;
    } catch {
        // 修复:检测失败时放行,不把用户卡死在前置检查上。
        return true;
    }
}

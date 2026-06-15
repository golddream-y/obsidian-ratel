/**
 * @file src/utils/disk-checker.ts
 * @description 跨平台磁盘空间检测
 * @module utils/disk-checker
 *
 * 设计要点:
 * - 1.2 倍缓冲:transformers 缓存会写中间文件,裸模型大小不够
 * - 失败时降级返回 false(阻断),让用户提前发现
 */

import fs from 'fs';

/**
 * 判断给定目录所在文件系统是否有足够空间。
 *
 * @param dirPath - 任意路径(实际检查的是其所在文件系统)。
 * @param neededBytes - 预估需要字节数。
 * @returns 足够返回 true;不足或检测失败时返回 false。
 */
export async function hasEnoughDiskSpace(dirPath: string, neededBytes: number): Promise<boolean> {
    try {
        // 关键路径:statfs 在 Node 18+ 跨平台可用。
        const stats = await fs.promises.statfs(dirPath);
        const requiredWithBuffer = Math.ceil(neededBytes * 1.2);
        return stats.bavail * stats.bsize >= requiredWithBuffer;
    } catch {
        return false;
    }
}

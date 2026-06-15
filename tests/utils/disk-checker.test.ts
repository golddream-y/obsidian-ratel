/**
 * @file tests/utils/disk-checker.test.ts
 * @description hasEnoughDiskSpace 行为
 * @module tests/utils/disk-checker
 * @depends utils/disk-checker
 */

import { describe, it, expect } from 'vitest';
import { hasEnoughDiskSpace } from '../../src/utils/disk-checker';
import path from 'path';

describe('hasEnoughDiskSpace', () => {
    it('充足 - 返回 true', async () => {
        const result = await hasEnoughDiskSpace(path.join(__dirname, '../'), 1024);
        expect(result).toBe(true);
    });

    it('不足 - 返回 false', async () => {
        const result = await hasEnoughDiskSpace(path.join(__dirname, '../'), 1024 ** 5);
        expect(result).toBe(false);
    });
});

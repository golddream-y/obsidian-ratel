/**
 * @file src/ui/mascot/types.ts
 * @description 聊天吉祥物脸档枚举
 * @module ui/mascot/types
 */
export const MASCOT_FACES = ['error', 'stopped', 'waiting', 'thinking', 'working', 'speaking', 'listening', 'idle'] as const;
export type MascotFace = (typeof MASCOT_FACES)[number];

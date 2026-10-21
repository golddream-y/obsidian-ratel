/**
 * @file src/ui/tokens/chunk-size-presets.ts
 * @description 分块大小档位 — 预设值、互转与实际生效上限。
 * @module ui/tokens/chunk-size-presets
 *
 * 设计要点:
 * - 用户记不住「448 token 是多大」,所以给的是有含义的档位(精细/均衡/粗粒度),数字只是附属。
 * - 实际生效上限跟着嵌入模型的输入上限走:本地 bge-small 是 512,减去特殊 token 与结构前缀预留,
 *   可用于正文的预算是 448。超出部分在代码里兜底钳制,界面上直接显示实际生效值。
 */

/** 分块档位 — 用户选择的是档位,不是数字。 */
export type ChunkSizePresetId = 'fine' | 'balanced' | 'coarse' | 'custom';

/** 实际生效的块大小上限(token) — 本地模型 512 减去 64 的预留。 */
export const CHUNK_SIZE_MAX_TOKENS = 448;

/** 分块大小下限(token) — 再小就没有可检索的上下文了。 */
export const CHUNK_SIZE_MIN_TOKENS = 64;

/**
 * 档位 → 块大小(token)。
 *
 * 关键路径:三档之间留出足够间距,让用户能感知到检索行为的差别;
 * 粗粒度取上限值,保证「选最粗」和「顶到上限」是同一件事。
 */
export const CHUNK_SIZE_PRESETS = {
	fine: 192,
	balanced: 320,
	coarse: CHUNK_SIZE_MAX_TOKENS,
} as const;

/** 新装默认档位。 */
export const DEFAULT_CHUNK_SIZE_PRESET: Exclude<ChunkSizePresetId, 'custom'> = 'balanced';

/** 档位 id 顺序 — 界面按此顺序渲染按钮。 */
export const CHUNK_SIZE_PRESET_ORDER: ChunkSizePresetId[] = [
	'fine',
	'balanced',
	'coarse',
	'custom',
];

/**
 * 档位 → 块大小。
 *
 * @param id - 档位 id(custom 无预设值)
 * @returns 块大小(token);custom 返回默认档位值
 */
export function presetToTokens(id: Exclude<ChunkSizePresetId, 'custom'>): number {
	return CHUNK_SIZE_PRESETS[id];
}

/**
 * 块大小 → 档位。
 *
 * 关键路径:命中预设返回该预设,否则一律 custom ——
 * 不能把 300 说成「均衡」,用户会以为它和 320 一样。
 *
 * @param tokens - 当前块大小
 * @returns 档位 id
 */
export function tokensToPreset(tokens: number): ChunkSizePresetId {
	for (const [id, value] of Object.entries(CHUNK_SIZE_PRESETS)) {
		if (tokens === value) return id as Exclude<ChunkSizePresetId, 'custom'>;
	}
	return 'custom';
}

/**
 * 把块大小钳进可用区间。
 *
 * @param tokens - 原始值
 * @returns 落在 [min, max] 内的值
 */
export function clampChunkSize(tokens: number): number {
	if (!Number.isFinite(tokens)) return CHUNK_SIZE_PRESETS[DEFAULT_CHUNK_SIZE_PRESET];
	return Math.min(CHUNK_SIZE_MAX_TOKENS, Math.max(CHUNK_SIZE_MIN_TOKENS, Math.round(tokens)));
}

/**
 * 选择档位 → 写入设置。
 *
 * 关键路径:选 custom 时保留当前数字,只改档位标记;
 * 选具体档位时数字随档位走,两者始终一致。
 *
 * @param settings - 可变设置片段
 * @param preset - 选中的档位
 */
export function applyChunkSizePreset(
	settings: { chunkSizePreset: ChunkSizePresetId; chunkSize: number },
	preset: ChunkSizePresetId,
): void {
	settings.chunkSizePreset = preset;
	if (preset !== 'custom') {
		settings.chunkSize = presetToTokens(preset);
	} else {
		settings.chunkSize = clampChunkSize(settings.chunkSize);
	}
}

/**
 * 从已存的块大小推断档位 — 加载旧设置时用。
 *
 * @param tokens - 磁盘上的块大小
 * @returns 档位与钳制后的块大小
 */
export function inferChunkSizePreset(tokens: number | undefined): {
	preset: ChunkSizePresetId;
	chunkSize: number;
} {
	const chunkSize = clampChunkSize(tokens ?? CHUNK_SIZE_PRESETS[DEFAULT_CHUNK_SIZE_PRESET]);
	return { preset: tokensToPreset(chunkSize), chunkSize };
}

/**
 * 规范化分块相关字段 — loadSettings 后调用。
 *
 * 关键路径:旧库的 chunkSize 是按字符时代留下的值,可能超过可用上限;
 * 钳进来并按值反推档位,避免界面显示"自定义 500"却实际按 448 切。
 *
 * @param settings - 合并 DEFAULT 后的设置对象
 * @param raw - 磁盘原始片段;用于判断旧库是否缺少 chunkSizePreset
 */
export function normalizeChunkSizeSettings(
	settings: { chunkSize: number; chunkSizePreset: ChunkSizePresetId },
	raw?: { chunkSizePreset?: ChunkSizePresetId },
): void {
	if (raw?.chunkSizePreset == null) {
		const inferred = inferChunkSizePreset(settings.chunkSize);
		settings.chunkSize = inferred.chunkSize;
		settings.chunkSizePreset = inferred.preset;
		return;
	}
	settings.chunkSize = clampChunkSize(settings.chunkSize);
	settings.chunkSizePreset = tokensToPreset(settings.chunkSize);
}

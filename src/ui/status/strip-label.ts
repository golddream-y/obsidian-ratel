/**
 * @file src/ui/status/strip-label.ts
 * @description StatusStrip 文案合成与上下文百分比文字色
 * @module ui/status/strip-label
 * @depends ./tone
 */
import type { Tone } from './tone';

export interface ComposeStripLabelOpts {
	/** work-bar 合并后的忙态文案;硬 gate 文案也走此字段 */
	busyOverride: string | null;
	/** deriveTone + i18n 得到的默认文案(含 chatBusy 压制后) */
	toneLabel: string;
	chatBusy: boolean;
	tone: Tone;
}

/**
 * 将上下文占用百分比钳到 [0, 100]。
 *
 * @param percentage - 原始占用百分比(可能越界)
 * @returns 钳制后的百分比,供 Strip 数字与 Drawer meter 共用
 */
export function clampContextPct(percentage: number): number {
	return Math.min(Math.max(percentage, 0), 100);
}

/**
 * 合成 StatusStrip 主文案。
 *
 * 优先级:busyOverride > toneLabel。
 * chatBusy / tone 保留在签名里供调用方语义对齐与后续扩展,本函数当前不二次压制。
 *
 * @param opts - 合成选项
 * @returns Strip 主文案
 */
export function composeStripLabel(opts: ComposeStripLabelOpts): string {
	if (opts.busyOverride) return opts.busyOverride;
	return opts.toneLabel;
}

/**
 * 上下文占用百分比的文字色(Strip 右侧 mono %)。
 * 阈值与旧 Header 胶囊一致:≥95 error / ≥80 warning / 否则 success。
 *
 * @param percentage - 建议已 clamp;未 clamp 时仍按数值阈值取色
 * @returns CSS 颜色变量字符串
 */
export function contextPctTextColor(percentage: number): string {
	if (percentage >= 95) return 'var(--text-error)';
	if (percentage >= 80) return 'var(--text-warning)';
	return 'var(--text-success)';
}

import { tNow } from '../i18n';

export function requireString(args: Record<string, unknown>, key: string, label: string): string {
	const v = args[key];
	if (typeof v !== 'string' || v.length === 0) {
		throw new Error(tNow('error.tool.invalidArg', { label, type: typeof v }));
	}
	return v;
}

/**
 * 拒绝把上送占位符当作正文落盘。模型会照抄历史里的标记。
 */
export function rejectOffloadMarker(value: string): void {
	if (value.startsWith('[written]')) {
		throw new Error(tNow('error.tool.offloadMarker'));
	}
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === 'string' ? v : undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
	const v = args[key];
	return typeof v === 'boolean' ? v : defaultValue;
}

export function optionalNumber(args: Record<string, unknown>, key: string, defaultValue: number): number {
	const v = args[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : defaultValue;
}

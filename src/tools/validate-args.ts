export function requireString(args: Record<string, unknown>, key: string, label: string): string {
	const v = args[key];
	if (typeof v !== 'string' || v.length === 0) {
		throw new Error(`${label} 必须是非空字符串,收到: ${typeof v}`);
	}
	return v;
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

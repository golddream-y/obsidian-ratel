/**
 * @file src/prompts/interpolate.ts
 * @description {{var}} 占位符替换与校验
 * @module prompts/interpolate
 */

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * 替换模板中的 `{{var}}` 占位符。
 *
 * 已知变量替换为对应值;未知占位符保留原样(避免误伤用户文本中的 `{{...}}`)。
 *
 * @param template - 含占位符的模板字符串
 * @param vars - 变量名到值的映射
 * @returns 替换后的字符串
 */
export function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(PLACEHOLDER_RE, (_full, key: string) =>
		key in vars ? vars[key]! : `{{${key}}}`,
	);
}

/**
 * 校验模板是否包含全部必需占位符。
 *
 * @param template - 待校验模板
 * @param required - 必需占位符名列表
 * @returns 缺失的占位符名列表(空数组表示全部存在)
 */
export function validatePlaceholders(template: string, required: string[]): string[] {
	return required.filter((key) => !template.includes(`{{${key}}}`));
}

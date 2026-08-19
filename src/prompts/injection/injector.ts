/**
 * @file src/prompts/injection/injector.ts
 * @description PromptInjector — 动态注入段的统一组装器与预算执行点(S-SR-LAYERING)
 * @module prompts/injection/injector
 * @depends prompts/injection/ids
 */

import type { InjectionSourceId } from './ids';

/** 注入源接口 — 每个动态 system 段实现一份,向 PromptInjector 注册 */
export interface InjectionSource {
	id: InjectionSourceId;
	/** 构建本段内容;返回 null 表示本段缺席(不注入) */
	build(): string | null;
	/** 本段字节预算硬上限(未设 = 不限);超出尾部截断 — 兜底,源内部应先自限 */
	ownBudgetBytes?: number;
}

/** 组装产物 — 注入源 id + 最终文本 */
export interface InjectedSection {
	id: InjectionSourceId;
	content: string;
}

/**
 * 按 UTF-8 字节做尾部截断 — 供 injector 兜底与各注入路径复用。
 *
 * 关键路径:中文每字 3 字节,字符串 length 判断会漏;必须 Buffer.byteLength。
 * 截断可能切到字符中间,解码时产生替换符,不影响 LLM 阅读。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
	// 修复:负预算时 subarray 从尾部计数,会静默产出"截一半"的错误形态;统一返回空串。
	if (maxBytes <= 0) return '';
	const byteLength = Buffer.byteLength(text, 'utf-8');
	if (byteLength <= maxBytes) return text;
	return Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
}

/**
 * 统一注入管理器 — 动态 system 段的唯一组装出口。
 *
 * 设计要点:
 * - 源负责构建(有状态,由 ContextManager 既有 setter 写状态);管理器负责组装与预算兜底。
 * - 静态段(zone: static)仍走 sections.ts 注册表;injector 只管动态段,模板解析不重复造。
 * - 预算裁剪的主体在源内部(如 composer 的 memory 分层);ownBudgetBytes 是最后防线。
 */
export class PromptInjector {
	private sources = new Map<InjectionSourceId, InjectionSource>();

	/** 登记注入源;id 重复视为编码错误,直接抛错 */
	register(source: InjectionSource): void {
		if (this.sources.has(source.id)) {
			throw new Error(`注入源重复注册: ${source.id}`);
		}
		this.sources.set(source.id, source);
	}

	/** 按注册序组装;null/空串段跳过,超 ownBudgetBytes 尾部截断 */
	buildSections(): InjectedSection[] {
		const out: InjectedSection[] = [];
		for (const source of this.sources.values()) {
			const content = source.build();
			if (content === null || content === '') continue;
			const bounded = source.ownBudgetBytes !== undefined
				? truncateUtf8Bytes(content, source.ownBudgetBytes)
				: content;
			out.push({ id: source.id, content: bounded });
		}
		return out;
	}
}

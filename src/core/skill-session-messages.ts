/**
 * @file src/core/skill-session-messages.ts
 * @description ADR-012 — Skill 指令写入 Session.messages 的标记与探测
 * @module core/skill-session-messages
 * @depends ports/llm
 */

import type { ChatMessage } from '../ports/llm';

/**
 * 激活写入的 system 消息前缀 — hydrate 可跳过;幂等探测靠此前缀。
 *
 * @param name - skill 名
 */
export function skillInstructionsPrefix(name: string): string {
	return `[skill:${name}]\n`;
}

/**
 * 反激活 supersede 消息前缀。
 *
 * @param name - skill 名
 */
export function skillSupersedePrefix(name: string): string {
	return `[skill-off:${name}]\n`;
}

/**
 * 拼装写入 transcript 的 skill 正文。
 */
export function formatSkillInstructionsContent(name: string, body: string): string {
	return `${skillInstructionsPrefix(name)}${body}`;
}

/**
 * 拼装 supersede 短说明(面向模型,非 UI 文案)。
 */
export function formatSkillSupersedeContent(name: string): string {
	return (
		`${skillSupersedePrefix(name)}` +
		`此后请勿再遵循 Skill「${name}」此前注入的指令;若需再次使用请重新 activate_skill。`
	);
}

/**
 * 当前是否仍启用该 skill 的会话指令，以最近一次激活或停用记录为准。
 *
 * @param messages - 按时间顺序保存的会话消息
 * @param name - Skill 名称
 * @returns 最近一次记录为激活时返回 true
 * @example
 *   sessionHasSkillInstructions(messages, 'reviewer');
 */
export function sessionHasSkillInstructions(messages: ChatMessage[], name: string): boolean {
	return latestSkillState(messages, name) === 'active';
}

/**
 * 当前是否已停用该 skill，重新激活后旧停用记录不再生效。
 *
 * @param messages - 按时间顺序保存的会话消息
 * @param name - Skill 名称
 * @returns 最近一次记录为停用时返回 true
 * @example
 *   sessionHasSkillSupersede(messages, 'reviewer');
 */
export function sessionHasSkillSupersede(messages: ChatMessage[], name: string): boolean {
	return latestSkillState(messages, name) === 'inactive';
}

function latestSkillState(messages: ChatMessage[], name: string): 'active' | 'inactive' | undefined {
	const activePrefix = skillInstructionsPrefix(name);
	const inactivePrefix = skillSupersedePrefix(name);
	// 修复:历史正文不会在停用时删除，必须逆序查最近记录，避免重复停用和无法重新激活。
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== 'system') continue;
		if (message.content.startsWith(activePrefix)) return 'active';
		if (message.content.startsWith(inactivePrefix)) return 'inactive';
	}
	return undefined;
}

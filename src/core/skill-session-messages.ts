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
 * 本场是否已注入过该 skill 正文(不论是否已 supersede)。
 */
export function sessionHasSkillInstructions(messages: ChatMessage[], name: string): boolean {
	const prefix = skillInstructionsPrefix(name);
	return messages.some((m) => m.role === 'system' && m.content.startsWith(prefix));
}

/**
 * 本场是否已有 supersede 标记(用于 deactivate 幂等)。
 */
export function sessionHasSkillSupersede(messages: ChatMessage[], name: string): boolean {
	const prefix = skillSupersedePrefix(name);
	return messages.some((m) => m.role === 'system' && m.content.startsWith(prefix));
}

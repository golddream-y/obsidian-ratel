/**
 * @file tests/core/context-manager-skills.test.ts
 * @description ADR-012 — ContextManager skill 消息注入
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { Skill } from '../../src/skills/types';
import { skillInstructionsPrefix, skillSupersedePrefix } from '../../src/core/skill-session-messages';

function makePersistence(store: Map<string, Session>): Persistence {
	return {
		sessions: {
			get: async (id) => store.get(id) ?? null,
			upsert: async (s) => {
				store.set(s.id, { ...s, messages: [...s.messages] });
			},
			list: async () => [...store.values()],
			delete: async (id) => {
				store.delete(id);
			},
		},
		notes: {
			get: async () => null,
			upsert: async () => {},
			listByPath: async () => [],
			delete: async () => {},
		},
		hooks: {
			append: async () => {},
			list: async () => [],
		},
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
}

function makeSkill(name: string, instructions = `body-${name}`): Skill {
	return {
		manifest: {
			name,
			description: `d-${name}`,
			enabled: true,
			activation: 'always',
			tags: [],
		},
		instructions,
		source: 'vault',
		dir: `/v/${name}`,
	};
}

describe('ContextManager skills ADR-012', () => {
	let store: Map<string, Session>;
	let ctx: ContextManager;

	beforeEach(async () => {
		store = new Map();
		ctx = new ContextManager(makePersistence(store), undefined, 8000);
		await ctx.load('s1');
	});

	it('appendSkillInstructions - 首次写入 - messages 含 [skill:name] 前缀', async () => {
		ctx.appendSkillInstructions('reviewer', 'do review');
		expect(ctx.hasSkillInstructions('reviewer')).toBe(true);
		await ctx.save();
		const s = store.get('s1')!;
		expect(s.messages[0]!.content.startsWith(skillInstructionsPrefix('reviewer'))).toBe(true);
		expect(s.messages[0]!.content).toContain('do review');
	});

	it('appendSkillInstructions - 同名再次 - 不重复追加', async () => {
		ctx.appendSkillInstructions('reviewer', 'a');
		ctx.appendSkillInstructions('reviewer', 'b');
		await ctx.save();
		const s = store.get('s1')!;
		expect(s.messages.filter((m) => m.content.startsWith(skillInstructionsPrefix('reviewer')))).toHaveLength(
			1,
		);
	});

	it('ensureAlwaysSkillsInjected - 空场 - 各写一次', () => {
		ctx.ensureAlwaysSkillsInjected([makeSkill('a'), makeSkill('b')]);
		expect(ctx.hasSkillInstructions('a')).toBe(true);
		expect(ctx.hasSkillInstructions('b')).toBe(true);
	});

	it('appendSkillSupersede - 已注入后 - 追加 skill-off 前缀', async () => {
		ctx.appendSkillInstructions('reviewer', 'x');
		ctx.appendSkillSupersede('reviewer');
		await ctx.save();
		const s = store.get('s1')!;
		expect(s.messages.some((m) => m.content.startsWith(skillSupersedePrefix('reviewer')))).toBe(true);
	});

	it('toMessages - setSkillsContext active 非空 - 仍不注入 Active 段', () => {
		ctx.setSkillsContext('## Discovery\n- x', '## Active\nSHOULD_NOT_APPEAR');
		ctx.appendSkillInstructions('reviewer', 'instr');
		const out = ctx.toMessages();
		const joined = out.map((m) => m.content).join('\n');
		expect(joined).toContain('## Discovery');
		expect(joined).not.toContain('SHOULD_NOT_APPEAR');
		expect(joined).toContain(skillInstructionsPrefix('reviewer'));
	});
});

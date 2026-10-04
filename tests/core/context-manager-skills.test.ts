/**
 * @file tests/core/context-manager-skills.test.ts
 * @description ADR-012 — ContextManager skill 消息注入
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createActivateSkillTool } from '../../src/tools/activate-skill';
import { createDeactivateSkillTool } from '../../src/tools/deactivate-skill';
import { SkillRegistry } from '../../src/skills/skill-registry';
import { tNow } from '../../src/i18n';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';
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
	it('技能状态 - 停用并重载会话 - 不再判为激活', async () => {
		ctx.appendSkillInstructions('reviewer', 'x');
		ctx.appendSkillSupersede('reviewer');
		await ctx.save();
		await ctx.load('s1');
		expect(ctx.hasSkillInstructions('reviewer')).toBe(false);
	});

	it('技能生命周期 - 激活停用两次循环 - 每次转换均写入记录', async () => {
		ctx.appendSkillInstructions('reviewer', 'x');
		ctx.appendSkillSupersede('reviewer');
		ctx.appendSkillInstructions('reviewer', 'new');
		expect(ctx.hasSkillInstructions('reviewer')).toBe(true);
		ctx.appendSkillSupersede('reviewer');
		ctx.appendSkillSupersede('reviewer');
		expect(ctx.hasSkillInstructions('reviewer')).toBe(false);
		await ctx.save();
		expect(store.get('s1')!.messages.map((m) => m.content.split('\n')[0])).toEqual([
			'[skill:reviewer]', '[skill-off:reviewer]', '[skill:reviewer]', '[skill-off:reviewer]',
		]);
	});

	it('技能工具 - 重复停用及重新激活 - 拒绝无效停用并重新注入指令', async () => {
		const registry = new SkillRegistry();
		registry.reload([{
			manifest: { name: 'reviewer', description: '审查', enabled: true, activation: 'auto', tags: [] },
			instructions: '审查内容', dir: '/fake/reviewer', source: 'builtin',
		}], []);
		const hooks = {
			hasInSession: (name: string) => ctx.hasSkillInstructions(name),
			appendToSession: (name: string, body: string) => ctx.appendSkillInstructions(name, body),
			supersedeInSession: (name: string) => ctx.appendSkillSupersede(name),
		};
		const activate = createActivateSkillTool(registry, { name: 'activate_skill', description: '', parameters: {} }, hooks);
		const deactivate = createDeactivateSkillTool(registry, { name: 'deactivate_skill', description: '', parameters: {} }, hooks);
		await activate.execute({ name: 'reviewer' });
		await deactivate.execute({ name: 'reviewer' });
		await expect(deactivate.execute({ name: 'reviewer' })).rejects.toThrow(tNow('skill.notice.notActive', { name: 'reviewer' }));
		await expect(activate.execute({ name: 'reviewer' })).resolves.toBe(tNow('skill.notice.activated', { name: 'reviewer' }));
		expect(ctx.hasSkillInstructions('reviewer')).toBe(true);
	});

});

/**
 * @file tests/tools/tool-contract-recovery.test.ts
 * @description 验证参数拒绝后同工具重试通过真实补丁执行并一次落盘
 * @module tests/tools/tool-contract-recovery
 * @depends core/agent-loop, core/tool-args, tools/apply-patch
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { HookRegistry } from '../../src/core/hooks';
import { ToolRegistry } from '../../src/core/tool-registry';
import { parseToolArguments } from '../../src/core/tool-args';
import { createApplyPatchTool } from '../../src/tools/apply-patch';
import { measureNoteText } from '../../src/tools/note-text-stats';
import { setLang } from '../../src/i18n';
import type { ChatMessage, ChatRequest, LLMClient, ToolCall } from '../../src/ports/llm';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { AgentEvent } from '../../src/types';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

const initial = '甲\n乙\n丙\n丁\n';
const expected = '甲\n乙二\n丙\n丁二\n';
const retryArgs = {
  patch: '*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n@@\n 丙\n-丁\n+丁二\n*** End Patch',
};

function createPersistence(): Persistence {
  const sessions = new Map<string, Session>();
  return {
    sessions: { get: async (id) => sessions.get(id) ?? null, upsert: async (s) => { sessions.set(s.id, s); }, list: async () => [], delete: async () => {} },
    notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
    hooks: { append: async () => {}, list: async () => [] },
    getLastSessionId: async () => null, setLastSessionId: async () => {}, listSessionIndex: async () => [],
  };
}

afterEach(() => setLang('zh'));
describe('工具参数失败后的同工具恢复', () => {
  const cases: Array<{ label: string; first: Omit<ToolCall, 'name' | 'id'>; kind: string }> = [
    { label: '裸空补丁与错误结束标记', first: parseToolArguments('*** Begin Patch\n*** End of Patch', 'tool_calls'), kind: 'invalid-json' },
    { label: '两处修改裸补丁', first: parseToolArguments(retryArgs.patch, 'tool_calls'), kind: 'invalid-json' },
    { label: '数组顶层', first: parseToolArguments('[]', 'tool_calls'), kind: 'invalid-shape' },
    { label: '输出上限', first: parseToolArguments('{"patch":', 'length'), kind: 'output-limit' },
    { label: '旧 raw 调用', first: { args: { raw: retryArgs.patch } }, kind: 'legacy-unparsed' },
  ];
  for (const item of cases) {
    it(`apply_patch 恢复 - ${item.label} - 拒绝后合法重试只落盘一次`, async () => {
      setLang('zh');
      const state = { files: { 'notes/a.md': initial } };
      const vault = createMockVaultPort(state);
      const process = vi.spyOn(vault, 'processFile');
      const write = vi.spyOn(vault, 'writeFile');
      const permission = vi.fn(async () => {});
      const tools = new ToolRegistry();
      tools.register(createApplyPatchTool(vault, makeToolDef('apply_patch')));
      const requests: ChatMessage[][] = [];
      const snapshots: Array<{ content: string; writes: number }> = [];
      let round = 0;
      const llm: LLMClient = {
        supportsImages: false,
        countTokens: () => 10,
        async *chat(req: ChatRequest) {
          requests.push(structuredClone(req.messages));
          snapshots.push({ content: await vault.readFile('notes/a.md'), writes: process.mock.calls.length });
          if (round++ === 0) {
            yield { text: '', toolCall: { id: 'bad', name: 'apply_patch', ...item.first } };
          } else if (round === 2) {
            const feedback = req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
            expect(feedback).toContain('apply_patch 未执行');
            expect(feedback).toContain('含 patch 字符串的 JSON 对象');
            yield { text: '', toolCall: { id: 'retry', name: 'apply_patch', ...parseToolArguments(JSON.stringify(retryArgs), 'tool_calls') } };
          } else {
            // 隔离既有短正文续写机制，第三轮明确给出完整收笔正文。
            yield { text: '修改完成。'.repeat(50) };
          }
        },
      };
      const ctx = new ContextManager(createPersistence(), undefined, 8000);
      const events: AgentEvent[] = [];
      for await (const event of agentLoop({ sessionId: 'recovery', message: '局部修改两行' }, ctx, llm, tools, new HookRegistry(), undefined, undefined, permission)) events.push(event);
      expect(requests).toHaveLength(3);
      expect(snapshots).toEqual([{ content: initial, writes: 0 }, { content: initial, writes: 0 }, { content: expected, writes: 1 }]);
      expect(await vault.readFile('notes/a.md')).toBe(expected);
      expect(process).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(permission).toHaveBeenCalledTimes(1);
      const results = events.filter((e) => e.type === 'tool.result');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ payload: { argsIssue: { kind: item.kind } } });
      expect(results[1]).toMatchObject({ payload: { result: { path: 'notes/a.md', text: measureNoteText(expected) }, argsIssue: null } });
      const persisted = ctx.getTranscript();
      expect(persisted.find((m) => m.toolCallId === 'bad' && m.role === 'assistant')).toMatchObject({ toolArgsIssue: { kind: item.kind } });
    });
  }
});

it('apply_patch 业务错误 - 合法 JSON 内错误结束标记 - 不套参数解析错误且零落盘', async () => {
  setLang('zh');
  const vault = createMockVaultPort({ files: { 'notes/a.md': initial } });
  const process = vi.spyOn(vault, 'processFile');
  const write = vi.spyOn(vault, 'writeFile');
  const tools = new ToolRegistry();
  tools.register(createApplyPatchTool(vault, makeToolDef('apply_patch')));
  const malformed = parseToolArguments(JSON.stringify({ patch: retryArgs.patch.replace('*** End Patch', '*** End of Patch') }), 'tool_calls');
  expect(malformed.argsIssue).toBeNull();
  let round = 0;
  const llm: LLMClient = {
    supportsImages: false,
    countTokens: () => 10,
    async *chat() {
      if (round++ === 0) yield { text: '', toolCall: { id: 'syntax', name: 'apply_patch', ...malformed } };
      else yield { text: '补丁语法错误，文件保持不变。'.repeat(30) };
    },
  };
  const ctx = new ContextManager(createPersistence(), undefined, 8000);
  const events: AgentEvent[] = [];
  for await (const event of agentLoop({ sessionId: 'syntax', message: '局部修改两行' }, ctx, llm, tools, new HookRegistry())) events.push(event);
  expect(await vault.readFile('notes/a.md')).toBe(initial);
  expect(process).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const result = events.find((e) => e.type === 'tool.result');
  expect(result?.type).toBe('tool.result');
  if (result?.type !== 'tool.result') throw new Error('缺少工具结果');
  expect(result.payload.argsIssue).toBeNull();
  expect(result.payload.result).toContain('补丁格式无法解析');
  expect(result.payload.result).not.toContain('JSON');
  expect(result.payload.result).not.toContain('截断');
});

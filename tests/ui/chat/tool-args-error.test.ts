/**
 * @file tests/ui/chat/tool-args-error.test.ts
 * @description 工具参数错误的中英文展示与原文隔离测试
 * @module tests/ui/chat/tool-args-error
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../../src/i18n';
import type { ToolArgsIssue } from '../../../src/ports/llm';
import { formatToolArgsUserError } from '../../../src/ui/chat/tool-args-error';

const issues: ToolArgsIssue[] = [
  { kind: 'invalid-json', raw: '私密补丁' },
  { kind: 'invalid-shape', raw: '[]', actualType: 'array' },
  { kind: 'output-limit', raw: '私密补丁' },
  { kind: 'legacy-unparsed', raw: '私密补丁' },
];
const expected = {
  zh: ['工具参数不是合法 JSON，未执行。', '工具参数顶层是 array，必须是 JSON 对象，未执行。', '响应达到输出长度上限，参数无法解析，未执行。', '旧调用的参数未解析，原因未知，未执行。'],
  en: ['Tool arguments are invalid JSON. The tool was not executed.', 'Tool arguments are array; a JSON object is required. The tool was not executed.', 'The response reached its output limit and its arguments could not be parsed. The tool was not executed.', 'Arguments in this older call were not parsed; the cause is unknown. The tool was not executed.'],
};
afterEach(() => setLang('zh'));
describe('formatToolArgsUserError', () => {
  for (const lang of ['zh', 'en'] as const) {
    it(`错误文案 - ${lang} 四种分类 - 翻译明确且不泄漏原文`, () => {
      setLang(lang);
      expect(issues.map(formatToolArgsUserError)).toEqual(expected[lang]);
      for (const issue of issues) expect(formatToolArgsUserError(issue)).not.toContain(issue.raw);
    });
  }
});

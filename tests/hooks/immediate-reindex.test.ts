import { describe, it, expect } from 'vitest';
import { extractToolTargetPath, isDeleteTool } from '../../src/hooks/immediate-reindex';
import type { ToolCall } from '../../src/ports/llm';

describe('extractToolTargetPath', () => {
  it('write_note - 提取 path', () => {
    const tc: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };
    expect(extractToolTargetPath(tc)).toBe('a.md');
  });

  it('append_note - 提取 path', () => {
    const tc: ToolCall = { id: '2', name: 'append_note', args: { path: 'b.md', content: 'y' } };
    expect(extractToolTargetPath(tc)).toBe('b.md');
  });

  it('edit_note - 提取 path', () => {
    const tc: ToolCall = { id: '3', name: 'edit_note', args: { path: 'c.md', line: 1, content: 'z' } };
    expect(extractToolTargetPath(tc)).toBe('c.md');
  });

  it('delete_note - 提取 path', () => {
    const tc: ToolCall = { id: '4', name: 'delete_note', args: { path: 'd.md' } };
    expect(extractToolTargetPath(tc)).toBe('d.md');
  });

  it('非写工具 - 返回 null', () => {
    const tc: ToolCall = { id: '5', name: 'read_note', args: { path: 'e.md' } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });

  it('args 缺 path 字段 - 返回 null', () => {
    const tc: ToolCall = { id: '6', name: 'write_note', args: { content: 'x' } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });

  it('path 不是字符串 - 返回 null', () => {
    const tc: ToolCall = { id: '7', name: 'write_note', args: { path: 123 } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });

  it('path 是空字符串 - 返回 null', () => {
    const tc: ToolCall = { id: '8', name: 'write_note', args: { path: '' } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });
});

describe('isDeleteTool', () => {
  it('delete_note - 返回 true', () => {
    expect(isDeleteTool('delete_note')).toBe(true);
  });

  it('write_note - 返回 false', () => {
    expect(isDeleteTool('write_note')).toBe(false);
  });

  it('read_note - 返回 false', () => {
    expect(isDeleteTool('read_note')).toBe(false);
  });
});

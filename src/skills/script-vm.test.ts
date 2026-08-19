/**
 * @file src/skills/script-vm.test.ts
 * @description vm 沙箱核心测试 — 能力面裁剪 / fs 白名单 / reportProgress / 结果序列化
 * @module skills/script-vm.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInVmSandbox } from './script-vm';

describe('runInVmSandbox', () => {
	let vaultRoot: string;
	let skillDir: string;

	beforeEach(() => {
		vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-vault-'));
		skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skill-'));
	});
	afterEach(() => {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
		fs.rmSync(skillDir, { recursive: true, force: true });
	});

	it('能力面 - 全新 context 无 fetch/require/process/XMLHttpRequest', () => {
		const r = runInVmSandbox({
			code: `[typeof fetch, typeof require, typeof process, typeof XMLHttpRequest, typeof globalThis].join(',')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		// 修正:结果经 JSON 序列化,字符串带引号(与 Task 3 worker 验收 '"1+2"' 一致;plan 原断言漏了引号)
		if (r.ok) expect(r.result).toBe('"undefined,undefined,undefined,undefined,object"');
	});

	it('网络禁用 - fetch 调用直接抛错(不存在)', () => {
		const r = runInVmSandbox({
			// 修复:原用例只 typeof 未调用,属假测试;实际调用 fetch,ReferenceError 被 catch 为 scriptError
			code: `fetch("http://example.com")`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(false);
	});

	it('fs 白名单 - 写 vault 内文件成功', () => {
		const r = runInVmSandbox({
			code: `fs.writeFileSync('out/a.txt', 'hi'); 'written'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		expect(fs.readFileSync(path.join(vaultRoot, 'out/a.txt'), 'utf-8')).toBe('hi');
	});

	it('fs 白名单 - 写白名单外路径抛错被捕获为 scriptError', () => {
		const r = runInVmSandbox({
			// 关键路径:os.tmpdir() 本身在白名单外,相对路径 .. 逃逸同样拦截
			code: `fs.writeFileSync('${path.join(os.tmpdir(), 'escape.txt').replace(/\\/g, '\\\\')}', 'x'); 'ok'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(false);
	});

	it('fs 白名单 - 相对路径 .. 逃逸抛错', () => {
		fs.mkdirSync(path.join(vaultRoot, 'scripts'), { recursive: true });
		const r = runInVmSandbox({
			code: `try { fs.readFileSync('../../etc/passwd'); 'leaked' } catch (e) { 'blocked' }`,
			args: [],
			allowedDirs: [path.join(vaultRoot, 'scripts')],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('"blocked"');
	});

	it('reportProgress - 脚本主动报进度 - 回调收到消息', () => {
		const seen: string[] = [];
		const r = runInVmSandbox({
			code: `reportProgress('step-1'); 42`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
			onProgress: (m) => seen.push(m),
		});
		expect(seen).toEqual(['step-1']);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('42');
	});

	it('args - 参数以全局 args 数组注入', () => {
		const r = runInVmSandbox({
			code: `args.join('|')`,
			args: ['--input', 'data.json'],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('"--input|data.json"');
	});

	it('结果序列化 - 对象返回 JSON 字符串', () => {
		const r = runInVmSandbox({
			code: `({ count: 3, names: ['a'] })`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(JSON.parse(r.result)).toEqual({ count: 3, names: ['a'] });
	});

	it('结果序列化 - 空脚本 - 末表达式 undefined 序列化为字面量', () => {
		const r = runInVmSandbox({
			code: ``,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toBe('undefined');
	});

	it('结果序列化 - 循环引用 - JSON 失败降级 String 不炸沙箱', () => {
		const r = runInVmSandbox({
			code: `const a={};a.self=a;a`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.result).toContain('object');
	});

	it('结果序列化 - 超 64KB 截断并加尾注', () => {
		const r = runInVmSandbox({
			code: `'x'.repeat(100000)`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(Buffer.byteLength(r.result, 'utf-8')).toBeLessThanOrEqual(64 * 1024);
			expect(r.result).toContain('截断');
		}
	});

	it('脚本抛错 - 返回 ok:false 含错误消息与堆栈', () => {
		const r = runInVmSandbox({
			code: `throw new Error('boom')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('boom');
	});

	it('console - log/warn/error 透传回调,不炸 context', () => {
		const logs: string[] = [];
		const r = runInVmSandbox({
			code: `console.log('a'); console.warn('b'); console.error('c'); 'done'`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
			onLog: (_lv, m) => logs.push(String(m)),
		});
		expect(logs).toEqual(['a', 'b', 'c']);
		expect(r.ok).toBe(true);
	});

	it('path - 暴露 join/resolve/dirname/basename/extname/sep 纯函数', () => {
		const r = runInVmSandbox({
			code: `[typeof path.join, typeof path.resolve, typeof path.sep].join(',')`,
			args: [],
			allowedDirs: [vaultRoot, skillDir],
		});
		expect(r.ok).toBe(true);
		// 修正:同上,JSON 序列化字符串带引号
		if (r.ok) expect(r.result).toBe('"function,function,string"');
	});
});

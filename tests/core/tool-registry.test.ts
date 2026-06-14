import { describe, it, expect } from 'vitest';
import { ToolRegistry, type Tool } from '../../src/core/tool-registry';
import type { ToolDefinition } from '../../src/ports/llm';

const dummyDef: ToolDefinition = {
	name: 'test_tool',
	description: 'A test tool',
	parameters: {
		type: 'object',
		properties: {
			input: { type: 'string', description: 'Test input' },
		},
		required: ['input'],
	},
};

const dummyTool: Tool = {
	definition: dummyDef,
	execute: async (args) => `result: ${args.input as string}`,
};

describe('ToolRegistry', () => {
	it('registers a tool and lists its definition', () => {
		const registry = new ToolRegistry();
		registry.register(dummyTool);
		expect(registry.definitions()).toEqual([dummyDef]);
	});

	it('executes a registered tool by ToolCall', async () => {
		const registry = new ToolRegistry();
		registry.register(dummyTool);
		const result = await registry.execute({
			id: 'call_1',
			name: 'test_tool',
			args: { input: 'hello' },
		});
		expect(result).toBe('result: hello');
	});

	it('throws on unknown tool', async () => {
		const registry = new ToolRegistry();
		await expect(
			registry.execute({ id: 'call_1', name: 'unknown', args: {} }),
		).rejects.toThrow('Tool not found: unknown');
	});

	it('returns empty definitions when no tools registered', () => {
		const registry = new ToolRegistry();
		expect(registry.definitions()).toEqual([]);
	});

	it('registers multiple tools', () => {
		const registry = new ToolRegistry();
		const tool2: Tool = {
			definition: { name: 'tool2', description: 'Second tool', parameters: {} },
			execute: async () => 'tool2 result',
		};
		registry.register(dummyTool);
		registry.register(tool2);
		expect(registry.definitions()).toHaveLength(2);
		expect(registry.definitions().map((d) => d.name)).toEqual(['test_tool', 'tool2']);
	});

	it('isReadOnly returns true for tools marked readOnly', () => {
		const registry = new ToolRegistry();
		registry.register({
			definition: { name: 'read_tool', description: '', parameters: { type: 'object', properties: {} } },
			execute: async () => 'r',
			readOnly: true,
		});
		registry.register({
			definition: { name: 'write_tool', description: '', parameters: { type: 'object', properties: {} } },
			execute: async () => 'r',
		});
		expect(registry.isReadOnly('read_tool')).toBe(true);
		expect(registry.isReadOnly('write_tool')).toBe(false);
	});

	it('isReadOnly returns false for unknown tools', () => {
		const registry = new ToolRegistry();
		expect(registry.isReadOnly('nonexistent')).toBe(false);
	});
});

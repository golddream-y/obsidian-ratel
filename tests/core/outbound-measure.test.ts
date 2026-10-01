/**
 * @file tests/core/outbound-measure.test.ts
 * @description measureOutbound — 按实际上送字段分项估算 token
 * @module tests/core/outbound-measure
 * @depends core/outbound-measure
 */

import { describe, it, expect } from 'vitest';
import { measureOutbound } from '../../src/core/outbound-measure';
import { estimateTokens } from '../../src/ui/tokens/token-estimator';

describe('measureOutbound', () => {
	it('measureOutbound - 含参数与思考过程 - 分项相加且正文单独计不全', () => {
		const content = 'hello body';
		const reasoning = 'think step';
		const toolArgs = { path: 'note.md' };
		const messages = [{ content, reasoning, toolArgs }];
		const m = measureOutbound(messages);
		expect(m.content).toBe(estimateTokens(content));
		expect(m.reasoning).toBe(estimateTokens(reasoning));
		expect(m.toolArgs).toBe(estimateTokens(JSON.stringify(toolArgs)));
		expect(m.total).toBe(m.content + m.toolArgs + m.reasoning + m.attachments + m.toolSchemas);
		expect(m.total).toBeGreaterThan(estimateTokens(content));
	});

	it('measureOutbound - 工具定义 - 计入 toolSchemas', () => {
		const schemas = [{ name: 'read_note', description: '读', parameters: { type: 'object' } }];
		const without = measureOutbound([{ content: 'x' }]);
		const withSchemas = measureOutbound([{ content: 'x' }], schemas);
		expect(withSchemas.toolSchemas).toBe(estimateTokens(JSON.stringify(schemas)));
		expect(withSchemas.total - without.total).toBe(withSchemas.toolSchemas);
	});

	it('measureOutbound - 附件 estimatedTokens - 计入 attachments', () => {
		const m = measureOutbound([
			{
				content: 'see image',
				attachments: [{ estimatedTokens: 120 }, { estimatedTokens: 80 }],
			},
		]);
		expect(m.attachments).toBe(200);
		expect(m.total).toBe(m.content + 200);
	});
});

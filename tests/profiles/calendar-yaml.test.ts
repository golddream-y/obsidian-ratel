/**
 * @file tests/profiles/calendar-yaml.test.ts
 * @description 仓库示例 YAML 必须能通过校验
 * @module profiles/calendar-yaml.test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateProfile } from '../../src/profiles/validate';

describe('calendar-week-start.yaml', () => {
	it('validateProfile - 仓库示例 YAML - ok', () => {
		const raw = readFileSync('plugin-profiles/calendar-week-start.yaml', 'utf-8');
		const r = validateProfile(parse(raw));
		expect(r.ok).toBe(true);
	});
});

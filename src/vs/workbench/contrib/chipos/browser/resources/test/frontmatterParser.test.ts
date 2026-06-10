/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseRuleFile } from '../frontmatterParser.js';

suite('frontmatterParser', () => {
	test('no frontmatter is treated as an always-apply rule, whole content is body', () => {
		const r = parseRuleFile('just a rule body');
		assert.strictEqual(r.ruleType, 'always');
		assert.strictEqual(r.alwaysApply, true);
		assert.strictEqual(r.body, 'just a rule body');
	});

	test('alwaysApply:true → always (case-insensitive key), description parsed', () => {
		const r = parseRuleFile('---\nalwaysApply: true\ndescription: Be terse\n---\nbody here');
		assert.strictEqual(r.ruleType, 'always');
		assert.strictEqual(r.description, 'Be terse');
		assert.strictEqual(r.body, 'body here');
	});

	test('globs → glob ruleType', () => {
		const r = parseRuleFile('---\nglobs: **/*.sv\n---\nverilog rule');
		assert.strictEqual(r.ruleType, 'glob');
		assert.deepStrictEqual(r.globs, ['**/*.sv']);
	});

	test('globs as a bracketed list', () => {
		const r = parseRuleFile('---\nglobs: [**/*.sv, **/*.v]\n---\nx');
		assert.deepStrictEqual(r.globs, ['**/*.sv', '**/*.v']);
	});

	test('FEAT-001c B3: description but no trigger → agent (model attaches by relevance)', () => {
		const r = parseRuleFile('---\ndescription: just docs\n---\nx');
		assert.strictEqual(r.ruleType, 'agent');
	});

	test('frontmatter with no trigger and no description → manual (never auto-injects)', () => {
		const r = parseRuleFile('---\nfoo: bar\n---\nx');
		assert.strictEqual(r.ruleType, 'manual');
	});

	test('FEAT-003/P2.7: skill command/slash frontmatter parsed + normalized', () => {
		assert.deepStrictEqual(
			{
				command: parseRuleFile('---\ncommand: /review\n---\nbody').command,
				slash: parseRuleFile('---\nslash: deploy\n---\nbody').command,
				commandWinsOverSlash: parseRuleFile('---\ncommand: a\nslash: b\n---\nbody').command,
				invalidDropped: parseRuleFile('---\ncommand: bad name!\n---\nbody').command,
				absent: parseRuleFile('---\ndescription: x\n---\nbody').command,
			},
			{ command: 'review', slash: 'deploy', commandWinsOverSlash: 'a', invalidDropped: undefined, absent: undefined },
		);
	});

	test('FEAT-001c: parses priority frontmatter as a number; missing/invalid -> undefined', () => {
		assert.strictEqual(parseRuleFile('---\npriority: 7\n---\nbody').priority, 7);
		assert.strictEqual(parseRuleFile('---\ndescription: x\n---\nbody').priority, undefined);
		assert.strictEqual(parseRuleFile('---\npriority: high\n---\nbody').priority, undefined);
	});

	test('FEAT-005: parses agent mode frontmatter (subagent vs default)', () => {
		assert.strictEqual(parseRuleFile('---\nmode: subagent\n---\nbody').mode, 'subagent');
		assert.strictEqual(parseRuleFile('---\ndescription: x\n---\nbody').mode, undefined);
	});
});

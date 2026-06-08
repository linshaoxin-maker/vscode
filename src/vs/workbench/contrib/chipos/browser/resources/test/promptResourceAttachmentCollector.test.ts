/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { collectPromptResources, RuleDescriptor } from '../promptResourceAttachmentCollector.js';

suite('PromptResourceAttachmentCollector', () => {
	const rule = (over: Partial<RuleDescriptor>): RuleDescriptor =>
		({ name: 'r', source: 'user', ruleType: 'always', body: 'b', ...over });

	test('always rules are always included as kind=rule', () => {
		const res = collectPromptResources([rule({ name: 'a', body: 'be terse' })], {});
		assert.strictEqual(res.attachments.length, 1);
		assert.strictEqual(res.attachments[0].kind, 'rule');
		assert.strictEqual(res.attachments[0].reason, 'always');
		assert.strictEqual(res.attachments[0].payload?.body, 'be terse');
	});

	test('glob rule included only when the active file matches', () => {
		const r = rule({ name: 'sv', ruleType: 'glob', globs: ['**/*.sv'], body: 'verilog' });
		assert.strictEqual(collectPromptResources([r], { activeFile: 'src/cpu.sv' }).attachments.length, 1);
		assert.strictEqual(collectPromptResources([r], { activeFile: 'src/main.ts' }).attachments.length, 0);
		assert.strictEqual(collectPromptResources([r], {}).attachments.length, 0);
	});

	test('FEAT-001c B2: exclude glob ("!" prefix) removes matched files (exclude wins over include)', () => {
		const incExc = rule({ name: 'ts', ruleType: 'glob', globs: ['**/*.ts', '!vendor/**'], body: 'x' });
		const onlyExc = rule({ name: 'ex', ruleType: 'glob', globs: ['!vendor/**'], body: 'x' });
		assert.deepStrictEqual(
			{
				incMatched: collectPromptResources([incExc], { activeFile: 'src/a.ts' }).attachments.length,
				incExcluded: collectPromptResources([incExc], { activeFile: 'vendor/b.ts' }).attachments.length,
				onlyExcKept: collectPromptResources([onlyExc], { activeFile: 'src/a.ts' }).attachments.length,
				onlyExcDropped: collectPromptResources([onlyExc], { activeFile: 'vendor/b.ts' }).attachments.length,
			},
			{ incMatched: 1, incExcluded: 0, onlyExcKept: 1, onlyExcDropped: 0 },
		);
	});

	test('FEAT-009 B4: enabled:false short-circuits to no attachments (even with an always rule)', () => {
		const r = rule({ name: 'a', body: 'x' }); // an always rule (always applies when enabled)
		assert.deepStrictEqual(
			{
				on: collectPromptResources([r], { activeFile: 'src/a.ts' }).attachments.length,
				onDefault: collectPromptResources([r], {}).attachments.length,
				off: collectPromptResources([r], { enabled: false }).attachments.length,
			},
			{ on: 1, onDefault: 1, off: 0 },
		);
	});

	test('manual rule included only when attached', () => {
		const r = rule({ name: 'm', ruleType: 'manual', body: 'x' });
		assert.strictEqual(collectPromptResources([r], {}).attachments.length, 0);
		assert.strictEqual(collectPromptResources([r], { manualRuleIds: ['m'] }).attachments.length, 1);
	});

	test('maxCount cap reports omitted', () => {
		const rules = [rule({ name: 'a' }), rule({ name: 'b' }), rule({ name: 'c' })];
		const res = collectPromptResources(rules, { maxCount: 2 });
		assert.strictEqual(res.attachments.length, 2);
		assert.strictEqual(res.omitted.length, 1);
		assert.strictEqual(res.omitted[0].reason, 'maxCount');
	});

	test('plugin rule carries source + source_ref provenance', () => {
		const r = rule({ name: 'p', source: 'plugin', sourceRef: 'ai-dev', body: 'x' });
		const a = collectPromptResources([r], {}).attachments[0];
		assert.strictEqual(a.source, 'plugin');
		assert.strictEqual(a.source_ref, 'ai-dev');
	});
});

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

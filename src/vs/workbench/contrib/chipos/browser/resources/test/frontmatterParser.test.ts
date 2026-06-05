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

	test('frontmatter present but no trigger declared → manual (never auto-injects)', () => {
		const r = parseRuleFile('---\ndescription: just docs\n---\nx');
		assert.strictEqual(r.ruleType, 'manual');
	});
});

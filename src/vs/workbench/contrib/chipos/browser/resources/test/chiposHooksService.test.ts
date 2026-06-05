/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseHookFileContent } from '../chiposHooksService.js';

suite('ChiposHooksService.parseHookFileContent', () => {
	const REF = '/ws/.chipos/hooks/x.json';

	test('single deny hook parses with matcher + provenance', () => {
		const hooks = parseHookFileContent(JSON.stringify({
			point: 'tool.before_dispatch', action: 'deny',
			tool_name: 'run_in_terminal', reason: 'terminal disabled',
		}), REF);
		assert.deepStrictEqual(hooks, [{
			point: 'tool.before_dispatch', action: 'deny',
			tool_name: 'run_in_terminal', reason: 'terminal disabled',
			source: 'workspace', source_ref: REF,
		}]);
	});

	test('action defaults to observe; an array of hooks all parse', () => {
		const hooks = parseHookFileContent(JSON.stringify([
			{ point: 'tool.before_dispatch', tool_name: 'edit_file' },
			{ point: 'turn.after_end', action: 'observe' },
		]), REF);
		assert.strictEqual(hooks.length, 2);
		assert.strictEqual(hooks[0].action, 'observe');
		assert.strictEqual(hooks[1].point, 'turn.after_end');
	});

	test('entries with an unknown/absent point are dropped', () => {
		const hooks = parseHookFileContent(JSON.stringify([
			{ point: 'not.a.real.point', action: 'deny' },
			{ action: 'deny', tool_name: 'x' },
			{ point: 'tool.before_dispatch', tool_name: 'keep' },
		]), REF);
		assert.strictEqual(hooks.length, 1);
		assert.strictEqual(hooks[0].tool_name, 'keep');
	});

	test('malformed JSON and non-object entries yield no hooks (never throws)', () => {
		assert.deepStrictEqual(parseHookFileContent('{not json', REF), []);
		assert.deepStrictEqual(parseHookFileContent(JSON.stringify(['just a string', 42, null]), REF), []);
	});

	test('tool_name and reason are capped to the schema limits', () => {
		const hooks = parseHookFileContent(JSON.stringify({
			point: 'tool.before_dispatch', action: 'deny',
			tool_name: 'a'.repeat(200), reason: 'b'.repeat(600),
		}), REF);
		assert.strictEqual(hooks[0].tool_name!.length, 128);
		assert.strictEqual(hooks[0].reason!.length, 512);
	});

	test('a non-deny action string degrades to observe', () => {
		const hooks = parseHookFileContent(JSON.stringify({
			point: 'tool.before_dispatch', action: 'allow',
		}), REF);
		assert.strictEqual(hooks[0].action, 'observe');
	});
});

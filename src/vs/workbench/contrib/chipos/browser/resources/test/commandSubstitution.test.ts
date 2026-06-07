/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { substituteCommandArgs, tokenizeArguments } from '../commandSubstitution.js';

suite('commandSubstitution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('tokenizeArguments', () => {
		test('double and single quoted spans each collapse to one token; unquoted runs split on whitespace', () => {
			assert.deepStrictEqual(tokenizeArguments(`a "b c" 'd e'`), ['a', 'b c', 'd e']);
		});

		test('repeated whitespace collapses; empty / whitespace-only input yields []', () => {
			assert.deepStrictEqual(tokenizeArguments('  one   two  '), ['one', 'two']);
			assert.deepStrictEqual(tokenizeArguments('   '), []);
		});
	});

	suite('substituteCommandArgs', () => {
		test('$ARGUMENTS expands to the whole raw string; $1/$2 are 1-based; $ARGUMENTS[0] is 0-based; out-of-range => empty', () => {
			assert.deepStrictEqual(
				{
					all: substituteCommandArgs('[$ARGUMENTS]', 'alpha beta'),
					first: substituteCommandArgs('[$1]', 'alpha beta'),
					second: substituteCommandArgs('[$2]', 'alpha beta'),
					zeroBased: substituteCommandArgs('[$ARGUMENTS[0]]', 'alpha beta'),
					overRangePositional: substituteCommandArgs('[$9]', 'alpha beta'),
					overRangeIndexed: substituteCommandArgs('[$ARGUMENTS[9]]', 'alpha beta'),
				},
				{
					all: '[alpha beta]',
					first: '[alpha]',
					second: '[beta]',
					zeroBased: '[alpha]',
					overRangePositional: '[]',
					overRangeIndexed: '[]',
				},
			);
		});

		test('$name resolves via argumentNames; an unknown $name is left literal', () => {
			assert.deepStrictEqual(
				{
					known: substituteCommandArgs('[$foo]-[$bar]', 'one two', ['foo', 'bar']),
					unknown: substituteCommandArgs('[$baz]', 'one two', ['foo', 'bar']),
					noNames: substituteCommandArgs('[$foo]', 'one two'),
				},
				{
					known: '[one]-[two]',
					unknown: '[$baz]',
					noNames: '[$foo]',
				},
			);
		});

		test('\\$ARGUMENTS stays a literal "$ARGUMENTS"; \\\\$ARGUMENTS keeps one backslash and substitutes', () => {
			// Body fixtures use real backslashes (here written as escaped JS string literals).
			assert.deepStrictEqual(
				{
					escaped: substituteCommandArgs('\\$ARGUMENTS', 'raw'),
					escapedPair: substituteCommandArgs('\\\\$ARGUMENTS', 'raw'),
				},
				{
					escaped: '$ARGUMENTS',
					escapedPair: '\\raw',
				},
			);
		});

		test('append fallback adds "ARGUMENTS: ..." only when no bare $ARGUMENTS placeholder is present and rawArgs is non-empty', () => {
			assert.deepStrictEqual(
				{
					// No $ARGUMENTS in body + non-empty args => appended once.
					appended: substituteCommandArgs('do work', 'x y'),
					// Bare $ARGUMENTS present => never appended.
					notAppendedWhenPresent: substituteCommandArgs('args=$ARGUMENTS', 'x y'),
					// Empty / whitespace-only args => never appended.
					notAppendedWhenEmpty: substituteCommandArgs('do work', '   '),
				},
				{
					appended: 'do work\n\nARGUMENTS: x y',
					notAppendedWhenPresent: 'args=x y',
					notAppendedWhenEmpty: 'do work',
				},
			);
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { filterHooksForInvoke, redactSensitive } from '../hookSecurity.js';
import { ReasonerHookDefinition } from '../statelessInvoke/types.js';

/** FEAT-004 B6 — pure hook-security helpers. */
suite('hookSecurity (FEAT-004 B6)', () => {

	const decl = { point: 'tool.before_dispatch', action: 'deny' } as unknown as ReasonerHookDefinition;
	const fn = { point: 'tool.before_dispatch', kind: 'function', module: './x.js', export: 'f' } as unknown as ReasonerHookDefinition;

	test('filterHooksForInvoke: disable → none; exec off → drops function; exec on → all', () => {
		assert.deepStrictEqual(
			{
				disabled: filterHooksForInvoke([decl, fn], { executablePlugins: true, disable: true }),
				execOff: filterHooksForInvoke([decl, fn], { executablePlugins: false, disable: false }).map(h => (h as { kind?: string }).kind ?? 'decl'),
				execOn: filterHooksForInvoke([decl, fn], { executablePlugins: true, disable: false }).length,
			},
			{ disabled: [], execOff: ['decl'], execOn: 2 },
		);
	});

	test('redactSensitive masks sensitive keys, recurses objects/arrays, passes non-objects through', () => {
		assert.deepStrictEqual(
			redactSensitive({
				cmd: 'ls',
				api_key: 'sk-123',
				nested: { token: 't', safe: 'ok' },
				list: [{ password: 'p' }, 'plain'],
				count: 5,
			}),
			{
				cmd: 'ls',
				api_key: '[redacted]',
				nested: { token: '[redacted]', safe: 'ok' },
				list: [{ password: '[redacted]' }, 'plain'],
				count: 5,
			},
		);
	});

	test('redactSensitive does not mutate the original', () => {
		const original = { token: 'secret', nested: { apikey: 'k' } };
		redactSensitive(original);
		assert.deepStrictEqual(original, { token: 'secret', nested: { apikey: 'k' } });
	});
});

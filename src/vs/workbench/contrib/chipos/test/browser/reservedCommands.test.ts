/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	RESERVED_COMMANDS,
	RESERVED_NAMES,
} from '../../../../../workbench/contrib/chipos/browser/chatAgent/statelessInvoke/types.js';

suite('ReservedCommands — contract table (surface-unification)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ships /clear (local) and /compact (endpoint), no aliases yet', () => {
		assert.deepStrictEqual(RESERVED_COMMANDS.map(c => c.name), ['clear', 'compact']);
		const clear = RESERVED_COMMANDS[0];
		assert.strictEqual(clear.routing, 'local');
		assert.strictEqual(clear.takesArgs, false);
		assert.strictEqual(clear.availableInFlight, false);
		const compact = RESERVED_COMMANDS[1];
		assert.strictEqual(compact.routing, 'endpoint');
		assert.strictEqual(compact.takesArgs, false);
		// aliases empty on purpose — /new, /reset aren't resolved by any surface yet,
		// so reserving them would wrongly suppress a user's own new.md/reset.md.
		for (const c of RESERVED_COMMANDS) {
			assert.deepStrictEqual([...c.aliases], [], `${c.name} should have no aliases`);
		}
	});

	test('RESERVED_NAMES = exactly the functional reserved names (collision suppression)', () => {
		assert.ok(RESERVED_NAMES.has('clear'));
		assert.ok(RESERVED_NAMES.has('compact'));
		assert.strictEqual(RESERVED_NAMES.size, 2, 'only /clear and /compact are reserved');
		assert.ok(!RESERVED_NAMES.has('new'), 'no /new alias until a surface resolves it');
		assert.ok(!RESERVED_NAMES.has('reset'), 'no /reset alias until a surface resolves it');
		assert.ok(!RESERVED_NAMES.has('deploy'), 'arbitrary user commands are not reserved');
	});
});

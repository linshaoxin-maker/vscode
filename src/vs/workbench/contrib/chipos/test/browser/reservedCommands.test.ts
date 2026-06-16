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

	test('Slice 1 ships /clear (local routing), no aliases yet', () => {
		assert.deepStrictEqual(RESERVED_COMMANDS.map(c => c.name), ['clear']);
		const clear = RESERVED_COMMANDS[0];
		assert.strictEqual(clear.routing, 'local');
		assert.strictEqual(clear.takesArgs, false);
		assert.strictEqual(clear.availableInFlight, false);
		// aliases empty on purpose — /new, /reset aren't resolved by any surface yet,
		// so reserving them would wrongly suppress a user's own new.md/reset.md.
		assert.deepStrictEqual([...clear.aliases], []);
	});

	test('RESERVED_NAMES = exactly the functional reserved names (collision suppression)', () => {
		assert.ok(RESERVED_NAMES.has('clear'));
		assert.strictEqual(RESERVED_NAMES.size, 1, 'only /clear is reserved in slice 1');
		assert.ok(!RESERVED_NAMES.has('new'), 'no /new alias until a surface resolves it');
		assert.ok(!RESERVED_NAMES.has('reset'), 'no /reset alias until a surface resolves it');
		assert.ok(!RESERVED_NAMES.has('compact'), 'compact is not reserved until its slice lands');
	});
});

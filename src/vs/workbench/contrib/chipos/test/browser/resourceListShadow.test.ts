/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeShadowedRows } from '../../../../../workbench/contrib/chipos/browser/settings/tabs/resourceListTab.js';

suite('FEAT-005 computeShadowedRows (agent name-collision shadow)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no duplicate names → nothing shadowed', () => {
		const rows = [
			{ name: 'reviewer', enabled: true },
			{ name: 'planner', enabled: true },
		];
		assert.strictEqual(computeShadowedRows(rows).size, 0);
	});

	test('two enabled same-named rows across planes → the later (user) one is shadowed', () => {
		// Plane order is workspace-first, so the workspace row wins and the user row
		// is the dead one — exactly what getAgentDefinition resolves.
		const workspace = { name: 'reviewer', enabled: true };
		const user = { name: 'reviewer', enabled: true };
		const shadowed = computeShadowedRows([workspace, user]);
		assert.strictEqual(shadowed.has(workspace), false);
		assert.strictEqual(shadowed.has(user), true);
		assert.strictEqual(shadowed.size, 1);
	});

	test('a DISABLED higher-plane row never shadows the enabled lower-plane row', () => {
		// getAgentDefinition skips a disabled match and falls through, so the enabled
		// user row is the effective one and must NOT be flagged.
		const workspaceDisabled = { name: 'reviewer', enabled: false };
		const userEnabled = { name: 'reviewer', enabled: true };
		const shadowed = computeShadowedRows([workspaceDisabled, userEnabled]);
		assert.strictEqual(shadowed.size, 0);
	});

	test('three enabled same-named rows → only the first survives, the other two are shadowed', () => {
		const a = { name: 'reviewer', enabled: true };
		const b = { name: 'reviewer', enabled: true };
		const c = { name: 'reviewer', enabled: true };
		const shadowed = computeShadowedRows([a, b, c]);
		assert.strictEqual(shadowed.has(a), false);
		assert.strictEqual(shadowed.has(b), true);
		assert.strictEqual(shadowed.has(c), true);
	});

	test('disabled duplicates are never themselves shadowed', () => {
		const enabled = { name: 'reviewer', enabled: true };
		const disabledDup = { name: 'reviewer', enabled: false };
		const shadowed = computeShadowedRows([enabled, disabledDup]);
		assert.strictEqual(shadowed.size, 0);
	});
});

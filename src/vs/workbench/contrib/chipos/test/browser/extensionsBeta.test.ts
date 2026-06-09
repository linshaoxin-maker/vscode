/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isExtensionSystemEnabled, visibleSettingsTabs } from '../../common/extensionsBeta.js';

/** FEAT-006c — chipos.extensions.beta master gate. */
suite('extensionsBeta', () => {

	test('extension system defaults ON; only an explicit false disables it', () => {
		assert.deepStrictEqual(
			[undefined, true, false, 'true', 0].map(isExtensionSystemEnabled),
			[true, true, false, true, true],
		);
	});

	test('off hides the extension-system tabs and keeps the baseline tabs', () => {
		const all = ['general', 'models', 'features', 'rules', 'commands', 'skills', 'hooks', 'agents', 'plugins', 'connection', 'tools', 'edaTools', 'beta'];
		assert.deepStrictEqual(
			{ on: visibleSettingsTabs(all, true), off: visibleSettingsTabs(all, false) },
			{
				on: all,
				off: ['general', 'models', 'features', 'connection', 'tools', 'edaTools', 'beta'],
			},
		);
	});
});

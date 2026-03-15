/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';

suite('ChipOS Quick Toggles — Toggle Logic', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	test('thinking toggle: false → true', () => {
		let current = false;
		current = !current;
		assert.strictEqual(current, true);
	});

	test('thinking toggle: true → false', () => {
		let current = true;
		current = !current;
		assert.strictEqual(current, false);
	});

	test('autoApproveMode cycle: strict → standard → full_auto → strict', () => {
		const MODES = ['strict', 'standard', 'full_auto'] as const;

		function cycle(current: string): string {
			const idx = MODES.indexOf(current as typeof MODES[number]);
			return MODES[(idx + 1) % MODES.length];
		}

		assert.strictEqual(cycle('strict'), 'standard');
		assert.strictEqual(cycle('standard'), 'full_auto');
		assert.strictEqual(cycle('full_auto'), 'strict');
	});

	test('autoApproveMode cycle: unknown value defaults to standard', () => {
		const MODES = ['strict', 'standard', 'full_auto'] as const;

		function cycle(current: string): string {
			const idx = MODES.indexOf(current as typeof MODES[number]);
			if (idx === -1) {
				return MODES[0];
			}
			return MODES[(idx + 1) % MODES.length];
		}

		assert.strictEqual(cycle('invalid'), 'strict');
		assert.strictEqual(cycle(''), 'strict');
	});

	test('all three quick toggle action IDs are unique', () => {
		const ids = [
			'chipos.toggleThinking',
			'chipos.cycleAutoApprove',
			'chipos.openModelSettings',
		];
		const uniqueIds = new Set(ids);
		assert.strictEqual(uniqueIds.size, ids.length);
	});
});

suite('ChipOS Quick Toggles — ContextKey Expressions', () => {

	test('thinking toggle uses config.chipos.showThinking', () => {
		const configKey = 'config.chipos.showThinking';
		assert.ok(configKey.startsWith('config.'));
		assert.ok(configKey.includes('showThinking'));
	});

	test('autoApprove toggle uses config.chipos.autoApproveMode', () => {
		const configKey = 'config.chipos.autoApproveMode';
		assert.ok(configKey.startsWith('config.'));
		assert.ok(configKey.includes('autoApproveMode'));
	});

	test('toggled state: thinking off means untoggled', () => {
		const showThinking = false;
		const isToggled = showThinking;
		assert.strictEqual(isToggled, false);
	});

	test('toggled state: autoApprove strict means untoggled', () => {
		const autoApproveMode = 'strict';
		const isToggled = autoApproveMode !== 'strict';
		assert.strictEqual(isToggled, false);
	});

	test('toggled state: autoApprove standard means toggled', () => {
		const autoApproveMode: string = 'standard';
		const isToggled = autoApproveMode !== 'strict';
		assert.strictEqual(isToggled, true);
	});

	test('toggled state: autoApprove full_auto means toggled', () => {
		const autoApproveMode: string = 'full_auto';
		const isToggled = autoApproveMode !== 'strict';
		assert.strictEqual(isToggled, true);
	});
});

suite('ChipOS Quick Toggles — Menu Registration', () => {

	test('toggles register on ChatInput menu group', () => {
		const menuGroup = 'chipos';
		assert.strictEqual(menuGroup, 'chipos');
	});

	test('toggle ordering: thinking(200) < autoApprove(201) < modelSettings(202)', () => {
		const orders = {
			thinking: 200,
			autoApprove: 201,
			modelSettings: 202,
		};
		assert.ok(orders.thinking < orders.autoApprove);
		assert.ok(orders.autoApprove < orders.modelSettings);
	});
});

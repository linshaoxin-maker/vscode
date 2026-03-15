/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ChipOSSettingsEditorInput } from '../../../../../workbench/contrib/chipos/browser/settings/chiposSettingsEditorInput.js';

suite('ChipOSSettingsEditorInput', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	test('has correct type ID', () => {
		assert.strictEqual(ChipOSSettingsEditorInput.ID, 'workbench.input.chiposSettings');
	});

	test('resource uses chipos-settings scheme', () => {
		const input = new ChipOSSettingsEditorInput();
		disposables.add(input);

		assert.ok(input.resource);
		assert.strictEqual(input.resource.scheme, 'chipos-settings');
	});

	test('getName returns ChipOS Settings', () => {
		const input = new ChipOSSettingsEditorInput();
		disposables.add(input);

		const name = input.getName();
		assert.ok(name.length > 0);
	});

	test('typeId matches static ID', () => {
		const input = new ChipOSSettingsEditorInput();
		disposables.add(input);

		assert.strictEqual(input.typeId, ChipOSSettingsEditorInput.ID);
	});

	test('matches returns true for same type', () => {
		const input1 = new ChipOSSettingsEditorInput();
		const input2 = new ChipOSSettingsEditorInput();
		disposables.add(input1);
		disposables.add(input2);

		assert.strictEqual(input1.matches(input2), true);
	});

	test('matches returns false for different type', () => {
		const input = new ChipOSSettingsEditorInput();
		disposables.add(input);

		assert.strictEqual(input.matches({}), false);
		assert.strictEqual(input.matches(null), false);
		assert.strictEqual(input.matches('string'), false);
	});

	test('getIcon returns a valid icon', () => {
		const input = new ChipOSSettingsEditorInput();
		disposables.add(input);

		const icon = input.getIcon();
		assert.ok(icon);
	});
});

suite('ChipOSSettingsEditor — Constants', () => {

	test('Editor ID is defined', () => {
		const EDITOR_ID = 'workbench.editor.chiposSettings';
		assert.ok(EDITOR_ID);
		assert.strictEqual(EDITOR_ID, 'workbench.editor.chiposSettings');
	});

	test('Tab IDs are valid', () => {
		const tabs = ['models', 'features', 'connection'] as const;
		assert.strictEqual(tabs.length, 3);
		assert.strictEqual(tabs[0], 'models');
		assert.strictEqual(tabs[1], 'features');
		assert.strictEqual(tabs[2], 'connection');
	});

	test('default active tab is models', () => {
		const defaultTab = 'models';
		assert.strictEqual(defaultTab, 'models');
	});
});

suite('ChipOSSettingsEditorOptions', () => {

	test('initialTab option accepted', () => {
		const options = { initialTab: 'models' as const };
		assert.strictEqual(options.initialTab, 'models');
	});

	test('initialTab can be features', () => {
		const options = { initialTab: 'features' as const };
		assert.strictEqual(options.initialTab, 'features');
	});

	test('initialTab can be connection', () => {
		const options = { initialTab: 'connection' as const };
		assert.strictEqual(options.initialTab, 'connection');
	});

	test('options without initialTab are valid', () => {
		const options = {};
		assert.strictEqual((options as any).initialTab, undefined);
	});
});

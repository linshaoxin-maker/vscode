/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ModeSwitchWidget } from 'vs/workbench/contrib/chipos/browser/chatPanel/modeSwitchWidget';
import type { SessionMode } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatSessionManager';

suite('ModeSwitchWidget', () => {

	let container: HTMLElement;
	let widget: ModeSwitchWidget;

	setup(() => {
		container = document.createElement('div');
		widget = new ModeSwitchWidget(container);
	});

	teardown(() => {
		widget.dispose();
	});

	test('renders into container', () => {
		assert.ok(container.querySelector('.chipos-chat-mode-switch'));
		assert.ok(container.querySelector('.chipos-chat-mode-select'));
		assert.ok(container.querySelector('.chipos-chat-mode-indicator'));
	});

	test('defaults to agent mode', () => {
		assert.strictEqual(widget.getMode(), 'agent');
	});

	test('setMode updates the select value', () => {
		widget.setMode('spec');
		assert.strictEqual(widget.getMode(), 'spec');
		widget.setMode('agent');
		assert.strictEqual(widget.getMode(), 'agent');
	});

	test('setMode updates indicator class', () => {
		const indicator = container.querySelector('.chipos-chat-mode-indicator')!;

		widget.setMode('spec');
		assert.ok(indicator.classList.contains('chipos-mode-spec'));
		assert.ok(!indicator.classList.contains('chipos-mode-agent'));

		widget.setMode('agent');
		assert.ok(indicator.classList.contains('chipos-mode-agent'));
		assert.ok(!indicator.classList.contains('chipos-mode-spec'));
	});

	test('setEnabled controls disabled state', () => {
		const select = container.querySelector('.chipos-chat-mode-select') as HTMLSelectElement;

		widget.setEnabled(false);
		assert.strictEqual(select.disabled, true);

		widget.setEnabled(true);
		assert.strictEqual(select.disabled, false);
	});

	test('fires onDidChangeMode when select changes', () => {
		const select = container.querySelector('.chipos-chat-mode-select') as HTMLSelectElement;
		let firedMode: SessionMode | undefined;
		widget.onDidChangeMode(mode => { firedMode = mode; });

		select.value = 'spec';
		select.dispatchEvent(new Event('change'));
		assert.strictEqual(firedMode, 'spec');

		select.value = 'agent';
		select.dispatchEvent(new Event('change'));
		assert.strictEqual(firedMode, 'agent');
	});

	test('setMode does not fire event', () => {
		let fired = false;
		widget.onDidChangeMode(() => { fired = true; });
		widget.setMode('spec');
		assert.strictEqual(fired, false);
	});
});

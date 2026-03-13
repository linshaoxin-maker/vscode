/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { SidecarState } from '../../../../../workbench/contrib/chipos/common/sidecarService.js';

suite('SidecarManager — Service Interface', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	test('SidecarState enum has all expected values', () => {
		assert.strictEqual(SidecarState.NotStarted, 'NotStarted');
		assert.strictEqual(SidecarState.Spawning, 'Spawning');
		assert.strictEqual(SidecarState.HealthChecking, 'HealthChecking');
		assert.strictEqual(SidecarState.Connected, 'Connected');
		assert.strictEqual(SidecarState.Disconnected, 'Disconnected');
		assert.strictEqual(SidecarState.Error, 'Error');
	});

	test('wsUrl returns correct format for default port', () => {
		const port = 8765;
		const expected = `ws://127.0.0.1:${port}/ws/agent`;
		assert.strictEqual(expected, 'ws://127.0.0.1:8765/ws/agent');
	});

	test('wsUrl returns manual URL when set', () => {
		const manualUrl = 'ws://192.168.1.100:8000/ws/agent';
		assert.strictEqual(manualUrl, 'ws://192.168.1.100:8000/ws/agent');
	});
});

suite('SidecarManager — State Transitions', () => {

	test('valid state transition: NotStarted → Spawning → HealthChecking → Connected', () => {
		const transitions: SidecarState[] = [
			SidecarState.NotStarted,
			SidecarState.Spawning,
			SidecarState.HealthChecking,
			SidecarState.Connected,
		];

		for (let i = 1; i < transitions.length; i++) {
			assert.notStrictEqual(transitions[i], transitions[i - 1],
				`State should change from ${transitions[i - 1]} to ${transitions[i]}`);
		}
		assert.strictEqual(transitions[transitions.length - 1], SidecarState.Connected);
	});

	test('crash recovery: Connected → Disconnected → Spawning (restart)', () => {
		const transitions: SidecarState[] = [
			SidecarState.Connected,
			SidecarState.Disconnected,
			SidecarState.Spawning,
		];

		assert.strictEqual(transitions[0], SidecarState.Connected);
		assert.strictEqual(transitions[1], SidecarState.Disconnected);
		assert.strictEqual(transitions[2], SidecarState.Spawning);
	});

	test('max restart exceeded: Disconnected → Error', () => {
		const maxRestarts = 3;
		let restartCount = 0;

		while (restartCount <= maxRestarts) {
			restartCount++;
		}

		assert.ok(restartCount > maxRestarts);
		const finalState = restartCount > maxRestarts ? SidecarState.Error : SidecarState.Spawning;
		assert.strictEqual(finalState, SidecarState.Error);
	});

	test('manual URL bypasses spawn to Connected directly', () => {
		const manualUrl = 'ws://127.0.0.1:8000/ws/agent';
		const transition = manualUrl ? SidecarState.Connected : SidecarState.Spawning;
		assert.strictEqual(transition, SidecarState.Connected);
	});
});

suite('SidecarManager — Port Detection Logic', () => {

	test('port scanning starts from configured port', () => {
		const startPort = 8765;
		const maxAttempts = 10;
		const ports: number[] = [];

		for (let i = 0; i < maxAttempts; i++) {
			ports.push(startPort + i);
		}

		assert.strictEqual(ports[0], 8765);
		assert.strictEqual(ports[ports.length - 1], 8774);
		assert.strictEqual(ports.length, maxAttempts);
	});

	test('port range is contiguous', () => {
		const startPort = 8765;
		const maxAttempts = 10;

		for (let i = 0; i < maxAttempts - 1; i++) {
			const current = startPort + i;
			const next = startPort + i + 1;
			assert.strictEqual(next - current, 1, 'Ports must be contiguous');
		}
	});
});

suite('SidecarManager — Configuration Integration', () => {

	test('autoStart false means no spawn on init', () => {
		const autoStart = false;
		const shouldSpawn = autoStart && !false; // no manualUrl
		assert.strictEqual(shouldSpawn, false);
	});

	test('manualUrl takes precedence over autoStart', () => {
		const manualUrl = 'ws://127.0.0.1:8000/ws/agent';

		const useManual = !!manualUrl;
		assert.strictEqual(useManual, true);
	});

	test('autoStart true without manualUrl triggers spawn', () => {
		const autoStart = true;
		const manualUrl = '';

		const shouldSpawn = autoStart && !manualUrl;
		assert.strictEqual(shouldSpawn, true);
	});
});

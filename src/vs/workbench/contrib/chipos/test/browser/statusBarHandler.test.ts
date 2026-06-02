/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { StatusBarHandler } from '../../../../../workbench/contrib/chipos/browser/migration/statusBarHandler.js';
import { ConnectionState } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

// ── Mock IStatusbarEntryAccessor & IStatusbarService ──────────────────────

interface RecordedEntry {
	name: string;
	text: string;
	ariaLabel: string;
}

class MockStatusbarEntryAccessor {
	readonly updates: RecordedEntry[] = [];
	disposed = false;

	update(entry: RecordedEntry): void {
		this.updates.push(entry);
	}

	dispose(): void {
		this.disposed = true;
	}
}

class MockStatusbarService {
	readonly entries = new Map<string, MockStatusbarEntryAccessor>();

	addEntry(entry: RecordedEntry, id: string, _alignment: unknown, _location: unknown): MockStatusbarEntryAccessor {
		const accessor = new MockStatusbarEntryAccessor();
		accessor.updates.push(entry);
		this.entries.set(id, accessor);
		return accessor;
	}

	getLastText(id: string): string | undefined {
		const accessor = this.entries.get(id);
		if (!accessor || accessor.updates.length === 0) {
			return undefined;
		}
		return accessor.updates[accessor.updates.length - 1].text;
	}
}

suite('StatusBarHandler', () => {

	let statusbarService: MockStatusbarService;
	let handler: StatusBarHandler;

	setup(() => {
		statusbarService = new MockStatusbarService();
		handler = new StatusBarHandler(statusbarService as any);
	});

	teardown(() => {
		handler.dispose();
	});

	// ── Connection state ──────────────────────────────────────────────────

	test('initializes with Disconnected state', () => {
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text);
		assert.ok(text!.includes('Disconnected'));
	});

	test('updates to Connected state', () => {
		handler.updateConnectionState(ConnectionState.Connected);
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text!.includes('Connected'));
		assert.ok(!text!.includes('Disconnected'));
	});

	test('updates to Connecting state', () => {
		handler.updateConnectionState(ConnectionState.Connecting);
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text!.includes('Connecting'));
	});

	test('updates to Reconnecting state', () => {
		handler.updateConnectionState(ConnectionState.Reconnecting);
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text!.includes('Reconnecting'));
	});

	test('updates to Error state', () => {
		handler.updateConnectionState(ConnectionState.Error);
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text!.includes('Error'));
	});

	test('uses fallback label for unknown state', () => {
		handler.updateConnectionState('mystery' as ConnectionState);
		const text = statusbarService.getLastText('chipos.statusbar.connection');
		assert.ok(text!.includes('mystery'));
	});

	// ── Agent running state ───────────────────────────────────────────────

	test('shows agent running entry when running=true', () => {
		handler.updateAgentState(true);
		const text = statusbarService.getLastText('chipos.statusbar.agent');
		assert.ok(text);
		assert.ok(text!.includes('Agent running'));
	});

	test('shows custom stage text when provided', () => {
		handler.updateAgentState(true, 'Analyzing files');
		const text = statusbarService.getLastText('chipos.statusbar.agent');
		assert.ok(text!.includes('Analyzing files'));
	});

	test('removes agent entry when running=false', () => {
		handler.updateAgentState(true);
		const accessor = statusbarService.entries.get('chipos.statusbar.agent');
		assert.ok(accessor);

		handler.updateAgentState(false);
		assert.strictEqual(accessor!.disposed, true);
	});

	test('updates existing agent entry on subsequent calls', () => {
		handler.updateAgentState(true, 'Step 1');
		handler.updateAgentState(true, 'Step 2');

		const accessor = statusbarService.entries.get('chipos.statusbar.agent');
		const lastUpdate = accessor!.updates[accessor!.updates.length - 1];
		assert.ok(lastUpdate.text.includes('Step 2'));
	});

	test('no-op when stopping agent that was never started', () => {
		handler.updateAgentState(false);
		assert.strictEqual(statusbarService.entries.has('chipos.statusbar.agent'), false);
	});

	// ── Reconnect button (UX #4) ─────────────────────────────────────────

	test('reconnect button: hidden by default', () => {
		assert.strictEqual(statusbarService.entries.has('chipos.statusbar.reconnect'), false);
	});

	test('reconnect button: appears for sidecar-error', () => {
		handler.updateReconnectButton('sidecar-error');
		const text = statusbarService.getLastText('chipos.statusbar.reconnect');
		assert.ok(text);
		assert.ok(text!.includes('Reconnect'));
	});

	test('reconnect button: appears for worker-error', () => {
		handler.updateReconnectButton('worker-error');
		const text = statusbarService.getLastText('chipos.statusbar.reconnect');
		assert.ok(text!.includes('Reconnect'));
	});

	test('reconnect button: appears for worker-disconnected', () => {
		handler.updateReconnectButton('worker-disconnected');
		const text = statusbarService.getLastText('chipos.statusbar.reconnect');
		assert.ok(text!.includes('Reconnect'));
	});

	test('reconnect button: shows persistent Connected pill when reason is undefined', () => {
		// 2026-05-15: undefined no longer disposes the entry. It flips to a
		// persistent "Worker: Connected" pill (reason ?? 'connected') so the
		// indicator is always present instead of vanishing on reconnect —
		// dispose() left stale entries during some transition sequences.
		handler.updateReconnectButton('worker-error');
		const accessor = statusbarService.entries.get('chipos.statusbar.reconnect');
		assert.ok(accessor);

		handler.updateReconnectButton(undefined);
		assert.strictEqual(accessor!.disposed, false);
		const text = statusbarService.getLastText('chipos.statusbar.reconnect');
		assert.ok(text!.includes('Connected'));
	});

	test('reconnect button: updates existing entry when reason changes', () => {
		handler.updateReconnectButton('worker-error');
		handler.updateReconnectButton('sidecar-error');

		const accessor = statusbarService.entries.get('chipos.statusbar.reconnect');
		// Only one entry created; subsequent calls update in place.
		assert.strictEqual(accessor!.updates.length, 2);
	});

	// ── Dispose ───────────────────────────────────────────────────────────

	test('dispose cleans up all entries', () => {
		handler.updateAgentState(true);
		handler.updateReconnectButton('worker-error');
		handler.dispose();

		const connectionAccessor = statusbarService.entries.get('chipos.statusbar.connection');
		const agentAccessor = statusbarService.entries.get('chipos.statusbar.agent');
		const reconnectAccessor = statusbarService.entries.get('chipos.statusbar.reconnect');
		assert.strictEqual(connectionAccessor!.disposed, true);
		assert.strictEqual(agentAccessor!.disposed, true);
		assert.strictEqual(reconnectAccessor!.disposed, true);
	});
});

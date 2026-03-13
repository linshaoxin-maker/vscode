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

	// ── Dispose ───────────────────────────────────────────────────────────

	test('dispose cleans up all entries', () => {
		handler.updateAgentState(true);
		handler.dispose();

		const connectionAccessor = statusbarService.entries.get('chipos.statusbar.connection');
		const agentAccessor = statusbarService.entries.get('chipos.statusbar.agent');
		assert.strictEqual(connectionAccessor!.disposed, true);
		assert.strictEqual(agentAccessor!.disposed, true);
	});
});

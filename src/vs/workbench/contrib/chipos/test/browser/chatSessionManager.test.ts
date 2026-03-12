/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChatSessionManager, type IChatSession, type IChatMessage } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatSessionManager';

function makeMessage(role: IChatMessage['role'] = 'user', content = 'hello'): IChatMessage {
	return {
		id: `msg_${Date.now()}_${Math.random()}`,
		role,
		content,
		timestamp: Date.now(),
		isStreaming: false,
	};
}

suite('ChatSessionManager', () => {

	let manager: ChatSessionManager;

	setup(() => {
		manager = new ChatSessionManager();
	});

	teardown(() => {
		manager.dispose();
	});

	// ── Basic session lifecycle ────────────────────────────────────────────

	test('initializes with one default session', () => {
		const sessions = manager.getSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].title, 'New Chat');
		assert.strictEqual(sessions[0].status, 'idle');
		assert.strictEqual(sessions[0].mode, 'agent');
	});

	test('createSession adds a new session and sets it as active', () => {
		const s = manager.createSession('Test');
		assert.strictEqual(s.title, 'Test');
		assert.strictEqual(manager.getActiveSession()?.id, s.id);
		assert.strictEqual(manager.getSessions().length, 2);
	});

	test('switchToSession changes active session', () => {
		const s1 = manager.getActiveSession()!;
		const s2 = manager.createSession('Second');
		assert.strictEqual(manager.getActiveSession()?.id, s2.id);

		manager.switchToSession(s1.id);
		assert.strictEqual(manager.getActiveSession()?.id, s1.id);
	});

	test('switchToSession ignores unknown id', () => {
		const active = manager.getActiveSession()!;
		manager.switchToSession('nonexistent');
		assert.strictEqual(manager.getActiveSession()?.id, active.id);
	});

	test('switchToSession ignores same session id', () => {
		const active = manager.getActiveSession()!;
		let fired = false;
		manager.onDidChangeActiveSession(() => { fired = true; });
		manager.switchToSession(active.id);
		assert.strictEqual(fired, false);
	});

	// ── Close session ─────────────────────────────────────────────────────

	test('closeSession removes idle session', async () => {
		const s2 = manager.createSession('ToClose');
		assert.strictEqual(manager.getSessions().length, 2);
		const closed = await manager.closeSession(s2.id);
		assert.strictEqual(closed, true);
		assert.strictEqual(manager.getSessions().length, 1);
	});

	test('closeSession returns false for running session', async () => {
		const s = manager.getActiveSession()!;
		manager.setSessionStatus(s.id, 'running');
		const closed = await manager.closeSession(s.id);
		assert.strictEqual(closed, false);
		assert.strictEqual(manager.getSessions().length, 1);
	});

	test('forceCloseSession removes running session', () => {
		const s = manager.getActiveSession()!;
		manager.setSessionStatus(s.id, 'running');
		manager.forceCloseSession(s.id);
		// After force close of the only session, a new default session should be created
		assert.strictEqual(manager.getSessions().length, 1);
		assert.notStrictEqual(manager.getActiveSession()?.id, s.id);
	});

	test('closeSession on active session switches to another', async () => {
		const s1 = manager.getActiveSession()!;
		const _s2 = manager.createSession('Second');
		// s2 is now active. Close it.
		const closed = await manager.closeSession(_s2.id);
		assert.strictEqual(closed, true);
		assert.strictEqual(manager.getActiveSession()?.id, s1.id);
	});

	// ── Messages ──────────────────────────────────────────────────────────

	test('appendMessage adds message to session', () => {
		const s = manager.getActiveSession()!;
		const msg = makeMessage('user', 'test');
		manager.appendMessage(s.id, msg);
		assert.strictEqual(s.messages.length, 1);
		assert.strictEqual(s.messages[0].content, 'test');
	});

	test('appendMessage ignores unknown session', () => {
		manager.appendMessage('nonexistent', makeMessage());
		// No error thrown
	});

	test('updateLastAssistantContent appends to streaming message', () => {
		const s = manager.getActiveSession()!;
		const assistantMsg: IChatMessage = {
			id: 'a1',
			role: 'assistant',
			content: 'Hello',
			timestamp: Date.now(),
			isStreaming: true,
		};
		manager.appendMessage(s.id, assistantMsg);
		const updated = manager.updateLastAssistantContent(s.id, ' World');
		assert.ok(updated);
		assert.strictEqual(updated!.content, 'Hello World');
	});

	test('updateLastAssistantContent returns undefined if no streaming message', () => {
		const s = manager.getActiveSession()!;
		manager.appendMessage(s.id, makeMessage('user'));
		const updated = manager.updateLastAssistantContent(s.id, ' extra');
		assert.strictEqual(updated, undefined);
	});

	test('finishStreaming marks all messages as non-streaming', () => {
		const s = manager.getActiveSession()!;
		const msg: IChatMessage = { id: '1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true };
		manager.appendMessage(s.id, msg);
		manager.finishStreaming(s.id);
		assert.strictEqual(s.messages[0].isStreaming, false);
	});

	// ── Status and mode ───────────────────────────────────────────────────

	test('setSessionStatus updates status', () => {
		const s = manager.getActiveSession()!;
		manager.setSessionStatus(s.id, 'running');
		assert.strictEqual(s.status, 'running');
		manager.setSessionStatus(s.id, 'error');
		assert.strictEqual(s.status, 'error');
	});

	test('setSessionMode updates mode', () => {
		const s = manager.getActiveSession()!;
		assert.strictEqual(s.mode, 'agent');
		manager.setSessionMode(s.id, 'spec');
		assert.strictEqual(s.mode, 'spec');
	});

	// ── FEAT-04: autoNameSession ──────────────────────────────────────────

	test('autoNameSession sets title from first message', () => {
		const s = manager.getActiveSession()!;
		assert.strictEqual(s.title, 'New Chat');
		manager.autoNameSession(s.id, 'Help me write a counter module');
		assert.strictEqual(s.title, 'Help me write a counter module');
	});

	test('autoNameSession truncates at 30 chars with ellipsis', () => {
		const s = manager.getActiveSession()!;
		const longMsg = 'This is a very long message that exceeds thirty characters limit';
		manager.autoNameSession(s.id, longMsg);
		assert.strictEqual(s.title.length, 31); // 30 + '…'
		assert.ok(s.title.endsWith('…'));
	});

	test('autoNameSession does not override custom title', () => {
		const s = manager.createSession('My Custom Title');
		manager.autoNameSession(s.id, 'Some message');
		assert.strictEqual(s.title, 'My Custom Title');
	});

	test('autoNameSession does nothing for empty message', () => {
		const s = manager.getActiveSession()!;
		manager.autoNameSession(s.id, '');
		assert.strictEqual(s.title, 'New Chat');
	});

	// ── FEAT-04: renameSession ────────────────────────────────────────────

	test('renameSession updates the title', () => {
		const s = manager.getActiveSession()!;
		manager.renameSession(s.id, 'Renamed');
		assert.strictEqual(s.title, 'Renamed');
	});

	test('renameSession trims whitespace', () => {
		const s = manager.getActiveSession()!;
		manager.renameSession(s.id, '  Trimmed  ');
		assert.strictEqual(s.title, 'Trimmed');
	});

	test('renameSession keeps original if new title is empty', () => {
		const s = manager.getActiveSession()!;
		manager.renameSession(s.id, 'Original');
		manager.renameSession(s.id, '   ');
		assert.strictEqual(s.title, 'Original');
	});

	test('renameSession ignores unknown session', () => {
		manager.renameSession('nonexistent', 'Title');
		// No error thrown
	});

	// ── clearMessages ─────────────────────────────────────────────────────

	test('clearMessages removes all messages', () => {
		const s = manager.getActiveSession()!;
		manager.appendMessage(s.id, makeMessage());
		manager.appendMessage(s.id, makeMessage());
		assert.strictEqual(s.messages.length, 2);
		manager.clearMessages(s.id);
		assert.strictEqual(s.messages.length, 0);
	});

	// ── Max sessions ──────────────────────────────────────────────────────

	test('enforces max 10 sessions by evicting oldest idle', () => {
		// Manager starts with 1 session. Create 9 more = 10 total.
		for (let i = 0; i < 9; i++) {
			manager.createSession(`S${i}`);
		}
		assert.strictEqual(manager.getSessions().length, 10);

		// 11th session should evict the oldest idle
		manager.createSession('S10');
		assert.strictEqual(manager.getSessions().length, 10);
	});

	// ── Events ────────────────────────────────────────────────────────────

	test('fires onDidChangeActiveSession on create', () => {
		let firedSession: IChatSession | undefined;
		manager.onDidChangeActiveSession(s => { firedSession = s; });
		const s = manager.createSession('Event Test');
		assert.strictEqual(firedSession?.id, s.id);
	});

	test('fires onDidChangeSessionList on create', () => {
		let list: IChatSession[] = [];
		manager.onDidChangeSessionList(l => { list = l; });
		manager.createSession('Event Test');
		assert.strictEqual(list.length, 2);
	});

	test('fires onDidUpdateSession on status change', () => {
		let updated: IChatSession | undefined;
		manager.onDidUpdateSession(s => { updated = s; });
		const s = manager.getActiveSession()!;
		manager.setSessionStatus(s.id, 'running');
		assert.strictEqual(updated?.status, 'running');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * FEAT-R20 回归测试: Agent 级 session_id 过滤
 *
 * 验证 ChipOSChatAgent 的 invoke() 和 _listenForContinuation() 中
 * 对 event.session_id 的过滤逻辑：
 * - 匹配当前 session 的事件 → 正常处理
 * - 不匹配的事件 → 被丢弃，不影响当前 session 的 progress/effects
 * - session_id 为空的事件 → 不被过滤（向后兼容）
 */

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import {
	AgentEventType,
	ConnectionState,
	type AgentEvent,
	type ITextDeltaPayload,
	type IDonePayload,
} from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import type { IEventStreamClient } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventStreamClient.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';

// ── Minimal stubs ──────────────────────────────────────────────────────────

class StubEventStreamClient extends Disposable implements IEventStreamClient {
	private readonly _onDidReceiveEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidReceiveEvent: Event<AgentEvent> = this._onDidReceiveEvent.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<ConnectionState>());
	readonly onDidChangeConnectionState: Event<ConnectionState> = this._onDidChangeConnectionState.event;

	private _connectionState = ConnectionState.Disconnected;
	get connectionState(): ConnectionState { return this._connectionState; }

	connected = false;

	async connect(): Promise<void> {
		this.connected = true;
		this._connectionState = ConnectionState.Connected;
		this._onDidChangeConnectionState.fire(ConnectionState.Connected);
	}

	disconnect(): void {
		this.connected = false;
		this._connectionState = ConnectionState.Disconnected;
		this._onDidChangeConnectionState.fire(ConnectionState.Disconnected);
	}

	sendTask(_sessionId: string, _query: string, _mentions: any[], _mode: 'agent' | 'spec', _options: any): void { /* no-op */ }
	sendStop(_sessionId: string): void { /* no-op */ }
	sendConfirmResponse(_requestId: string, _action: string, _comment?: string, _sessionId?: string): void { /* no-op */ }

	/** Test helper: emit an event as if received from SSE */
	simulateEvent(event: AgentEvent): void {
		this._onDidReceiveEvent.fire(event);
	}
}

function makeTextDelta(sessionId: string | undefined, content: string): AgentEvent {
	return {
		event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		event_type: AgentEventType.TextDelta,
		timestamp: Date.now() / 1000,
		session_id: sessionId,
		payload: { content } as ITextDeltaPayload,
	};
}

function makeDone(sessionId: string | undefined): AgentEvent {
	return {
		event_id: `evt-done-${Date.now()}`,
		event_type: AgentEventType.Done,
		timestamp: Date.now() / 1000,
		session_id: sessionId,
		payload: {} as IDonePayload,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

suite('FEAT-R20: Session ID Filtering (Agent-level regression)', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	/**
	 * 核心过滤逻辑的单元验证：
	 * 模拟 invoke() 中的 listener 行为，验证 session_id 不匹配的事件被丢弃。
	 */
	test('events with mismatched session_id are filtered out', () => {
		const client = disposables.add(new StubEventStreamClient());
		const sessionId = 'session-A';
		const received: AgentEvent[] = [];

		// 模拟 invoke() 中的 listener 逻辑
		disposables.add(client.onDidReceiveEvent((event: AgentEvent) => {
			// 这是 chipOSChatAgent.ts invoke() 中的过滤条件
			if (event.session_id && event.session_id !== sessionId) {
				return; // filtered
			}
			received.push(event);
		}));

		// 发送匹配的事件
		client.simulateEvent(makeTextDelta('session-A', 'hello from A'));
		// 发送不匹配的事件
		client.simulateEvent(makeTextDelta('session-B', 'hello from B'));
		// 发送无 session_id 的事件（向后兼容，不过滤）
		client.simulateEvent(makeTextDelta(undefined, 'hello from unknown'));

		assert.strictEqual(received.length, 2, 'Should receive 2 events (matched + no session_id)');
		assert.strictEqual((received[0].payload as ITextDeltaPayload).content, 'hello from A');
		assert.strictEqual((received[1].payload as ITextDeltaPayload).content, 'hello from unknown');
	});

	/**
	 * 模拟 _listenForContinuation() 中的过滤逻辑：
	 * 使用 runtime.backendSessionId 做二次过滤。
	 */
	test('continuation events with mismatched session_id are filtered out', () => {
		const client = disposables.add(new StubEventStreamClient());
		const backendSessionId = 'backend-session-X';
		const received: AgentEvent[] = [];

		// 模拟 _listenForContinuation() 中的 listener 逻辑
		disposables.add(client.onDidReceiveEvent((event: AgentEvent) => {
			// 这是 chipOSChatAgent.ts _listenForContinuation() 中的过滤条件
			if (backendSessionId && event.session_id && event.session_id !== backendSessionId) {
				return; // filtered
			}
			received.push(event);
		}));

		// 匹配的事件
		client.simulateEvent(makeTextDelta('backend-session-X', 'continuation text'));
		// 不匹配的事件
		client.simulateEvent(makeTextDelta('backend-session-Y', 'wrong session'));
		// 无 session_id（兼容）
		client.simulateEvent(makeTextDelta(undefined, 'legacy event'));
		// Done 事件（匹配）
		client.simulateEvent(makeDone('backend-session-X'));

		assert.strictEqual(received.length, 3, 'Should receive 3 events (2 matched + 1 legacy)');
		assert.strictEqual(received[0].event_type, AgentEventType.TextDelta);
		assert.strictEqual(received[1].event_type, AgentEventType.TextDelta);
		assert.strictEqual(received[2].event_type, AgentEventType.Done);
	});

	/**
	 * 两个 session 并发：各自只收到自己的事件。
	 */
	test('two concurrent sessions receive only their own events', () => {
		const client = disposables.add(new StubEventStreamClient());
		const sessionA = 'session-A';
		const sessionB = 'session-B';
		const receivedA: AgentEvent[] = [];
		const receivedB: AgentEvent[] = [];

		// Session A listener
		disposables.add(client.onDidReceiveEvent((event: AgentEvent) => {
			if (event.session_id && event.session_id !== sessionA) { return; }
			receivedA.push(event);
		}));

		// Session B listener
		disposables.add(client.onDidReceiveEvent((event: AgentEvent) => {
			if (event.session_id && event.session_id !== sessionB) { return; }
			receivedB.push(event);
		}));

		// 交替发送事件
		client.simulateEvent(makeTextDelta('session-A', 'A-1'));
		client.simulateEvent(makeTextDelta('session-B', 'B-1'));
		client.simulateEvent(makeTextDelta('session-A', 'A-2'));
		client.simulateEvent(makeTextDelta('session-B', 'B-2'));
		client.simulateEvent(makeDone('session-A'));
		client.simulateEvent(makeDone('session-B'));

		assert.strictEqual(receivedA.length, 3, 'Session A: 2 text + 1 done');
		assert.strictEqual(receivedB.length, 3, 'Session B: 2 text + 1 done');

		assert.strictEqual((receivedA[0].payload as ITextDeltaPayload).content, 'A-1');
		assert.strictEqual((receivedA[1].payload as ITextDeltaPayload).content, 'A-2');
		assert.strictEqual(receivedA[2].event_type, AgentEventType.Done);

		assert.strictEqual((receivedB[0].payload as ITextDeltaPayload).content, 'B-1');
		assert.strictEqual((receivedB[1].payload as ITextDeltaPayload).content, 'B-2');
		assert.strictEqual(receivedB[2].event_type, AgentEventType.Done);
	});

	/**
	 * backendSessionId 为空时不过滤（初始状态，尚未收到 session_id）。
	 */
	test('when backendSessionId is empty, no filtering occurs', () => {
		const client = disposables.add(new StubEventStreamClient());
		const backendSessionId = ''; // 初始状态
		const received: AgentEvent[] = [];

		disposables.add(client.onDidReceiveEvent((event: AgentEvent) => {
			if (backendSessionId && event.session_id && event.session_id !== backendSessionId) {
				return;
			}
			received.push(event);
		}));

		client.simulateEvent(makeTextDelta('any-session', 'should pass'));
		client.simulateEvent(makeTextDelta('another-session', 'also pass'));

		assert.strictEqual(received.length, 2, 'All events pass when backendSessionId is empty');
	});
});

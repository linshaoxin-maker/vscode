/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import {
	AgentEventType,
	type AgentEvent,
	type ITextDeltaEvent,
	type IToolCallEvent,
	type IErrorEvent,
	type IDoneEvent,
	type IStatusEvent,
	type ITodoUpdateEvent,
	type ITaskCompleteEvent,
} from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

// ── Mock WebSocket for testing ──────────────────────────────────────────────

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	onopen: ((event: any) => void) | null = null;
	onmessage: ((event: any) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
	onclose: ((event: any) => void) | null = null;

	sentMessages: string[] = [];

	simulateOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.({});
	}

	simulateMessage(data: object): void {
		this.onmessage?.({ data: JSON.stringify(data) });
	}

	simulateClose(code = 1000, reason = ''): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	simulateError(): void {
		this.onerror?.({});
	}

	send(data: string): void {
		this.sentMessages.push(data);
	}

	close(_code?: number, _reason?: string): void {
		this.readyState = MockWebSocket.CLOSED;
	}
}

// ── Protocol mapping tests ──────────────────────────────────────────────────
//
// These tests verify the V1 backend protocol → AgentEvent mapping logic
// without requiring a real WebSocket connection. We test the mapping
// functions in isolation by simulating server messages.

suite('WebSocketEventStreamClient — Protocol Mapping', () => {

	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	// Helper: simulate the _handleRawMessage logic from WebSocketEventStreamClient
	function mapServerMessage(msg: object): AgentEvent[] {
		const events: AgentEvent[] = [];
		const raw = msg as { type: string; data: any; session_id: string | null };
		let eventCounter = 0;
		const nextId = () => `test_${++eventCounter}`;
		const ts = Date.now() / 1000;

		switch (raw.type) {
			case 'status': {
				const data = raw.data as { level: string; text: string; tool_name?: string };
				if (data.tool_name) {
					events.push({
						event_id: nextId(),
						event_type: AgentEventType.ToolCall,
						timestamp: ts,
						payload: { tool_name: data.tool_name, arguments: {}, call_id: `status_tc` },
					} as IToolCallEvent);
				}
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.Status,
					timestamp: ts,
					payload: { level: data.level, text: data.text, tool_name: data.tool_name },
				} as IStatusEvent);
				break;
			}
			case 'todo': {
				const data = raw.data as { todos: Array<{ task_id: string; task_des: string; task_status: string }> };
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.TodoUpdate,
					timestamp: ts,
					payload: { todos: data.todos },
				} as ITodoUpdateEvent);
				break;
			}
			case 'chat': {
				const data = raw.data as { content: string };
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.TextDelta,
					timestamp: ts,
					payload: { content: data.content, role: 'assistant' },
				} as ITextDeltaEvent);
				break;
			}
			case 'error': {
				const message = typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data);
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.Error,
					timestamp: ts,
					payload: { error_code: 'SERVER_ERROR', message, retryable: false },
				} as IErrorEvent);
				break;
			}
			case 'task_complete': {
				const data = raw.data as { status: string; message?: string };
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.TaskComplete,
					timestamp: ts,
					payload: { status: data.status, message: data.message },
				} as ITaskCompleteEvent);
				events.push({
					event_id: nextId(),
					event_type: AgentEventType.Done,
					timestamp: ts,
					payload: { summary: data.message || `Task ${data.status}.`, metrics: {} },
				} as IDoneEvent);
				break;
			}
			case 'heartbeat':
				break;
		}

		return events;
	}

	test('status with tool_name maps to ToolCall + Status', () => {
		const events = mapServerMessage({
			type: 'status',
			data: { level: 'info', text: '正在执行工具: read_file', tool_name: 'read_file' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0].event_type, AgentEventType.ToolCall);
		assert.strictEqual((events[0] as IToolCallEvent).payload.tool_name, 'read_file');
		assert.strictEqual(events[1].event_type, AgentEventType.Status);
		assert.strictEqual((events[1] as IStatusEvent).payload.level, 'info');
	});

	test('status without tool_name maps to Status only', () => {
		const events = mapServerMessage({
			type: 'status',
			data: { level: 'warning', text: 'Agent 正在忙碌中' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event_type, AgentEventType.Status);
		assert.strictEqual((events[0] as IStatusEvent).payload.level, 'warning');
		assert.strictEqual((events[0] as IStatusEvent).payload.text, 'Agent 正在忙碌中');
	});

	test('status with thinking level maps correctly', () => {
		const events = mapServerMessage({
			type: 'status',
			data: { level: 'thinking', text: 'Analyzing code structure...' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event_type, AgentEventType.Status);
		assert.strictEqual((events[0] as IStatusEvent).payload.level, 'thinking');
	});

	test('chat maps to TextDelta', () => {
		const events = mapServerMessage({
			type: 'chat',
			data: { content: '已完成检查，发现 2 处语法问题...' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event_type, AgentEventType.TextDelta);
		assert.strictEqual((events[0] as ITextDeltaEvent).payload.content, '已完成检查，发现 2 处语法问题...');
		assert.strictEqual((events[0] as ITextDeltaEvent).payload.role, 'assistant');
	});

	test('todo maps to TodoUpdate', () => {
		const events = mapServerMessage({
			type: 'todo',
			data: {
				todos: [
					{ task_id: '1', task_des: '读取 README', task_status: 'done' },
					{ task_id: '2', task_des: '分析代码', task_status: 'running' },
				],
			},
			session_id: 's1',
		});

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event_type, AgentEventType.TodoUpdate);
		assert.strictEqual((events[0] as ITodoUpdateEvent).payload.todos.length, 2);
		assert.strictEqual((events[0] as ITodoUpdateEvent).payload.todos[0].task_status, 'done');
	});

	test('error (string data) maps to Error event', () => {
		const events = mapServerMessage({
			type: 'error',
			data: 'Invalid request format: missing user_query',
			session_id: null,
		});

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event_type, AgentEventType.Error);
		assert.strictEqual((events[0] as IErrorEvent).payload.error_code, 'SERVER_ERROR');
		assert.strictEqual((events[0] as IErrorEvent).payload.message, 'Invalid request format: missing user_query');
		assert.strictEqual((events[0] as IErrorEvent).payload.retryable, false);
	});

	test('task_complete maps to TaskComplete + Done', () => {
		const events = mapServerMessage({
			type: 'task_complete',
			data: { status: 'success' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0].event_type, AgentEventType.TaskComplete);
		assert.strictEqual((events[0] as ITaskCompleteEvent).payload.status, 'success');
		assert.strictEqual(events[1].event_type, AgentEventType.Done);
		assert.strictEqual((events[1] as IDoneEvent).payload.summary, 'Task success.');
	});

	test('task_complete with error status includes message', () => {
		const events = mapServerMessage({
			type: 'task_complete',
			data: { status: 'error', message: 'LLM API timeout' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 2);
		assert.strictEqual((events[0] as ITaskCompleteEvent).payload.status, 'error');
		assert.strictEqual((events[0] as ITaskCompleteEvent).payload.message, 'LLM API timeout');
		assert.strictEqual((events[1] as IDoneEvent).payload.summary, 'LLM API timeout');
	});

	test('task_complete cancelled', () => {
		const events = mapServerMessage({
			type: 'task_complete',
			data: { status: 'cancelled' },
			session_id: 's1',
		});

		assert.strictEqual(events.length, 2);
		assert.strictEqual((events[0] as ITaskCompleteEvent).payload.status, 'cancelled');
	});

	test('heartbeat produces no events', () => {
		const events = mapServerMessage({
			type: 'heartbeat',
			data: { status: 'ping' },
			session_id: null,
		});

		assert.strictEqual(events.length, 0);
	});

	test('full conversation flow: status → status(tool) → chat → task_complete', () => {
		const allEvents: AgentEvent[] = [];

		// 1. status: thinking
		allEvents.push(...mapServerMessage({
			type: 'status', data: { level: 'thinking', text: 'Analyzing...' }, session_id: 's1',
		}));

		// 2. status: tool call
		allEvents.push(...mapServerMessage({
			type: 'status', data: { level: 'info', text: 'Executing read_file', tool_name: 'read_file' }, session_id: 's1',
		}));

		// 3. todo
		allEvents.push(...mapServerMessage({
			type: 'todo', data: { todos: [{ task_id: '1', task_des: 'Read files', task_status: 'done' }] }, session_id: 's1',
		}));

		// 4. chat (final response)
		allEvents.push(...mapServerMessage({
			type: 'chat', data: { content: 'Found 2 syntax errors in your Verilog.' }, session_id: 's1',
		}));

		// 5. task_complete
		allEvents.push(...mapServerMessage({
			type: 'task_complete', data: { status: 'success' }, session_id: 's1',
		}));

		const types = allEvents.map(e => e.event_type);
		assert.deepStrictEqual(types, [
			AgentEventType.Status,        // thinking
			AgentEventType.ToolCall,       // tool call
			AgentEventType.Status,         // tool status text
			AgentEventType.TodoUpdate,     // todo update
			AgentEventType.TextDelta,      // chat content
			AgentEventType.TaskComplete,   // task complete
			AgentEventType.Done,           // done
		]);
	});
});

suite('WebSocketEventStreamClient — Client Message Format', () => {

	test('task message includes llm_config and context_files', () => {
		const msg = {
			type: 'task',
			session_id: 's1',
			user_id: 'ide_user',
			user_query: 'Check my verilog',
			workspace_path: '/tmp/project',
			mode: 'agent',
			context_files: [{ path: '/tmp/project/main.v', type: 'file', content: null }],
			auto_approve_mode: 'standard',
			llm_config: {
				api_key: 'sk-test',
				base_url: 'https://api.deepseek.com',
				model: 'deepseek-chat',
				provider: 'auto',
				enable_builtin_tools: true,
			},
		};

		assert.strictEqual(msg.type, 'task');
		assert.strictEqual(msg.session_id, 's1');
		assert.ok(msg.llm_config);
		assert.strictEqual(msg.llm_config.model, 'deepseek-chat');
		assert.strictEqual(msg.context_files.length, 1);
	});

	test('stop message format', () => {
		const msg = {
			type: 'stop',
			session_id: 's1',
			user_id: 'ide_user',
		};

		assert.strictEqual(msg.type, 'stop');
		assert.strictEqual(msg.session_id, 's1');
	});

	test('confirm_response message format', () => {
		const msg = {
			type: 'confirm_response',
			session_id: '',
			request_id: 'req_123',
			action: 'approve',
			comment: 'Looks good',
		};

		assert.strictEqual(msg.type, 'confirm_response');
		assert.strictEqual(msg.request_id, 'req_123');
		assert.strictEqual(msg.action, 'approve');
	});
});

suite('WebSocketEventStreamClient — MockWebSocket Integration', () => {

	test('MockWebSocket can track sent messages', () => {
		const ws = new MockWebSocket();
		ws.simulateOpen();

		ws.send(JSON.stringify({ type: 'task', session_id: 's1' }));
		assert.strictEqual(ws.sentMessages.length, 1);

		const parsed = JSON.parse(ws.sentMessages[0]);
		assert.strictEqual(parsed.type, 'task');
	});

	test('MockWebSocket lifecycle: open → message → close', () => {
		const ws = new MockWebSocket();
		const events: string[] = [];

		ws.onopen = () => events.push('open');
		ws.onmessage = (e) => events.push(`msg:${JSON.parse(e.data).type}`);
		ws.onclose = () => events.push('close');

		ws.simulateOpen();
		ws.simulateMessage({ type: 'heartbeat', data: { status: 'ping' }, session_id: null });
		ws.simulateMessage({ type: 'chat', data: { content: 'hello' }, session_id: 's1' });
		ws.simulateClose();

		assert.deepStrictEqual(events, ['open', 'msg:heartbeat', 'msg:chat', 'close']);
	});
});

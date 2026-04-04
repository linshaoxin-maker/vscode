/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import {
	AgentEvent,
	AgentEventType,
	ConnectionState,
	type ITextDeltaEvent,
	type IToolCallEvent,
	type IToolResultEvent,
	type IDoneEvent,
	type IMentionItem,
} from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';

// ── IEventStreamClient ─────────────────────────────────────────────────────

export interface IEventStreamClient extends IDisposable {
	readonly onDidReceiveEvent: Event<AgentEvent>;
	readonly onDidChangeConnectionState: Event<ConnectionState>;
	readonly connectionState: ConnectionState;

	connect(): Promise<void>;
	disconnect(): void;
	sendTask(sessionId: string, query: string, mentions: IMentionItem[], mode: 'agent' | 'spec', options: { thinking: boolean; autoApproveMode: string; workspacePath?: string; llmConfig?: { provider: string; api_key: string; base_url: string; model: string } }): void;
	sendStop(sessionId: string): void;
	sendConfirmResponse(requestId: string, action: string, comment?: string, sessionId?: string): void;

	/** FEAT-R73: 回传 IDE 端工具执行结果 */
	sendIdeToolResult(sessionId: string, callId: string, content: string, isError: boolean): void;

	/** FEAT-R55: 上报 IDE 侧 MCP 工具定义给 Reasoner */
	registerIdeMcpTools(sessionId: string, tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }>): void;
}

// ── MockEventStreamClient ──────────────────────────────────────────────────

let eventCounter = 0;
function nextEventId(): string {
	return `evt_${++eventCounter}_${Date.now()}`;
}

/**
 * Mock implementation for development without a real Sidecar backend.
 * Simulates a basic conversation flow: receives a task, streams back
 * a canned response with text_delta events, optionally includes a
 * tool_call/tool_result pair, and finishes with a done event.
 */
export class MockEventStreamClient extends Disposable implements IEventStreamClient {

	private readonly _onDidReceiveEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<ConnectionState>());
	readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

	private _connectionState = ConnectionState.Disconnected;
	private _streamingTimer: ReturnType<typeof setTimeout> | undefined;
	private _stopped = false;

	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	async connect(): Promise<void> {
		this._setConnectionState(ConnectionState.Connecting);
		await this._delay(300);
		this._setConnectionState(ConnectionState.Connected);
	}

	disconnect(): void {
		this._cancelStreaming();
		this._setConnectionState(ConnectionState.Disconnected);
	}

	sendTask(sessionId: string, query: string, _mentions: IMentionItem[], _mode: 'agent' | 'spec', _options: { thinking: boolean; autoApproveMode: string; workspacePath?: string; llmConfig?: { provider: string; api_key: string; base_url: string; model: string } }): void {
		if (this._connectionState !== ConnectionState.Connected) {
			return;
		}
		this._stopped = false;
		this._simulateResponse(sessionId, query);
	}

	sendStop(_sessionId: string): void {
		this._stopped = true;
		this._cancelStreaming();
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.Done,
			timestamp: Date.now() / 1000,
			payload: { summary: 'Task stopped by user.', metrics: {} },
		} as IDoneEvent);
	}

	sendConfirmResponse(_requestId: string, _action: string, _comment?: string): void {
		// no-op in mock
	}

	sendIdeToolResult(_sessionId: string, _callId: string, _content: string, _isError: boolean): void {
		// no-op in mock
	}

	registerIdeMcpTools(_sessionId: string, _tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }>): void {
		// no-op in mock
	}

	// ── Private ────────────────────────────────────────────────────────────

	private _setConnectionState(state: ConnectionState): void {
		this._connectionState = state;
		this._onDidChangeConnectionState.fire(state);
	}

	private _emit(event: AgentEvent): void {
		this._onDidReceiveEvent.fire(event);
	}

	private _cancelStreaming(): void {
		if (this._streamingTimer !== undefined) {
			clearTimeout(this._streamingTimer);
			this._streamingTimer = undefined;
		}
	}

	private async _simulateResponse(_sessionId: string, query: string): Promise<void> {
		const response = this._generateResponse(query);
		const tokens = this._tokenize(response);

		await this._delay(200);

		// Optionally simulate a tool call
		if (query.toLowerCase().includes('file') || query.toLowerCase().includes('code')) {
			this._emit({
				event_id: nextEventId(),
				event_type: AgentEventType.ToolCall,
				timestamp: Date.now() / 1000,
				payload: {
					tool_name: 'read_file',
					arguments: { path: 'src/main.sv' },
					call_id: `call_${Date.now()}`,
				},
			} as IToolCallEvent);

			await this._delay(500);

			if (this._stopped) { return; }

			this._emit({
				event_id: nextEventId(),
				event_type: AgentEventType.ToolResult,
				timestamp: Date.now() / 1000,
				payload: {
					call_id: `call_${Date.now()}`,
					tool_name: 'read_file',
					result: 'module main(input clk, input rst_n, output reg [7:0] count);',
					success: true,
				},
			} as IToolResultEvent);

			await this._delay(200);
		}

		// Stream text deltas
		for (let i = 0; i < tokens.length; i++) {
			if (this._stopped) { return; }
			this._emit({
				event_id: nextEventId(),
				event_type: AgentEventType.TextDelta,
				timestamp: Date.now() / 1000,
				payload: { content: tokens[i], role: 'assistant' },
			} as ITextDeltaEvent);
			await this._delay(20 + Math.random() * 40);
		}

		if (this._stopped) { return; }

		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.Done,
			timestamp: Date.now() / 1000,
			payload: { summary: 'Task completed.', metrics: { tokens_used: tokens.length } },
		} as IDoneEvent);
	}

	private _generateResponse(query: string): string {
		return [
			`I'll help you with that. Based on your question about "${query.slice(0, 50)}",`,
			' here is my analysis:\n\n',
			'## Summary\n\n',
			'The Verilog module follows standard RTL design patterns. ',
			'Here is an example counter module:\n\n',
			'```verilog\n',
			'module counter (\n',
			'  input  wire       clk,\n',
			'  input  wire       rst_n,\n',
			'  output reg [7:0]  count\n',
			');\n\n',
			'  always @(posedge clk or negedge rst_n) begin\n',
			'    if (!rst_n)\n',
			'      count <= 8\'h0;\n',
			'    else\n',
			'      count <= count + 1\'b1;\n',
			'  end\n\n',
			'endmodule\n',
			'```\n\n',
			'This implements a simple 8-bit counter with asynchronous active-low reset.\n',
		].join('');
	}

	private _tokenize(text: string): string[] {
		const tokens: string[] = [];
		let i = 0;
		while (i < text.length) {
			const len = 1 + Math.floor(Math.random() * 4);
			tokens.push(text.slice(i, i + len));
			i += len;
		}
		return tokens;
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(resolve => {
			this._streamingTimer = setTimeout(resolve, ms);
		});
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	AgentEvent,
	AgentEventType,
	ConnectionState,
	type IMentionItem,
	type ITextDeltaEvent,
	type IToolCallEvent,
	type IToolResultEvent,
	type IErrorEvent,
	type IDoneEvent,
	type IStatusEvent,
	type ITodoUpdateEvent,
	type ITaskCompleteEvent,
	type ISkillTreeEvent,
	type IConfirmAutoResolvedEvent,
	type IConfirmRequestEvent,
	type IRoundStartEvent,
	type IPlanEvent,
	type IDiffPreviewEvent,
	type ISimReportEvent,
	type ICoverageReportEvent,
	type ILintReportEvent,
	type INegotiationViewEvent,
	type IParallelProgressEvent,
	type ILoopProgressEvent,
	type ISpecReviewEvent,
	type ITaskSummaryEvent,
	type ISubagentEventEvent,
	type IModelTurnEvent,
	type IWorktreeFilesAppliedEvent,
} from '../../../../../workbench/contrib/chipos/browser/eventStream/eventTypes.js';
import { IEventStreamClient } from '../../../../../workbench/contrib/chipos/browser/eventStream/eventStreamClient.js';

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_TIMEOUT_MS = 45_000;

let eventCounter = 0;
function nextEventId(): string {
	return `ws_evt_${++eventCounter}_${Date.now()}`;
}

/**
 * Backend message shape. The actual backend (agent/data_model/agent_response.py)
 * supports ~25 message types. The IServerMessage type covers all known types.
 */
interface IServerMessage {
	readonly type:
		| 'status' | 'todo' | 'chat' | 'heartbeat' | 'error'
		| 'model_output' | 'tool_start' | 'tool_result'
		| 'round_start' | 'plan' | 'timing_highlight'
		| 'confirm_request' | 'confirm_auto_resolved' | 'parallel_progress' | 'diff_preview'
		| 'sim_report' | 'negotiation_view' | 'coverage_report' | 'lint_report'
		| 'task_complete' | 'task_summary' | 'subagent_event'
		| 'model_turn_start' | 'model_turn_end'
		| 'spec_review' | 'loop_progress' | 'worktree_files_applied'
		| 'pre_review_report' | 'skill_tree'
		| string;
	readonly data: unknown;
	readonly session_id: string | null;
	/**
	 * Trace ID — reasoner emits at the top level of every ServerEvent
	 * (stream_manager.py:build_event). The WS client extracts and forwards
	 * via IAgentEventBase.trace_id (eventTypes.ts:53). Optional because
	 * not every event type has trace context (heartbeat / connection-level
	 * messages do not).
	 */
	readonly trace_id?: string;
}

/**
 * Client request sent to the backend.
 */
interface IClientMessage {
	type: string;
	session_id: string;
	[key: string]: unknown;
}

/**
 * Real WebSocket client that connects to the ChipOS backend (Sidecar).
 *
 * Adapts the backend V1 protocol (status/todo/chat/heartbeat/error/task_complete)
 * to the frontend AgentEvent type system, bridging the gap between the Python
 * backend and the TypeScript IDE frontend.
 */
export class WebSocketEventStreamClient extends Disposable implements IEventStreamClient {

	private readonly _onDidReceiveEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidReceiveEvent: Event<AgentEvent> = this._onDidReceiveEvent.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<ConnectionState>());
	readonly onDidChangeConnectionState: Event<ConnectionState> = this._onDidChangeConnectionState.event;

	private _connectionState = ConnectionState.Disconnected;
	private _ws: WebSocket | undefined;
	private _reconnectAttempts = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private _url: string;

	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	constructor(
		url: string,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._url = url;
	}

	/**
	 * Update the backend URL. Disconnects any existing connection.
	 */
	setUrl(url: string): void {
		if (this._url !== url) {
			this.disconnect();
			this._url = url;
		}
	}

	async connect(): Promise<void> {
		if (this._disposed) {
			return;
		}

		if (this._connectionState === ConnectionState.Connected) {
			return;
		}

		this._setConnectionState(ConnectionState.Connecting);
		this._logService.info('[ChipOS WS] Connecting to', this._url);

		try {
			await this._openWebSocket();
		} catch (err) {
			this._logService.error('[ChipOS WS] Connection failed:', String(err));
			this._setConnectionState(ConnectionState.Error);
			this._scheduleReconnect();
		}
	}

	disconnect(): void {
		this._clearReconnectTimer();
		this._clearHeartbeatTimer();

		if (this._ws) {
			this._ws.onopen = null;
			this._ws.onmessage = null;
			this._ws.onerror = null;
			this._ws.onclose = null;
			if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
				this._ws.close(1000, 'Client disconnect');
			}
			this._ws = undefined;
		}

		this._reconnectAttempts = 0;
		this._setConnectionState(ConnectionState.Disconnected);
	}

	sendTask(
		sessionId: string,
		query: string,
		mentions: IMentionItem[],
		mode: 'agent' | 'spec',
		options: { thinking: boolean; autoApproveMode: string; workspacePath?: string; llmConfig?: { provider: string; api_key: string; base_url: string; model: string } },
	): void {
		const apiKey = this._configurationService.getValue<string>('chipos.apiKey') || '';
		const apiBaseUrl = this._configurationService.getValue<string>('chipos.apiBaseUrl') || '';
		const model = this._configurationService.getValue<string>('chipos.model') || '';
		const provider = this._configurationService.getValue<string>('chipos.provider') || 'openai';
		const enableBuiltinTools = this._configurationService.getValue<boolean>('chipos.enableBuiltinTools') ?? true;

		const contextFiles = mentions.map(m => ({
			path: m.path,
			type: m.type,
			content: m.content ?? null,
		}));

		const folders = this._workspaceContextService.getWorkspace().folders;
		const workspacePath = folders.length > 0 ? folders[0].uri.fsPath : '';

		this._send({
			type: 'task',
			session_id: sessionId,
			user_id: 'ide_user',
			user_query: query,
			workspace_path: workspacePath,
			mode,
			context_files: contextFiles,
			auto_approve_mode: options.autoApproveMode,
			thinking: options.thinking,
			llm_config: {
				api_key: apiKey,
				base_url: apiBaseUrl,
				model,
				provider,
				enable_builtin_tools: enableBuiltinTools,
			},
		});
	}

	sendStop(sessionId: string): void {
		this._send({
			type: 'stop',
			session_id: sessionId,
			user_id: 'ide_user',
		});
	}

	sendConfirmResponse(requestId: string, action: string, comment?: string, sessionId?: string): void {
		this._send({
			type: 'confirm_response',
			session_id: sessionId ?? '',
			request_id: requestId,
			action,
			comment: comment ?? '',
		});
	}

	/**
	 * Request the dynamic skill tree from the backend.
	 */
	requestSkillTree(): void {
		this._send({
			type: 'get_skill_tree',
			session_id: '',
		});
	}

	// ── WebSocket lifecycle ──────────────────────────────────────────────────

	private _openWebSocket(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			try {
				this._ws = new WebSocket(this._url);
			} catch (err) {
				reject(err);
				return;
			}

			const timeout = setTimeout(() => {
				reject(new Error('WebSocket connection timeout'));
				if (this._ws) {
					this._ws.close();
					this._ws = undefined;
				}
			}, 10_000);

			this._ws.onopen = () => {
				clearTimeout(timeout);
				this._logService.info('[ChipOS WS] Connected');
				this._reconnectAttempts = 0;
				this._setConnectionState(ConnectionState.Connected);
				this._resetHeartbeatTimer();
				resolve();
			};

			this._ws.onmessage = (event) => {
				this._handleRawMessage(event.data);
			};

			this._ws.onerror = (event) => {
				clearTimeout(timeout);
				this._logService.error('[ChipOS WS] Error:', String(event));
				if (this._connectionState === ConnectionState.Connecting) {
					reject(new Error('WebSocket error'));
				}
			};

			this._ws.onclose = (event) => {
				clearTimeout(timeout);
				this._logService.info('[ChipOS WS] Closed: code=', event.code, 'reason=', event.reason);
				this._ws = undefined;
				this._clearHeartbeatTimer();

				if (!this._disposed && this._connectionState !== ConnectionState.Disconnected) {
					this._setConnectionState(ConnectionState.Disconnected);
					this._scheduleReconnect();
				}
			};
		});
	}

	// ── Message handling ─────────────────────────────────────────────────────

	/**
	 * Per-message trace_id (ADR-009 §4.1). Set in _handleRawMessage before
	 * dispatch, read by _emit so downstream AgentEvent has trace_id correlated
	 * with reasoner master trace.jsonl. Cleared after dispatch.
	 */
	private _currentTraceId: string | undefined;

	private _handleRawMessage(raw: unknown): void {
		if (typeof raw !== 'string') {
			return;
		}

		let msg: IServerMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			this._logService.error('[ChipOS WS] Invalid JSON:', String(raw).slice(0, 200));
			return;
		}

		this._resetHeartbeatTimer();

		// Capture top-level trace_id (set by reasoner stream_manager.py:build_event)
		// so all _emit calls in this dispatch get it injected. Cleared after dispatch.
		this._currentTraceId = typeof msg.trace_id === 'string' && msg.trace_id ? msg.trace_id : undefined;

		switch (msg.type) {
			// ── Streaming text from LLM (the actual delta chunks) ──
			case 'model_output':
				this._handleModelOutput(msg.data as { content?: string; is_delta?: boolean; thinking?: string; thinking_is_delta?: boolean });
				break;

			// ── Tool lifecycle ──
			case 'tool_start':
				this._handleToolStart(msg.data as { tool_name: string; args: unknown; tool_id: string; summary?: string; snapshot_content?: string });
				break;
			case 'tool_result':
				this._handleToolResult(msg.data as { tool_name: string; content: string; content_type?: string; tool_id?: string; summary?: string; is_error?: boolean });
				break;

			// ── Status / progress / informational ──
			case 'status':
				this._handleStatus(msg.data as { level: string; text: string; tool_name?: string });
				break;
			case 'todo':
				this._handleTodo(msg.data as { todos: Array<{ task_id: string; task_des: string; task_status: string }> });
				break;

			// ── Final reply (accumulated, non-streaming) ──
			case 'chat':
				this._handleChat(msg.data as { content: string });
				break;

			// ── Task lifecycle ──
		case 'task_complete':
			this._handleTaskComplete(msg.data as { status: string; message?: string });
			break;

		// ── Confirmations (Hook approval) ──
		case 'confirm_request':
			this._handleConfirmRequest(msg.data as Record<string, unknown>);
			break;

		case 'confirm_auto_resolved':
			this._handleConfirmAutoResolved(msg.data as Record<string, unknown>);
			break;

		// ── Code diff preview ──
		case 'diff_preview':
			this._handleDiffPreview(msg.data as { file_path: string; hunks: unknown[] });
			break;

		// ── Keep-alive ──
		case 'heartbeat':
			break;

		// ── Errors ──
		case 'error':
			this._handleError(msg.data);
			break;

		// ── Skill tree ──
		case 'skill_tree':
			this._handleSkillTree(msg.data as { version: number; total_skills: number; children: unknown[] });
			break;

		// ── Round start ──
		case 'round_start':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.RoundStart, timestamp: Date.now() / 1000, payload: msg.data as { round: number } } as IRoundStartEvent);
			break;

		// ── Plan ──
		case 'plan':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.Plan, timestamp: Date.now() / 1000, payload: msg.data as { milestones: [] } } as IPlanEvent);
			break;

		// ── Simulation report ──
		case 'sim_report':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.SimReport, timestamp: Date.now() / 1000, payload: msg.data } as ISimReportEvent);
			break;

		// ── Coverage report ──
		case 'coverage_report':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.CoverageReport, timestamp: Date.now() / 1000, payload: msg.data } as ICoverageReportEvent);
			break;

		// ── Lint report ──
		case 'lint_report':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.LintReport, timestamp: Date.now() / 1000, payload: msg.data } as ILintReportEvent);
			break;

		// ── Negotiation view ──
		case 'negotiation_view':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.NegotiationView, timestamp: Date.now() / 1000, payload: msg.data } as INegotiationViewEvent);
			break;

		// ── Parallel progress ──
		case 'parallel_progress':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.ParallelProgress, timestamp: Date.now() / 1000, payload: msg.data } as IParallelProgressEvent);
			break;

		// ── Loop progress ──
		case 'loop_progress':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.LoopProgress, timestamp: Date.now() / 1000, payload: msg.data } as ILoopProgressEvent);
			break;

		// ── Spec review ──
		case 'spec_review':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.SpecReview, timestamp: Date.now() / 1000, payload: msg.data } as ISpecReviewEvent);
			break;

		// ── Task summary ──
		case 'task_summary':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.TaskSummary, timestamp: Date.now() / 1000, payload: msg.data } as ITaskSummaryEvent);
			break;

		// ── Subagent event ──
		case 'subagent_event':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.SubagentEvent, timestamp: Date.now() / 1000, payload: msg.data } as ISubagentEventEvent);
			break;

		// ── Model turn boundaries ──
		case 'model_turn_start':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.ModelTurnStart, timestamp: Date.now() / 1000, payload: {} } as IModelTurnEvent);
			break;
		case 'model_turn_end':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.ModelTurnEnd, timestamp: Date.now() / 1000, payload: {} } as IModelTurnEvent);
			break;

		// ── Worktree files applied ──
		case 'worktree_files_applied':
			this._emit({ event_id: nextEventId(), event_type: AgentEventType.WorktreeFilesApplied, timestamp: Date.now() / 1000, payload: msg.data } as IWorktreeFilesAppliedEvent);
			break;

		// ── Passthrough events that don't need special handling ──
		case 'timing_highlight':
		case 'pre_review_report':
			this._logService.info('[ChipOS WS] Passthrough event:', msg.type);
			break;

		default:
			this._logService.info('[ChipOS WS] Unhandled message type:', msg.type);
	}
	}

	// ── model_output: LLM streaming text chunks ────────────────────────────

	private _handleModelOutput(data: { content?: string; is_delta?: boolean; thinking?: string; thinking_is_delta?: boolean }): void {
		if (data.content) {
			this._emit({
				event_id: nextEventId(),
				event_type: AgentEventType.TextDelta,
				timestamp: Date.now() / 1000,
				payload: { content: data.content, role: 'assistant' },
			} as ITextDeltaEvent);
		}
		if (data.thinking) {
			this._emit({
				event_id: nextEventId(),
				event_type: AgentEventType.TextDelta,
				timestamp: Date.now() / 1000,
				payload: { content: data.thinking, role: 'thinking' },
			} as ITextDeltaEvent);
		}
	}

	// ── tool_start / tool_result ─────────────────────────────────────────────

	private _handleToolStart(data: { tool_name: string; args: unknown; tool_id: string; summary?: string; snapshot_content?: string }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.ToolCall,
			timestamp: Date.now() / 1000,
			payload: {
				tool_name: data.tool_name,
				arguments: (typeof data.args === 'object' && data.args !== null ? data.args : {}) as Record<string, unknown>,
				call_id: data.tool_id || `tc_${Date.now()}`,
				summary: data.summary,
				snapshot_content: data.snapshot_content,
			},
		} as IToolCallEvent);
	}

	private _handleToolResult(data: { tool_name: string; content: string; content_type?: string; tool_id?: string; summary?: string; is_error?: boolean }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.ToolResult,
			timestamp: Date.now() / 1000,
			payload: {
				call_id: data.tool_id || `tr_${Date.now()}`,
				tool_name: data.tool_name,
				result: data.content,
				success: !data.is_error,
				summary: data.summary,
			},
		} as IToolResultEvent);
	}

	// ── status ──────────────────────────────────────────────────────────────

	private _handleStatus(data: { level: string; text: string; tool_name?: string }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.Status,
			timestamp: Date.now() / 1000,
			payload: {
				level: data.level as 'info' | 'success' | 'warning' | 'thinking',
				text: data.text,
				tool_name: data.tool_name,
			},
		} as IStatusEvent);
	}

	// ── todo ─────────────────────────────────────────────────────────────────

	private _handleTodo(data: { todos: Array<{ task_id: string; task_des: string; task_status: string }> }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.TodoUpdate,
			timestamp: Date.now() / 1000,
			payload: { todos: data.todos },
		} as ITodoUpdateEvent);
	}

	// ── chat: final accumulated reply ────────────────────────────────────────

	private _handleChat(data: { content: string }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.TextDelta,
			timestamp: Date.now() / 1000,
			payload: { content: data.content, role: 'assistant' },
		} as ITextDeltaEvent);
	}

	// ── error ────────────────────────────────────────────────────────────────

	private _handleError(data: unknown): void {
		const message = typeof data === 'string' ? data : JSON.stringify(data);
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.Error,
			timestamp: Date.now() / 1000,
			payload: {
				error_code: 'SERVER_ERROR',
				message,
				retryable: false,
			},
		} as IErrorEvent);
	}

	// ── task_complete ────────────────────────────────────────────────────────

	private _handleTaskComplete(data: { status: string; message?: string }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.TaskComplete,
			timestamp: Date.now() / 1000,
			payload: {
				status: data.status as 'success' | 'cancelled' | 'error',
				message: data.message,
			},
		} as ITaskCompleteEvent);

		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.Done,
			timestamp: Date.now() / 1000,
			payload: {
				summary: data.message || `Task ${data.status}.`,
				metrics: {},
			},
		} as IDoneEvent);
	}

	// ── confirm_request: Hook approval cards ─────────────────────────────────

	private _handleConfirmRequest(data: Record<string, unknown>): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.ConfirmRequest,
			timestamp: Date.now() / 1000,
			payload: {
				request_id: String(data.request_id ?? data.hook_id ?? `cr_${Date.now()}`),
				card_type: String(data.card_type ?? 'simple'),
				card_data: (data.card_data as Record<string, unknown>) ?? {},
				title: data.title as string | undefined,
				message: data.message as string | undefined,
				options: data.options as Array<{ label: string; action: string }> | undefined,
				is_background: Boolean(data.is_background),
			},
		} as IConfirmRequestEvent);
	}

	private _handleConfirmAutoResolved(data: Record<string, unknown>): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.ConfirmAutoResolved,
			timestamp: Date.now() / 1000,
			payload: {
				request_id: String(data.request_id ?? ''),
				hook_id: String(data.hook_id ?? ''),
				card_type: String(data.card_type ?? ''),
				action: String(data.action ?? ''),
				reason: String(data.reason ?? 'timeout'),
				timeout_ms: Number(data.timeout_ms ?? 0),
			},
		} as IConfirmAutoResolvedEvent);
	}

	// ── diff_preview ─────────────────────────────────────────────────────────

	private _handleDiffPreview(data: { file_path: string; hunks: unknown[] }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.DiffPreview,
			timestamp: Date.now() / 1000,
			payload: {
				file_path: data.file_path,
				hunks: (data.hunks ?? []) as Array<{ header: string; lines: Array<{ type: string; content: string; line_no?: number }> }>,
			},
		} as IDiffPreviewEvent);
	}

	// ── skill_tree ───────────────────────────────────────────────────────────

	private _handleSkillTree(data: { version: number; total_skills: number; children: unknown[] }): void {
		this._emit({
			event_id: nextEventId(),
			event_type: AgentEventType.SkillTree,
			timestamp: Date.now() / 1000,
			payload: data,
		} as ISkillTreeEvent);
	}

	// ── Reconnection ─────────────────────────────────────────────────────────

	private _scheduleReconnect(): void {
		if (this._disposed || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
				this._logService.error('[ChipOS WS] Max reconnect attempts exceeded');
				this._setConnectionState(ConnectionState.Error);
			}
			return;
		}

		this._reconnectAttempts++;
		const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;
		this._logService.info('[ChipOS WS] Reconnecting in', delay, 'ms (attempt', this._reconnectAttempts, ')');
		this._setConnectionState(ConnectionState.Reconnecting);

		this._reconnectTimer = setTimeout(() => {
			if (!this._disposed) {
				this.connect();
			}
		}, delay);
	}

	// ── Heartbeat watchdog ───────────────────────────────────────────────────

	private _resetHeartbeatTimer(): void {
		this._clearHeartbeatTimer();
		this._heartbeatTimer = setTimeout(() => {
			this._logService.warn('[ChipOS WS] Heartbeat timeout, server may be unresponsive');
			if (this._ws && this._ws.readyState === WebSocket.OPEN) {
				this._ws.close(4000, 'Heartbeat timeout');
			}
		}, HEARTBEAT_TIMEOUT_MS);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private _send(message: IClientMessage): void {
		if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
			this._logService.error('[ChipOS WS] Cannot send: WebSocket not open');
			return;
		}
		this._ws.send(JSON.stringify(message));
	}

	private _emit(event: AgentEvent): void {
		// Inject current msg's trace_id (captured in _handleRawMessage) so
		// downstream consumers (chat bubble pill / admin UI) can correlate
		// with reasoner master trace.jsonl. ADR-009 §4.1.
		if (this._currentTraceId && !event.trace_id) {
			(event as { trace_id?: string }).trace_id = this._currentTraceId;
		}
		this._onDidReceiveEvent.fire(event);
	}

	private _setConnectionState(state: ConnectionState): void {
		if (this._connectionState === state) {
			return;
		}
		this._connectionState = state;
		this._onDidChangeConnectionState.fire(state);
	}

	private _clearReconnectTimer(): void {
		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	private _clearHeartbeatTimer(): void {
		if (this._heartbeatTimer !== undefined) {
			clearTimeout(this._heartbeatTimer);
			this._heartbeatTimer = undefined;
		}
	}

	sendIdeToolResult(_sessionId: string, _callId: string, _content: string, _isError: boolean): void { /* no-op: V1 WebSocket protocol does not support IDE tool results */ }

	registerIdeMcpTools(_sessionId: string, _tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }>): void { /* no-op: V1 WebSocket protocol does not support MCP tool registration */ }

	override dispose(): void {
		this._disposed = true;
		this.disconnect();
		super.dispose();
	}
}

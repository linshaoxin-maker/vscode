/*---------------------------------------------------------------------------------------------
 *  FEAT-T08: HTTP/2 SSE Event Stream Client (v2)
 *
 *  替换 webSocketEventStreamClient.ts，使用 HTTP/2 SSE 接收推理层推送，
 *  HTTP/2 POST 发送任务/停止/确认。
 *
 *  实现 IEventStreamClient 接口，可作为 WebSocketEventStreamClient 的替代。
 *
 *  通信协议（REQ-A03 / REQ-A04）：
 *  - UI -> 推理层: HTTP/2 POST (SendTask / StopTask / SendConfirmResponse)
 *  - 推理层 -> UI: HTTP/2 SSE (EventStream)
 *---------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import {
	AgentEvent,
	AgentEventType,
	ConnectionState,
	type IMentionItem,
} from './eventTypes.js';
import type { IEventStreamClient } from './eventStreamClient.js';

/**
 * SSE + HTTP/2 配置
 */
export interface ISseClientConfig {
	/** 推理层 HTTP/2 基础 URL (e.g. http://localhost:8080) */
	baseUrl: string;
	/** JWT Token（remote 模式必填） */
	token?: string;
	/** 重连间隔基数 (ms)，默认 1000 */
	reconnectBaseMs?: number;
	/** 最大重连间隔 (ms)，默认 30000 */
	reconnectMaxMs?: number;
	/** 最大重连次数，默认 10 */
	maxReconnectAttempts?: number;
}

/**
 * SSE 事件类型 → AgentEventType 映射表
 *
 * 对齐 Proto ServerEvent 的 32 种 oneof payload。
 * SSE data 字段中的 JSON 对象的 "type" 字段值 → AgentEventType 枚举。
 */
const SSE_TYPE_MAP: Record<string, AgentEventType> = {
	'text_delta': AgentEventType.TextDelta,
	'thinking_delta': AgentEventType.ThinkingDelta,
	'model_turn_start': AgentEventType.ModelTurnStart,
	'model_turn_end': AgentEventType.ModelTurnEnd,
	'tool_call': AgentEventType.ToolCall,
	'tool_result': AgentEventType.ToolResult,
	'file_edit': AgentEventType.FileEdit,
	'confirm_request': AgentEventType.ConfirmRequest,
	'confirm': AgentEventType.Confirm,
	'status': AgentEventType.Status,
	'round_start': AgentEventType.RoundStart,
	'todo': AgentEventType.TodoUpdate,
	'plan': AgentEventType.Plan,
	'diff_preview': AgentEventType.DiffPreview,
	'task_complete': AgentEventType.TaskComplete,
	'skill_tree': AgentEventType.SkillTree,
	'sim_report': AgentEventType.SimReport,
	'coverage_report': AgentEventType.CoverageReport,
	'lint_report': AgentEventType.LintReport,
	'negotiation_view': AgentEventType.NegotiationView,
	'parallel_progress': AgentEventType.ParallelProgress,
	'loop_progress': AgentEventType.LoopProgress,
	'spec_review': AgentEventType.SpecReview,
	'task_summary': AgentEventType.TaskSummary,
	'subagent_event': AgentEventType.SubagentEvent,
	'worktree_files_applied': AgentEventType.WorktreeFilesApplied,
	'usage': AgentEventType.Usage,
	'heartbeat': AgentEventType.Heartbeat,
	'error': AgentEventType.Error,
	'done': AgentEventType.Done,
	'queue_update': AgentEventType.QueueUpdate,
	'context_warning': AgentEventType.ContextWarning,
	'timing_highlight': AgentEventType.TimingHighlight,
	'pre_review_report': AgentEventType.PreReviewReport,
};

/**
 * HTTP/2 SSE 事件流客户端
 *
 * 实现 IEventStreamClient 接口，可直接替换 WebSocketEventStreamClient。
 */
export class SseEventStreamClient extends Disposable implements IEventStreamClient {

	private _eventSource: EventSource | null = null;
	private _sessionId: string = '';
	private _streamToken: string = '';
	private _lastSequenceId: number = 0;
	private _reconnectAttempts: number = 0;
	private _sessionDone: boolean = false;
	private _state: ConnectionState = ConnectionState.Disconnected;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _seenEventIds = new Set<string>();

	private readonly _onDidReceiveEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<ConnectionState>());
	readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

	constructor(private readonly _config: ISseClientConfig) {
		super();
	}

	get connectionState(): ConnectionState {
		return this._state;
	}

	// ── IEventStreamClient: connect ─────────────────────────────────────────

	async connect(): Promise<void> {
		if (this._state === ConnectionState.Connected) {
			return;
		}
		if (this._state === ConnectionState.Connecting) {
			return new Promise<void>((resolve, reject) => {
				const d = this._onDidChangeConnectionState.event(state => {
					d.dispose();
					if (state === ConnectionState.Connected) {
						resolve();
					} else {
						reject(new Error(`Connection failed (state=${state})`));
					}
				});
			});
		}
		this._setState(ConnectionState.Connecting);

		// Only verify the backend is reachable (health check).
		// The actual EventSource is deferred until sendTask() provides a sessionId,
		// avoiding the SESSION_NOT_FOUND → reconnect loop that causes event loss.
		try {
			const healthUrl = `${this._config.baseUrl}/health`;
			console.log('[SseClient] connect() health check:', healthUrl);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const resp = await fetch(healthUrl, { signal: controller.signal });
			clearTimeout(timer);
			if (!resp.ok) {
				throw new Error(`Health check returned ${resp.status}`);
			}
			console.log('[SseClient] Backend reachable, EventSource deferred until sendTask');
			this._setState(ConnectionState.Connected);
		} catch (err) {
			console.error('[SseClient] connect() health check failed:', String(err));
			this._setState(ConnectionState.Error);
			throw new Error(`Cannot reach backend at ${this._config.baseUrl}: ${String(err)}`);
		}
	}

	// ── IEventStreamClient: disconnect ──────────────────────────────────────

	disconnect(): void {
		this._closeEventSource();
		this._clearReconnectTimer();
		this._reconnectAttempts = 0;
		this._streamToken = '';
		this._sessionId = '';
		this._seenEventIds.clear();
		this._setState(ConnectionState.Disconnected);
	}

	// ── IEventStreamClient: sendTask ────────────────────────────────────────

	sendTask(
		sessionId: string,
		query: string,
		mentions: IMentionItem[],
		mode: 'agent' | 'spec',
		options: { thinking: boolean; autoApproveMode: string; llmConfig?: { provider: string; api_key: string; base_url: string; model: string } },
	): void {
		// Clean up previous session state to prevent stale reconnect timers
		// from racing with the new POST + EventSource.
		this._clearReconnectTimer();
		this._closeEventSource();
		this._reconnectAttempts = 0;
		this._sessionDone = false;
		this._lastSequenceId = 0;
		this._seenEventIds.clear();
		this._sessionId = sessionId;

		// Send POST first so the backend creates the session before the
		// EventSource connects — avoids SESSION_NOT_FOUND → reconnect loop.
		this._post('/api/v1/task', {
			session_id: sessionId,
			prompt: query,
			mode,
			context_files: mentions.map(m => ({
				path: m.path,
				content: m.content ?? '',
			})),
			thinking: options.thinking,
			auto_approve_mode: options.autoApproveMode,
			...(options.llmConfig ? { llm_config: options.llmConfig } : {}),
		}).then(async resp => {
			try {
				const data = await resp.json();
				if (data.stream_token) {
					this._streamToken = data.stream_token;
				}
			} catch { /* response may not have JSON body */ }
			// Open EventSource AFTER the POST succeeds (session now exists on server).
			this._openEventSource();
		}).catch(err => {
			console.error('[SseClient] sendTask failed:', err);
			this._emitError(`sendTask failed: ${err}`, 'TASK_SUBMIT_FAILED', 'SESSION', false);
		});
	}

	// ── IEventStreamClient: sendStop ────────────────────────────────────────

	sendStop(sessionId: string): void {
		this._post('/api/v1/stop', { session_id: sessionId }).catch(err => {
			console.error('[SseClient] sendStop failed:', err);
			this._emitError(`sendStop failed: ${err}`, 'STOP_FAILED', 'SESSION', true);
		});
	}

	// ── IEventStreamClient: sendConfirmResponse ─────────────────────────────

	sendConfirmResponse(requestId: string, action: string, comment?: string, sessionId?: string): void {
		this._post('/api/v1/confirm', {
			session_id: sessionId ?? this._sessionId,
			request_id: requestId,
			action,
			comment: comment ?? '',
		}).catch(err => {
			console.error('[SseClient] sendConfirmResponse failed:', err);
			this._emitError(`Confirm response failed: ${err}`, 'CONFIRM_FAILED', 'SESSION', false);
		});
	}

	// ── SSE 连接管理 ────────────────────────────────────────────────────────

	private _reopenEventSourceWithToken(): void {
		if (this._state === ConnectionState.Connected || this._state === ConnectionState.Connecting) {
			this._openEventSource();
		}
	}

	private async _openEventSource(): Promise<void> {
		this._closeEventSource();

		if (!this._sessionId) {
			console.log('[SseClient] Skipping EventSource open: no session_id yet');
			return;
		}

		const params = new URLSearchParams();
		params.set('session_id', this._sessionId);
		if (this._lastSequenceId > 0) {
			params.set('last_sequence_id', String(this._lastSequenceId));
		}
		if (this._streamToken) {
			params.set('stream_token', this._streamToken);
		}

		const url = `${this._config.baseUrl}/api/v1/events?${params.toString()}`;
		console.log('[SseClient] Opening EventSource:', url);

		this._eventSource = new EventSource(url);

		this._eventSource.onopen = () => {
			console.log('[SseClient] EventSource connected');
			this._reconnectAttempts = 0;
			this._setState(ConnectionState.Connected);
		};

		this._eventSource.onmessage = (ev: MessageEvent) => {
			try {
				this._dispatchEvent(JSON.parse(ev.data));
			} catch (e) {
				console.error('[SseClient] Failed to parse SSE event:', e);
			}
		};

		this._eventSource.onerror = (ev: Event) => {
			const es = this._eventSource;
			const readyState = es ? es.readyState : -1;
			console.error('[SseClient] EventSource error, readyState:', readyState, '(0=CONNECTING, 1=OPEN, 2=CLOSED)', ev);
			if (this._sessionDone) {
				console.log('[SseClient] Session done — not reconnecting');
				this._closeEventSource();
				return;
			}
			if (readyState === 2 && this._streamToken) {
				console.warn('[SseClient] Connection closed with stream_token present — clearing stale token for next attempt');
				this._streamToken = '';
			}
			this._closeEventSource();
			this._scheduleReconnect();
		};
	}

	private _closeEventSource(): void {
		if (this._eventSource) {
			this._eventSource.close();
			this._eventSource = null;
		}
	}

	// ── 事件分发 ────────────────────────────────────────────────────────────

	private _dispatchEvent(raw: Record<string, unknown>): void {
		const type = raw['type'] as string | undefined;
		if (!type) {
			return;
		}

		// 更新 sequence_id（断线续传用）
		const seqId = raw['sequence_id'] as string | undefined;
		if (seqId) {
			const parts = seqId.split('-');
			const num = parseInt(parts[parts.length - 1], 10);
			if (!isNaN(num) && num > this._lastSequenceId) {
				this._lastSequenceId = num;
			}
		}

		// 去重：跳过已分发的事件（SSE 重连 replay 场景）
		const eventId = (raw['event_id'] as string) ?? seqId ?? '';
		if (eventId && this._seenEventIds.has(eventId)) {
			return;
		}
		if (eventId) {
			this._seenEventIds.add(eventId);
			if (this._seenEventIds.size > 2000) {
				let dropped = 0;
				for (const old of this._seenEventIds) {
					if (dropped >= 500) { break; }
					this._seenEventIds.delete(old);
					dropped++;
				}
			}
		}

		const eventType = SSE_TYPE_MAP[type];
		if (eventType === undefined) {
			console.warn('[SseClient] Unknown event type:', type);
			return;
		}

		const payload = raw['data'] && typeof raw['data'] === 'object'
			? raw['data'] as Record<string, unknown>
			: (() => {
				const { type: _t, event_id: _e, session_id: _s, sequence_id: _sq, timestamp_ms: _ts, ...rest } = raw;
				return rest;
			})();

		this._onDidReceiveEvent.fire({
			event_type: eventType,
			event_id: eventId,
			session_id: (raw['session_id'] as string) ?? this._sessionId,
			timestamp: (raw['timestamp_ms'] as number) ?? Date.now(),
			payload,
		} as unknown as AgentEvent);

		if (type === 'done') {
			this._sessionDone = true;
			this._closeEventSource();
			this._clearReconnectTimer();
		}
	}

	// ── 重连 ────────────────────────────────────────────────────────────────

	private _scheduleReconnect(): void {
		const maxAttempts = this._config.maxReconnectAttempts ?? 10;
		if (this._reconnectAttempts >= maxAttempts) {
			this._setState(ConnectionState.Error);
			this._emitError('Max reconnect attempts reached');
			return;
		}

		this._setState(ConnectionState.Reconnecting);
		this._reconnectAttempts++;

		const baseMs = this._config.reconnectBaseMs ?? 1000;
		const maxMs = this._config.reconnectMaxMs ?? 30000;
		const delay = Math.min(baseMs * Math.pow(2, this._reconnectAttempts - 1), maxMs);

		this._reconnectTimer = setTimeout(() => {
			this._openEventSource();
		}, delay);
	}

	private _clearReconnectTimer(): void {
		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	// ── HTTP POST ───────────────────────────────────────────────────────────

	private async _post(path: string, body: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this._config.token) {
			headers['Authorization'] = `Bearer ${this._config.token}`;
		}

		const resp = await fetch(`${this._config.baseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
		}
		return resp;
	}

	// ── 辅助 ────────────────────────────────────────────────────────────────

	private _setState(state: ConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeConnectionState.fire(state);
		}
	}

	private _emitError(message: string, code: string = 'SSE_ERROR', category: string = 'TRANSPORT', retryable: boolean = true): void {
		this._onDidReceiveEvent.fire({
			event_type: AgentEventType.Error,
			event_id: `err_${Date.now()}`,
			session_id: this._sessionId,
			timestamp: Date.now(),
			payload: {
				error_code: code,
				message,
				retryable,
				category,
				details: {},
			},
		} as AgentEvent);
	}

	override dispose(): void {
		this.disconnect();
		super.dispose();
	}
}

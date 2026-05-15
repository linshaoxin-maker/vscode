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
import type { ILogService } from '../../../../../platform/log/common/log.js';
import {
	AgentEvent,
	AgentEventType,
	ConnectionState,
	type IMentionItem,
} from './eventTypes.js';
import type { IEventStreamClient } from './eventStreamClient.js';
import { CHIPOS_REASONER_VERSION } from '../../common/releaseConfig.js';

/**
 * Token provider interface for dynamic token resolution.
 * Phase 1 Unified Auth: replaces static token string.
 */
export interface ITokenProvider {
	getAccessToken(): Promise<string | undefined>;
	refreshAccessToken(): Promise<string | undefined>;
}

/**
 * SSE + HTTP/2 配置
 */
export interface ISseClientConfig {
	/** 推理层 HTTP/2 基础 URL (e.g. http://localhost:8080) */
	baseUrl: string;
	/** @deprecated Use tokenProvider instead. Static JWT Token（legacy fallback） */
	token?: string;
	/** Dynamic token provider (Phase 1 Unified Auth) */
	tokenProvider?: ITokenProvider;
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
	'ide_tool_call': AgentEventType.IdeToolCall,  // FEAT-R72
	'ppa_report': AgentEventType.PpaReport,  // wiring fix 2026-05-08:
	// reasoner ppa_optimize_loop emits "ppa_report" but wire-string map
	// missed this entry, so events were silently dropped at SSE parse.
	// AgentEventType.PpaReport + IPpaReportPayload were already defined
	// in eventTypes.ts; just needed this map line.
};

/**
 * HTTP/2 SSE 事件流客户端
 *
 * 实现 IEventStreamClient 接口，可直接替换 WebSocketEventStreamClient。
 */
export class SseEventStreamClient extends Disposable implements IEventStreamClient {

	private _sessionId: string = '';
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

	constructor(
		private readonly _config: ISseClientConfig,
		private readonly _logService?: ILogService,
	) {
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
			this._logService?.debug('[SseClient] connect() health check: %s', healthUrl);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const token = await this._resolveToken();
			const headers: Record<string, string> = {};
			if (token) {
				headers['Authorization'] = `Bearer ${token}`;
			}
			let resp = await fetch(healthUrl, { headers, signal: controller.signal });
			if (resp.status === 401 && this._config.tokenProvider) {
				const authCode = await this._readErrorCode(resp.clone());
				if (authCode === 'AUTH_TOKEN_EXPIRED') {
					const refreshed = await this._config.tokenProvider.refreshAccessToken();
					if (refreshed) {
						resp = await fetch(healthUrl, {
							headers: { Authorization: `Bearer ${refreshed}` },
							signal: controller.signal,
						});
					}
				}
			}
			clearTimeout(timer);
			if (!resp.ok) {
				if (resp.status === 401 || resp.status === 403) {
					const authCode = await this._readErrorCode(resp.clone());
					throw new Error(`Authentication failed (${authCode ?? resp.status}). Check your ChipOS auth settings in Connection.`);
				}
				throw new Error(`Health check returned ${resp.status}`);
			}
			// NEED-B03: version compatibility check
			try {
				const body = await resp.json() as { reasoner_version?: string };
				if (body.reasoner_version && body.reasoner_version !== CHIPOS_REASONER_VERSION) {
					this._logService?.warn(
						`[SseClient] Version mismatch: IDE expects reasoner ${CHIPOS_REASONER_VERSION}, got ${body.reasoner_version}. Some features may not work correctly.`
					);
					this._emitError(
						`Version mismatch: IDE expects Reasoner v${CHIPOS_REASONER_VERSION}, backend is v${body.reasoner_version}. Please update your backend.`,
						'VERSION_MISMATCH',
						'COMPAT',
						false,  // not retryable — user must update
					);
				}
			} catch { /* health body parse failure is non-fatal */ }
			this._logService?.info('[SseClient] Backend reachable, EventSource deferred until sendTask');
			this._setState(ConnectionState.Connected);
		} catch (err) {
			this._logService?.error('[SseClient] connect() health check failed: %s', String(err));
			this._setState(ConnectionState.Error);
			throw new Error(`Cannot reach backend at ${this._config.baseUrl}: ${String(err)}`);
		}
	}

	// ── IEventStreamClient: disconnect ──────────────────────────────────────

	disconnect(): void {
		this._closeEventSource();
		this._clearReconnectTimer();
		this._reconnectAttempts = 0;
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
		options: { thinking: boolean; autoApproveMode: string; workspacePath?: string; llmConfig?: { provider: string; api_key: string; base_url: string; model: string } },
	): void {
		// Clean up previous session state to prevent stale reconnect timers
		// from racing with the new POST + EventSource.
		this._clearReconnectTimer();
		this._closeEventSource();
		this._reconnectAttempts = 0;
		this._sessionDone = false;
		// When the chat thread reuses the same backend session across rounds
		// (chipOSChatAgent does this so reasoner Memory persists), DO NOT
		// reset _lastSequenceId. The reasoner's session retains an
		// _event_buffer of every emitted event; if we reconnect SSE with
		// last_sequence_id=0, the backend replays the previous round's
		// 'done' event, which makes us flip _sessionDone=true and close
		// the new round's stream before its real events arrive. The user
		// then sees no response, retries, and hits HTTP 409
		// SESSION_ALREADY_RUNNING because the backend task we never observed
		// is still in flight. Keep the cursor so resume picks up after the
		// last event we already processed. A fresh session id (new chat
		// thread) does require a reset.
		const sameSession = this._sessionId === sessionId;
		if (!sameSession) {
			this._lastSequenceId = 0;
			this._seenEventIds.clear();
		} else {
			// Same-session reuse: dedup cache can still safely be cleared
			// (event_ids are unique per emit, _lastSequenceId is the only
			// state the backend resume contract cares about).
			this._seenEventIds.clear();
		}
		this._sessionId = sessionId;

		// Send POST first so the backend creates the session before the
		// EventSource connects — avoids SESSION_NOT_FOUND → reconnect loop.
		this._post('/api/v1/task', {
			session_id: sessionId,
			prompt: query,
			mode,
			workspace_path: options.workspacePath || '',
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
				// Phase 1: stream_token removed. Session ID is the only needed response.
				if (data.session_id) {
					this._sessionId = data.session_id;
				}
			} catch (parseErr) {
				console.warn('[SseClient] Failed to parse sendTask response:', parseErr);
			}
			// Open SSE AFTER the POST succeeds (session now exists on server).
			this._openEventSource();
		}).catch(err => {
			this._logService?.error('[SseClient] sendTask failed: %s', err);
			const status = (err as any).httpStatus as number | undefined;
			if (status === 401 || status === 403) {
				// Auth failure — do NOT retry. The chat error UI (UX-AUTH-1)
				// detects AUTH_FAILED and renders an inline "Log In" button
				// instead of a Retry button, so the message text just needs
				// to convey "you need to authenticate" without prescribing
				// the wrong action ("check your API token" — irrelevant in
				// the OAuth path).
				this._emitError(
					`Not signed in or session expired (${status}).`,
					'AUTH_FAILED',
					'AUTH',
					false,  // not retryable
				);
				this._setState(ConnectionState.Error);
			} else {
				this._emitError(`sendTask failed: ${err}`, 'TASK_SUBMIT_FAILED', 'SESSION', false);
			}
		});
	}

	// ── IEventStreamClient: sendStop ────────────────────────────────────────

	sendStop(sessionId: string): void {
		this._post('/api/v1/stop', { session_id: sessionId }).catch(err => {
			this._logService?.error('[SseClient] sendStop failed: %s', err);
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
			this._logService?.error('[SseClient] sendConfirmResponse failed: %s', err);
			this._emitError(`Confirm response failed: ${err}`, 'CONFIRM_FAILED', 'SESSION', false);
		});
	}

	// ── FEAT-R73: sendIdeToolResult ─────────────────────────────────────────

	sendIdeToolResult(sessionId: string, callId: string, content: string, isError: boolean): void {
		this._post('/api/v1/ide-tool-result', {
			session_id: sessionId,
			call_id: callId,
			content,
			is_error: isError,
		}).catch(err => {
			this._logService?.error('[SseClient] sendIdeToolResult failed: %s', err);
			this._emitError(`IDE tool result failed: ${err}`, 'IDE_TOOL_RESULT_FAILED', 'SESSION', false);
		});
	}

	// ── FEAT-R55: registerIdeMcpTools ──────────────────────────────────────

	registerIdeMcpTools(sessionId: string, tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }>): void {
		this._post('/api/v1/ide-mcp-tools', {
			session_id: sessionId,
			tools,
		}).catch(err => {
			this._logService?.error('[SseClient] registerIdeMcpTools failed: %s', err);
			this._emitError(`MCP tools registration failed: ${err}`, 'MCP_TOOLS_REGISTER_FAILED', 'SESSION', false);
		});
	}

	// ── SSE 连接管理 ────────────────────────────────────────────────────────

	private _sseAbortController: AbortController | null = null;

	/**
	 * Phase 1 Unified Auth: fetch-based SSE with Bearer token in headers.
	 * Replaces EventSource which cannot send custom headers.
	 */
	private async _openEventSource(): Promise<void> {
		this._closeEventSource();

		if (!this._sessionId) {
			this._logService?.debug('[SseClient] Skipping SSE open: no session_id yet');
			return;
		}

		const params = new URLSearchParams();
		params.set('session_id', this._sessionId);
		if (this._lastSequenceId > 0) {
			params.set('last_sequence_id', String(this._lastSequenceId));
		}

		const url = `${this._config.baseUrl}/api/v1/events?${params.toString()}`;
		this._logService?.info('[SseClient] Opening fetch-based SSE: %s', url);

		const token = await this._resolveToken();
		const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		this._sseAbortController = new AbortController();

		try {
			const resp = await fetch(url, {
				headers,
				signal: this._sseAbortController.signal,
			});

			if (resp.status === 401) {
				const authCode = await this._readErrorCode(resp.clone());
				if (authCode === 'AUTH_TOKEN_EXPIRED') {
					const refreshed = await this._tryRefreshAndRetry();
					if (refreshed) {
						return; // _tryRefreshAndRetry will re-open SSE
					}
					this._logService?.error('[SseClient] SSE token expired and refresh failed');
					this._emitError('Authentication token expired for SSE', 'AUTH_TOKEN_EXPIRED', 'AUTH', true);
				} else {
					this._logService?.error('[SseClient] SSE authentication failed: %s', authCode ?? 'unknown');
					this._emitError('Authentication failed for SSE', authCode ?? 'AUTH_FAILED', 'AUTH', false);
				}
				this._setState(ConnectionState.Disconnected);
				return;
			}

			if (!resp.ok || !resp.body) {
				this._logService?.error('[SseClient] SSE response not ok: %d', resp.status);
				this._closeEventSource();
				this._scheduleReconnect();
				return;
			}

			this._logService?.info('[SseClient] SSE connected');
			this._reconnectAttempts = 0;
			this._setState(ConnectionState.Connected);

			// Read SSE stream
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			// Idle-watchdog: the reasoner's event stream emits a ``heartbeat``
			// event every 30s when the agent queue is idle (see
			// reasoning/session/agent_session.py:event_stream). If we see
			// NOTHING — not even a heartbeat — for IDLE_TIMEOUT_MS, the
			// underlying TCP must be half-open (NAT idle, proxy timeout,
			// laptop sleep, etc.) and ``reader.read()`` will block forever
			// without this guard. On timeout we abort the controller which
			// surfaces as an AbortError below, then ``_scheduleReconnect``
			// picks up with ``last_sequence_id`` so no event is lost.
			//
			// Observed 2026-05-13: Full Auto E2E completed on the reasoner
			// in 35 s, but the IDE never saw the final 'done' event because
			// the SSE silently dropped sometime after the auto-allow burst;
			// UI stayed stuck on "Connecting to backend..." indefinitely.
			// Detail: HANDOFF doc, but symptom is "task done backend-side,
			// UI spinner stuck".
			const IDLE_TIMEOUT_MS = 60_000;
			const abortOnIdle = this._sseAbortController!;
			let idleTimer: ReturnType<typeof setTimeout> | null = null;
			const resetIdleTimer = () => {
				if (idleTimer !== null) {
					clearTimeout(idleTimer);
				}
				idleTimer = setTimeout(() => {
					this._logService?.warn(
						'[SseClient] SSE idle for %dms (no heartbeat) — aborting + reconnecting',
						IDLE_TIMEOUT_MS,
					);
					try {
						abortOnIdle.abort();
					} catch {
						// best-effort
					}
				}, IDLE_TIMEOUT_MS);
			};
			resetIdleTimer();

			const processStream = async () => {
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}
						// Any byte from the server resets the idle watchdog —
						// includes heartbeat comment lines AND data events.
						resetIdleTimer();
						buffer += decoder.decode(value, { stream: true });

						// Parse SSE lines
						const lines = buffer.split('\n');
						buffer = lines.pop() ?? ''; // keep incomplete line

						for (const line of lines) {
							if (line.startsWith('data: ')) {
								try {
									this._dispatchEvent(JSON.parse(line.slice(6)));
								} catch (e) {
									this._logService?.error('[SseClient] Failed to parse SSE event: %s', e);
								}
							}
						}
					}
				} catch (err: any) {
					if (err.name === 'AbortError') {
						// Either intentional close OR our idle-watchdog
						// fired. The next block decides if we reconnect.
					} else {
						this._logService?.error('[SseClient] SSE stream error: %s', err);
					}
				} finally {
					if (idleTimer !== null) {
						clearTimeout(idleTimer);
						idleTimer = null;
					}
				}

				// Stream ended (clean close, error, or idle-abort) — same
				// recovery path: reconnect unless session is already done.
				if (!this._sessionDone) {
					this._logService?.info('[SseClient] SSE stream ended, scheduling reconnect');
					this._closeEventSource();
					this._scheduleReconnect();
				} else {
					this._logService?.info('[SseClient] Session done — not reconnecting');
					this._closeEventSource();
				}
			};

			processStream();

		} catch (err: any) {
			if (err.name === 'AbortError') {
				return;
			}
			this._logService?.error('[SseClient] SSE fetch error: %s', err);
			this._closeEventSource();
			this._scheduleReconnect();
		}
	}

	private _closeEventSource(): void {
		if (this._sseAbortController) {
			this._sseAbortController.abort();
			this._sseAbortController = null;
		}
	}

	/**
	 * Resolve token: prefer tokenProvider, fallback to static config.token
	 */
	private async _resolveToken(): Promise<string | undefined> {
		if (this._config.tokenProvider) {
			return this._config.tokenProvider.getAccessToken();
		}
		return this._config.token;
	}

	/**
	 * On 401: try refresh once, then re-open SSE. Returns true if retry initiated.
	 */
	private async _tryRefreshAndRetry(): Promise<boolean> {
		if (!this._config.tokenProvider) {
			return false;
		}
		this._logService?.info('[SseClient] 401 received, attempting token refresh...');
		const newToken = await this._config.tokenProvider.refreshAccessToken();
		if (newToken) {
			this._logService?.info('[SseClient] Token refreshed, re-opening SSE');
			this._openEventSource(); // re-open with new token
			return true;
		}
		return false;
	}

	private async _readErrorCode(resp: Response): Promise<string | undefined> {
		try {
			const body = await resp.json() as { error?: { code?: string } };
			return body?.error?.code;
		} catch {
			return undefined;
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
			this._logService?.warn('[SseClient] Unknown event type: %s', type);
			return;
		}

		const payload = raw['data'] && typeof raw['data'] === 'object'
			? raw['data'] as Record<string, unknown>
			: (() => {
				const { type: _t, event_id: _e, session_id: _s, sequence_id: _sq, timestamp_ms: _ts, ...rest } = raw;
				return rest;
			})();

		// ADR-009 §4.1 trace_id injection: reasoner emits trace_id at the top
		// level of every ServerEvent JSON (stream_manager.build_event), and
		// IAgentEventBase.trace_id is the contract for downstream consumers
		// (chat bubble pill in chipOSChatAgent + FullTracer.begin). The
		// WebSocket client (webSocketEventStreamClient._emit) already does
		// this — the SSE client missed it, so SSE-routed chat rounds never
		// saw event.trace_id and the pill never rendered. Pull it through
		// here so SSE has parity.
		const rawTraceId = raw['trace_id'];
		const traceId = typeof rawTraceId === 'string' && rawTraceId ? rawTraceId : undefined;

		this._onDidReceiveEvent.fire({
			event_type: eventType,
			event_id: eventId,
			session_id: (raw['session_id'] as string) ?? this._sessionId,
			timestamp: (raw['timestamp_ms'] as number) ?? Date.now(),
			trace_id: traceId,
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

	private static readonly _POST_TIMEOUT_MS = 30_000;

	private async _post(path: string, body: unknown, _isRetry: boolean = false): Promise<Response> {
		const token = await this._resolveToken();
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SseEventStreamClient._POST_TIMEOUT_MS);

		try {
			const resp = await fetch(`${this._config.baseUrl}${path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			// Phase 1 Unified Auth: only refresh-retry on AUTH_TOKEN_EXPIRED
			if (resp.status === 401 && !_isRetry && this._config.tokenProvider) {
				const authCode = await this._readErrorCode(resp.clone());
				if (authCode === 'AUTH_TOKEN_EXPIRED') {
					this._logService?.info('[SseClient] POST %s returned AUTH_TOKEN_EXPIRED, attempting refresh...', path);
					const newToken = await this._config.tokenProvider.refreshAccessToken();
					if (newToken) {
						this._logService?.info('[SseClient] Token refreshed, retrying POST %s', path);
						return this._post(path, body, true);
					}
				}
			}

			if (!resp.ok) {
				let detail = resp.statusText;
				try {
					const errBody = await resp.json();
					if (errBody?.error?.message) {
						detail = `${errBody.error.code || resp.status}: ${errBody.error.message}`;
					}
				} catch { /* body may not be JSON */ }
				const err = new Error(`HTTP ${resp.status}: ${detail}`);
				(err as any).httpStatus = resp.status;
				throw err;
			}
			return resp;
		} catch (err: any) {
			if (err.name === 'AbortError') {
				throw new Error(`POST ${path} timed out after ${SseEventStreamClient._POST_TIMEOUT_MS}ms`);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
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

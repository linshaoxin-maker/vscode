/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatelessClient — IDE-side gateway to ChipOS C 档 reasoner endpoints.
 *
 * Phase 0 #8b + Phase 1 (ADR-018 reverse-channel + resume). See:
 *   - ADR-017 (C 档 stateless reasoner) + ADR-018 (mixed-state)
 *   - document/backend-v2-migration/04-decisions/PHASE-1-PROTOCOL-SPEC.md §1
 *     (endpoint table), §2.2 / §2.4 / §2.5 / §2.6 / §2.9 (request/response
 *     shapes), §3 (error codes), §4.2 (idempotency — 404 on stale call_id is
 *     OK, 412 on catalog mismatch).
 *
 * Responsibilities:
 *   - POST /api/v1/invoke and stream back ``InvokeEvent``s parsed from SSE
 *   - POST /api/v1/invoke/{trace_id}/cancel — server-side cancellation side door
 *   - POST /api/v1/replay/{trace_id}?last_sequence_id=N — short-buffer SSE replay
 *     (Phase 0; Phase 1 replaces with /resume/{chat_session_id})
 *   - POST /api/v1/compact — single-JSON conversation summarization
 *   - POST /api/v1/tools/register — out-of-band tool catalog upload (Phase 1)
 *   - POST /api/v1/tool_result/{trace_id}/{call_id} — IDE→reasoner reverse-channel
 *     completion for an ``ide_tool_call`` SSE event (Phase 1)
 *   - POST /api/v1/confirm_response/{trace_id}/{request_id} — IDE→reasoner
 *     reverse-channel completion for a ``confirm_request`` SSE event (Phase 1)
 *   - POST /api/v1/resume/{chat_session_id} — SSE drop reconnect (Phase 1)
 *   - GET  /api/v1/turn_state/{chat_session_id} — IDE startup in-flight probe (Phase 1)
 *
 * Wire format mirrors the existing reasoner SSE (``data: <json>\n\n``) so this
 * follows the same conventions as ``grpcSseEventStreamClient.ts``. We don't
 * reuse that parser because this is a different client surface (per-round short
 * SSE, no reconnect / dedup / session-id machinery — those concerns are owned
 * by the caller / integration layer in chipOSChatAgent.ts).
 */

import {
	type CompactRequest,
	type CompactResponse,
	type ConfirmResponseRequest,
	type InvokeEvent,
	type InvokeRequest,
	type RegisterToolsRequest,
	type RegisterToolsResponse,
	type ResumeRequest,
	type ToolResultRequest,
	type TurnStateResponse,
} from './types.js';


// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown by ``replay()`` when the reasoner returns HTTP 410 — the trace's
 * 5-minute replay buffer has expired (or the trace was never known to this
 * reasoner replica). PROTOCOL-SPEC §8.3 remediation: drop local partial
 * state and re-issue the full invoke (messages + state are still in
 * ``chatSessions/<uuid>.jsonl``).
 */
export class StatelessReplayExpiredError extends Error {
	readonly traceId: string;

	constructor(traceId: string) {
		super(`replay window expired or unknown trace_id=${traceId}`);
		this.name = 'StatelessReplayExpiredError';
		this.traceId = traceId;
	}
}

/**
 * Thrown by ``resume()`` when the reasoner returns HTTP 404 — there is no
 * in-flight turn for ``traceId`` (turn completed naturally between SSE drop
 * and the resume POST, or the trace_id was wrong). PROTOCOL-SPEC §2.6:
 * IDE remediation is benign — the turn likely finished; fetch latest state
 * via ``getTurnState()`` if necessary.
 */
export class StatelessResumeNotFoundError extends Error {
	readonly traceId: string;

	constructor(traceId: string) {
		super(`no in-flight turn for trace_id=${traceId}`);
		this.name = 'StatelessResumeNotFoundError';
		this.traceId = traceId;
	}
}

/**
 * Thrown by ``invoke()`` / ``replay()`` / ``compact()`` and the Phase 1
 * methods when the server returns a non-2xx HTTP status (other than the
 * specially-handled 410 / 404 cases above). The ``status`` + best-effort
 * parsed ``body`` are surfaced so callers can decide whether to retry /
 * surface to user.
 */
export class StatelessHttpError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown, message?: string) {
		super(message ?? `stateless reasoner HTTP ${status}`);
		this.name = 'StatelessHttpError';
		this.status = status;
		this.body = body;
	}
}


// ── Client options + class ────────────────────────────────────────────────

export interface StatelessClientOptions {
	/** e.g. "http://121.89.82.122:8080" — no trailing slash. */
	readonly baseUrl: string;
	/** Optional bearer token. Omit for auth-disabled local dev. */
	readonly authToken?: string;
	/**
	 * Per-request bearer token provider. Preferred over the static `authToken`:
	 * resolved immediately before EVERY request, so a token nearing expiry gets
	 * refreshed (chiposTokenManager.getAccessToken auto-refreshes). Fixes 401s
	 * on long-lived turns — `/resume`, `/confirm_response`, `/tool_result` that
	 * fire minutes after invoke-start, past the JWT TTL. When both are set, the
	 * provider wins; `authToken` stays as a static fallback for tests.
	 */
	readonly authTokenProvider?: () => Promise<string | undefined>;
	/** Inject for tests; defaults to global ``fetch``. */
	readonly fetchFn?: typeof fetch;
	/**
	 * Per-request abort timeout. Defaults to 600_000 ms (10 min) — owner
	 * pinned 600s in AUDIT P1-3 to accommodate "thinking" models that may
	 * stall mid-stream for up to 5 min while emitting reasoning tokens.
	 */
	readonly requestTimeoutMs?: number;
}

/**
 * Cancel-endpoint return envelope. Either the 202 success shape or any error
 * shape from 404 / 503 (caller decides what to do with each).
 */
export type CancelResponse =
	| { cancelled: boolean; trace_id: string; reason: string }
	| { error: string;[k: string]: unknown };

/**
 * StatelessClient — IDE-side gateway to ChipOS C 档 reasoner endpoints.
 *
 * See class-level docstring at top of file for design overview.
 */
export class StatelessClient {

	private readonly _baseUrl: string;
	private readonly _authToken: string | undefined;
	private readonly _authTokenProvider?: () => Promise<string | undefined>;
	private readonly _fetch: typeof fetch;
	private readonly _timeoutMs: number;

	constructor(opts: StatelessClientOptions) {
		// Normalize: strip trailing slash so callers can pass either form.
		this._baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this._authToken = opts.authToken;
		this._authTokenProvider = opts.authTokenProvider;
		// Bind through a wrapper so the default isn't ripped off the ``fetch``
		// identifier if a caller monkeypatches ``globalThis.fetch`` later.
		this._fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
		this._timeoutMs = opts.requestTimeoutMs ?? 600_000;
	}

	/**
	 * Resolve the Authorization header FRESH per request. Prefers the token
	 * provider (which auto-refreshes a near-expiry token) over the static
	 * `authToken`. Returns `{}` when tokenless (auth-disabled dev). This is the
	 * P0.5 fix: capturing the token once at construction let a long-lived turn's
	 * late `/resume` / `/confirm_response` fire with an expired JWT → 401.
	 */
	private async _authHeaders(): Promise<Record<string, string>> {
		const token = this._authTokenProvider
			? await this._authTokenProvider()
			: this._authToken;
		return token ? { 'Authorization': `Bearer ${token}` } : {};
	}

	/**
	 * POST /api/v1/invoke and yield ``InvokeEvent``s parsed from the SSE
	 * response body. The returned AsyncIterable is hot — each iteration
	 * awaits the next event.
	 *
	 * Throws ``StatelessHttpError`` on non-2xx HTTP status (before yielding
	 * any events). SSE-emitted ``type === 'error'`` events are yielded
	 * normally — caller decides how to surface (see P0-7: this client does
	 * NOT echo server message text to user; caller's job).
	 *
	 * Passing an AbortSignal that fires mid-stream aborts the underlying
	 * fetch + the iterator throws AbortError. Note: this only kills the
	 * network connection. For SERVER-side cancellation (which makes the
	 * reasoner emit ``round_end{reason:'cancelled'}`` and stop billing for
	 * LLM tokens) use ``cancel(traceId)`` instead.
	 */
	invoke(req: InvokeRequest, signal?: AbortSignal): AsyncIterable<InvokeEvent> {
		const url = `${this._baseUrl}/api/v1/invoke`;
		return this._sseRequest(url, req, signal);
	}

	/**
	 * POST /api/v1/invoke/{trace_id}/cancel — server-side abort of the
	 * in-flight invoke owning ``traceId``. Resolves with the JSON body:
	 *   - 202: ``{cancelled: true, trace_id, reason}``
	 *   - 404: ``{error: 'trace_not_found', ...}`` (live invoke gone — race
	 *     between user cancel and natural end; treat as no-op success)
	 *   - 503: ``{error: 'stateless_disabled', ...}`` (feature flag off)
	 *
	 * Does NOT throw on 404/503 — caller picks how to handle. Throws
	 * ``StatelessHttpError`` only on other non-2xx (5xx etc) so the caller
	 * sees genuine server failures.
	 */
	async cancel(traceId: string, reason?: string): Promise<CancelResponse> {
		const url = `${this._baseUrl}/api/v1/invoke/${encodeURIComponent(traceId)}/cancel`;
		const body: Record<string, unknown> = { trace_id: traceId };
		if (reason !== undefined) {
			body.reason = reason;
		}
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			// 202 (success), 404 (not_found), 503 (disabled) all carry a JSON
			// envelope the caller wants to inspect — parse + return rather
			// than throw. Genuine 5xx is the throw branch below.
			if (resp.status === 202 || resp.status === 404 || resp.status === 503) {
				return (await this._parseJson(resp)) as CancelResponse;
			}
			if (!resp.ok) {
				const parsed = await this._parseJsonSafe(resp);
				throw new StatelessHttpError(resp.status, parsed);
			}
			// Some servers may return 200 (lenient) — treat as success too.
			return (await this._parseJson(resp)) as CancelResponse;
		} finally {
			clear();
		}
	}

	/**
	 * POST /api/v1/replay/{trace_id}?last_sequence_id=N — re-stream events
	 * from the reasoner's 5-min trace-scoped buffer with
	 * ``sequence_id > lastSequenceId``. The stream closes when the buffer
	 * is caught up to "now" (no follow mode — PROTOCOL-SPEC §8.3 explicit).
	 *
	 * Throws ``StatelessReplayExpiredError`` on HTTP 410 (replay window
	 * expired or trace unknown). Caller's remediation: drop local partial
	 * state, re-issue the full invoke from chatSession.jsonl.
	 */
	replay(traceId: string, lastSequenceId: number): AsyncIterable<InvokeEvent> {
		const qs = `?last_sequence_id=${encodeURIComponent(String(lastSequenceId))}`;
		const url = `${this._baseUrl}/api/v1/replay/${encodeURIComponent(traceId)}${qs}`;
		// Returned AsyncIterable lazily fires the fetch on first next() so
		// 410 surfaces as the first thrown error rather than an unhandled
		// promise rejection.
		return this._sseRequest(url, undefined, undefined, [
			{ onStatus: 410, throw: () => new StatelessReplayExpiredError(traceId) },
		]);
	}

	/**
	 * POST /api/v1/compact — single JSON response (not SSE).
	 *
	 * Throws ``StatelessHttpError`` on non-2xx.
	 */
	async compact(req: CompactRequest): Promise<CompactResponse> {
		const url = `${this._baseUrl}/api/v1/compact`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(req),
				signal: controller.signal,
			});
			if (!resp.ok) {
				const parsed = await this._parseJsonSafe(resp);
				throw new StatelessHttpError(resp.status, parsed);
			}
			return (await this._parseJson(resp)) as CompactResponse;
		} finally {
			clear();
		}
	}

	// ── Phase 1 endpoints (ADR-018 reverse-channel + resume) ──────────────

	/**
	 * POST /api/v1/tools/register — long-lived out-of-band tool catalog upload
	 * (PHASE-1-PROTOCOL-SPEC §2.2). Called at IDE startup and whenever the
	 * live MCP server set changes. Reasoner returns an opaque
	 * ``catalog_version`` that the IDE caches and sends back as
	 * ``InvokeRequest.expected_catalog_version`` on every subsequent invoke
	 * (412 on mismatch → re-register + retry, per ADR-018 §2 D9 / R-S).
	 *
	 * Throws ``StatelessHttpError`` on non-2xx.
	 */
	async registerTools(req: RegisterToolsRequest): Promise<RegisterToolsResponse> {
		const url = `${this._baseUrl}/api/v1/tools/register`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(req),
				signal: controller.signal,
			});
			if (!resp.ok) {
				const parsed = await this._parseJsonSafe(resp);
				throw new StatelessHttpError(resp.status, parsed);
			}
			return (await this._parseJson(resp)) as RegisterToolsResponse;
		} finally {
			clear();
		}
	}

	/**
	 * POST /api/v1/tool_result/{trace_id}/{call_id} — reverse-channel reply
	 * to an ``ide_tool_call`` SSE event (PHASE-1-PROTOCOL-SPEC §2.4).
	 *
	 *   - 202 → ``{accepted: true}`` (reasoner resolved the pending future)
	 *   - 404 → ``{error: 'call_not_found', ...}`` — benign: the reasoner's
	 *     callback already timed out or this is a duplicate POST after the
	 *     loop moved on (PHASE-1-PROTOCOL-SPEC §4.2 idempotency). IDE
	 *     should silently drop.
	 *   - 400 / 5xx → throws ``StatelessHttpError``.
	 */
	async postToolResult(
		traceId: string,
		callId: string,
		req: ToolResultRequest,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		const url = `${this._baseUrl}/api/v1/tool_result/${encodeURIComponent(traceId)}/${encodeURIComponent(callId)}`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(req),
				signal: controller.signal,
			});
			if (resp.status === 202 || resp.status === 200) {
				// 202 success: reasoner may return empty body or a small JSON
				// envelope. Normalize either case to {accepted: true}.
				try { await resp.text(); } catch { /* best-effort */ }
				return { accepted: true };
			}
			if (resp.status === 404) {
				const parsed = await this._parseJsonSafe(resp);
				if (parsed && typeof parsed === 'object' && 'error' in parsed) {
					return parsed as { error: string;[k: string]: unknown };
				}
				return { error: 'call_not_found' };
			}
			const parsed = await this._parseJsonSafe(resp);
			throw new StatelessHttpError(resp.status, parsed);
		} finally {
			clear();
		}
	}

	/**
	 * POST /api/v1/hook_result/{trace_id}/{eval_id} — reverse-channel reply to a
	 * ``hook_eval`` SSE event (FEAT-004 / H-1). The IDE ran the plugin function
	 * hook and POSTs the decision (``{decision, amended_args?, agent_message?}``).
	 *
	 * Status semantics mirror ``postToolResult`` (the underlying reasoner uses the
	 * same future-resolution machinery, keyed on ``eval_id``):
	 *   - 202 → ``{accepted: true}`` (reasoner resolved the pending eval future)
	 *   - 404 → ``{error: 'eval_not_found', ...}`` — benign: the reasoner's eval
	 *     already timed out (it fails closed/open by its own posture) or this is a
	 *     duplicate POST after the loop moved on. IDE should silently drop.
	 *   - 400 / 5xx → throws ``StatelessHttpError``.
	 */
	async postHookResult(
		traceId: string,
		evalId: string,
		body: Record<string, unknown>,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		const url = `${this._baseUrl}/api/v1/hook_result/${encodeURIComponent(traceId)}/${encodeURIComponent(evalId)}`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (resp.status === 202 || resp.status === 200) {
				// 202 success: reasoner may return empty body or a small JSON
				// envelope. Normalize either case to {accepted: true}.
				try { await resp.text(); } catch { /* best-effort */ }
				return { accepted: true };
			}
			if (resp.status === 404) {
				const parsed = await this._parseJsonSafe(resp);
				if (parsed && typeof parsed === 'object' && 'error' in parsed) {
					return parsed as { error: string;[k: string]: unknown };
				}
				return { error: 'eval_not_found' };
			}
			const parsed = await this._parseJsonSafe(resp);
			throw new StatelessHttpError(resp.status, parsed);
		} finally {
			clear();
		}
	}

	/**
	 * POST /api/v1/confirm_response/{trace_id}/{request_id} — reverse-channel
	 * reply to a ``confirm_request`` SSE event (PHASE-1-PROTOCOL-SPEC §2.5).
	 *
	 * Status semantics mirror ``postToolResult`` (the underlying reasoner
	 * uses the same future-resolution machinery — §2.5 final paragraph).
	 *   - 202 → ``{accepted: true}``
	 *   - 404 → ``{error: 'request_not_found', ...}`` (stale POST — benign)
	 *   - 400 / 5xx → throws ``StatelessHttpError``.
	 */
	async postConfirmResponse(
		traceId: string,
		requestId: string,
		req: ConfirmResponseRequest,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		const url = `${this._baseUrl}/api/v1/confirm_response/${encodeURIComponent(traceId)}/${encodeURIComponent(requestId)}`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(req),
				signal: controller.signal,
			});
			if (resp.status === 202 || resp.status === 200) {
				try { await resp.text(); } catch { /* best-effort */ }
				return { accepted: true };
			}
			if (resp.status === 404) {
				const parsed = await this._parseJsonSafe(resp);
				if (parsed && typeof parsed === 'object' && 'error' in parsed) {
					return parsed as { error: string;[k: string]: unknown };
				}
				return { error: 'request_not_found' };
			}
			const parsed = await this._parseJsonSafe(resp);
			throw new StatelessHttpError(resp.status, parsed);
		} finally {
			clear();
		}
	}

	/**
	 * POST /api/v1/resume/{chat_session_id} — SSE drop reconnect, continuing
	 * the in-flight turn referenced by ``req.trace_id`` from
	 * ``req.last_sequence_id`` forward (PHASE-1-PROTOCOL-SPEC §2.6).
	 *
	 * Throws:
	 *   - ``StatelessResumeNotFoundError`` on HTTP 404 (no in-flight turn for
	 *     this trace_id; likely finished naturally between drop + reconnect)
	 *   - ``StatelessReplayExpiredError`` on HTTP 410 (SSE buffer evicted —
	 *     IDE shows "session expired, resend original prompt")
	 *   - ``StatelessHttpError`` on other non-2xx
	 *
	 * The returned AsyncIterable yields events in the same shape as
	 * ``invoke()``; the stream concludes with a ``resumed_buffer_drained``
	 * marker per §2.6 (Phase 1 buffer-drain-only handoff).
	 */
	resume(chatSessionId: string, req: ResumeRequest, signal?: AbortSignal): AsyncIterable<InvokeEvent> {
		const url = `${this._baseUrl}/api/v1/resume/${encodeURIComponent(chatSessionId)}`;
		return this._sseRequest(url, req, signal, [
			{ onStatus: 404, throw: () => new StatelessResumeNotFoundError(req.trace_id) },
			{ onStatus: 410, throw: () => new StatelessReplayExpiredError(req.trace_id) },
		]);
	}

	/**
	 * GET /api/v1/turn_state/{chat_session_id} — IDE startup probe for
	 * in-flight turns belonging to this chat session
	 * (PHASE-1-PROTOCOL-SPEC §2.9).
	 *
	 * Per §2.9 IDE behaviour: caller iterates ``in_flight_traces`` and
	 * either auto-resumes (state="running") or prompts the user
	 * (state="stale"). HTTP 404 is treated as an empty result (unknown
	 * chat_session_id is functionally equivalent to "no in-flight traces").
	 * Other non-2xx throws ``StatelessHttpError``.
	 */
	async getTurnState(chatSessionId: string): Promise<TurnStateResponse> {
		const url = `${this._baseUrl}/api/v1/turn_state/${encodeURIComponent(chatSessionId)}`;
		const headers: Record<string, string> = { 'Accept': 'application/json' };
		Object.assign(headers, await this._authHeaders());
		const { controller, clear } = this._timeoutSignal(undefined);
		try {
			const resp = await this._fetch(url, {
				method: 'GET',
				headers,
				signal: controller.signal,
			});
			if (resp.status === 404) {
				// Drain body for connection reuse, then synthesise an empty
				// result so callers don't need a separate 404 code path.
				try { await resp.text(); } catch { /* best-effort */ }
				return { chat_session_id: chatSessionId, in_flight_traces: [] };
			}
			if (!resp.ok) {
				const parsed = await this._parseJsonSafe(resp);
				throw new StatelessHttpError(resp.status, parsed);
			}
			return (await this._parseJson(resp)) as TurnStateResponse;
		} finally {
			clear();
		}
	}

	// ── Internals ─────────────────────────────────────────────────────────

	/**
	 * Combine the caller's optional signal with our request timeout into a
	 * single controller passed to fetch. Aborts on EITHER source firing.
	 * Returns a ``clear()`` to cancel the timeout once the request settles.
	 */
	private _timeoutSignal(callerSignal: AbortSignal | undefined): { controller: AbortController; clear: () => void; reset: () => void } {
		const controller = new AbortController();
		// Forward caller-abort → our controller so the fetch sees a single
		// signal. Done via listener (cheap) rather than ``AbortSignal.any``
		// which isn't on every supported runtime yet.
		const onCallerAbort = () => {
			try {
				controller.abort(callerSignal?.reason);
			} catch {
				// best-effort
			}
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				onCallerAbort();
			} else {
				callerSignal.addEventListener('abort', onCallerAbort, { once: true });
			}
		}
		// A (idle timeout, not a hard cap): a re-armable timer. `reset()` is
		// called on every received SSE chunk, so the abort only fires after a
		// TRUE idle gap of _timeoutMs. Keepalives (~25s) keep a healthy stream —
		// including a 永等 human-confirm wait — alive indefinitely; only a
		// genuinely dead stream aborts. Previously this was a hard per-request
		// cap that cut the confirm wait every 10 min → reconnect → permission
		// card supersede churn → un-clickable card on long waits.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			timer = setTimeout(() => {
				try {
					controller.abort(new Error(`stateless request idle for ${this._timeoutMs}ms`));
				} catch {
					// best-effort
				}
			}, this._timeoutMs);
		};
		arm();
		const reset = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			arm();
		};
		const clear = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			if (callerSignal) {
				callerSignal.removeEventListener('abort', onCallerAbort);
			}
		};
		return { controller, clear, reset };
	}

	/**
	 * Drive an SSE request → AsyncIterable<InvokeEvent> conversion.
	 *
	 * Shared between ``invoke()`` (POST + JSON body), ``replay()`` (POST without
	 * body), and ``resume()`` (POST + JSON body). If ``body`` is undefined,
	 * sends no Content-Type and no body — matches the replay endpoint contract
	 * (query string only). If ``body`` is defined (object), it's JSON-encoded
	 * with ``Content-Type: application/json``.
	 *
	 * Per-endpoint status overrides (passed via ``statusOverrides``) translate
	 * specific HTTP statuses to typed errors before generic ``StatelessHttpError``
	 * kicks in:
	 *   - replay: 410 → ``StatelessReplayExpiredError``
	 *   - resume: 404 → ``StatelessResumeNotFoundError``, 410 → ``StatelessReplayExpiredError``
	 */
	private _sseRequest(
		url: string,
		body: unknown,
		signal: AbortSignal | undefined,
		statusOverrides?: { onStatus: number; throw: () => Error }[],
	): AsyncIterable<InvokeEvent> {
		// Capture instance state into local consts so the async generator
		// doesn't capture ``this`` (lint-friendly + makes the closure shape
		// explicit for review).
		const fetchFn = this._fetch;
		// P0.5: resolve the auth header per request (fresh/refreshed token), not
		// once at construction — long-lived turns (resume) outlive the JWT TTL.
		const authHeaders = () => this._authHeaders();
		const timeoutCtor = (s: AbortSignal | undefined) => this._timeoutSignal(s);

		return {
			[Symbol.asyncIterator](): AsyncIterator<InvokeEvent> {
				let started = false;
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
				let clearTimer: (() => void) | undefined;
				let resetTimer: (() => void) | undefined;
				const decoder = new TextDecoder('utf-8');
				let buffer = '';
				let exhausted = false;
				const queue: InvokeEvent[] = [];

				const start = async (): Promise<void> => {
					const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
					if (body !== undefined) {
						headers['Content-Type'] = 'application/json';
					}
					Object.assign(headers, await authHeaders());
					const { controller, clear, reset } = timeoutCtor(signal);
					clearTimer = clear;
					resetTimer = reset;
					const resp = await fetchFn(url, {
						method: 'POST',
						headers,
						body: body !== undefined ? JSON.stringify(body) : undefined,
						signal: controller.signal,
					});
					if (statusOverrides) {
						for (const ov of statusOverrides) {
							if (resp.status === ov.onStatus) {
								// Drain body so the connection can be reused, but
								// the body content is irrelevant to the error.
								try { await resp.text(); } catch { /* best-effort */ }
								throw ov.throw();
							}
						}
					}
					if (!resp.ok) {
						let parsed: unknown;
						try {
							parsed = await resp.json();
						} catch {
							try { parsed = await resp.text(); } catch { parsed = undefined; }
						}
						throw new StatelessHttpError(resp.status, parsed);
					}
					if (!resp.body) {
						// Successful response but no body — treat as empty
						// SSE stream (caller's for-await terminates immediately).
						exhausted = true;
						return;
					}
					reader = resp.body.getReader();
				};

				const flushBufferedEvents = (): void => {
					// SSE spec: events are separated by a blank line (\n\n).
					// Split on \n\n; the last fragment (no trailing \n\n) is
					// the in-progress event, retained for next read.
					// Be lenient about \r\n line endings (some proxies).
					const normalized = buffer.replace(/\r\n/g, '\n');
					const parts = normalized.split('\n\n');
					buffer = parts.pop() ?? '';
					for (const block of parts) {
						const evt = parseSseEventBlock(block);
						if (evt !== undefined) {
							queue.push(evt);
						}
					}
				};

				const pump = async (): Promise<void> => {
					if (!reader) {
						exhausted = true;
						return;
					}
					while (queue.length === 0 && !exhausted) {
						const { done, value } = await reader.read();
						// A: any received chunk (incl. keepalive) re-arms the idle
						// timeout, so a healthy stream — or a long 永等 confirm wait
						// kept warm by ~25s keepalives — never hits the abort cap.
						resetTimer?.();
						if (done) {
							exhausted = true;
							// Handle a truncated final event: if the buffer
							// still has bytes but no terminating \n\n, that
							// means the server closed mid-event. Per spec
							// requirement (handle truncated final = log warn,
							// end iteration), we silently drop and end.
							// If the buffer contains a well-formed event that
							// just happened to lack the trailing blank line
							// (some servers omit it before close), try to
							// parse it as a single-block final event for
							// resilience.
							if (buffer.length > 0) {
								const tail = buffer;
								buffer = '';
								const evt = parseSseEventBlock(tail);
								if (evt !== undefined) {
									queue.push(evt);
								}
								// else: truncated → drop (per spec).
							}
							break;
						}
						buffer += decoder.decode(value, { stream: true });
						flushBufferedEvents();
					}
				};

				return {
					async next(): Promise<IteratorResult<InvokeEvent>> {
						try {
							if (!started) {
								started = true;
								await start();
							}
							if (queue.length === 0 && !exhausted) {
								await pump();
							}
							if (queue.length > 0) {
								return { value: queue.shift()!, done: false };
							}
							// Stream finished — release timer (reader is
							// already done at this point).
							if (clearTimer) {
								clearTimer();
								clearTimer = undefined;
							}
							return { value: undefined as unknown as InvokeEvent, done: true };
						} catch (err) {
							// Ensure resources are released on error too.
							if (reader) {
								try { await reader.cancel(); } catch { /* best-effort */ }
								reader = undefined;
							}
							if (clearTimer) {
								clearTimer();
								clearTimer = undefined;
							}
							throw err;
						}
					},
					async return(value?: unknown): Promise<IteratorResult<InvokeEvent>> {
						// Caller broke out of the for-await loop — release
						// underlying stream + cancel pending timeout so we
						// don't leak.
						if (reader) {
							try { await reader.cancel(); } catch { /* best-effort */ }
							reader = undefined;
						}
						if (clearTimer) {
							clearTimer();
							clearTimer = undefined;
						}
						return { value: value as InvokeEvent, done: true };
					},
				};
			},
		};
	}

	private async _parseJson(resp: Response): Promise<unknown> {
		try {
			return await resp.json();
		} catch (err) {
			throw new StatelessHttpError(
				resp.status,
				undefined,
				`failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async _parseJsonSafe(resp: Response): Promise<unknown> {
		try {
			return await resp.json();
		} catch {
			try {
				return await resp.text();
			} catch {
				return undefined;
			}
		}
	}
}


// ── Pure SSE parser helper (no class state) ───────────────────────────────

/**
 * Parse a single SSE "event block" (the text between two ``\n\n`` separators)
 * into an InvokeEvent. Returns ``undefined`` if the block contains no
 * ``data:`` field (e.g. comment-only / keep-alive blocks).
 *
 * Honors multi-line ``data:`` fields per SSE spec: multiple ``data:`` lines
 * inside one event are concatenated with ``\n`` before JSON.parse.
 *
 * Lines beginning with ``:`` are comments (SSE keep-alives) — skipped.
 * Lines without a colon are ignored. Other SSE fields (``event:``, ``id:``,
 * ``retry:``) are ignored — reasoner doesn't use them; the routing type is
 * inside the JSON payload.
 */
function parseSseEventBlock(block: string): InvokeEvent | undefined {
	const dataLines: string[] = [];
	for (const rawLine of block.split('\n')) {
		// Strip a single trailing \r in case the upstream split missed
		// \r\n normalization (defense in depth).
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith(':')) {
			// SSE comment / keep-alive — skip silently.
			continue;
		}
		// Field format: ``<name>:<space?><value>``. Per spec, if there's no
		// colon the line IS the field name with empty value — we only care
		// about ``data`` so we skip such lines.
		const colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		const name = line.slice(0, colon);
		if (name !== 'data') {
			continue;
		}
		// Value: everything after the colon; a single leading space (added by
		// most SSE servers for readability) is stripped per spec.
		let value = line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}
		dataLines.push(value);
	}
	if (dataLines.length === 0) {
		return undefined;
	}
	const payload = dataLines.join('\n');
	try {
		return JSON.parse(payload) as InvokeEvent;
	} catch {
		// Malformed JSON in an SSE data block: skip rather than abort the
		// whole stream. The integration layer can decide to surface as an
		// error event upstream; here we stay close to "skip + keep going"
		// because a single bad event mid-stream shouldn't kill the round.
		return undefined;
	}
}

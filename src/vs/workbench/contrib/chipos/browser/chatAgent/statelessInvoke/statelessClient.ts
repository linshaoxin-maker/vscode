/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatelessClient — IDE-side gateway to ChipOS C 档 reasoner endpoints.
 *
 * Phase 0 #8b. See:
 *   - ADR-017 (C 档 stateless reasoner)
 *   - document/backend-v2-migration/04-decisions/PHASE-0-PROTOCOL-SPEC.md §1.3 (endpoints),
 *     §2.2 (schema), §8 (cancellation + replay + error handling)
 *   - document/backend-v2-migration/04-decisions/PHASE-0-SEQUENCE-DIAGRAMS.md
 *     §1 (single round), §7 (cancel), §8 (replay)
 *
 * Responsibilities:
 *   - POST /api/v1/invoke and stream back ``InvokeEvent``s parsed from SSE
 *   - POST /api/v1/invoke/{trace_id}/cancel — server-side cancellation side door
 *   - POST /api/v1/replay/{trace_id}?last_sequence_id=N — short-buffer SSE replay
 *   - POST /api/v1/compact — single-JSON conversation summarization
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
	type InvokeEvent,
	type InvokeRequest,
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
 * Thrown by ``invoke()`` / ``replay()`` / ``compact()`` when the server
 * returns a non-2xx HTTP status (other than the 410 case handled above).
 * The ``status`` + best-effort parsed ``body`` are surfaced so callers can
 * decide whether to retry / surface to user.
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
	private readonly _fetch: typeof fetch;
	private readonly _timeoutMs: number;

	constructor(opts: StatelessClientOptions) {
		// Normalize: strip trailing slash so callers can pass either form.
		this._baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this._authToken = opts.authToken;
		// Bind through a wrapper so the default isn't ripped off the ``fetch``
		// identifier if a caller monkeypatches ``globalThis.fetch`` later.
		this._fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
		this._timeoutMs = opts.requestTimeoutMs ?? 600_000;
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
		if (this._authToken) {
			headers['Authorization'] = `Bearer ${this._authToken}`;
		}
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
		return this._sseRequest(url, undefined, undefined, traceId);
	}

	/**
	 * POST /api/v1/compact — single JSON response (not SSE).
	 *
	 * Throws ``StatelessHttpError`` on non-2xx.
	 */
	async compact(req: CompactRequest): Promise<CompactResponse> {
		const url = `${this._baseUrl}/api/v1/compact`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this._authToken) {
			headers['Authorization'] = `Bearer ${this._authToken}`;
		}
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

	// ── Internals ─────────────────────────────────────────────────────────

	/**
	 * Combine the caller's optional signal with our request timeout into a
	 * single controller passed to fetch. Aborts on EITHER source firing.
	 * Returns a ``clear()`` to cancel the timeout once the request settles.
	 */
	private _timeoutSignal(callerSignal: AbortSignal | undefined): { controller: AbortController; clear: () => void } {
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
		const timer = setTimeout(() => {
			try {
				controller.abort(new Error(`stateless request timed out after ${this._timeoutMs}ms`));
			} catch {
				// best-effort
			}
		}, this._timeoutMs);
		const clear = () => {
			clearTimeout(timer);
			if (callerSignal) {
				callerSignal.removeEventListener('abort', onCallerAbort);
			}
		};
		return { controller, clear };
	}

	/**
	 * Drive an SSE request → AsyncIterable<InvokeEvent> conversion.
	 *
	 * Shared between ``invoke()`` (POST + JSON body) and ``replay()`` (POST
	 * without body). If ``body`` is undefined, sends no Content-Type and no
	 * body — matches the replay endpoint contract (query string only).
	 *
	 * If ``replayTraceId`` is provided, HTTP 410 is translated to
	 * ``StatelessReplayExpiredError`` (replay-specific contract).
	 */
	private _sseRequest(
		url: string,
		body: unknown,
		signal: AbortSignal | undefined,
		replayTraceId?: string,
	): AsyncIterable<InvokeEvent> {
		// Capture instance state into local consts so the async generator
		// doesn't capture ``this`` (lint-friendly + makes the closure shape
		// explicit for review).
		const fetchFn = this._fetch;
		const authToken = this._authToken;
		const timeoutCtor = (s: AbortSignal | undefined) => this._timeoutSignal(s);

		return {
			[Symbol.asyncIterator](): AsyncIterator<InvokeEvent> {
				let started = false;
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
				let clearTimer: (() => void) | undefined;
				const decoder = new TextDecoder('utf-8');
				let buffer = '';
				let exhausted = false;
				const queue: InvokeEvent[] = [];

				const start = async (): Promise<void> => {
					const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
					if (body !== undefined) {
						headers['Content-Type'] = 'application/json';
					}
					if (authToken) {
						headers['Authorization'] = `Bearer ${authToken}`;
					}
					const { controller, clear } = timeoutCtor(signal);
					clearTimer = clear;
					const resp = await fetchFn(url, {
						method: 'POST',
						headers,
						body: body !== undefined ? JSON.stringify(body) : undefined,
						signal: controller.signal,
					});
					if (replayTraceId !== undefined && resp.status === 410) {
						// Drain body so the connection can be reused, but
						// the body content is irrelevant to the error.
						try { await resp.text(); } catch { /* best-effort */ }
						throw new StatelessReplayExpiredError(replayTraceId);
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

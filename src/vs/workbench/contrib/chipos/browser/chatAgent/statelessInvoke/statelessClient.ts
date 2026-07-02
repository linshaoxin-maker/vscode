/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatelessClient — IDE-side gateway to ChipOS C 档 reasoner endpoints, now a
 * thin shell over the canonical `@chipos/invoke-client` ReasonerClient
 * (M3b, 19-SURFACE-CONVERGENCE). The HTTP/SSE machinery — fetch + stream
 * parse + re-armable idle timeout + per-request fresh auth + 401 forced-refresh
 * retry — lives in `./vendor/agent/reasonerClient.ts` (+ its
 * `../transport/fetchSSE.ts`), vendored verbatim from
 * `packages/invoke-client`; this module keeps ONLY the IDE adaptations:
 *
 *   - The legacy error-class names (`StatelessHttpError` / …) as aliases of the
 *     canonical classes, so existing `instanceof` sites keep working unchanged.
 *   - The pull-shaped streaming face: the IDE agent consumes turns via
 *     `for await (const ev of client.invoke(...))`, while the canonical client
 *     pushes events into a callback — `toAsyncIterable` bridges the two. (The
 *     shell WRAPS the canonical client rather than extending it because the
 *     `invoke`/`resume` names keep their historical pull signatures, which TS
 *     rightly rejects as incompatible overrides of the push-shaped base.)
 *   - `invoke()` maps onto the canonical `invokeRaw()` (NOT `invoke()`): the
 *     IDE owns its tool-catalog lifecycle in chipOSChatAgent (register + cache
 *     + 412 re-register-and-retry), so the batteries-included canonical
 *     handshake — which would register a noop catalog — must stay out of the
 *     way.
 *   - A 600s short-call timeout (canonical defaults 30s): `compact()` is a
 *     full LLM summarize call and routinely exceeds 30s on long histories;
 *     600s preserves this client's historical behaviour.
 *
 * Endpoint semantics (status → error/result mapping) are unchanged — see the
 * canonical client for per-method docs; the contract reference is
 * PHASE-1-PROTOCOL-SPEC §1-§4 + ADR-018.
 */

import {
	ReasonerClient,
	ReasonerHttpError,
	ReasonerReplayExpiredError,
	ReasonerResumeNotFoundError,
	type CancelResponse,
	type ReasonerClientOptions,
	type ReasonerHealth,
} from './vendor/agent/reasonerClient.js';
import { type SkillTreeData } from './vendor/types/protocol.js';
import {
	type CompactRequest,
	type CompactResponse,
	type ConfirmResponseRequest,
	type HookResultRequest,
	type InvokeEvent,
	type InvokeRequest,
	type RegisterToolsRequest,
	type RegisterToolsResponse,
	type ResumeRequest,
	type ToolResultRequest,
	type TurnStateResponse,
} from './types.js';

// ── Errors — legacy names kept as aliases (same classes, so instanceof works) ──

export {
	ReasonerHttpError as StatelessHttpError,
	ReasonerReplayExpiredError as StatelessReplayExpiredError,
	ReasonerResumeNotFoundError as StatelessResumeNotFoundError,
};

export type { CancelResponse };

// ── Options ────────────────────────────────────────────────────────────────

/**
 * Historical alias of the canonical options bag. The IDE passes
 * `{baseUrl, authTokenProvider}`; every other knob keeps its canonical
 * meaning (see vendor/agent/reasonerClient.ts).
 */
export type StatelessClientOptions = ReasonerClientOptions;

/**
 * `compact()` on long histories is a full LLM call; the canonical 30s default
 * for short (non-SSE) calls would cut it off. 600s mirrors what this client
 * enforced before M3b (its short calls shared the 600s SSE idle timeout).
 */
const IDE_POST_TIMEOUT_MS = 600_000;

/**
 * StatelessClient — see module docstring. Endpoint methods delegate 1:1 to the
 * canonical ReasonerClient; only the two streaming faces are adapted from push
 * (callback) to pull (AsyncIterable).
 */
export class StatelessClient {

	private readonly _inner: ReasonerClient;

	constructor(opts: StatelessClientOptions) {
		this._inner = new ReasonerClient({ postTimeoutMs: IDE_POST_TIMEOUT_MS, ...opts });
	}

	/**
	 * POST /api/v1/invoke and yield `InvokeEvent`s parsed from the SSE
	 * response body. The returned AsyncIterable is LAZY (the request fires on
	 * first iteration) and hot afterwards.
	 *
	 * The IDE owns the catalog handshake (chipOSChatAgent registers tools and
	 * handles 412 itself), so this rides the canonical `invokeRaw` — `req`
	 * must already carry `expected_catalog_version`, and a 412 surfaces as a
	 * `StatelessHttpError` for the caller's retry logic.
	 *
	 * Aborting `signal` mid-stream tears down the fetch and the iterator
	 * throws AbortError. That only kills the network connection — for
	 * SERVER-side cancellation use `cancel(traceId)`.
	 */
	invoke(req: InvokeRequest, signal?: AbortSignal): AsyncIterable<InvokeEvent> {
		return toAsyncIterable((onEvent, s) => this._inner.invokeRaw(req, onEvent, s), signal);
	}

	/**
	 * POST /api/v1/resume/{chat_session_id} — SSE drop reconnect, continuing
	 * the in-flight turn referenced by `req.trace_id` from
	 * `req.last_sequence_id` forward. Yields events like `invoke()`; the
	 * stream concludes with a `resumed_buffer_drained` marker.
	 *
	 * Throws (on first iteration):
	 *   - `StatelessResumeNotFoundError` on HTTP 404 (no in-flight turn —
	 *     likely finished naturally between drop + reconnect)
	 *   - `StatelessReplayExpiredError` on HTTP 410 (SSE buffer evicted —
	 *     IDE shows "session expired, resend original prompt")
	 *   - `StatelessHttpError` on other non-2xx
	 */
	resume(chatSessionId: string, req: ResumeRequest, signal?: AbortSignal): AsyncIterable<InvokeEvent> {
		return toAsyncIterable((onEvent, s) => this._inner.resume(chatSessionId, req, onEvent, s), signal);
	}

	// ── Non-streaming endpoints — 1:1 delegation to the canonical client ──

	/** POST /api/v1/invoke/{trace_id}/cancel — server-side abort (202/404/503 → envelope; else throws). */
	cancel(traceId: string, reason?: string): Promise<CancelResponse> {
		return this._inner.cancel(traceId, reason);
	}

	/** POST /api/v1/compact — conversation summarization (sync JSON; throws on non-2xx). */
	compact(req: CompactRequest): Promise<CompactResponse> {
		return this._inner.compact(req);
	}

	/** GET /api/v1/skill-tree — dynamic-skill category tree for the side panel. */
	getSkillTree(): Promise<SkillTreeData> {
		return this._inner.getSkillTree();
	}

	/** POST /api/v1/tools/register — out-of-band tool catalog upload (412 basis). */
	registerTools(req: RegisterToolsRequest): Promise<RegisterToolsResponse> {
		return this._inner.registerTools(req);
	}

	/** POST /api/v1/tool_result/{trace_id}/{call_id} — reply to an ide_tool_call. */
	postToolResult(
		traceId: string,
		callId: string,
		req: ToolResultRequest,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		return this._inner.postToolResult(traceId, callId, req);
	}

	/** POST /api/v1/hook_result/{trace_id}/{eval_id} — reply to a hook_eval (FEAT-004). */
	postHookResult(
		traceId: string,
		evalId: string,
		req: HookResultRequest,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		return this._inner.postHookResult(traceId, evalId, req);
	}

	/** POST /api/v1/confirm_response/{trace_id}/{request_id} — reply to a confirm_request. */
	postConfirmResponse(
		traceId: string,
		requestId: string,
		req: ConfirmResponseRequest,
	): Promise<{ accepted: boolean } | { error: string;[k: string]: unknown }> {
		return this._inner.postConfirmResponse(traceId, requestId, req);
	}

	/** GET /api/v1/turn_state/{chat_session_id} — in-flight probe (404 → empty result). */
	getTurnState(chatSessionId: string): Promise<TurnStateResponse> {
		return this._inner.getTurnState(chatSessionId);
	}

	/** GET /health — best-effort reachability probe (network error → reachable:false). */
	checkHealth(): Promise<ReasonerHealth> {
		return this._inner.checkHealth();
	}
}

// ── push→pull bridge ───────────────────────────────────────────────────────

/**
 * Adapt a callback-push SSE run (the canonical client shape) into the LAZY
 * pull AsyncIterable the IDE agent consumes.
 *
 * Semantics preserved from the pre-M3b hand-rolled iterator:
 *   - LAZY: nothing fires until the first `next()` (constructing the iterable
 *     without consuming it must not send a request);
 *   - errors from the run (HTTP status errors, aborts, network) surface as a
 *     rejection of the pending/next `next()`;
 *   - breaking out of `for await` (iterator `return()`) aborts the underlying
 *     fetch and swallows the resulting AbortError — early exit is not an error.
 */
function toAsyncIterable(
	run: (onEvent: (e: InvokeEvent) => void, signal: AbortSignal) => Promise<void>,
	callerSignal?: AbortSignal,
): AsyncIterable<InvokeEvent> {
	// Single-shot latch: each iterator lazily fires its own POST, so iterating
	// the same iterable twice would re-send the SAME trace_id (a duplicate turn
	// server-side). The IDE's retry loops correctly construct a fresh iterable
	// per attempt — this latch turns the latent misuse into a loud error.
	let iterated = false;
	return {
		[Symbol.asyncIterator](): AsyncIterator<InvokeEvent> {
			if (iterated) {
				throw new Error('StatelessClient stream already consumed — a turn stream is single-shot; call invoke()/resume() again for a retry');
			}
			iterated = true;
			const queue: InvokeEvent[] = [];
			const controller = new AbortController();
			let started = false;
			let done = false;
			let failed = false; // explicit flag — a rejection reason of `undefined` must still surface
			let failure: unknown;
			let returned = false;
			// A QUEUE of waiters (not a single slot): the AsyncIterator protocol
			// allows overlapping next() calls (e.g. Promise.all of two next()s) —
			// a single slot would drop the first waiter's wake-up and hang it.
			const waiters: Array<() => void> = [];

			const notify = () => {
				// Wake everyone; each re-checks queue/done state in its loop.
				const ws = waiters.splice(0, waiters.length);
				for (const w of ws) { w(); }
			};

			const onCallerAbort = () => {
				try {
					controller.abort((callerSignal as (AbortSignal & { reason?: unknown }) | undefined)?.reason);
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
			const release = () => {
				if (callerSignal) {
					callerSignal.removeEventListener('abort', onCallerAbort);
				}
			};

			const start = () => {
				started = true;
				// NB: release() (dropping the caller-abort listener) happens on
				// the CONSUMER side (done/throw/return), not when the run
				// settles — the pre-M3b iterator kept the listener until the
				// caller finished consuming, and the abort-propagation contract
				// (caller abort → fetch signal aborts) must hold for events
				// still queued after the stream closed.
				run(e => { queue.push(e); notify(); }, controller.signal).then(
					() => { done = true; notify(); },
					err => {
						// An abort triggered by return() is a clean early exit,
						// not a failure to surface.
						if (!returned) {
							failed = true;
							failure = err;
						}
						done = true;
						notify();
					},
				);
			};

			return {
				async next(): Promise<IteratorResult<InvokeEvent>> {
					if (!started) {
						start();
					}
					// eslint-disable-next-line no-constant-condition
					while (true) {
						if (returned) {
							// return() was called — the iteration is over even if
							// the (aborted) run has not settled yet.
							return { value: undefined as unknown as InvokeEvent, done: true };
						}
						if (queue.length > 0) {
							return { value: queue.shift()!, done: false };
						}
						if (done) {
							if (failed) {
								const err = failure;
								failed = false; // surface once
								failure = undefined;
								release();
								throw err;
							}
							release();
							return { value: undefined as unknown as InvokeEvent, done: true };
						}
						await new Promise<void>(resolve => { waiters.push(resolve); });
					}
				},
				async return(value?: unknown): Promise<IteratorResult<InvokeEvent>> {
					// Caller broke out of the for-await loop — tear down the
					// underlying stream; the run's AbortError is swallowed and any
					// pending concurrent next() is woken to observe `returned`.
					returned = true;
					try {
						controller.abort(new Error('consumer stopped iterating'));
					} catch {
						// best-effort
					}
					release();
					notify();
					return { value: value as InvokeEvent, done: true };
				},
			};
		},
	};
}

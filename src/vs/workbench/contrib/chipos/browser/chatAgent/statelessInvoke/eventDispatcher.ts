/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8e — pure event-dispatch state machine.
 *
 * Translate one stateless SSE `InvokeEvent` from the reasoner into a
 * `DispatchResult` describing what side-effects the caller should run on its
 * progress channel + how to update its accumulators. Kept free-function /
 * dependency-free so it's straightforward to unit-test without DI.
 *
 * The caller (`ChipOSChatAgent._invokeStateless`) owns:
 *   - text accumulation buffer (so consecutive `content_block_delta` events
 *     fold into one chat bubble),
 *   - the `final_messages` list from the terminal `round_end` event (Phase 1
 *     replaces the Phase 0 `langgraph_state_blob` — IDE appends these
 *     directly to chatSessions/*.jsonl per ADR-018 §2 D8 mixed-state),
 *   - latest token usage,
 *   - termination flag,
 *   - flushing the text buffer on `content_block_stop` / `message_stop` /
 *     `round_end` / `error`,
 *   - reverse-channel dispatch for `ide_tool_call` (POST /tool_result) and
 *     `confirm_request` (POST /confirm_response),
 *   - bookkeeping for `checkpoint` (resume watermark) / `keepalive` (idle
 *     timer reset) / `resumed_buffer_drained` (live-stream handoff marker).
 *
 * Forward-compat: unknown event types are ignored (return `{}`). New
 * reasoner-side events should be additive — clients on older protocol
 * versions silently drop them, the conversation still terminates on
 * `round_end`.
 */

import { StatelessHttpError, StatelessReplayExpiredError } from './statelessClient.js';
import type {
	CheckpointData,
	ConfirmRequestData,
	IdeToolCallData,
	InvokeEvent,
	KeepaliveData,
	Message,
	ResumedBufferDrainedData,
	TokenUsage,
} from './types.js';

/**
 * What the dispatcher's caller should do after processing one event.
 *
 * All fields are optional. Caller logic:
 *   - `appendText`: concat onto its assistant-text accumulator.
 *   - `flushText`: call its flush helper (`progress([markdown(buf)])`) and
 *     reset the buffer.
 *   - `progressMessage`: emit as `IChatProgressMessage` (e.g. tool-call
 *     pill, shimmer reconnect banner).
 *   - `thinkingText`: emit as `IChatThinkingPart` (reasoning panel).
 *   - `markdownError`: emit as `IChatMarkdownContent` then mark error
 *     in the final result (see `errorMessage`).
 *   - `usage`: stash for the final result's metadata.
 *   - `errorMessage`: when set, caller terminates with errorDetails.
 *   - `terminate`: when true, the SSE round is over; caller breaks
 *     the for-await loop after flushing.
 *
 * Phase 1 (ADR-018) additions — reverse-channel + heartbeat plumbing:
 *   - `ideToolCall`: reasoner asked IDE to execute a tool. Caller must
 *     run the tool and POST result to `/api/v1/tool_result/{trace_id}/{call_id}`.
 *   - `confirmRequest`: reasoner asked IDE to render a confirm card. Caller
 *     renders, captures user click, POSTs to
 *     `/api/v1/confirm_response/{trace_id}/{request_id}`.
 *   - `keepalive`: heartbeat — caller may reset its idle-disconnect timer.
 *   - `checkpoint`: safe-to-resume watermark — caller may stash for later
 *     `/api/v1/resume/{chat_session_id}` calls (`last_sequence_id`).
 *   - `resumedBufferDrained`: emitted by `/resume` after replay catches up;
 *     caller knows it's now on the live stream (or stream closes here).
 *   - `finalMessages`: from the terminal `round_end.data.final_messages` —
 *     caller appends these to chatSessions/*.jsonl. Replaces the Phase 0
 *     `langgraphStateBlob` field which is gone from the wire.
 */
export interface DispatchResult {
	appendText?: string;
	flushText?: boolean;
	progressMessage?: { content: string; shimmer?: boolean };
	thinkingText?: string;
	markdownError?: string;
	usage?: TokenUsage;
	errorMessage?: string;
	terminate?: boolean;
	// Phase 1 additions (ADR-018 §2 D7 + D8 + D10 + D14):
	/** Reverse channel: IDE must execute this tool + POST result back. */
	ideToolCall?: { callId: string; toolName: string; args: Record<string, unknown>; timeoutMs?: number };
	/** Reverse channel: IDE must render confirm card + POST user choice back. */
	confirmRequest?: { requestId: string; cardType: string; cardData: Record<string, unknown>; title?: string; buttons?: string[] };
	/** Keepalive heartbeat — reset client-side idle timer; usually no-op render. */
	keepalive?: { ts: number };
	/** Checkpoint watermark — IDE may store as "safe-to-resume seq" marker. */
	checkpoint?: { iteration: number; messagesCount: number };
	/** Resume buffer-drain done marker (from /resume endpoint stream). */
	resumedBufferDrained?: { sequenceId: number };
	/**
	 * D10 rehydrate marker: the reasoner restarted mid-turn and re-drove the
	 * agent loop from its checkpoint. The caller uses this to retire any confirm
	 * card that was live on the old reasoner — the rehydrated loop re-emits a
	 * FRESH `confirm_request` (new request_id), so the original card would
	 * otherwise linger as a dead duplicate.
	 */
	resumedLive?: boolean;
	/** When `terminate: true`, the final_messages list to append to chatSessions/*.jsonl. */
	finalMessages?: Message[];
	/**
	 * [ChipOS] A tool-call lifecycle update for collapsible tool-invocation
	 * rendering (replaces the plain "$(tools) name" progressMessage). The
	 * caller pairs start/complete by `callId`:
	 *   - `tool_call_emitted`    → { isComplete:false, toolName, input }
	 *   - `tool_result_observed` → { isComplete:true, outputPreview, isError }
	 * The reasoner ships the args (`input`) and a result preview
	 * (`content_preview`) precisely so the IDE can show what each tool did.
	 */
	toolInvocation?: {
		callId: string;
		toolName?: string;
		input?: Record<string, unknown>;
		isComplete: boolean;
		outputPreview?: string;
		isError?: boolean;
	};
	/**
	 * [ChipOS] Structured agent error → rendered as an `agentError` card
	 * (category icon + error code + retry hint) instead of a plain markdown
	 * line. Carries the raw backend fields; the caller applies category
	 * presets for the final visual.
	 */
	agentError?: {
		category?: string;
		errorCode?: string;
		message: string;
		retryable?: boolean;
	};
}

/**
 * Translate one `InvokeEvent` → `DispatchResult`. Pure function.
 *
 * `friendlyToolName` is injected so the dispatcher can render
 * `Calling ${friendly_name}` without importing the chat agent's
 * `_friendlyToolName` map.
 *
 * @param event raw event off the SSE stream
 * @param friendlyToolName optional tool-name humaniser (defaults to identity)
 */
export function dispatchStatelessEvent(
	event: InvokeEvent,
	friendlyToolName: (raw: string) => string = raw => raw,
): DispatchResult {
	switch (event.type) {
		case 'message_start':
		case 'content_block_start':
			return {};

		case 'content_block_delta': {
			// Anthropic shape: { delta: { type: 'text_delta', text: '...' } }
			const data = (event.data ?? {}) as { delta?: { type?: string; text?: string } };
			if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
				return { appendText: data.delta.text };
			}
			return {};
		}

		case 'content_block_stop':
			return { flushText: true };

		case 'message_delta': {
			// PHASE-0-SPEC-AUDIT P0-3: server emits usage on message_delta.
			const data = (event.data ?? {}) as { usage?: TokenUsage };
			return data.usage ? { usage: data.usage } : {};
		}

		case 'message_stop':
			return { flushText: true };

		case 'tool_call_emitted': {
			// [ChipOS] Render as a collapsible tool invocation (was: a plain
			// "$(tools) name" progressMessage that couldn't be expanded). The
			// reasoner ships id + name + input — pass them through so the IDE
			// shows the tool name and its args.
			const data = (event.data ?? {}) as { id?: string; name?: string; input?: Record<string, unknown> };
			const name = typeof data.name === 'string' ? data.name : 'tool';
			return {
				flushText: true,
				toolInvocation: {
					callId: typeof data.id === 'string' && data.id ? data.id : name,
					toolName: name,
					input: data.input && typeof data.input === 'object' ? data.input : undefined,
					isComplete: false,
				},
			};
		}

		case 'tool_result_observed': {
			// [ChipOS] Was dropped ("not surfaced to user") even though the
			// reasoner explicitly marks this event display-purpose and ships a
			// content_preview. Pair by tool_use_id and complete the invocation
			// with the result preview so the user can see what the tool returned.
			const data = (event.data ?? {}) as { tool_use_id?: string; is_error?: boolean; content_preview?: string };
			const callId = typeof data.tool_use_id === 'string' ? data.tool_use_id : '';
			if (!callId) {
				return {};
			}
			return {
				toolInvocation: {
					callId,
					isComplete: true,
					outputPreview: typeof data.content_preview === 'string' ? data.content_preview : '',
					isError: !!data.is_error,
				},
			};
		}

		case 'ide_tool_call': {
			// Phase 1 reverse channel — IDE-side tool execution. Reasoner blocks
			// awaiting POST /tool_result/{trace_id}/{call_id}. flushText so any
			// pending assistant text renders before we kick off tool exec.
			const data = (event.data ?? {}) as unknown as IdeToolCallData;
			return {
				flushText: true,
				ideToolCall: {
					callId: data.call_id,
					toolName: data.tool_name,
					args: data.args,
					timeoutMs: typeof data.timeout_ms === 'number' ? data.timeout_ms : undefined,
				},
			};
		}

		case 'confirm_request': {
			// Phase 1 reverse channel — render ChipOSPermissionCard, capture
			// click, POST /confirm_response/{trace_id}/{request_id}.
			const data = (event.data ?? {}) as unknown as ConfirmRequestData;
			return {
				flushText: true,
				confirmRequest: {
					requestId: data.request_id,
					cardType: data.card_type,
					cardData: data.card_data,
					title: typeof data.title === 'string' ? data.title : undefined,
					buttons: Array.isArray(data.buttons) ? data.buttons : undefined,
				},
			};
		}

		case 'keepalive': {
			// Phase 1 anti-proxy-timeout heartbeat (every ~25s). Caller may
			// use it to reset its idle timer or render a subtle alive indicator.
			const data = (event.data ?? {}) as unknown as KeepaliveData;
			return { keepalive: { ts: typeof data.ts === 'number' ? data.ts : 0 } };
		}

		case 'checkpoint': {
			// Phase 1 safe-to-resume watermark. Caller stashes for a future
			// /resume call's `last_sequence_id` semantics.
			const data = (event.data ?? {}) as unknown as CheckpointData;
			return {
				checkpoint: {
					iteration: typeof data.iteration === 'number' ? data.iteration : 0,
					messagesCount: typeof data.messages_count === 'number' ? data.messages_count : 0,
				},
			};
		}

		case 'resumed_buffer_drained': {
			// Phase 1 /resume endpoint handoff marker — replay caught up,
			// from this seq forward we're on the live stream (or stream closes).
			const data = (event.data ?? {}) as unknown as ResumedBufferDrainedData;
			return {
				resumedBufferDrained: {
					sequenceId: typeof data.sequence_id === 'number' ? data.sequence_id : 0,
				},
			};
		}

		case 'resumed_live':
			// D10 (ADR-018 §2 D10 / R-D) marker: the reasoner restarted mid-turn
			// and rehydrated the agent loop from its checkpoint. The continuation
			// content_block_delta / round_end events that follow drive the actual
			// rendering — but the rehydrated loop also re-emits any pending
			// confirm_request with a FRESH request_id, so the caller must retire
			// the now-orphaned card from the dead reasoner (else two cards show
			// for one logical confirm).
			return { resumedLive: true };

		case 'thinking_delta': {
			const data = (event.data ?? {}) as { delta?: { text?: string } };
			const text = typeof data.delta?.text === 'string' ? data.delta.text : '';
			return text.length > 0 ? { thinkingText: text } : {};
		}

		case 'round_progress':
		case 'trace_link':
			// Decorative — reserved for future UI hooks.
			return {};

		case 'round_end': {
			// Phase 1 (ADR-018): `reason` literal now excludes "tool_use" and
			// adds "max_iterations" / "interrupted". `langgraph_state_blob` is
			// gone — IDE owns the conversation log via `final_messages` which
			// it appends to chatSessions/*.jsonl (D8 mixed-state).
			const data = (event.data ?? {}) as { reason?: string; final_messages?: Message[] };
			return {
				terminate: true,
				flushText: true,
				finalMessages: Array.isArray(data.final_messages) ? data.final_messages : undefined,
			};
		}

		case 'error': {
			// [ChipOS] Emit a structured agentError so the caller can render a
			// proper error card (category icon + code + retry hint) rather than
			// a one-line markdown string.
			const data = (event.data ?? {}) as { message?: string; error_code?: string; category?: string; retryable?: boolean };
			const msg = typeof data.message === 'string'
				? data.message
				: `reasoner error (${data.error_code ?? data.category ?? 'unknown'})`;
			return {
				flushText: true,
				agentError: {
					category: typeof data.category === 'string' ? data.category : undefined,
					errorCode: typeof data.error_code === 'string' ? data.error_code : undefined,
					message: msg,
					retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
				},
				errorMessage: msg,
			};
		}

		default:
			// Forward-compat: caller should `_logService.trace(...)` the unknown.
			return {};
	}
}

// ── SSE-failure classifier (used by _invokeStateless's catch block) ────────

/**
 * Classify what went wrong with a stateless SSE iteration so the caller can
 * decide between:
 *   - `'cancelled'`: user clicked Stop → return a cancelled result (don't
 *     re-render the error to chat).
 *   - `'replay'`: transient network drop → try `client.replay(traceId, seq)`.
 *   - `'surface-http'`: server responded non-2xx (4xx / 5xx) → render the
 *     status to user, do NOT attempt replay (re-issuing won't help).
 *   - `'surface-replay-expired'`: a previous `replay()` call returned 410 →
 *     surface "reconnect window expired" guidance.
 *   - `'surface-other'`: anything else (unknown shape) → render best-effort
 *     error message.
 *
 * Pure function — no DI, no I/O. Caller owns the actual progress + cleanup.
 *
 * @param err the thrown value from a `for await ... of client.invoke(...)` block
 * @param abortSignal the controller signal we passed into the iterator;
 *                    `aborted` distinguishes user cancel from anything else
 */
export function classifySseFailure(
	err: unknown,
	abortSignal: AbortSignal,
): 'cancelled' | 'replay' | 'surface-http' | 'surface-replay-expired' | 'surface-other' {
	if (abortSignal.aborted) {
		return 'cancelled';
	}
	if (err instanceof StatelessReplayExpiredError) {
		return 'surface-replay-expired';
	}
	if (err instanceof StatelessHttpError) {
		// 4xx and 5xx that surfaced as HttpError are not transient — re-
		// issuing the SAME bytes won't help; surface and let user decide.
		return 'surface-http';
	}
	// Anything else (TypeError from a half-closed socket, AbortError that
	// wasn't ours, generic network error) → attempt replay before giving up.
	return 'replay';
}


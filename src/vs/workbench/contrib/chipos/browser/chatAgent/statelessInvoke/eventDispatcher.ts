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
 *   - latest `langgraph_state_blob` (the most-recent `round_end` blob is
 *     what gets persisted),
 *   - latest token usage,
 *   - termination flag,
 *   - flushing the text buffer on `content_block_stop` / `message_stop` /
 *     `round_end` / `error`.
 *
 * Forward-compat: unknown event types are ignored (return `{}`). New
 * reasoner-side events should be additive — clients on older protocol
 * versions silently drop them, the conversation still terminates on
 * `round_end`.
 */

import type { InvokeEvent, TokenUsage } from './types.js';

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
 *   - `langgraphStateBlob`: stash for persistence (most-recent wins).
 *   - `usage`: stash for the final result's metadata.
 *   - `errorMessage`: when set, caller terminates with errorDetails.
 *   - `terminate`: when true, the SSE round is over; caller breaks
 *     the for-await loop after flushing.
 */
export interface DispatchResult {
	appendText?: string;
	flushText?: boolean;
	progressMessage?: { content: string; shimmer?: boolean };
	thinkingText?: string;
	markdownError?: string;
	langgraphStateBlob?: string;
	usage?: TokenUsage;
	errorMessage?: string;
	terminate?: boolean;
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
			const data = event.data as { delta?: { type?: string; text?: string } };
			if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
				return { appendText: data.delta.text };
			}
			return {};
		}

		case 'content_block_stop':
			return { flushText: true };

		case 'message_delta': {
			// PHASE-0-SPEC-AUDIT P0-3: server emits usage on message_delta.
			const data = event.data as { usage?: TokenUsage };
			return data.usage ? { usage: data.usage } : {};
		}

		case 'message_stop':
			return { flushText: true };

		case 'tool_call_emitted': {
			const data = event.data as { name?: string };
			const name = typeof data.name === 'string' ? data.name : 'tool';
			return {
				flushText: true,
				progressMessage: { content: `$(tools) ${friendlyToolName(name)}` },
			};
		}

		case 'tool_result_observed':
			// Internal bookkeeping — not surfaced to user.
			return {};

		case 'thinking_delta': {
			const data = event.data as { delta?: { text?: string } };
			const text = typeof data.delta?.text === 'string' ? data.delta.text : '';
			return text.length > 0 ? { thinkingText: text } : {};
		}

		case 'round_progress':
		case 'trace_link':
			// Decorative — reserved for future UI hooks.
			return {};

		case 'round_end': {
			const data = event.data as { reason?: string; langgraph_state_blob?: string };
			return {
				terminate: true,
				flushText: true,
				langgraphStateBlob: typeof data.langgraph_state_blob === 'string'
					? data.langgraph_state_blob
					: undefined,
			};
		}

		case 'error': {
			const data = event.data as { message?: string; error_code?: string; category?: string };
			const msg = typeof data.message === 'string'
				? data.message
				: `reasoner error (${data.error_code ?? data.category ?? 'unknown'})`;
			return {
				flushText: true,
				markdownError: `$(error) **ChipOS:** ${msg}`,
				errorMessage: msg,
			};
		}

		default:
			// Forward-compat: caller should `_logService.trace(...)` the unknown.
			return {};
	}
}

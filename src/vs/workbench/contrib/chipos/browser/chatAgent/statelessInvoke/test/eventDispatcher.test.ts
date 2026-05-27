/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8e — `dispatchStatelessEvent` unit tests.
 *
 * Locks the per-event state-machine that translates reasoner SSE events
 * into IDE-side side-effect descriptors. The dispatcher is pure (no DI,
 * no I/O); these tests assert one full traversal of the InvokeEventType
 * union plus the forward-compat unknown-event case.
 *
 * What we deliberately do NOT cover here:
 *   - the chipOSChatAgent.ts orchestration that flushes the text buffer
 *     + emits IChatProgress parts (that's #9 e2e territory)
 *   - SSE wire parsing (lives in statelessClient.test.ts)
 */

import assert from 'assert';
import { dispatchStatelessEvent } from '../eventDispatcher.js';
import type { InvokeEvent, TokenUsage } from '../types.js';

function ev(type: InvokeEvent['type'], data: Record<string, unknown> = {}, sequence_id = 1): InvokeEvent {
	return { type, sequence_id, data };
}

suite('dispatchStatelessEvent', () => {

	test('message_start / content_block_start → noop', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('message_start')), {});
		assert.deepStrictEqual(dispatchStatelessEvent(ev('content_block_start')), {});
	});

	test('content_block_delta with text_delta → appendText', () => {
		const r = dispatchStatelessEvent(ev('content_block_delta', { delta: { type: 'text_delta', text: 'hello' } }));
		assert.deepStrictEqual(r, { appendText: 'hello' });
	});

	test('content_block_delta with non-text delta type → noop', () => {
		// e.g. input_json_delta from Anthropic tool-streaming
		const r = dispatchStatelessEvent(ev('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{}' } }));
		assert.deepStrictEqual(r, {});
	});

	test('content_block_delta missing delta → noop (defensive)', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('content_block_delta', {})), {});
		assert.deepStrictEqual(dispatchStatelessEvent(ev('content_block_delta', { delta: { type: 'text_delta' } })), {});
	});

	test('content_block_stop / message_stop → flushText only', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('content_block_stop')), { flushText: true });
		assert.deepStrictEqual(dispatchStatelessEvent(ev('message_stop')), { flushText: true });
	});

	test('message_delta with usage → forwarded; without usage → noop (P0-3)', () => {
		const usage: TokenUsage = {
			input_tokens: 12,
			output_tokens: 34,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 0,
		};
		assert.deepStrictEqual(dispatchStatelessEvent(ev('message_delta', { usage })), { usage });
		assert.deepStrictEqual(dispatchStatelessEvent(ev('message_delta', {})), {});
	});

	test('tool_call_emitted → flushText + tools progress message via friendly name', () => {
		const r = dispatchStatelessEvent(
			ev('tool_call_emitted', { name: 'read_file', id: 'toolu_abc' }),
			raw => `Friendly(${raw})`,
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			progressMessage: { content: '$(tools) Friendly(read_file)' },
		});
	});

	test('tool_call_emitted without name → falls back to "tool"', () => {
		const r = dispatchStatelessEvent(ev('tool_call_emitted', {}));
		assert.deepStrictEqual(r, {
			flushText: true,
			progressMessage: { content: '$(tools) tool' },
		});
	});

	test('tool_result_observed → noop (internal bookkeeping)', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('tool_result_observed', { tool_use_id: 'toolu_abc' })), {});
	});

	test('thinking_delta with text → emitted as thinkingText; empty → noop', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('thinking_delta', { delta: { text: 'pondering...' } })),
			{ thinkingText: 'pondering...' },
		);
		assert.deepStrictEqual(dispatchStatelessEvent(ev('thinking_delta', { delta: { text: '' } })), {});
		assert.deepStrictEqual(dispatchStatelessEvent(ev('thinking_delta', {})), {});
	});

	test('round_progress / trace_link → noop (decorative)', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('round_progress', { round_idx: 1 })), {});
		assert.deepStrictEqual(dispatchStatelessEvent(ev('trace_link', { trace_id: 'abc' })), {});
	});

	test('round_end with blob → terminate + flush + langgraph blob', () => {
		const r = dispatchStatelessEvent(
			ev('round_end', { reason: 'end_turn', langgraph_state_blob: 'base64stuff==' }),
		);
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			langgraphStateBlob: 'base64stuff==',
		});
	});

	test('round_end without blob → terminate + flush, blob undefined', () => {
		const r = dispatchStatelessEvent(ev('round_end', { reason: 'cancelled' }));
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			langgraphStateBlob: undefined,
		});
	});

	test('error with message → flush + markdownError + errorMessage', () => {
		const r = dispatchStatelessEvent(
			ev('error', { message: 'upstream LLM 429', error_code: 'rate_limit', category: 'transient' }),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			markdownError: '$(error) **ChipOS:** upstream LLM 429',
			errorMessage: 'upstream LLM 429',
		});
	});

	test('error without message → synthesises from error_code / category', () => {
		const r = dispatchStatelessEvent(ev('error', { error_code: 'rate_limit' }));
		assert.deepStrictEqual(r, {
			flushText: true,
			markdownError: '$(error) **ChipOS:** reasoner error (rate_limit)',
			errorMessage: 'reasoner error (rate_limit)',
		});
	});

	test('error with no identifiers → "unknown" sentinel', () => {
		const r = dispatchStatelessEvent(ev('error', {}));
		assert.deepStrictEqual(r, {
			flushText: true,
			markdownError: '$(error) **ChipOS:** reasoner error (unknown)',
			errorMessage: 'reasoner error (unknown)',
		});
	});

	test('unknown event type → noop (forward-compat)', () => {
		// Cast through unknown — the dispatcher must tolerate event types
		// the IDE was compiled against an older protocol_version for.
		const future = { type: 'some_future_event', sequence_id: 99, data: { foo: 'bar' } } as unknown as InvokeEvent;
		assert.deepStrictEqual(dispatchStatelessEvent(future), {});
	});

	test('default friendlyToolName is identity', () => {
		const r = dispatchStatelessEvent(ev('tool_call_emitted', { name: 'raw_tool' }));
		assert.strictEqual(r.progressMessage?.content, '$(tools) raw_tool');
	});
});

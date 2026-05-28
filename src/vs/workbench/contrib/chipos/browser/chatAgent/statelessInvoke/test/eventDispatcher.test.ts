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
import { classifySseFailure, dispatchStatelessEvent } from '../eventDispatcher.js';
import { StatelessHttpError, StatelessReplayExpiredError } from '../statelessClient.js';
import type { InvokeEvent, Message, TokenUsage } from '../types.js';

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

	test('round_end with final_messages → terminate + flush + finalMessages (Phase 1 ADR-018)', () => {
		const finalMessages: Message[] = [
			{ role: 'assistant', content: 'Done.' },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
		];
		const r = dispatchStatelessEvent(
			ev('round_end', { reason: 'end_turn', final_messages: finalMessages }),
		);
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			finalMessages,
		});
	});

	test('round_end without final_messages → terminate + flush, finalMessages undefined', () => {
		// Covers the "cancelled" and "interrupted" reasons where reasoner may
		// have nothing useful to append (Phase 1 reason literals).
		const r = dispatchStatelessEvent(ev('round_end', { reason: 'cancelled' }));
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			finalMessages: undefined,
		});
	});

	test('round_end with non-array final_messages → defensively dropped', () => {
		// Forward-compat: bad/old payload shouldn't crash; we just drop the field.
		const r = dispatchStatelessEvent(ev('round_end', { reason: 'max_iterations', final_messages: 'not-an-array' as unknown as Message[] }));
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			finalMessages: undefined,
		});
	});

	test('ide_tool_call → flushText + ideToolCall (camelCased payload)', () => {
		const r = dispatchStatelessEvent(
			ev('ide_tool_call', {
				call_id: 'call_xyz',
				tool_name: 'read_file',
				args: { path: '/tmp/foo.ts' },
				timeout_ms: 60000,
			}),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			ideToolCall: {
				callId: 'call_xyz',
				toolName: 'read_file',
				args: { path: '/tmp/foo.ts' },
				timeoutMs: 60000,
			},
		});
	});

	test('ide_tool_call without timeout_ms → timeoutMs undefined', () => {
		const r = dispatchStatelessEvent(
			ev('ide_tool_call', { call_id: 'c1', tool_name: 't1', args: {} }),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			ideToolCall: { callId: 'c1', toolName: 't1', args: {}, timeoutMs: undefined },
		});
	});

	test('confirm_request → flushText + confirmRequest (camelCased payload)', () => {
		const r = dispatchStatelessEvent(
			ev('confirm_request', {
				request_id: 'chipos_confirm_abc',
				card_type: 'agent_ask',
				card_data: { question: 'Proceed?' },
				title: 'Permission needed',
				buttons: ['approve', 'reject'],
			}),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			confirmRequest: {
				requestId: 'chipos_confirm_abc',
				cardType: 'agent_ask',
				cardData: { question: 'Proceed?' },
				title: 'Permission needed',
				buttons: ['approve', 'reject'],
			},
		});
	});

	test('confirm_request without title/buttons → those fields undefined', () => {
		const r = dispatchStatelessEvent(
			ev('confirm_request', {
				request_id: 'r1',
				card_type: 'generic',
				card_data: {},
			}),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			confirmRequest: {
				requestId: 'r1',
				cardType: 'generic',
				cardData: {},
				title: undefined,
				buttons: undefined,
			},
		});
	});

	test('keepalive → keepalive only (no flush, no terminate)', () => {
		const r = dispatchStatelessEvent(ev('keepalive', { ts: 1716800000000 }));
		assert.deepStrictEqual(r, { keepalive: { ts: 1716800000000 } });
	});

	test('keepalive missing ts → defaults to 0 (defensive)', () => {
		const r = dispatchStatelessEvent(ev('keepalive', {}));
		assert.deepStrictEqual(r, { keepalive: { ts: 0 } });
	});

	test('checkpoint → checkpoint only (resume watermark)', () => {
		const r = dispatchStatelessEvent(ev('checkpoint', { iteration: 3, messages_count: 7 }));
		assert.deepStrictEqual(r, { checkpoint: { iteration: 3, messagesCount: 7 } });
	});

	test('resumed_buffer_drained → resumedBufferDrained only', () => {
		const r = dispatchStatelessEvent(ev('resumed_buffer_drained', { sequence_id: 42 }));
		assert.deepStrictEqual(r, { resumedBufferDrained: { sequenceId: 42 } });
	});

	test('resumed_live → decorative no-op (D10 rehydrate marker)', () => {
		const r = dispatchStatelessEvent(
			ev('resumed_live', { trace_id: 't-1', resumed_from_iteration: 3 }),
		);
		assert.deepStrictEqual(r, {});
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

suite('classifySseFailure', () => {

	const liveSignal = (): AbortSignal => new AbortController().signal;
	const abortedSignal = (): AbortSignal => {
		const c = new AbortController();
		c.abort();
		return c.signal;
	};

	test('aborted signal → cancelled (regardless of error type)', () => {
		assert.strictEqual(classifySseFailure(new Error('whatever'), abortedSignal()), 'cancelled');
		assert.strictEqual(classifySseFailure(new StatelessHttpError(500, null), abortedSignal()), 'cancelled');
		assert.strictEqual(classifySseFailure(new StatelessReplayExpiredError('abc'), abortedSignal()), 'cancelled');
	});

	test('StatelessReplayExpiredError → surface-replay-expired', () => {
		assert.strictEqual(
			classifySseFailure(new StatelessReplayExpiredError('trace-1'), liveSignal()),
			'surface-replay-expired',
		);
	});

	test('StatelessHttpError → surface-http (4xx + 5xx both, replay would not help)', () => {
		assert.strictEqual(classifySseFailure(new StatelessHttpError(400, { detail: 'bad' }), liveSignal()), 'surface-http');
		assert.strictEqual(classifySseFailure(new StatelessHttpError(503, null), liveSignal()), 'surface-http');
		assert.strictEqual(classifySseFailure(new StatelessHttpError(409, null), liveSignal()), 'surface-http');
	});

	test('generic network errors → replay (transient, attempt /replay)', () => {
		assert.strictEqual(classifySseFailure(new TypeError('fetch failed'), liveSignal()), 'replay');
		assert.strictEqual(classifySseFailure(new Error('socket hang up'), liveSignal()), 'replay');
		assert.strictEqual(classifySseFailure('string-thrown', liveSignal()), 'replay');
	});
});

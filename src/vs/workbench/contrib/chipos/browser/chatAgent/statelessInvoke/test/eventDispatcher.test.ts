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

	test('tool_call_emitted → flushText + collapsible tool invocation carrying args', () => {
		const r = dispatchStatelessEvent(
			ev('tool_call_emitted', { name: 'read_file', id: 'toolu_abc', input: { file_path: '/x' } }),
			raw => `Friendly(${raw})`,
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			toolInvocation: {
				callId: 'toolu_abc',
				toolName: 'read_file',
				input: { file_path: '/x' },
				isComplete: false,
			},
		});
	});

	test('tool_start (agent_core bridge) → same toolInvocation directive as tool_call_emitted', () => {
		const r = dispatchStatelessEvent(
			ev('tool_start', { tool_name: 'verilog_lint', tool_id: 'run_1', args: { file_path: '/x.v' } }),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			toolInvocation: { callId: 'run_1', toolName: 'verilog_lint', input: { file_path: '/x.v' }, isComplete: false },
		});
	});

	test('tool_result (agent_core bridge) → completes the invocation with content preview', () => {
		const r = dispatchStatelessEvent(ev('tool_result', { tool_id: 'run_1', content: '0 errors', tool_name: 'verilog_lint' }));
		assert.deepStrictEqual(r, {
			toolInvocation: { callId: 'run_1', isComplete: true, outputPreview: '0 errors', isError: false },
		});
	});

	test('tool_call_emitted without name → falls back to "tool"', () => {
		const r = dispatchStatelessEvent(ev('tool_call_emitted', {}));
		assert.deepStrictEqual(r, {
			flushText: true,
			toolInvocation: {
				callId: 'tool',
				toolName: 'tool',
				input: undefined,
				isComplete: false,
			},
		});
	});

	test('tool_result_observed → completes invocation with output preview', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('tool_result_observed', { tool_use_id: 'toolu_abc', content_preview: 'hello', is_error: false })),
			{
				toolInvocation: {
					callId: 'toolu_abc',
					isComplete: true,
					outputPreview: 'hello',
					isError: false,
				},
			},
		);
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

	test('resumed_live → resumedLive marker (D10 rehydrate, retires stale confirm)', () => {
		const r = dispatchStatelessEvent(
			ev('resumed_live', { trace_id: 't-1', resumed_from_iteration: 3 }),
		);
		assert.deepStrictEqual(r, { resumedLive: true });
	});

	test('error with message → flush + structured agentError + errorMessage', () => {
		const r = dispatchStatelessEvent(
			ev('error', { message: 'upstream LLM 429', error_code: 'rate_limit', category: 'transient', retryable: true }),
		);
		assert.deepStrictEqual(r, {
			flushText: true,
			agentError: {
				category: 'transient',
				errorCode: 'rate_limit',
				message: 'upstream LLM 429',
				retryable: true,
			},
			errorMessage: 'upstream LLM 429',
		});
	});

	test('error without message → synthesises from error_code / category', () => {
		const r = dispatchStatelessEvent(ev('error', { error_code: 'rate_limit' }));
		assert.deepStrictEqual(r, {
			flushText: true,
			agentError: {
				category: undefined,
				errorCode: 'rate_limit',
				message: 'reasoner error (rate_limit)',
				retryable: undefined,
			},
			errorMessage: 'reasoner error (rate_limit)',
		});
	});

	test('error with no identifiers → "unknown" sentinel', () => {
		const r = dispatchStatelessEvent(ev('error', {}));
		assert.deepStrictEqual(r, {
			flushText: true,
			agentError: {
				category: undefined,
				errorCode: undefined,
				message: 'reasoner error (unknown)',
				retryable: undefined,
			},
			errorMessage: 'reasoner error (unknown)',
		});
	});

	test('unknown event type → noop (forward-compat)', () => {
		// Cast through unknown — the dispatcher must tolerate event types
		// the IDE was compiled against an older protocol_version for.
		const future = { type: 'some_future_event', sequence_id: 99, data: { foo: 'bar' } } as unknown as InvokeEvent;
		assert.deepStrictEqual(dispatchStatelessEvent(future), {});
	});

	test('tool_call_emitted carries the raw tool name (friendly mapping happens in applyDispatch)', () => {
		const r = dispatchStatelessEvent(ev('tool_call_emitted', { name: 'raw_tool' }));
		assert.strictEqual(r.toolInvocation?.toolName, 'raw_tool');
	});

	// ── [ChipOS] Fusion (Direction 2): rich agent_core events ──────────────

	test('model_output → appendText (agentcore streamed assistant text)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('model_output', { content: 'hello', is_delta: true })),
			{ appendText: 'hello' },
		);
		// empty content → noop
		assert.deepStrictEqual(dispatchStatelessEvent(ev('model_output', {})), {});
	});

	test('chat → noop (text already streamed via model_output)', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('chat', { content: 'dup' })), {});
	});

	test('status → flushText + progressMessage', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('status', { message: '正在综合…' })),
			{ flushText: true, progressMessage: { content: '正在综合…' } },
		);
		assert.deepStrictEqual(dispatchStatelessEvent(ev('status', {})), {});
	});

	test('subagent_event tool_start → subagentEvent directive (drives the collapsible card)', () => {
		// A composite role's (e.g. rtl-coder) tool call becomes a structured
		// `subagentEvent` directive — the caller turns the first frame per
		// task_id into a parent ChatSubagentContentPart card and each
		// tool_start/tool_end into a nested child tool row. (Was: a bare
		// transient `progressMessage` one-liner.)
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('subagent_event', {
				task_id: 'rtl-coder', kind: 'tool_start', tool_name: 'edit_file',
				args: { file_path: 'rtl/foo.v' }, snapshot_content: 'old contents',
			})),
			{
				subagentEvent: {
					taskId: 'rtl-coder',
					kind: 'tool_start',
					toolName: 'edit_file',
					args: { file_path: 'rtl/foo.v' },
					filePath: undefined,
					snapshotContent: 'old contents',
				},
			},
		);
	});

	test('subagent_event tool_end → subagentEvent directive with file_path (completes the child row)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('subagent_event', {
				task_id: 'rtl-coder', kind: 'tool_end', tool_name: 'edit_file', file_path: 'rtl/foo.v',
			})),
			{
				subagentEvent: {
					taskId: 'rtl-coder',
					kind: 'tool_end',
					toolName: 'edit_file',
					args: undefined,
					filePath: 'rtl/foo.v',
					snapshotContent: undefined,
				},
			},
		);
	});

	test('subagent_event non-tool / empty frame → dropped (no transient progress line)', () => {
		// Legacy alias-only frames (subagent/phase, no tool lifecycle) and empty
		// frames are dropped — the bare one-line progress message is exactly what
		// the collapsible card replaces.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('subagent_event', { subagent: 'rtl-coder', phase: 'start' })),
			{},
		);
		assert.deepStrictEqual(dispatchStatelessEvent(ev('subagent_event', {})), {});
	});

	test('task_summary → flushText + progressMessage verdict line', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('task_summary', { task_type: 'rtl', verdict: 'ok' })),
			{ flushText: true, progressMessage: { content: 'rtl · ok' } },
		);
		assert.deepStrictEqual(dispatchStatelessEvent(ev('task_summary', {})), {});
	});

	test('todo → progressMessage count (full widget stays on toolInvocation path)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('todo', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] })),
			{ progressMessage: { content: 'Updated todo list (2)' } },
		);
		assert.deepStrictEqual(dispatchStatelessEvent(ev('todo', { todos: [] })), {});
	});

	test('round_start / model_turn_start / model_turn_end → flushText (turn boundary)', () => {
		assert.deepStrictEqual(dispatchStatelessEvent(ev('round_start')), { flushText: true });
		assert.deepStrictEqual(dispatchStatelessEvent(ev('model_turn_start', { step: 1 })), { flushText: true });
		assert.deepStrictEqual(dispatchStatelessEvent(ev('model_turn_end', { step: 1 })), { flushText: true });
	});

	test('event with undefined data → never throws (resume crash regression)', () => {
		// Live repro (2026-05-29): /resume yields a `resumed_buffer_drained`
		// marker with NO `data` field when a turn parked at confirm has nothing
		// past the watermark to replay. The dispatcher read `data.sequence_id`
		// on undefined → "Cannot read properties of undefined (reading
		// 'sequence_id')", crashing the WHOLE auto-resume path (network drop +
		// >10min-confirm both went through it). Every branch must tolerate a
		// missing `data`. Snapshot: no throw + the no-data fallback shape.
		const types: InvokeEvent['type'][] = [
			'message_start', 'content_block_start', 'content_block_delta',
			'content_block_stop', 'message_delta', 'message_stop',
			'tool_call_emitted', 'tool_result_observed', 'ide_tool_call',
			'confirm_request', 'keepalive', 'checkpoint',
			'resumed_buffer_drained', 'resumed_live', 'thinking_delta',
			'round_progress', 'trace_link', 'round_end', 'error',
			// Fusion rich events must also tolerate missing data.
			'round_start', 'status', 'chat', 'model_output',
			'model_turn_start', 'model_turn_end', 'subagent_event',
			'task_summary', 'todo',
		];
		const results = types.map(t => {
			const evNoData = { type: t, sequence_id: 1, data: undefined } as unknown as InvokeEvent;
			return dispatchStatelessEvent(evNoData);
		});
		// The specific crash site: resumed_buffer_drained must yield seq 0.
		assert.deepStrictEqual(results[types.indexOf('resumed_buffer_drained')], {
			resumedBufferDrained: { sequenceId: 0 },
		});
		// keepalive falls back to ts 0; none of the others throw.
		assert.deepStrictEqual(results[types.indexOf('keepalive')], { keepalive: { ts: 0 } });
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

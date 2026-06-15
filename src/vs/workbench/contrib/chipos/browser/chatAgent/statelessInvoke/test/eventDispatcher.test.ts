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
			toolInvocation: { callId: 'run_1', isComplete: true, outputPreview: '0 errors', isError: false, errorKind: undefined },
		});
	});

	test('tool_result with error_kind hook_deny → errorKind passthrough (renderer shows a hook-block badge)', () => {
		const r = dispatchStatelessEvent(ev('tool_result', {
			tool_id: 'run_2',
			content: "Tool 'run_in_terminal' was blocked by a reasoner hook: no shell in this workspace",
			is_error: true,
			error_kind: 'hook_deny',
		}));
		assert.deepStrictEqual(r, {
			toolInvocation: {
				callId: 'run_2',
				isComplete: true,
				outputPreview: "Tool 'run_in_terminal' was blocked by a reasoner hook: no shell in this workspace",
				isError: true,
				errorKind: 'hook_deny',
			},
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
			followups: undefined,
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
			followups: undefined,
		});
	});

	test('round_end with non-array final_messages → defensively dropped', () => {
		// Forward-compat: bad/old payload shouldn't crash; we just drop the field.
		const r = dispatchStatelessEvent(ev('round_end', { reason: 'max_iterations', final_messages: 'not-an-array' as unknown as Message[] }));
		assert.deepStrictEqual(r, {
			terminate: true,
			flushText: true,
			finalMessages: undefined,
			followups: undefined,
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

	test('chat → replyText (caller gates render on sawStreamedText)', () => {
		// The dispatcher no longer drops `chat` outright. It hands the reply text to
		// the STATEFUL caller as `replyText`; the caller renders it ONLY if no
		// assistant text streamed this turn (sawStreamedText). So a streamed reply is
		// still de-duped (caller drops it), but a chat-only reply (subagent / resume /
		// analog clarification / a non-streaming provider) is no longer invisible.
		// Live-render mirror of the reasoner accumulator's `_saw_streamed_text` guard.
		assert.deepStrictEqual(dispatchStatelessEvent(ev('chat', { content: 'the reply' })), { replyText: 'the reply' });
		// empty / missing content → noop (nothing to surface)
		assert.deepStrictEqual(dispatchStatelessEvent(ev('chat', { content: '' })), {});
		assert.deepStrictEqual(dispatchStatelessEvent(ev('chat', {})), {});
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
					result: undefined,
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
					result: undefined,
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

	test('task_summary → flushText + rich taskSummary card (not the single-line downgrade)', () => {
		// agent_core SummaryAssembler shape: structured_data object.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('task_summary', {
				task_type: 'rtl_generation',
				verdict: 'ok',
				structured_data: { verdict_badge: '✅', task_description: 'gen counter' },
			})),
			{ flushText: true, taskSummary: { task_type: 'rtl_generation', structured_data: { verdict_badge: '✅', task_description: 'gen counter' } } },
		);
		// subagent_tracker shape: structured_data_json string → parsed.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('task_summary', { task_type: 'lint_fix', structured_data_json: '{"rounds":2}' })),
			{ flushText: true, taskSummary: { task_type: 'lint_fix', structured_data: { rounds: 2 } } },
		);
		// task_type only (empty structured_data) still renders a minimal card.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('task_summary', { task_type: 'rtl' })),
			{ flushText: true, taskSummary: { task_type: 'rtl', structured_data: {} } },
		);
		// Nothing to render → dropped.
		assert.deepStrictEqual(dispatchStatelessEvent(ev('task_summary', {})), {});
		// Malformed JSON → falls back to verdict-only card (no throw).
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('task_summary', { task_type: 'x', structured_data_json: '{not json' })),
			{ flushText: true, taskSummary: { task_type: 'x', structured_data: {} } },
		);
	});

	// ── [ChipOS] Fusion: rich EDA report cards ────────────────────────────────
	// Payload keys mirror what the BACKEND composite_tools safe_emit (NOT the
	// legacy WebSocket shape) — see eventDispatcher.ts case comments.

	test('sim_report → edaSimReport (sim_debug_loop tests+summary, coverage_boost empty)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('sim_report', {
				tests: [{ name: 't1', status: 'pass', message: '' }, { name: 't2', status: 'fail', message: 'x' }],
				summary: { total: 2, passed: 1, failed: 1 },
			})),
			{ flushText: true, edaParts: [{ kind: 'edaSimReport', tests: [{ name: 't1', status: 'pass', message: '', duration_ms: undefined }, { name: 't2', status: 'fail', message: 'x', duration_ms: undefined }], summary: { total: 2, passed: 1, failed: 1, errors: undefined } }] },
		);
		// coverage_boost's {round, result} (no tests) → empty table derived from tests.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('sim_report', { round: 0, result: {} })),
			{ flushText: true, edaParts: [{ kind: 'edaSimReport', tests: [], summary: { total: 0, passed: 0, failed: 0, errors: undefined } }] },
		);
	});

	test('coverage_report → edaCoverageReport (toggle/overall passthrough + string gaps)', () => {
		// P1-3: toggle_cov / overall_cov / target now forwarded; line/branch passed
		// only when present (no faking from overall_cov — the card shows N/A).
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('coverage_report', { line_cov: 88, branch_cov: 72, toggle_cov: 60, overall_cov: 75, target: 90, gaps: ['rtl.v:12 [toggle] sig'] })),
			{ flushText: true, edaParts: [{ kind: 'edaCoverageReport', gaps: [{ file: '', lines: 'rtl.v:12 [toggle] sig' }], line_cov: 88, branch_cov: 72, toggle_cov: 60, overall_cov: 75, target: 90 }] },
		);
		// Text-fallback path: only overall_cov, no line/branch → those are omitted.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('coverage_report', { overall_cov: 65, gaps: [] })),
			{ flushText: true, edaParts: [{ kind: 'edaCoverageReport', gaps: undefined, overall_cov: 65 }] },
		);
	});

	test('lint_report → edaLintReport (backend `column` mapped to `col`)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('lint_report', {
				round: 1,
				errors: [{ file: 'a.v', line: 3, column: 5, rule: 'X', message: 'oops', severity: 'warning' }],
			})),
			{ flushText: true, edaParts: [{ kind: 'edaLintReport', errors: [{ file: 'a.v', line: 3, col: 5, severity: 'warning', message: 'oops', rule: 'X', auto_fixable: undefined }], auto_fixable: undefined, tool: undefined }] },
		);
	});

	test('ppa_report → edaPpaReport (stage passthrough)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('ppa_report', { stage: 'improved', round: 2, improvement: { area: 0.1 }, strategy: 'r1' })),
			{ flushText: true, edaParts: [{ kind: 'edaPpaReport', stage: 'improved', round: 2, ppa: undefined, baseline_ppa: undefined, previous_best_ppa: undefined, current_ppa: undefined, best_ppa: undefined, improvement: { area: 0.1 }, strategy: 'r1', sta_report: undefined, power_report: undefined, pareto_front_size: undefined }] },
		);
		// Unknown stage → defaulted to eval_round.
		assert.strictEqual((dispatchStatelessEvent(ev('ppa_report', { stage: 'bogus' })).edaParts?.[0] as { stage: string }).stage, 'eval_round');
	});

	test('negotiation_view → edaNegotiationView (perspectives + challenges folded)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('negotiation_view', { round: 1, perspectives: [{ role: 'rtl-coder', analysis: 'use FSM', confidence: 0.8 }] })),
			{ flushText: true, edaParts: [{ kind: 'edaNegotiationView', issue: '', perspectives: [{ agent: 'rtl-coder', position: 'use FSM', reasoning: '0.8' }], recommendation: '' }] },
		);
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('negotiation_view', { round: 2, challenges: [{ role: 'tb-agent', response: 'edge cases', revised_confidence: 0.9 }] })),
			{ flushText: true, edaParts: [{ kind: 'edaNegotiationView', issue: '', perspectives: [{ agent: 'tb-agent', position: 'edge cases', reasoning: '0.9' }], recommendation: '' }] },
		);
		// Synthesize round: recommendation only.
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('negotiation_view', { round: 2, recommendation: '推荐采用 rtl-coder 方案', consensus_reached: true })),
			{ flushText: true, edaParts: [{ kind: 'edaNegotiationView', issue: '', perspectives: [], recommendation: '推荐采用 rtl-coder 方案' }] },
		);
		// Bare round marker (nothing to show) → dropped.
		assert.deepStrictEqual(dispatchStatelessEvent(ev('negotiation_view', { round: 1 })), {});
	});

	test('parallel_progress → edaParallelProgress (raw status preserved, files[0]→file)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('parallel_progress', {
				task_id: 'pg-counter', phase: 'review',
				tracks: [{ name: 'RTL Agent', status: 'review', current_step: '等待用户审核', files: ['rtl/counter.v'] }],
			})),
			{ flushText: true, edaParts: [{ kind: 'edaParallelProgress', phase: 'review', tracks: [{ name: 'RTL Agent', status: 'review', progress: undefined, file: 'rtl/counter.v' }], conflicts: undefined }] },
		);
	});

	test('spec_review → edaSpecReview (1:1)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('spec_review', { spec_path: 's/p.md', spec_name: 'P', summary: 'ok', files: ['a.v'] })),
			{ flushText: true, edaParts: [{ kind: 'edaSpecReview', spec_path: 's/p.md', spec_name: 'P', summary: 'ok', files: ['a.v'] }] },
		);
	});

	test('diff_preview → markdownContents (fenced diff block)', () => {
		assert.deepStrictEqual(
			dispatchStatelessEvent(ev('diff_preview', {
				file_path: 'rtl/x.v',
				hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', content: 'old' }, { type: 'add', content: 'new' }] }],
			})),
			{ flushText: true, markdownContents: ['**Diff: `rtl/x.v`**\n```diff\n@@ -1 +1 @@\n- old\n+ new\n```'] },
		);
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
			// Fusion EDA report cards must also tolerate missing data.
			'sim_report', 'lint_report', 'coverage_report', 'ppa_report',
			'negotiation_view', 'parallel_progress', 'spec_review', 'diff_preview',
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

	test('EDA schema guard: renamed/unrecognized payload → visible degraded note, not a silent empty card', () => {
		// Backend renamed `errors` → `issues`: the lint card would otherwise render an
		// empty (0-error = "passed") table. Surface a degraded note instead.
		const r = dispatchStatelessEvent(ev('lint_report', { issues: [{ file: 'a.v', line: 1 }] }));
		assert.ok(!r.edaParts, 'no misleading empty edaParts');
		assert.ok(r.markdownContents && /EDA "lint_report"/.test(r.markdownContents[0]), 'degraded note carries the kind');
		assert.ok(r.markdownContents![0].includes('issues'), 'degraded note lists the unrecognized key');
	});

	test('EDA schema guard: recognized empty payload (lint passed, errors:[]) → normal card, no degrade', () => {
		const r = dispatchStatelessEvent(ev('lint_report', { errors: [] }));
		assert.ok(r.edaParts && r.edaParts[0].kind === 'edaLintReport', 'real lint card still renders');
		assert.ok(!r.markdownContents, 'no degraded note for a legit empty payload');
	});

	test('EDA schema guard: empty payload → legit no-op, not degraded', () => {
		const r = dispatchStatelessEvent(ev('sim_report', {}));
		assert.ok(!r.markdownContents, 'empty payload is a no-op, not a degrade');
	});
});

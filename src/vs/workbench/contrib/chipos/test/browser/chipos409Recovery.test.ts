/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit test for `_recoverFrom409Conflict` — the helper that clears a stuck
 * chat session after the reasoner rejects /invoke with `409 chat_session_busy`.
 *
 * Background: the reasoner holds a per-`chat_session_id` lock for the lifetime
 * of an /invoke (see `stateless_invoke.py` D11 guard); a second /invoke for the
 * same session while one is in flight gets a fast 409. This can strand a user
 * when an earlier turn is orphaned (agent_ask never answered + IDE reload, or a
 * genuine concurrent send). The old behaviour surfaced a `REASONER_HTTP_409`
 * card whose Retry just re-conflicts. The fix: on 409, probe `/turn_state`,
 * cancel every in-flight trace with `superseded_by_new_turn`, then retry once.
 *
 * Why a unit test rather than a live repro: the 409 is a genuine concurrency
 * race. With ChipOS now defaulting `chat.requestQueuing.defaultAction` to
 * `queue`, rapid sends serialise instead of firing overlapping invokes, and on
 * an IDE reload the reasoner releases the session lock the instant the SSE
 * client disconnects — so the 409 window is (intentionally) near-unreachable
 * from normal use. This test drives the recovery orchestration deterministically
 * against a mock client so the cancel-then-retry behaviour is pinned regardless.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { _recoverFrom409Conflict, _finalizeUnrecoverableRestoredRow, _runResumeWithFallback, type I409RecoveryClient, type IFinalizableRestoredResponse, type IResumeFallbackDeps } from '../../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';
import type { IChatAgentError } from '../../../../../workbench/contrib/chat/common/chatEdaTypes.js';
import type { IChatProgressResponseContent } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';

interface CancelCall { readonly traceId: string; readonly reason?: string }

/**
 * Minimal mock of the recovery client surface. Records every `cancel` call and
 * lets each test configure `getTurnState` (return value or rejection) plus an
 * optional set of trace ids whose `cancel` should reject.
 */
function makeClient(opts: {
	turnState?: { in_flight_traces?: ReadonlyArray<{ trace_id: string }> };
	turnStateError?: Error;
	cancelRejectsFor?: ReadonlySet<string>;
}): I409RecoveryClient & { cancelCalls: CancelCall[]; turnStateCalls: number } {
	const cancelCalls: CancelCall[] = [];
	let turnStateCalls = 0;
	const client: I409RecoveryClient & { cancelCalls: CancelCall[]; turnStateCalls: number } = {
		cancelCalls,
		get turnStateCalls() { return turnStateCalls; },
		async getTurnState(_cs: string) {
			turnStateCalls++;
			if (opts.turnStateError) {
				throw opts.turnStateError;
			}
			return opts.turnState ?? { in_flight_traces: [] };
		},
		async cancel(traceId: string, reason?: string) {
			cancelCalls.push({ traceId, reason });
			if (opts.cancelRejectsFor?.has(traceId)) {
				throw new Error(`cancel failed for ${traceId}`);
			}
			return undefined;
		},
	};
	return client;
}

/** Swallow-and-count the warn calls so we can assert the helper logged. */
function makeWarn(): { fn: (msg: string, ...args: unknown[]) => void; calls: string[] } {
	const calls: string[] = [];
	return { fn: (msg: string) => { calls.push(msg); }, calls };
}

suite('_recoverFrom409Conflict', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('cancels every in-flight trace with reason superseded_by_new_turn', async () => {
		const client = makeClient({
			turnState: { in_flight_traces: [{ trace_id: 'aaa' }, { trace_id: 'bbb' }, { trace_id: 'ccc' }] },
		});
		const warn = makeWarn();

		const count = await _recoverFrom409Conflict(client, 'stateless_chat_x', warn.fn);

		assert.strictEqual(count, 3, 'returns the number of in-flight traces');
		assert.strictEqual(client.turnStateCalls, 1, 'probes /turn_state exactly once');
		assert.deepStrictEqual(
			client.cancelCalls,
			[
				{ traceId: 'aaa', reason: 'superseded_by_new_turn' },
				{ traceId: 'bbb', reason: 'superseded_by_new_turn' },
				{ traceId: 'ccc', reason: 'superseded_by_new_turn' },
			],
			'cancels each stuck trace in order with the supersede reason',
		);
	});

	test('no in-flight traces → nothing cancelled, returns 0', async () => {
		const client = makeClient({ turnState: { in_flight_traces: [] } });
		const warn = makeWarn();

		const count = await _recoverFrom409Conflict(client, 'cs', warn.fn);

		assert.strictEqual(count, 0);
		assert.strictEqual(client.cancelCalls.length, 0, 'no cancel issued when nothing is in flight');
	});

	test('missing in_flight_traces field is treated as empty', async () => {
		const client = makeClient({ turnState: {} });
		const warn = makeWarn();

		const count = await _recoverFrom409Conflict(client, 'cs', warn.fn);

		assert.strictEqual(count, 0);
		assert.strictEqual(client.cancelCalls.length, 0);
	});

	test('one cancel failing does not abort the rest (best-effort)', async () => {
		const client = makeClient({
			turnState: { in_flight_traces: [{ trace_id: 'aaa' }, { trace_id: 'bbb' }, { trace_id: 'ccc' }] },
			cancelRejectsFor: new Set(['bbb']),
		});
		const warn = makeWarn();

		const count = await _recoverFrom409Conflict(client, 'cs', warn.fn);

		assert.strictEqual(count, 3, 'still reports all traces even though one cancel rejected');
		assert.deepStrictEqual(
			client.cancelCalls.map(c => c.traceId),
			['aaa', 'bbb', 'ccc'],
			'every trace is still attempted — the rejected bbb does not stop ccc',
		);
	});

	test('turn_state probe failing is swallowed → returns 0, no cancels, no throw', async () => {
		const client = makeClient({ turnStateError: new Error('network down') });
		const warn = makeWarn();

		const count = await _recoverFrom409Conflict(client, 'cs', warn.fn);

		assert.strictEqual(count, 0, 'probe failure recovers to 0 rather than throwing');
		assert.strictEqual(client.cancelCalls.length, 0, 'no traces to cancel when the probe failed');
		assert.ok(warn.calls.length > 0, 'the probe failure is logged');
	});
});

/**
 * Unit test for `_finalizeUnrecoverableRestoredRow` — the helper the resume
 * probe calls when it has conclusively given up (GET /turn_state failed after
 * bounded retries, or reported no in-flight trace). It must close the restored
 * "zombie" row — the row a stateless turn left on its pre-restart `reconnecting…`
 * progress + unanswered confirm card after an IDE reload — by appending a
 * terminal failure card, but ONLY when that row was genuinely in-flight at
 * restart (the chat model coerces such a row to Cancelled on (de)serialize, so
 * `isCanceled` is the discriminator). A cleanly completed row must be left
 * untouched so the probe-empty path never defaces a good answer.
 */
function makeRestoredResponse(opts: {
	isCanceled: boolean;
	existingParts?: ReadonlyArray<IChatProgressResponseContent>;
}): IFinalizableRestoredResponse & { readonly appended: IChatProgressResponseContent[] } {
	const appended: IChatProgressResponseContent[] = [];
	return {
		appended,
		isCanceled: opts.isCanceled,
		entireResponse: { value: opts.existingParts ?? [] },
		updateContent(part: IChatProgressResponseContent) { appended.push(part); },
	};
}

function makeErrorCard(code = 'TURN_UNRECOVERABLE'): IChatAgentError {
	return { kind: 'agentError', error_code: code, message: '测试：无法恢复', retryable: true };
}

suite('_finalizeUnrecoverableRestoredRow', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('restored in-flight zombie (isCanceled) → appends the terminal card', () => {
		const resp = makeRestoredResponse({ isCanceled: true });
		const card = makeErrorCard();

		const returned = _finalizeUnrecoverableRestoredRow(resp, card, () => { });

		assert.deepStrictEqual(
			{ returned, appended: resp.appended },
			{ returned: true, appended: [card] },
			'a row that was live at restart is closed with exactly the terminal card',
		);
	});

	test('cleanly completed row (not isCanceled) → left untouched', () => {
		const resp = makeRestoredResponse({ isCanceled: false });

		const returned = _finalizeUnrecoverableRestoredRow(resp, makeErrorCard(), () => { });

		assert.deepStrictEqual(
			{ returned, appended: resp.appended },
			{ returned: false, appended: [] },
			'a normally finished answer is never defaced by the probe-empty path',
		);
	});

	test('no last response (undefined) → no-op, returns false', () => {
		const returned = _finalizeUnrecoverableRestoredRow(undefined, makeErrorCard(), () => { });

		assert.strictEqual(returned, false);
	});

	test('idempotent: a terminal card with the same code already present → no double-append', () => {
		const existing = makeErrorCard('TURN_UNRECOVERABLE');
		const resp = makeRestoredResponse({ isCanceled: true, existingParts: [existing] });

		const returned = _finalizeUnrecoverableRestoredRow(resp, makeErrorCard('TURN_UNRECOVERABLE'), () => { });

		assert.deepStrictEqual(
			{ returned, appended: resp.appended },
			{ returned: false, appended: [] },
			're-entry on an already-finalized row must not stack a second card',
		);
	});
});

/**
 * Unit test for `_runResumeWithFallback` — the busy-session defense behind the
 * IDE-restart "继续生成" / "尝试继续" buttons. The button's doResume calls
 * `_sendStatelessResumeRequest`; when the chat session is still busy (the restored
 * row's finalize no-op'd because it wasn't `isCanceled`) that sendRequest is
 * rejected. Without a fallback the click dead-ends silently (reasoner sees zero
 * requests — the original bug). The fix resends the last turn (cancels pending
 * first), and only if even that has nothing to resend surfaces a loud notification.
 *
 * Why a unit test rather than a live repro: the reject path is near-unreachable
 * live — a pending confirm card makes `_sendStatelessResumeRequest` succeed via
 * resolve-confirm (observed: clicking the toast on a busy session yields a
 * `confirm_response`, not a reject). This pins the three branches against a mock
 * deps surface so the silent-dead-end regression can never come back.
 */
suite('_runResumeWithFallback', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function makeDeps(opts: { sendResume: boolean; resendLastTurn?: boolean }): IResumeFallbackDeps & { calls: string[] } {
		const calls: string[] = [];
		return {
			calls,
			async sendResume() { calls.push('sendResume'); return opts.sendResume; },
			resendLastTurn() { calls.push('resendLastTurn'); return opts.resendLastTurn ?? true; },
			notifyDeadEnd() { calls.push('notifyDeadEnd'); },
			warn() { calls.push('warn'); },
		};
	}

	test('sendResume accepted → done, no fallback fires', async () => {
		const deps = makeDeps({ sendResume: true });

		await _runResumeWithFallback(deps);

		assert.deepStrictEqual(deps.calls, ['sendResume'],
			'happy path: resend/notify never fire when /resume is accepted');
	});

	test('sendResume rejected (busy) + a turn to resend → falls back to resend, no loud', async () => {
		const deps = makeDeps({ sendResume: false, resendLastTurn: true });

		await _runResumeWithFallback(deps);

		assert.deepStrictEqual(deps.calls, ['sendResume', 'warn', 'resendLastTurn'],
			'the defense: a busy-rejected /resume resends instead of dead-ending silently');
	});

	test('sendResume rejected + nothing to resend → loud notification, never silent', async () => {
		const deps = makeDeps({ sendResume: false, resendLastTurn: false });

		await _runResumeWithFallback(deps);

		assert.deepStrictEqual(deps.calls, ['sendResume', 'warn', 'resendLastTurn', 'notifyDeadEnd'],
			'if even the resend has no turn, surface a loud notification (never a silent no-op)');
	});
});

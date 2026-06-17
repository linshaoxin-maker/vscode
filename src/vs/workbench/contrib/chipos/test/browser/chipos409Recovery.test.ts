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
import { _recoverFrom409Conflict, type I409RecoveryClient } from '../../../../../workbench/contrib/chipos/browser/chatAgent/chipOSChatAgent.js';

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

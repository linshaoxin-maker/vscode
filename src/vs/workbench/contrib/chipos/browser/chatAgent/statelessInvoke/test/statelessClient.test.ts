/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8b — StatelessClient unit tests.
 *
 * Each test injects a fake ``fetchFn`` so the suite is hermetic (no network,
 * no real reasoner). The fake returns canned ``Response`` objects with
 * synthetic SSE bodies built via ``ReadableStream`` chunking helpers below.
 *
 * Test framework: VS Code uses Mocha-style globals (suite/test) — same
 * convention as the sibling ``types.test.ts`` in this directory. The class
 * itself has no VS Code platform deps, so the tests can equivalently be
 * driven by ``node:test`` (rename ``suite``→``describe``); we go with Mocha
 * here so the file plugs into ``scripts/test.sh`` without further config.
 *
 * Coverage: see the 10 cases enumerated in Phase 0 #8b prompt — each
 * ``test('<name>', …)`` below maps 1:1 to that list.
 */

import * as assert from 'assert';
import {
	StatelessClient,
	StatelessHttpError,
	StatelessReplayExpiredError,
} from '../statelessClient.js';
import type { InvokeEvent, InvokeRequest } from '../types.js';


// ── Test helpers ──────────────────────────────────────────────────────────

/** Build a Response with an SSE body assembled from canned chunks. */
function makeSseResponse(status: number, chunks: ReadonlyArray<string | Uint8Array>): Response {
	const encoder = new TextEncoder();
	const encodedChunks: Uint8Array[] = chunks.map(c =>
		typeof c === 'string' ? encoder.encode(c) : c,
	);
	let i = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < encodedChunks.length) {
				controller.enqueue(encodedChunks[i++]);
			} else {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		status,
		headers: { 'Content-Type': 'text/event-stream' },
	});
}

/** Build a Response with a single JSON body and the given status. */
function makeJsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** Format an event as a single SSE ``data: <json>\n\n`` frame. */
function sseFrame(event: object): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** Collect every event yielded by an AsyncIterable into an array. */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) {
		out.push(x);
	}
	return out;
}

/**
 * Build a minimum-valid InvokeRequest. Tests parameterize trace_id only —
 * the rest of the fields are filler that matches PROTOCOL-SPEC §2.2 shape.
 */
function makeReq(traceId = 'trace-test-001'): InvokeRequest {
	return {
		trace_id: traceId,
		chat_session_id: 'sess-test',
		messages: [{ role: 'user', content: 'hello' }],
		model: 'zhipu/glm-5.1',
		workspace_path: '/tmp/ws',
	};
}

/**
 * Tracked fetch spy — records every call's URL + init so individual tests
 * can assert on what was sent over the wire (headers, body, signal forwarding,
 * etc). ``responder`` lets each test stage a per-URL response.
 */
interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}
function makeFetchSpy(responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const fn: typeof fetch = (input, init) => {
		const url = typeof input === 'string' ? input : (input as URL | Request).toString();
		calls.push({ url, init });
		return Promise.resolve(responder(url, init));
	};
	return { fn, calls };
}


// ── Tests ─────────────────────────────────────────────────────────────────

suite('StatelessClient — Phase 0 #8b', () => {

	const baseUrl = 'http://test.local:8080';

	test('invoke_yields_events_from_sse', async () => {
		const events: InvokeEvent[] = [
			{ type: 'message_start', sequence_id: 1, data: { trace_id: 't', model: 'm' } },
			{ type: 'content_block_delta', sequence_id: 2, data: { index: 0, delta: { type: 'text_delta', text: 'hi' } } },
			{ type: 'round_end', sequence_id: 3, data: { reason: 'end_turn' } },
		];
		const body = events.map(sseFrame).join('');
		const { fn } = makeFetchSpy(() => makeSseResponse(200, [body]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await collect(client.invoke(makeReq()));

		assert.deepStrictEqual(got, events);
	});

	test('invoke_throws_on_http_5xx', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(503, { error: 'stateless_disabled', message: 'set CHIPOS_STATELESS=1' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => collect(client.invoke(makeReq())),
			(err: unknown) => {
				assert.ok(err instanceof StatelessHttpError, `expected StatelessHttpError, got ${err}`);
				assert.strictEqual((err as StatelessHttpError).status, 503);
				const body = (err as StatelessHttpError).body as { error?: string };
				assert.strictEqual(body.error, 'stateless_disabled');
				return true;
			},
		);
	});

	test('invoke_handles_multi_chunk_sse_split_mid_event', async () => {
		// Split a single event payload across 2 chunks so the parser must
		// buffer until \n\n arrives. The split point lands inside the JSON.
		const evt = { type: 'content_block_delta', sequence_id: 1, data: { index: 0, delta: { type: 'text_delta', text: 'hello-world' } } };
		const full = sseFrame(evt);
		const split = Math.floor(full.length / 2);
		const part1 = full.slice(0, split);
		const part2 = full.slice(split);

		const { fn } = makeFetchSpy(() => makeSseResponse(200, [part1, part2]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await collect(client.invoke(makeReq()));

		assert.deepStrictEqual(got, [evt]);
	});

	test('invoke_passes_abort_signal_to_fetch', async () => {
		// Capture the wrapped signal the moment fetch is invoked (i.e. while
		// the request is still "in flight"), so we can test abort propagation
		// without race vs the in-progress async generator's cleanup.
		let capturedSignal: AbortSignal | undefined;
		const responder = (_url: string, init: RequestInit | undefined) => {
			capturedSignal = init?.signal as AbortSignal | undefined;
			return makeSseResponse(200, [sseFrame({ type: 'round_end', sequence_id: 1, data: { reason: 'end_turn' } })]);
		};
		const { fn, calls } = makeFetchSpy(responder);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const ac = new AbortController();
		// Iterate to drive the first fetch (capturedSignal is populated by
		// then), but stop after one event so cleanup hasn't run yet — verify
		// caller-abort propagates while the wrapper is still alive.
		const iter = client.invoke(makeReq(), ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		assert.strictEqual(first.done, false);

		assert.strictEqual(calls.length, 1);
		// The client wraps caller-signal with its own AbortController (so
		// timeout + caller-abort fan into one), so fetch sees a NON-undefined
		// signal but not necessarily ``=== ac.signal``. Aborting the caller
		// signal must propagate — verify that semantic instead of identity.
		assert.ok(capturedSignal, 'expected an AbortSignal to be forwarded to fetch');
		assert.strictEqual(capturedSignal.aborted, false);
		ac.abort(new Error('test cancel'));
		assert.strictEqual(capturedSignal.aborted, true, 'caller-abort must propagate to fetch signal');

		// Drain the iterator to release resources cleanly.
		await iter.return?.(undefined);
	});

	test('invoke_handles_empty_sse_lines_and_comments', async () => {
		// Mix in: leading blank line, two consecutive blank lines (separator
		// noise), comment line, multi-line data field for one event, then a
		// normal trailing event.
		const evtA = { type: 'content_block_delta', sequence_id: 1, data: { delta: 'a' } };
		const evtB = { type: 'round_end', sequence_id: 2, data: { reason: 'end_turn' } };
		const body =
			'\n' +
			': keepalive\n\n' +
			`data: ${JSON.stringify(evtA)}\n\n` +
			': another keepalive\n\n' +
			`data: ${JSON.stringify(evtB)}\n\n`;

		const { fn } = makeFetchSpy(() => makeSseResponse(200, [body]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await collect(client.invoke(makeReq()));

		assert.deepStrictEqual(got, [evtA, evtB]);
	});

	test('cancel_returns_json_202_body', async () => {
		const body = { cancelled: true, trace_id: 't1', reason: 'user_cancelled' };
		const { fn, calls } = makeFetchSpy((url) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/invoke/t1/cancel`);
			return makeJsonResponse(202, body);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await client.cancel('t1', 'user_cancelled');

		assert.deepStrictEqual(got, body);
		assert.strictEqual(calls.length, 1);
	});

	test('cancel_returns_error_body_on_404', async () => {
		const body = { error: 'trace_not_found', trace_id: 't-missing' };
		const { fn } = makeFetchSpy(() => makeJsonResponse(404, body));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		// Must resolve to the body, NOT throw — caller picks how to handle
		// "race between user cancel and natural end".
		const got = await client.cancel('t-missing');

		assert.deepStrictEqual(got, body);
	});

	test('replay_throws_StatelessReplayExpiredError_on_410', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(410, { error: 'replay_window_expired', trace_id: 't-old' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => collect(client.replay('t-old', 0)),
			(err: unknown) => {
				assert.ok(err instanceof StatelessReplayExpiredError, `expected StatelessReplayExpiredError, got ${err}`);
				assert.strictEqual((err as StatelessReplayExpiredError).traceId, 't-old');
				return true;
			},
		);
	});

	test('replay_yields_events_from_sse_like_invoke', async () => {
		const events: InvokeEvent[] = [
			{ type: 'content_block_delta', sequence_id: 4, data: { delta: 'd' } },
			{ type: 'content_block_delta', sequence_id: 5, data: { delta: 'e' } },
			{ type: 'round_end', sequence_id: 6, data: { reason: 'end_turn' } },
		];
		const body = events.map(sseFrame).join('');
		const { fn, calls } = makeFetchSpy((url) => {
			// Replay endpoint must include the query string with last_sequence_id.
			assert.ok(
				url.endsWith('/api/v1/replay/t-replay?last_sequence_id=3'),
				`unexpected url ${url}`,
			);
			return makeSseResponse(200, [body]);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await collect(client.replay('t-replay', 3));

		assert.deepStrictEqual(got, events);
		assert.strictEqual(calls.length, 1);
	});

	test('compact_returns_typed_response', async () => {
		const body = {
			summary_message: {
				role: 'user',
				content: 'Summary text',
				is_compact_summary: true,
				is_visible_in_transcript_only: true,
			},
			tokens_in: 1500,
			tokens_out: 420,
			cost_usd: 0.0042,
		};
		const { fn, calls } = makeFetchSpy((url, init) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/compact`);
			assert.strictEqual(init?.method, 'POST');
			return makeJsonResponse(200, body);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await client.compact({
			trace_id: 'c1',
			chat_session_id: 's1',
			messages: [{ role: 'user', content: 'old turn' }],
			model: 'zhipu/glm-5.1',
		});

		assert.strictEqual(got.tokens_in, 1500);
		assert.strictEqual(got.tokens_out, 420);
		assert.strictEqual(got.cost_usd, 0.0042);
		assert.strictEqual(got.summary_message.is_compact_summary, true);
		assert.strictEqual(calls.length, 1);
	});
});

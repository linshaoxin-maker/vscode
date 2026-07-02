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
	StatelessResumeNotFoundError,
} from '../statelessClient.js';
import type {
	ConfirmResponseRequest,
	InvokeEvent,
	InvokeRequest,
	RegisterToolsRequest,
	RegisterToolsResponse,
	ResumeRequest,
	ToolResultRequest,
	TurnStateResponse,
} from '../types.js';


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
		// Phase 1: required (ADR-018 §2 D9). Opaque hash returned by an
		// earlier /tools/register; tests can use any literal here.
		expected_catalog_version: 'cat-v-test',
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
		// Capture the wrapped signal the moment fetch is invoked, and keep the
		// SSE stream OPEN (no close) so the request is genuinely in flight when
		// the caller aborts — the transport releases its signal wiring as soon
		// as a stream finishes, so abort propagation is only promised for a
		// live stream (matching the real cancel-an-inflight-turn use).
		let capturedSignal: AbortSignal | undefined;
		const encoder = new TextEncoder();
		const responder = (_url: string, init: RequestInit | undefined) => {
			capturedSignal = init?.signal as AbortSignal | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					// One frame, then hold the stream open (no close()).
					controller.enqueue(encoder.encode(sseFrame({ type: 'content_block_delta', sequence_id: 1, data: { delta: 'x' } })));
				},
			});
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		};
		const { fn, calls } = makeFetchSpy(responder);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const ac = new AbortController();
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

		// Release the iterator. (A REAL fetch would reject the pending read on
		// abort and the iterator would throw; the mock Response's stream does
		// not model abort, so end via return() which never depends on it.)
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

	// (The Phase 0 `replay()` method was removed in M3b: zero call sites — the
	// IDE recovers SSE drops via `resume()` below. Its 410 semantics live on in
	// resume_throws_StatelessReplayExpiredError_on_410.)

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


// ── Phase 1 Tests (ADR-018 reverse-channel + resume) ─────────────────────

suite('StatelessClient — Phase 1 (ADR-018)', () => {

	const baseUrl = 'http://test.local:8080';

	// registerTools ─────────────────────────────────────────────────────────

	test('registerTools_returns_catalog_version', async () => {
		const respBody: RegisterToolsResponse = {
			catalog_version: 'abc1234567890def',
			accepted_tool_count: 2,
			rejected: [],
		};
		const { fn, calls } = makeFetchSpy((url, init) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/tools/register`);
			assert.strictEqual(init?.method, 'POST');
			const headers = init?.headers as Record<string, string>;
			assert.strictEqual(headers['Content-Type'], 'application/json');
			return makeJsonResponse(200, respBody);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const req: RegisterToolsRequest = {
			chat_session_id: 'sess-1',
			tools: [
				{ name: 'read_file', description: 'read', input_schema: {}, chipos_source: 'ide_builtin' },
				{ name: 'bash', description: 'shell', input_schema: {}, chipos_source: 'worker_mcp' },
			],
		};
		const got = await client.registerTools(req);

		assert.deepStrictEqual(got, respBody);
		assert.strictEqual(calls.length, 1);
	});

	test('registerTools_throws_StatelessHttpError_on_5xx', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(500, { error: 'internal_error', message: 'cache write failed' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => client.registerTools({ chat_session_id: 's', tools: [] }),
			(err: unknown) => {
				assert.ok(err instanceof StatelessHttpError);
				assert.strictEqual((err as StatelessHttpError).status, 500);
				return true;
			},
		);
	});

	// postToolResult ────────────────────────────────────────────────────────

	test('postToolResult_returns_accepted_on_202', async () => {
		const { fn, calls } = makeFetchSpy((url, init) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/tool_result/t1/call-abc`);
			assert.strictEqual(init?.method, 'POST');
			// 202 success — backend may return empty body
			return new Response(null, { status: 202 });
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const req: ToolResultRequest = { call_id: 'call-abc', content: 'tool output' };
		const got = await client.postToolResult('t1', 'call-abc', req);

		assert.deepStrictEqual(got, { accepted: true });
		assert.strictEqual(calls.length, 1);
	});

	test('postToolResult_returns_error_body_on_404_stale_call', async () => {
		const body = { error: 'call_not_found', call_id: 'call-stale' };
		const { fn } = makeFetchSpy(() => makeJsonResponse(404, body));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		// 404 = benign stale POST per PHASE-1-PROTOCOL-SPEC §4.2 — must NOT throw.
		const got = await client.postToolResult('t1', 'call-stale', { call_id: 'call-stale', content: '' });

		assert.deepStrictEqual(got, body);
	});

	test('postToolResult_throws_StatelessHttpError_on_5xx', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(500, { error: 'internal_error' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => client.postToolResult('t1', 'call-x', { call_id: 'call-x', content: '' }),
			(err: unknown) => {
				assert.ok(err instanceof StatelessHttpError);
				assert.strictEqual((err as StatelessHttpError).status, 500);
				return true;
			},
		);
	});

	test('postToolResult_url_encodes_path_params', async () => {
		// Defense in depth — even though trace_id / call_id are normally UUIDs,
		// any future change to id format must not produce broken URLs.
		const { fn, calls } = makeFetchSpy(() => new Response(null, { status: 202 }));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await client.postToolResult('trace with space', 'call/slash', { call_id: 'call/slash', content: '' });

		assert.strictEqual(
			calls[0].url,
			`${baseUrl}/api/v1/tool_result/trace%20with%20space/call%2Fslash`,
		);
	});

	// postConfirmResponse ───────────────────────────────────────────────────

	test('postConfirmResponse_returns_accepted_on_202', async () => {
		const { fn, calls } = makeFetchSpy((url) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/confirm_response/t1/req-xyz`);
			return new Response(null, { status: 202 });
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const req: ConfirmResponseRequest = { request_id: 'req-xyz', action: 'approve' };
		const got = await client.postConfirmResponse('t1', 'req-xyz', req);

		assert.deepStrictEqual(got, { accepted: true });
		assert.strictEqual(calls.length, 1);
	});

	test('postConfirmResponse_returns_error_body_on_404', async () => {
		const body = { error: 'request_not_found', request_id: 'req-stale' };
		const { fn } = makeFetchSpy(() => makeJsonResponse(404, body));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await client.postConfirmResponse('t1', 'req-stale', {
			request_id: 'req-stale',
			action: 'approve',
		});

		assert.deepStrictEqual(got, body);
	});

	test('postConfirmResponse_throws_on_400_invalid_action', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(400, { error: 'invalid_format', message: 'unknown action_id' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => client.postConfirmResponse('t1', 'r1', { request_id: 'r1', action: 'bogus' }),
			(err: unknown) => {
				assert.ok(err instanceof StatelessHttpError);
				assert.strictEqual((err as StatelessHttpError).status, 400);
				return true;
			},
		);
	});

	// resume ────────────────────────────────────────────────────────────────

	test('resume_yields_events_from_sse_like_invoke', async () => {
		const events: InvokeEvent[] = [
			{ type: 'content_block_delta', sequence_id: 5, data: { delta: 'continued' } },
			{ type: 'resumed_buffer_drained', sequence_id: 6, data: { sequence_id: 6 } },
		];
		const body = events.map(sseFrame).join('');
		const { fn, calls } = makeFetchSpy((url, init) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/resume/sess-1`);
			assert.strictEqual(init?.method, 'POST');
			const headers = init?.headers as Record<string, string>;
			assert.strictEqual(headers['Content-Type'], 'application/json');
			return makeSseResponse(200, [body]);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const req: ResumeRequest = { trace_id: 't-live', last_sequence_id: 4 };
		const got = await collect(client.resume('sess-1', req));

		assert.deepStrictEqual(got, events);
		assert.strictEqual(calls.length, 1);
	});

	test('resume_throws_StatelessResumeNotFoundError_on_404', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(404, { error: 'trace_not_found', trace_id: 't-done' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => collect(client.resume('sess-1', { trace_id: 't-done', last_sequence_id: 0 })),
			(err: unknown) => {
				assert.ok(
					err instanceof StatelessResumeNotFoundError,
					`expected StatelessResumeNotFoundError, got ${err}`,
				);
				assert.strictEqual((err as StatelessResumeNotFoundError).traceId, 't-done');
				return true;
			},
		);
	});

	test('resume_throws_StatelessReplayExpiredError_on_410', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(410, { error: 'replay_window_expired', trace_id: 't-old' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => collect(client.resume('sess-1', { trace_id: 't-old', last_sequence_id: 0 })),
			(err: unknown) => {
				assert.ok(
					err instanceof StatelessReplayExpiredError,
					`expected StatelessReplayExpiredError, got ${err}`,
				);
				assert.strictEqual((err as StatelessReplayExpiredError).traceId, 't-old');
				return true;
			},
		);
	});

	// getTurnState ──────────────────────────────────────────────────────────

	test('getTurnState_returns_typed_response', async () => {
		const body: TurnStateResponse = {
			chat_session_id: 'sess-1',
			in_flight_traces: [
				{
					trace_id: 't-running',
					started_at: 1716800000000,
					last_checkpoint_seq: 7,
					state: 'running',
					last_user_message_preview: 'refactor this file...',
				},
			],
		};
		const { fn, calls } = makeFetchSpy((url, init) => {
			assert.strictEqual(url, `${baseUrl}/api/v1/turn_state/sess-1`);
			assert.strictEqual(init?.method, 'GET');
			return makeJsonResponse(200, body);
		});
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const got = await client.getTurnState('sess-1');

		assert.deepStrictEqual(got, body);
		assert.strictEqual(calls.length, 1);
	});

	test('getTurnState_returns_empty_on_404_unknown_session', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(404, { error: 'chat_session_not_found' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		// Unknown chat_session_id is functionally equivalent to "no in-flight
		// traces" — synthesise empty result rather than throw.
		const got = await client.getTurnState('sess-unknown');

		assert.deepStrictEqual(got, {
			chat_session_id: 'sess-unknown',
			in_flight_traces: [],
		});
	});

	test('getTurnState_throws_StatelessHttpError_on_5xx', async () => {
		const { fn } = makeFetchSpy(() =>
			makeJsonResponse(503, { error: 'stateless_disabled' }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await assert.rejects(
			() => client.getTurnState('sess-1'),
			(err: unknown) => {
				assert.ok(err instanceof StatelessHttpError);
				assert.strictEqual((err as StatelessHttpError).status, 503);
				return true;
			},
		);
	});

	test('getTurnState_url_encodes_chat_session_id', async () => {
		const { fn, calls } = makeFetchSpy(() => makeJsonResponse(200, {
			chat_session_id: 'with space',
			in_flight_traces: [],
		}));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		await client.getTurnState('with space');

		assert.strictEqual(calls[0].url, `${baseUrl}/api/v1/turn_state/with%20space`);
	});

	test('registerTools_sets_bearer_token_when_configured', async () => {
		// Spot-check auth header propagation for the new endpoints — uses
		// registerTools as a representative non-SSE method (resume / SSE auth
		// is covered by the existing invoke tests + shared _sseRequest path).
		const { fn, calls } = makeFetchSpy(() =>
			makeJsonResponse(200, { catalog_version: 'v1', accepted_tool_count: 0, rejected: [] }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn, authToken: 'secret-token' });

		await client.registerTools({ chat_session_id: 's', tools: [] });

		const headers = calls[0].init?.headers as Record<string, string>;
		assert.strictEqual(headers['Authorization'], 'Bearer secret-token');
	});

	test('authTokenProvider is resolved FRESH per request (P0.5 — expired-JWT 401 on resume)', async () => {
		// Live-found regression: the client captured the token ONCE at
		// construction, so a long-lived turn's late /resume + /confirm_response
		// fired with an EXPIRED JWT → 401 at the ~10-min mark. The provider must
		// be consulted on EVERY request so getAccessToken's near-expiry refresh
		// keeps the Authorization header fresh. Here the provider hands out a new
		// token each call (simulating a refresh between requests).
		let n = 0;
		const provider = async () => `tok-${++n}`;
		const { fn, calls } = makeFetchSpy(() =>
			makeJsonResponse(200, { catalog_version: 'v', accepted_tool_count: 0, rejected: [] }),
		);
		const client = new StatelessClient({ baseUrl, fetchFn: fn, authTokenProvider: provider });

		await client.registerTools({ chat_session_id: 's', tools: [] });
		await client.registerTools({ chat_session_id: 's', tools: [] });

		const h0 = calls[0].init?.headers as Record<string, string>;
		const h1 = calls[1].init?.headers as Record<string, string>;
		assert.deepStrictEqual(
			[h0['Authorization'], h1['Authorization']],
			['Bearer tok-1', 'Bearer tok-2'],
		);
	});
});


// ── push→pull bridge edge cases (M3b toAsyncIterable) ─────────────────────

suite('StatelessClient — AsyncIterable bridge edges', () => {

	const baseUrl = 'http://test.local:8080';

	/** An SSE Response whose stream emits `frames` then HOLDS OPEN (never closes). */
	function makeHeldSseResponse(frames: string[]): Response {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const f of frames) { controller.enqueue(encoder.encode(f)); }
				// no close() — in flight until the client aborts.
			},
		});
		return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
	}

	test('bridge_is_lazy_no_fetch_until_first_next', async () => {
		const { fn, calls } = makeFetchSpy(() => makeSseResponse(200, [sseFrame({ type: 'round_end', sequence_id: 1, data: { reason: 'end_turn' } })]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const iterable = client.invoke(makeReq());
		// Constructing (and even getting an iterator) must not fire the request.
		const iter = iterable[Symbol.asyncIterator]();
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(calls.length, 0, 'no fetch before first next()');

		const first = await iter.next();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(first.done, false);
		await iter.return?.(undefined);
	});

	test('bridge_supports_concurrent_next_calls', async () => {
		// Two next() calls awaited TOGETHER while the stream is still open: both
		// must resolve (one per event) — a single-waiter bridge would hang one.
		const { fn } = makeFetchSpy(() => makeHeldSseResponse([
			sseFrame({ type: 'content_block_delta', sequence_id: 1, data: { i: 1 } }),
			sseFrame({ type: 'content_block_delta', sequence_id: 2, data: { i: 2 } }),
		]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const iter = client.invoke(makeReq())[Symbol.asyncIterator]();
		const [a, b] = await Promise.all([iter.next(), iter.next()]);
		assert.strictEqual(a.done, false);
		assert.strictEqual(b.done, false);
		assert.deepStrictEqual(
			[(a.value.data as { i: number }).i, (b.value.data as { i: number }).i].sort(),
			[1, 2],
		);
		await iter.return?.(undefined);
	});

	test('bridge_return_wakes_pending_next_as_done', async () => {
		// A next() parked on an idle (held-open, no more frames) stream must be
		// released as {done:true} when the consumer calls return().
		const { fn } = makeFetchSpy(() => makeHeldSseResponse([
			sseFrame({ type: 'message_start', sequence_id: 1, data: {} }),
		]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const iter = client.invoke(makeReq())[Symbol.asyncIterator]();
		const first = await iter.next();
		assert.strictEqual(first.done, false);

		const pending = iter.next(); // parks — no more frames are coming
		const ret = await iter.return?.(undefined);
		assert.strictEqual(ret?.done, true);
		const released = await pending;
		assert.strictEqual(released.done, true, 'parked next() must resolve done after return()');
	});

	test('bridge_is_single_shot_second_iteration_throws', async () => {
		// Re-iterating the SAME iterable would re-POST the same trace_id (a
		// duplicate turn server-side) — the latch turns that misuse into a loud
		// error instead. Retries must call invoke()/resume() again.
		const { fn, calls } = makeFetchSpy(() => makeSseResponse(200, [sseFrame({ type: 'round_end', sequence_id: 1, data: { reason: 'end_turn' } })]));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const iterable = client.invoke(makeReq());
		const got = await collect(iterable);
		assert.strictEqual(got.length, 1);
		assert.strictEqual(calls.length, 1);

		assert.throws(() => iterable[Symbol.asyncIterator](), /single-shot/);
		assert.strictEqual(calls.length, 1, 'no second POST from the latched iterable');
	});

	test('bridge_surfaces_run_failure_once_then_done', async () => {
		const { fn } = makeFetchSpy(() => makeJsonResponse(500, { error: 'boom' }));
		const client = new StatelessClient({ baseUrl, fetchFn: fn });

		const iter = client.invoke(makeReq())[Symbol.asyncIterator]();
		await assert.rejects(() => iter.next(), (e: unknown) => e instanceof StatelessHttpError && (e as StatelessHttpError).status === 500);
		// The failure is surfaced exactly once; a follow-up next() ends cleanly.
		const after = await iter.next();
		assert.strictEqual(after.done, true);
	});
});

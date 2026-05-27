/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8d — tests for `ConversationCompactor`.
 *
 * Covers:
 *   - chars/4 token estimation across string + ContentBlock variants
 *   - threshold-based `shouldCompact()` decision
 *   - happy-path compact: split → /compact → [summary, ...recent]
 *   - idempotency: pre-existing summary folded into new compact input
 *   - tool_use/tool_result pair retention inside the recent window
 *   - server failure surfaces as a rejected promise
 *   - summary marker fields normalized on output
 *   - constructor options propagate to the CompactRequest
 *
 * Test runner: VS Code mocha-style `suite`/`test` (matches adjacent
 * `types.test.ts`), assertions via `node:assert`.
 *
 * The `StatelessClient` collaborator is faked: tests pass a tiny object
 * exposing only `compact()` (the structural `IStatelessCompactClient` shape).
 */

import assert from 'assert';
import {
	ConversationCompactor,
	type IStatelessCompactClient,
} from '../conversationCompactor.js';
import type {
	CompactRequest,
	CompactResponse,
	Message,
} from '../types.js';

// =============================================================================
// Fake StatelessClient: records every /compact call + returns a canned response.
// =============================================================================

class FakeStatelessClient implements IStatelessCompactClient {
	readonly received: CompactRequest[] = [];
	private readonly _canned: CompactResponse;

	constructor(canned?: Partial<CompactResponse>) {
		this._canned = {
			summary_message: {
				role: 'user',
				content: canned?.summary_message?.content ?? '[fake summary]',
				is_compact_summary: canned?.summary_message?.is_compact_summary ?? true,
				is_visible_in_transcript_only:
					canned?.summary_message?.is_visible_in_transcript_only ?? true,
			},
			tokens_in: canned?.tokens_in ?? 100,
			tokens_out: canned?.tokens_out ?? 50,
			cost_usd: canned?.cost_usd ?? 0,
		};
	}

	async compact(req: CompactRequest): Promise<CompactResponse> {
		this.received.push(req);
		return this._canned;
	}
}

class ThrowingStatelessClient implements IStatelessCompactClient {
	async compact(_req: CompactRequest): Promise<CompactResponse> {
		throw new Error('llm_call_failed: provider 500');
	}
}

// =============================================================================
// Conversation builders — keep test bodies short by hoisting fixture shapes.
// =============================================================================

/**
 * Build N turns of (user → assistant) plain-text chat. Each user message
 * carries `userPrefix + idx`, each assistant reply carries `assistantPrefix + idx`.
 */
function makeTurns(n: number, userPrefix = 'u', assistantPrefix = 'a'): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < n; i++) {
		out.push({ role: 'user', content: `${userPrefix}${i}` });
		out.push({ role: 'assistant', content: `${assistantPrefix}${i}` });
	}
	return out;
}

// =============================================================================
// Suite
// =============================================================================

suite('statelessInvoke/conversationCompactor — Phase 0 #8d', () => {

	// ─────────────────────────────────────────────────────────────────
	// estimateTokens
	// ─────────────────────────────────────────────────────────────────

	test('test_estimate_tokens_simple_string', () => {
		// chars/4 heuristic: 8 chars + 4 chars = 12 chars → ceil(12/4) = 3
		const compactor = new ConversationCompactor(new FakeStatelessClient());
		const messages: Message[] = [
			{ role: 'user', content: 'abcd1234' }, // 8 chars
			{ role: 'assistant', content: 'wxyz' }, // 4 chars
		];
		assert.strictEqual(compactor.estimateTokens(messages), 3);
	});

	test('test_estimate_tokens_with_content_blocks', () => {
		// text "hello" (5) + tool_use name "read_file" (9) + JSON({"path":"/x"}) (14)
		//   + tool_result content "ok" (2) = 30 chars → ceil(30/4) = 8
		const compactor = new ConversationCompactor(new FakeStatelessClient());
		const messages: Message[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'hello' },
					{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/x' } },
				],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
			},
		];
		assert.strictEqual(compactor.estimateTokens(messages), 8);
	});

	// ─────────────────────────────────────────────────────────────────
	// shouldCompact
	// ─────────────────────────────────────────────────────────────────

	test('test_should_compact_below_threshold_returns_false', () => {
		const compactor = new ConversationCompactor(new FakeStatelessClient(), {
			triggerThresholdTokens: 100,
		});
		// 4 chars → 1 token, well below 100.
		assert.strictEqual(
			compactor.shouldCompact([{ role: 'user', content: 'tiny' }]),
			false,
		);
	});

	test('test_should_compact_above_threshold_returns_true', () => {
		const compactor = new ConversationCompactor(new FakeStatelessClient(), {
			triggerThresholdTokens: 10,
		});
		// 80 chars → 20 tokens, above 10.
		assert.strictEqual(
			compactor.shouldCompact([{ role: 'user', content: 'x'.repeat(80) }]),
			true,
		);
	});

	// ─────────────────────────────────────────────────────────────────
	// compact — happy path
	// ─────────────────────────────────────────────────────────────────

	test('test_compact_happy_path_emits_summary_plus_recent_turns', async () => {
		// 10 turns total, keep last 3 → /compact sees 7 old turns (14 messages).
		const fake = new FakeStatelessClient({
			summary_message: {
				role: 'user',
				content: 'Summary of first 7 turns',
				is_compact_summary: true,
				is_visible_in_transcript_only: true,
			},
		});
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 3 });
		const conv = makeTurns(10);

		const out = await compactor.compact(conv, 'sess-1', 'trace-compact-1');

		// Output shape: [summary, last-3-turns × 2 msgs each] = 7
		assert.strictEqual(out.length, 1 + 3 * 2);
		assert.strictEqual(out[0].content, 'Summary of first 7 turns');
		assert.strictEqual(out[0].is_compact_summary, true);
		// Recent slice starts at user "u7" (turns 7,8,9 kept).
		assert.strictEqual((out[1] as Message).content, 'u7');
		assert.strictEqual((out[out.length - 1] as Message).content, 'a9');

		// Server saw exactly the 7 old turns (14 messages).
		assert.strictEqual(fake.received.length, 1);
		assert.strictEqual(fake.received[0].messages.length, 7 * 2);
		assert.strictEqual(fake.received[0].messages[0].content, 'u0');
		assert.strictEqual(fake.received[0].trace_id, 'trace-compact-1');
		assert.strictEqual(fake.received[0].chat_session_id, 'sess-1');
	});

	// ─────────────────────────────────────────────────────────────────
	// compact — idempotency
	// ─────────────────────────────────────────────────────────────────

	test('test_compact_preserves_existing_summary_via_idempotency', async () => {
		// Conversation starts with an existing summary, then 8 turns. Compacting
		// with keepRecentTurns=3 should:
		//   - peel the old summary off
		//   - send <previous_summary>old</previous_summary> + first 5 turns to /compact
		//   - return [new_summary, last 3 turns × 2 msgs]   (old summary NOT in output)
		const fake = new FakeStatelessClient({
			summary_message: {
				role: 'user',
				content: 'merged summary',
				is_compact_summary: true,
				is_visible_in_transcript_only: true,
			},
		});
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 3 });

		const oldSummary: Message = {
			role: 'user',
			content: 'PREVIOUS_SUMMARY_TEXT',
			is_compact_summary: true,
			is_visible_in_transcript_only: true,
		};
		const conv: Message[] = [oldSummary, ...makeTurns(8)];

		const out = await compactor.compact(conv, 'sess-2', 'trace-compact-2');

		// Output: exactly one summary at head, then recent 3 turns × 2 msgs.
		assert.strictEqual(out.length, 1 + 3 * 2);
		assert.strictEqual(out[0].content, 'merged summary');
		// Crucially: the OLD summary text is NOT present anywhere in output.
		for (const m of out) {
			assert.notStrictEqual(m.content, 'PREVIOUS_SUMMARY_TEXT');
		}

		// Server input: first message is the synthetic <previous_summary> wrapper,
		// followed by the 5 oldest turns (10 messages).
		const sentMessages = fake.received[0].messages;
		assert.strictEqual(sentMessages.length, 1 + 5 * 2);
		assert.match(
			sentMessages[0].content as string,
			/<previous_summary>[\s\S]*PREVIOUS_SUMMARY_TEXT[\s\S]*<\/previous_summary>/,
		);
		assert.strictEqual(sentMessages[1].content, 'u0');
		assert.strictEqual(sentMessages[sentMessages.length - 1].content, 'a4');
	});

	// ─────────────────────────────────────────────────────────────────
	// compact — error propagation
	// ─────────────────────────────────────────────────────────────────

	test('test_compact_throws_on_endpoint_failure', async () => {
		const compactor = new ConversationCompactor(new ThrowingStatelessClient(), {
			keepRecentTurns: 2,
		});
		const conv = makeTurns(6);

		await assert.rejects(
			() => compactor.compact(conv, 'sess-3', 'trace-compact-3'),
			(err: Error) => /llm_call_failed/.test(err.message),
		);
	});

	// ─────────────────────────────────────────────────────────────────
	// recent-turns split with tool_use/tool_result pairs
	// ─────────────────────────────────────────────────────────────────

	test('test_recent_turns_split_with_tool_use_pair', async () => {
		// Build a conversation where the most recent activity is a turn that
		// fans out into tool_use/tool_result before the final assistant reply.
		// keepRecentTurns=2 means we must keep BOTH user-initiated turns at
		// the end plus everything they pull along (tool_use/result wrappers).
		//
		// Layout (10 messages, 2 user-initiated turns at the tail):
		//   [0] user "old_u0"             ← old turn 1 (turn-starter)
		//   [1] assistant "old_a0"
		//   [2] user "old_u1"             ← old turn 2 (turn-starter)
		//   [3] assistant "old_a1"
		//   [4] user "RECENT_FIRST"       ← recent turn 1 (turn-starter)
		//   [5] assistant tool_use(read_file)
		//   [6] user tool_result          ← NOT a turn-starter (pure tool_result)
		//   [7] assistant "after tool"
		//   [8] user "RECENT_SECOND"      ← recent turn 2 (turn-starter)
		//   [9] assistant "final"
		const conv: Message[] = [
			{ role: 'user', content: 'old_u0' },
			{ role: 'assistant', content: 'old_a0' },
			{ role: 'user', content: 'old_u1' },
			{ role: 'assistant', content: 'old_a1' },
			{ role: 'user', content: 'RECENT_FIRST' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'let me read it' },
					{ type: 'tool_use', id: 'toolu_x', name: 'read_file', input: { path: '/a' } },
				],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'file body' }],
			},
			{ role: 'assistant', content: 'after tool' },
			{ role: 'user', content: 'RECENT_SECOND' },
			{ role: 'assistant', content: 'final' },
		];

		const fake = new FakeStatelessClient();
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 2 });
		const out = await compactor.compact(conv, 'sess-4', 'trace-compact-4');

		// Expected: [summary] + messages[4..9] kept = 1 + 6 = 7
		assert.strictEqual(out.length, 7);
		assert.strictEqual((out[1] as Message).content, 'RECENT_FIRST');
		// Make sure the tool_use/tool_result pair survived intact and stayed
		// adjacent — the pair must NOT be split across the summary boundary.
		const recent = out.slice(1) as Message[];
		const toolUseIdx = recent.findIndex(
			m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'),
		);
		const toolResultIdx = recent.findIndex(
			m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'),
		);
		assert.ok(toolUseIdx >= 0, 'tool_use survived in recent slice');
		assert.strictEqual(toolResultIdx, toolUseIdx + 1, 'tool_use immediately followed by tool_result');
		// Server saw 2 old turns (4 messages).
		assert.strictEqual(fake.received[0].messages.length, 4);
	});

	// ─────────────────────────────────────────────────────────────────
	// summary marker normalization
	// ─────────────────────────────────────────────────────────────────

	test('test_summary_message_has_correct_marker_fields', async () => {
		// Even if the server returned WITHOUT the markers (buggy provider),
		// the compactor must normalize them to true on output.
		const fake = new FakeStatelessClient({
			summary_message: {
				role: 'user',
				content: 'unmarked summary',
				// markers intentionally omitted/false:
				is_compact_summary: false,
				is_visible_in_transcript_only: false,
			},
		});
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 2 });
		const out = await compactor.compact(makeTurns(5), 'sess-5', 'trace-compact-5');

		assert.strictEqual(out[0].is_compact_summary, true);
		assert.strictEqual(out[0].is_visible_in_transcript_only, true);
		assert.strictEqual(out[0].role, 'user');
		assert.strictEqual(out[0].content, 'unmarked summary');
	});

	// ─────────────────────────────────────────────────────────────────
	// option propagation
	// ─────────────────────────────────────────────────────────────────

	test('test_compact_request_uses_configured_max_summary_tokens', async () => {
		const fake = new FakeStatelessClient();
		const compactor = new ConversationCompactor(fake, {
			keepRecentTurns: 2,
			maxSummaryTokens: 1234,
			summaryModel: 'test-model-id',
		});

		await compactor.compact(makeTurns(5), 'sess-6', 'trace-compact-6');

		assert.strictEqual(fake.received.length, 1);
		assert.strictEqual(fake.received[0].max_summary_tokens, 1234);
		assert.strictEqual(fake.received[0].model, 'test-model-id');
	});

	// ─────────────────────────────────────────────────────────────────
	// extra defensive cases (bring suite to >10)
	// ─────────────────────────────────────────────────────────────────

	test('test_compact_short_circuits_when_no_old_turns', async () => {
		// Only 2 turns total, keepRecentTurns=5 → nothing to summarize.
		// /compact must NOT be called; return input unchanged.
		const fake = new FakeStatelessClient();
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 5 });
		const conv = makeTurns(2);

		const out = await compactor.compact(conv, 'sess-7', 'trace-compact-7');

		assert.strictEqual(fake.received.length, 0);
		assert.deepStrictEqual(out, conv);
	});

	test('test_compact_short_circuits_preserves_existing_summary', async () => {
		// Existing summary + only 2 fresh turns + keepRecentTurns=5 → no new
		// old turns to fold. Output must be [existingSummary, ...all 2 turns].
		const fake = new FakeStatelessClient();
		const compactor = new ConversationCompactor(fake, { keepRecentTurns: 5 });
		const oldSummary: Message = {
			role: 'user',
			content: 'OLD_SUMMARY',
			is_compact_summary: true,
			is_visible_in_transcript_only: true,
		};
		const conv: Message[] = [oldSummary, ...makeTurns(2)];

		const out = await compactor.compact(conv, 'sess-8', 'trace-compact-8');

		assert.strictEqual(fake.received.length, 0);
		assert.strictEqual(out.length, 1 + 2 * 2);
		assert.strictEqual(out[0].content, 'OLD_SUMMARY');
	});
});

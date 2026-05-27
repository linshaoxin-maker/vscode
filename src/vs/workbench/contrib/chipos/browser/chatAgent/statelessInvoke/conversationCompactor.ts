/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8d — `ConversationCompactor`.
 *
 * IDE-owned conversation compaction (C 档 stateless reasoner, ADR-017 §11.1 + Q3
 * decision = Plan B: client owns trigger, server owns the LLM summarize call).
 *
 * Pipeline
 * ---------
 * 1. IDE-side chat agent calls `shouldCompact(messages)` before each invoke
 *    (or the user types `/compact`).
 * 2. When true (or manual trigger), the agent calls `compact(messages, sid, tid)`.
 * 3. We split the conversation into [old turns, recent N turns], POST the old
 *    turns to `POST /api/v1/compact` via `StatelessClient.compact()`, take the
 *    returned `summary_message`, and return `[summary_message, ...recent_turns]`.
 * 4. Caller writes the new array back to `chatSessions/<id>.jsonl` and uses it
 *    for the next invoke.
 *
 * Idempotency (algorithm decision #6)
 * -----------------------------------
 * If `messages[0]` is already an `is_compact_summary` message, we PREPEND its
 * text content (wrapped in `<previous_summary>` tags) into the messages sent
 * to `/compact`, then drop the old summary from the output. The server folds
 * old + new context into a single summary — no "summary of summary of summary"
 * stacking that would silently grow the token budget across many compactions.
 *
 * Turn boundary semantics (algorithm decision #3)
 * -----------------------------------------------
 * A "turn" starts with a user message that carries genuine user input — i.e.
 * a string content OR a content-block list with at least one non-`tool_result`
 * block. Pure-`tool_result` user messages (the wrappers we synthesize to feed
 * tool output back to the assistant) are NOT turn starters; they get absorbed
 * into the surrounding turn together with the assistant's prior `tool_use` and
 * the assistant's follow-up reply. Walking backward from end-of-conversation,
 * we count N such turn-starters and keep everything from the Nth starter
 * onward as "recent".
 *
 * Token estimation (algorithm decision #2)
 * ----------------------------------------
 * Chars / 4 heuristic, summed across every text-bearing field in every message
 * (string content; TextBlock.text; ToolUseBlock.name + serialized input;
 * ToolResultBlock.content). NOT a real tokenizer — accurate to ~2× across
 * Chinese / English / code mixes, plenty good enough as a trigger heuristic.
 * Anything that needs LLM-grade accuracy should use the server's `tokens_in`
 * reported on `CompactResponse`.
 *
 * Related
 * -------
 * - Spec   : `PHASE-0-PROTOCOL-SPEC.md` §6 — endpoint contract
 * - ADR    : `ADR-017-c-stateless-reasoner-design.md` §11.1 — Claude Code reference
 * - Server : `backend_v2/packages/reasoning/src/reasoning/server/stateless_compact.py`
 */

import type {
	CompactRequest,
	CompactResponse,
	ContentBlock,
	Message,
	TextBlock,
} from './types.js';

// =============================================================================
// StatelessClient seam — Phase 0 #8b is shipping in parallel; if its module
// isn't on disk yet at integration time, this minimal structural type lets the
// compactor compile + test in isolation. Once #8b lands, replace this with:
//     import type { StatelessClient } from './statelessClient.js';
// and delete the inline interface below (no behavior change — same shape).
// =============================================================================

/**
 * Structural contract for the chunk of `StatelessClient` we need: a single
 * `compact()` method that POSTs to `/api/v1/compact` and resolves with the
 * `CompactResponse`. Keeping this structural (no class) means we can pass a
 * fake in tests without inheriting heavyweight client infrastructure.
 */
export interface IStatelessCompactClient {
	/**
	 * Send a `CompactRequest` to `POST /api/v1/compact` and resolve with the
	 * server-returned `CompactResponse`. Rejects on network failure,
	 * non-2xx response, or schema violation.
	 */
	compact(req: CompactRequest): Promise<CompactResponse>;
}

// =============================================================================
// Public options + defaults
// =============================================================================

/**
 * Tunables for `ConversationCompactor`. All optional; defaults match the
 * Claude Code reference + ADR-017 §11.1 numbers.
 */
export interface ConversationCompactorOptions {
	/**
	 * Total estimated tokens in `messages` above which `shouldCompact()`
	 * returns true. Default 50 000 — matches Claude Code's auto-compact
	 * trigger threshold per ADR-017 §11.1.
	 */
	triggerThresholdTokens?: number;

	/**
	 * How many recent turns to keep verbatim after compaction. Default 5.
	 * A turn = one user-initiated message + its assistant reply (and any
	 * tool_use/tool_result pairs absorbed into that turn — see file header
	 * "Turn boundary semantics").
	 */
	keepRecentTurns?: number;

	/**
	 * Max tokens the server should target for the summary itself. Passed
	 * through to `CompactRequest.max_summary_tokens`. Default 4000.
	 */
	maxSummaryTokens?: number;

	/**
	 * Model identifier for the summary call. Default `claude-3-5-haiku-latest`
	 * — cheap + fast, summarize doesn't need a flagship model.
	 */
	summaryModel?: string;
}

const DEFAULT_TRIGGER_THRESHOLD_TOKENS = 50_000;
const DEFAULT_KEEP_RECENT_TURNS = 5;
const DEFAULT_MAX_SUMMARY_TOKENS = 4000;
const DEFAULT_SUMMARY_MODEL = 'claude-3-5-haiku-latest';

// =============================================================================
// ConversationCompactor
// =============================================================================

/**
 * Owns the decision to compact + the call to `/api/v1/compact` + the assembly
 * of the post-compaction messages array.
 *
 * This class is stateless beyond its options + the injected client; every
 * call to `compact()` operates only on the messages array passed in. The
 * caller owns persistence (writing back to `chatSessions/<id>.jsonl`).
 *
 * The slash-command `/compact` is NOT handled here — the IDE chat input
 * handler watches for the slash, then calls `compact()` directly. This class
 * doesn't need to know about UX affordances.
 */
export class ConversationCompactor {

	private readonly _triggerThresholdTokens: number;
	private readonly _keepRecentTurns: number;
	private readonly _maxSummaryTokens: number;
	private readonly _summaryModel: string;

	/**
	 * @param _client  Injected `StatelessClient`-shaped collaborator with a
	 *                 `compact()` method that POSTs to `/api/v1/compact`.
	 * @param opts     Optional tunables; see `ConversationCompactorOptions`.
	 */
	constructor(
		private readonly _client: IStatelessCompactClient,
		opts?: ConversationCompactorOptions,
	) {
		this._triggerThresholdTokens = opts?.triggerThresholdTokens ?? DEFAULT_TRIGGER_THRESHOLD_TOKENS;
		this._keepRecentTurns = opts?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
		this._maxSummaryTokens = opts?.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
		this._summaryModel = opts?.summaryModel ?? DEFAULT_SUMMARY_MODEL;
	}

	/**
	 * Decide whether auto-compact should fire for this conversation right now.
	 *
	 * Pure function over `estimateTokens(messages) > triggerThresholdTokens`.
	 * Does NOT consider whether the messages contain an existing summary —
	 * stacking is handled in `compact()` itself, so a session that has been
	 * compacted before can still cross the threshold again and re-compact.
	 *
	 * @param messages Current full conversation (as it would be sent to invoke).
	 * @returns true iff the conversation is over budget.
	 */
	shouldCompact(messages: Message[]): boolean {
		return this.estimateTokens(messages) > this._triggerThresholdTokens;
	}

	/**
	 * Approximate token count for a conversation via the chars / 4 heuristic.
	 *
	 * Sums character counts from every text-bearing field:
	 *  - `Message.content` when it's a string
	 *  - `TextBlock.text`
	 *  - `ToolUseBlock.name` + JSON-serialized `input`
	 *  - `ToolResultBlock.content` (string or flattened text blocks)
	 *  - `ImageBlock` contributes a fixed ~1500 chars (~375 tokens) as a
	 *    rough proxy for the image-token cost most providers bill (Anthropic
	 *    bills 100-1500 tokens depending on resolution); good enough for
	 *    trigger purposes.
	 *
	 * NOT an exact tokenizer — accurate to ~2× across mixed CJK/ASCII/code.
	 * For LLM-grade accounting use the server-reported `tokens_in` /
	 * `tokens_out` on `CompactResponse`.
	 *
	 * @param messages Conversation to measure.
	 * @returns Approximate token count (always `>= 0`).
	 */
	estimateTokens(messages: Message[]): number {
		let chars = 0;
		for (const m of messages) {
			chars += this._charsInContent(m.content);
		}
		return Math.ceil(chars / 4);
	}

	/**
	 * Trigger compaction.
	 *
	 * Sends the "old turns" slice to `POST /api/v1/compact` and returns
	 * `[summary_message, ...recent_turns]` for the caller to persist.
	 *
	 * Idempotency: if `messages[0]` already carries `is_compact_summary:true`,
	 * its text is folded into the new compact input under a
	 * `<previous_summary>` wrapper, and the old summary is NOT duplicated in
	 * the output. This keeps a long session bounded — repeated compactions
	 * collapse into one summary message per round, not N stacked summaries.
	 *
	 * Edge cases:
	 *  - Fewer than `keepRecentTurns` turns total → no "old" slice exists,
	 *    method returns `messages` unchanged WITHOUT calling the server
	 *    (nothing to summarize).
	 *  - Existing summary + no new old turns to fold → also short-circuits
	 *    to the input unchanged (server call would be a no-op).
	 *
	 * @param messages       Current full conversation.
	 * @param chatSessionId  IDE-side chatSession uuid (telemetry passthrough).
	 * @param traceId        Fresh UUID for this `/compact` call. Caller
	 *                       generates so the admin trace UI can correlate.
	 * @returns Compacted messages array `[summary_message, ...recent_turns]`.
	 *          Caller writes this back to `chatSessions/<id>.jsonl`.
	 * @throws Whatever the underlying `client.compact()` throws — caller
	 *         logs + decides retry. We don't swallow: a failed compaction
	 *         should leave the existing conversation untouched (caller will
	 *         retry on the next invoke when the threshold still trips).
	 */
	async compact(
		messages: Message[],
		chatSessionId: string,
		traceId: string,
	): Promise<Message[]> {
		// 1. Split off any pre-existing summary from the head.
		const { existingSummary, remaining } = this._extractExistingSummary(messages);

		// 2. Walk backward to find the N most recent turns. `recentTurnsStartIdx`
		//    is the index in `remaining` at which the recent slice begins;
		//    everything before it is "old" and gets summarized.
		const recentStart = this._findRecentTurnsStartIndex(remaining, this._keepRecentTurns);
		const oldPart = remaining.slice(0, recentStart);
		const recentPart = remaining.slice(recentStart);

		// 3. Short-circuit when there's nothing new to summarize. We still
		//    re-emit the existing summary at the head so the caller can use
		//    the returned array as-is.
		if (oldPart.length === 0) {
			return existingSummary ? [existingSummary, ...recentPart] : recentPart;
		}

		// 4. Build the messages payload for /compact. If we have an existing
		//    summary, prepend it as a synthetic user message wrapped in
		//    <previous_summary> tags so the server's summarize prompt sees it
		//    as prior context to fold in (algorithm decision #6 idempotency).
		const compactInput: Message[] = [];
		if (existingSummary) {
			compactInput.push(this._wrapPreviousSummaryForCompactInput(existingSummary));
		}
		compactInput.push(...oldPart);

		// 5. Fire the server call. Errors propagate.
		const req: CompactRequest = {
			trace_id: traceId,
			chat_session_id: chatSessionId,
			messages: compactInput,
			model: this._summaryModel,
			max_summary_tokens: this._maxSummaryTokens,
		};
		const resp = await this._client.compact(req);

		// 6. Assemble output. The server-returned summary_message already
		//    carries is_compact_summary + is_visible_in_transcript_only per
		//    the spec; we trust it but defensively normalize so the markers
		//    are present even if a buggy provider stripped them.
		const summaryMessage = this._normalizeSummaryMarkers(resp.summary_message);
		return [summaryMessage, ...recentPart];
	}

	// ─────────────────────────────────────────────────────────────────────
	// Internal helpers
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Sum character count of a `Message.content` (string or block list).
	 * See `estimateTokens` doc for the per-block accounting rules.
	 */
	private _charsInContent(content: string | ContentBlock[]): number {
		if (typeof content === 'string') {
			return content.length;
		}
		let n = 0;
		for (const block of content) {
			switch (block.type) {
				case 'text':
					n += block.text.length;
					break;
				case 'tool_use':
					n += block.name.length;
					// JSON.stringify gives a deterministic upper bound on the
					// serialized input payload that the model actually sees.
					n += this._safeJsonStringify(block.input).length;
					break;
				case 'tool_result':
					if (typeof block.content === 'string') {
						n += block.content.length;
					} else {
						for (const inner of block.content) {
							n += inner.text.length;
						}
					}
					break;
				case 'image':
					// ~1500 chars ≈ ~375 tokens — rough proxy for image token
					// cost (Anthropic bills 100-1500 tokens per image; we pick
					// the upper end to be conservative on trigger).
					n += 1500;
					break;
			}
		}
		return n;
	}

	/**
	 * If `messages[0]` is a compact-summary message, peel it off and return
	 * it separately. Otherwise return `existingSummary: undefined` and the
	 * full array as `remaining`.
	 *
	 * Only the FIRST message is inspected — by construction a well-formed
	 * conversation has at most one summary marker at the head. We don't try
	 * to handle multi-summary corruption here (caller would have to repair
	 * the jsonl manually anyway).
	 */
	private _extractExistingSummary(messages: Message[]): {
		existingSummary: Message | undefined;
		remaining: Message[];
	} {
		if (messages.length > 0 && messages[0].is_compact_summary === true) {
			return { existingSummary: messages[0], remaining: messages.slice(1) };
		}
		return { existingSummary: undefined, remaining: messages };
	}

	/**
	 * Walk `messages` backward, counting turn starters until we've passed
	 * `keepN` of them. Returns the index of the earliest message belonging
	 * to the kept window.
	 *
	 * Turn-starter definition (algorithm decision #3): a user message whose
	 * content is either a plain string OR a content-block list containing
	 * at least one non-`tool_result` block. Pure-`tool_result` user messages
	 * are continuations of the previous turn (they wrap tool output for the
	 * assistant), not new user input.
	 *
	 * If the conversation has fewer than `keepN` turn-starters total, we
	 * keep everything (return 0 → recent slice == entire `messages`).
	 */
	private _findRecentTurnsStartIndex(messages: Message[], keepN: number): number {
		if (keepN <= 0 || messages.length === 0) {
			return messages.length;
		}
		let turnsCounted = 0;
		let firstKeptIndex = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (this._isTurnStarter(messages[i])) {
				turnsCounted++;
				if (turnsCounted === keepN) {
					firstKeptIndex = i;
					return firstKeptIndex;
				}
			}
		}
		// Fewer than keepN turn-starters → keep everything.
		return 0;
	}

	/**
	 * True iff `m` is a user message that opens a new conversational turn
	 * (as opposed to a pure tool_result wrapper). See file header
	 * "Turn boundary semantics" for the full definition.
	 */
	private _isTurnStarter(m: Message): boolean {
		if (m.role !== 'user') {
			return false;
		}
		if (typeof m.content === 'string') {
			return true;
		}
		// Block list: only a turn-starter if it has at least one block that
		// is NOT a tool_result (text / image / etc. count as user input).
		for (const block of m.content) {
			if (block.type !== 'tool_result') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Wrap an existing summary message so the server's summarize prompt
	 * treats it as prior context to fold into the new summary. The wrapper
	 * mirrors `compress_history_with_summary` (`[Previous summary]\n...`) but
	 * uses XML-style tags that are stable across LLM providers (Anthropic,
	 * OpenAI, and Zhipu all respect XML-tagged regions in instructions).
	 */
	private _wrapPreviousSummaryForCompactInput(existingSummary: Message): Message {
		const inner = this._contentToPlainText(existingSummary.content);
		return {
			role: 'user',
			content: `<previous_summary>\n${inner}\n</previous_summary>`,
		};
	}

	/**
	 * Flatten a `Message.content` to a plain text string for use inside the
	 * synthetic `<previous_summary>` wrapper. Block lists are walked the
	 * same way the server's `_flatten_content_to_text` walks them so the
	 * round-trip is symmetric.
	 */
	private _contentToPlainText(content: string | ContentBlock[]): string {
		if (typeof content === 'string') {
			return content;
		}
		const parts: string[] = [];
		for (const block of content) {
			switch (block.type) {
				case 'text':
					if (block.text) {
						parts.push(block.text);
					}
					break;
				case 'tool_use':
					parts.push(`[tool_use: ${block.name}]`);
					break;
				case 'tool_result':
					if (typeof block.content === 'string') {
						parts.push(`[tool_result: ${block.content}]`);
					} else {
						const inner = block.content.map((b: TextBlock) => b.text).join('\n');
						parts.push(`[tool_result: ${inner}]`);
					}
					break;
				case 'image':
					parts.push('[image]');
					break;
			}
		}
		return parts.join('\n');
	}

	/**
	 * Defensive marker normalization on the server-returned summary message.
	 * Per spec the server already sets both fields true; we re-assert to
	 * shield against a buggy / mis-configured provider that strips them.
	 */
	private _normalizeSummaryMarkers(m: Message): Message {
		return {
			...m,
			is_compact_summary: true,
			is_visible_in_transcript_only: true,
		};
	}

	/**
	 * `JSON.stringify` that never throws — guards against the (unlikely)
	 * case of a circular `input` object surviving into the conversation.
	 * Returns the empty string on failure so token estimation stays bounded.
	 */
	private _safeJsonStringify(value: unknown): string {
		try {
			return JSON.stringify(value) ?? '';
		} catch {
			return '';
		}
	}
}

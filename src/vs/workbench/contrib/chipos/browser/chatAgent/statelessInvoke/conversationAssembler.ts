/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * ConversationAssembler — Phase 0 #8c, updated for Phase 1 (ADR-018).
 *
 * Take a list of *normalized* ChipOS chat session records and transform them
 * into the stateless `InvokeRequest.messages[]` shape (Anthropic Messages API
 * format per ADR-018 §2 D8 + PHASE-1-PROTOCOL-SPEC §2).
 *
 * Why a "normalized" record (not the raw VSCode chat session JSONL):
 *   The on-disk VSCode chat storage (`~/Library/Application Support/ChipOS/User/
 *   workspaceStorage/<hash>/chatSessions/<uuid>.jsonl`) is **not** a simple
 *   `{role, content}` per-line file. Each file is the serialised form of
 *   VS Code's `ChatModel`: line 0 is `{kind:0, v:<ChatModel snapshot>}` with
 *   nested `requests[]` (each request has `message`, `response[]`, `agent`,
 *   `variableData`, etc.); subsequent lines are `{kind:2, k:<json-path>, v:<value>}`
 *   incremental patches (the append-log used to recover the in-memory model on
 *   reload). Tool calls live inside `response[]` items typed
 *   `{kind: 'toolInvocationSerialized', invocationMessage, isConfirmed,
 *   toolSpecificData:{kind:'input', rawInput:...}, toolCallId, toolId}` —
 *   not a flat `role:assistant + content:[tool_use_block]` row.
 *
 *   Reconciling the VSCode-native `ChatModel` shape against the Anthropic
 *   wire shape requires access to the live `IChatService`/`ChatModel` API
 *   (not pure data; reads `IChatRequest.message.parts`, response item kinds,
 *   etc.). That adapter belongs in the integration phase wired through
 *   `chipOSChatAgent.ts`.
 *
 *   This module operates **one layer above** that: it consumes a normalised
 *   `ChatSessionRecord[]` (a flat, Anthropic-shaped sequence) and produces
 *   `Message[]`. The adapter layer that walks `ChatModel.requests[]` and
 *   emits `ChatSessionRecord[]` is the integration-phase responsibility.
 *
 * Handles:
 *   - text messages (role: user|assistant|system, content: string OR ContentBlock[])
 *   - tool_use / tool_result pairing (assistant tool_use → the **immediately
 *     following** user message must carry a matching tool_result with the
 *     same `tool_use_id`)
 *   - `is_compact_summary` entries — preserved with the marker fields so
 *     downstream UI can render them differently (sticky / grey / collapsed)
 *
 * NOT handled (intentionally removed in Phase 1 — see ADR-018 §2 D8):
 *   - `chiposLangGraphState` / `langgraph_state_blob`: reasoner internal state
 *     (LangGraph node, partial responses, replay buffer) now lives reasoner-side
 *     in FileStateStore. The IDE no longer round-trips this blob through the
 *     conversation. Only user-visible messages live in `chatSessions/*.jsonl`.
 *
 * Pure-data: no VSCode-specific imports (IFileService, URI, etc.) — the
 * integration phase wires fs/IFileService. Tests live in `./test/`.
 *
 * Related:
 *   - ADR-018 §2 D8 (state truth bifurcation: messages → IDE, internal → reasoner)
 *   - PHASE-1-PROTOCOL-SPEC.md §2 (Message schema)
 *   - `./types.ts` (TS mirror of the python pydantic contracts)
 */

import type {
	ContentBlock,
	Message,
	TextBlock,
	ToolResultBlock,
	ToolUseBlock,
} from './types.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Minimum subset of a ChipOS chat session record the assembler consumes.
 *
 * The integration phase is responsible for *normalising* the on-disk VSCode
 * `ChatModel` JSONL (see module docstring for why) into this shape before
 * calling `assemble()`. The shape is intentionally Anthropic-flavoured so
 * the transform to `Message` is a 1:1 mapping per record (with the small
 * exception of tool_use/tool_result pairing validation).
 *
 * Fields:
 *   - `role`: 'user' / 'assistant' / 'system' — matches the role on the
 *     produced `Message`. Required for any record that becomes a message;
 *     a record missing `role` is treated as a *meta record* and skipped.
 *   - `content`: text body (string) OR a list of pre-built `ContentBlock`s
 *     (the integration phase may already have assembled tool_use blocks).
 *     If both `content` and `toolUse`/`toolResult` are set, the explicit
 *     `content` wins (callers should pick one form).
 *   - `isCompactSummary`: when true, marks the record as the inserted compact
 *     summary message (Claude Code semantics; manual `/compact` only in
 *     Phase 1 — see ADR-018 §6 R-I). Forces `role='user'` if `role` is unset,
 *     and emits both `is_compact_summary=true` AND
 *     `is_visible_in_transcript_only=true` on the produced `Message`.
 *   - `isVisibleInTranscriptOnly`: optional override for the same-named
 *     `Message` flag (defaults to whatever `isCompactSummary` implies).
 *   - `toolUse`: shorthand for an assistant `tool_use` block — the assembler
 *     wraps it in a single-element `ContentBlock[]` for the `Message.content`.
 *   - `toolResult`: shorthand for a user `tool_result` block — same wrapping.
 *
 * Note: Phase 0's `chiposLangGraphState` field has been removed per ADR-018
 * §2 D8 — reasoner-internal state lives reasoner-side in FileStateStore now,
 * the IDE no longer carries it through the conversation.
 *
 * Forward-compat: unknown fields are ignored. Add fields here only when the
 * integration phase needs them; the wire-side `Message` is the source of truth
 * for what reaches the reasoner.
 */
export interface ChatSessionRecord {
	role?: 'user' | 'assistant' | 'system';
	content?: string | ContentBlock[];
	/** Marks this as an inserted compact summary; forces user-role + visibility flag. */
	isCompactSummary?: boolean;
	/** Override for the `is_visible_in_transcript_only` Message flag. */
	isVisibleInTranscriptOnly?: boolean;
	/** Shorthand for an assistant tool_use ContentBlock. */
	toolUse?: { id: string; name: string; input: Record<string, unknown> };
	/** Shorthand for a user tool_result ContentBlock. */
	toolResult?: { tool_use_id: string; content: string | TextBlock[]; is_error?: boolean };
}

/**
 * Result of an assembly pass.
 *
 * - `messages`: ready-to-send `InvokeRequest.messages` array (already
 *   validated for tool_use/tool_result pairing and minimum-length).
 *
 * Note: Phase 0's `langgraph_state_blob` field is gone — see ADR-018 §2 D8.
 */
export interface AssembleResult {
	messages: Message[];
}

/**
 * Thrown when the input records cannot form a valid stateless invoke payload.
 *
 * The `cause` field is the (already-truncated) machine-readable reason —
 * matched against by tests, surfaced to telemetry. The human-facing `message`
 * adds context that may include record indices.
 *
 * Note: this is **only** thrown on logical assembly errors (empty input,
 * assistant-first, unmatched tool_use, mismatched tool_use_id). JSONL parse
 * errors in `assembleFromJsonl()` are **not** thrown — bad lines warn and
 * skip (defensive against partial flushes).
 */
export class ConversationAssemblyError extends Error {
	override readonly cause?: string;
	constructor(message: string, cause?: string) {
		super(message);
		this.name = 'ConversationAssemblyError';
		this.cause = cause;
	}
}

/**
 * Stateless conversation assembler.
 *
 * Pure-data class — no constructor deps, no I/O. Call `assemble()` with a
 * normalised record list, or `assembleFromJsonl()` to parse a JSONL string
 * first. Instances are reusable / thread-safe (no internal mutable state).
 */
export class ConversationAssembler {

	/**
	 * Transform a list of normalised chat session records into the stateless
	 * `InvokeRequest` payload (messages only — see ADR-018 §2 D8).
	 *
	 * Invariants enforced (throw `ConversationAssemblyError`):
	 *   1. `records` must be non-empty — IDE side must always compose at least
	 *      one user message (use `{role:'user', content:''}` placeholder if the
	 *      user hit send with empty input). Mirrors PHASE-1-PROTOCOL-SPEC
	 *      §2.2 AUDIT P0-2 (server rejects empty messages[] with 400).
	 *   2. First emitted message must have role='user'. Anthropic API requires
	 *      a leading user turn; compact-summary entries also normalise to
	 *      user-role so they satisfy this.
	 *   3. Every assistant `tool_use` must be followed by a user `tool_result`
	 *      with matching `tool_use_id`. The peek is *immediate* (the next
	 *      record in input order) — interleaved assistant turns are not
	 *      allowed between a tool_use and its matching tool_result.
	 *
	 * Records without a `role` AND without compact-summary marker are treated
	 * as meta-only and skipped from the emitted messages.
	 *
	 * @param records normalised chat session records (input order = chronological)
	 * @returns the assembled messages
	 * @throws ConversationAssemblyError on any of the invariants above
	 */
	assemble(records: ChatSessionRecord[]): AssembleResult {
		if (records.length === 0) {
			throw new ConversationAssemblyError(
				'assemble() requires at least one ChatSessionRecord; IDE must compose a placeholder user message (see PHASE-1-PROTOCOL-SPEC P0-2)',
				'empty_records',
			);
		}

		// Build messages, validating tool_use/tool_result pairing.
		const messages: Message[] = [];
		for (let i = 0; i < records.length; i++) {
			const built = this._buildMessage(records[i], i);
			if (built === null) {
				continue; // meta-only record (no role + no compact marker)
			}
			messages.push(built);

			// Tool_use pairing check: if this message is an assistant message
			// carrying a tool_use block, the NEXT emitted record must be a
			// user message carrying a tool_result with matching id(s).
			const toolUseIds = this._extractToolUseIds(built);
			if (toolUseIds.length > 0) {
				// Find the next non-meta record's built message
				let peek: Message | null = null;
				for (let j = i + 1; j < records.length; j++) {
					peek = this._buildMessage(records[j], j);
					if (peek !== null) {
						break;
					}
				}
				if (peek === null || peek.role !== 'user') {
					// BACKSTOP — orphaned tool_use: an assistant tool_use with no following
					// user tool_result. The turn was cancelled / interrupted and never closed
					// (e.g. a cross-restart leftover), and the user abandoned it with a fresh
					// turn instead of /resume. We DROP the unpaired tool_use rather than
					// fabricate a result — we can't know whether it actually succeeded
					// server-side, and a wrong synthetic result would mislead the model.
					// Dropping keeps the conversation both VALID (no dangling tool_use) and
					// HONEST (no invented data). In-process cancels are normally closed
					// accurately upstream (turn-end cleanup emits a real 'cancelled' result);
					// this only catches the leftovers.
					messages.pop(); // remove the orphan we just pushed
					continue;
				}
				const resultIds = this._extractToolResultIds(peek);
				for (const useId of toolUseIds) {
					if (!resultIds.includes(useId)) {
						throw new ConversationAssemblyError(
							`assistant tool_use id="${useId}" at record index ${i} has no matching tool_result in the following user message (saw tool_result_ids=[${resultIds.join(',')}])`,
							'tool_use_unmatched_id',
						);
					}
				}
			}
		}

		if (messages.length === 0) {
			throw new ConversationAssemblyError(
				'assemble() produced 0 messages — all input records were meta-only (no role + not compact summary)',
				'empty_messages_after_filter',
			);
		}
		if (messages[0].role !== 'user') {
			throw new ConversationAssemblyError(
				`first message must be role=user (Anthropic Messages API requirement); got role=${messages[0].role}`,
				'first_message_not_user',
			);
		}

		return { messages };
	}

	/**
	 * Convenience: parse a JSONL string (one `ChatSessionRecord` per line) and
	 * assemble. Defensive against partial flushes: lines that fail to parse
	 * emit a `console.warn` and are skipped — they do NOT throw.
	 *
	 * - Empty lines and lines that are whitespace-only are silently ignored.
	 * - Lines that parse to a non-object (string, number, null, array) are
	 *   skipped with a warn (those are never valid records).
	 * - Logical assembly errors (post-parse) still throw
	 *   `ConversationAssemblyError` — defensive parsing only covers the
	 *   per-line `JSON.parse()` step.
	 *
	 * Caveat: this method consumes the *simple* per-line JSONL shape (each
	 * line = one full `ChatSessionRecord`). It does **not** parse the VSCode-
	 * native `ChatModel` JSONL on disk (see module docstring) — that requires
	 * the live `IChatService` adapter the integration phase will wire.
	 *
	 * @param jsonlContent raw multi-line JSONL string
	 * @returns same as `assemble()`
	 * @throws ConversationAssemblyError on logical assembly errors only
	 */
	assembleFromJsonl(jsonlContent: string): AssembleResult {
		const records: ChatSessionRecord[] = [];
		const lines = jsonlContent.split(/\r?\n/);
		for (let lineNo = 0; lineNo < lines.length; lineNo++) {
			const raw = lines[lineNo];
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch (err) {
				// Defensive: a partial flush / truncated last line shouldn't
				// blow up the whole assembly. Warn and continue.
				console.warn(
					`[ConversationAssembler] skipping unparseable JSONL line ${lineNo + 1}: ${err instanceof Error ? err.message : String(err)}`,
				);
				continue;
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				console.warn(
					`[ConversationAssembler] skipping JSONL line ${lineNo + 1}: not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
				);
				continue;
			}
			records.push(parsed as ChatSessionRecord);
		}
		return this.assemble(records);
	}

	// ------------------------------------------------------------------------
	// Internal helpers
	// ------------------------------------------------------------------------

	/**
	 * Convert a single `ChatSessionRecord` into a wire-shape `Message`, or
	 * return `null` if the record is meta-only (no role + no compact marker)
	 * and should be skipped from the emitted messages list.
	 *
	 * Precedence when multiple sources of content are present on one record:
	 *   1. explicit `content` (string or ContentBlock[])
	 *   2. shorthand `toolUse` (wrapped in a single-element block list)
	 *   3. shorthand `toolResult` (wrapped in a single-element block list)
	 *   4. compact-summary with no content → empty string body
	 *   5. otherwise → null (meta-only)
	 *
	 * Compact-summary normalisation:
	 *   - role defaults to 'user' if unset
	 *   - role MUST be 'user' if set (assistant compact summary is nonsensical)
	 *   - both `is_compact_summary` and `is_visible_in_transcript_only` are
	 *     emitted as true (unless the caller explicitly set
	 *     `isVisibleInTranscriptOnly: false`, which we honour)
	 */
	private _buildMessage(record: ChatSessionRecord, index: number): Message | null {
		// Compact-summary handling first — it forces role and visibility flags.
		if (record.isCompactSummary === true) {
			const role = record.role ?? 'user';
			if (role !== 'user') {
				throw new ConversationAssemblyError(
					`compact summary record at index ${index} must be role=user; got role=${role}`,
					'compact_summary_non_user',
				);
			}
			const content = this._extractContent(record) ?? '';
			const visibleOnly = record.isVisibleInTranscriptOnly ?? true;
			return {
				role: 'user',
				content,
				is_compact_summary: true,
				is_visible_in_transcript_only: visibleOnly,
			};
		}

		const content = this._extractContent(record);
		if (content === null) {
			// Meta-only record — no role/content/toolUse/toolResult. Skipped.
			return null;
		}

		if (record.role === undefined) {
			throw new ConversationAssemblyError(
				`record at index ${index} has content but no role; cannot infer (use isCompactSummary for user-side summary records)`,
				'missing_role_with_content',
			);
		}

		const msg: Message = { role: record.role, content };
		if (record.isVisibleInTranscriptOnly === true) {
			msg.is_visible_in_transcript_only = true;
		}
		return msg;
	}

	/**
	 * Resolve the `Message.content` for a record from (in order) explicit
	 * `content`, `toolUse` shorthand, or `toolResult` shorthand. Returns
	 * `null` when no content source is present.
	 */
	private _extractContent(record: ChatSessionRecord): string | ContentBlock[] | null {
		if (record.content !== undefined) {
			return record.content;
		}
		if (record.toolUse) {
			const block: ToolUseBlock = {
				type: 'tool_use',
				id: record.toolUse.id,
				name: record.toolUse.name,
				input: record.toolUse.input,
			};
			return [block];
		}
		if (record.toolResult) {
			const block: ToolResultBlock = {
				type: 'tool_result',
				tool_use_id: record.toolResult.tool_use_id,
				content: record.toolResult.content,
			};
			if (record.toolResult.is_error === true) {
				block.is_error = true;
			}
			return [block];
		}
		return null;
	}

	/**
	 * Collect every `ToolUseBlock.id` carried by a message. Returns `[]` for
	 * pure-text messages or messages whose content is a string.
	 */
	private _extractToolUseIds(msg: Message): string[] {
		if (typeof msg.content === 'string') {
			return [];
		}
		const ids: string[] = [];
		for (const block of msg.content) {
			if (block.type === 'tool_use') {
				ids.push(block.id);
			}
		}
		return ids;
	}

	/**
	 * Collect every `ToolResultBlock.tool_use_id` carried by a message.
	 */
	private _extractToolResultIds(msg: Message): string[] {
		if (typeof msg.content === 'string') {
			return [];
		}
		const ids: string[] = [];
		for (const block of msg.content) {
			if (block.type === 'tool_result') {
				ids.push(block.tool_use_id);
			}
		}
		return ids;
	}
}

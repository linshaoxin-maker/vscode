/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChatModelToRecordsAdapter — Phase 0 #8e Step 0.5, updated for Phase 1 (ADR-018).
 *
 * Bridges VS Code's live `IChatModel` (rich nested `requests[N].response[]`
 * tree of typed `IChatProgressResponseContent` parts) into the simpler
 * `ChatSessionRecord[]` shape that `ConversationAssembler.assemble()`
 * consumes. The assembler is intentionally pure-data + has no VS Code API
 * dependencies; this adapter is the one place that knows the in-memory
 * `IChatModel` shape.
 *
 * Discovered via empirical recon of `chatSessions/*.jsonl` on disk (Wave 3
 * #8c agent's intel, 2026-05-27): the on-disk file is NOT simple
 * `{role, content}` per line but a `{kind:0, v:<ChatModel snapshot>}` +
 * `{kind:2, k:<json-pointer>, v:<patch>}` stream that serialises
 * `IChatModel`. Rather than parsing that stream ourselves, we read the
 * live in-memory model VS Code already rehydrated for us and walk it.
 *
 * Mapping rules (locked):
 *   - `request.message.text` (string) → `{role:'user', content:<text>}`
 *   - `request.response.entireResponse.value[]` (array of typed parts):
 *     - pure-text-ish parts (markdown, etc) → concatenate into single
 *       `{role:'assistant', content:<concat>}` record
 *     - `kind:'toolInvocationSerialized'` → split:
 *       (a) `{role:'assistant', toolUse:{id:toolCallId, name:toolId,
 *           input:toolSpecificData.rawInput}}`
 *       (b) `{role:'user', toolResult:{tool_use_id:toolCallId,
 *           content:<extracted from resultDetails>,
 *           is_error:<from resultDetails.isError>}}` (only if isComplete)
 *     - `kind:'confirmation'` → ChipOS user-confirm specialisation, name
 *       fixed to `'chipos_user_confirm'`; next request's `confirmation`
 *       string field provides the tool_result content. See ADR-018 §2 D13.
 *     - `kind:'thinking'` / `kind:'progressMessage'` /
 *       `kind:'mcpServersStarting'` / `kind:'undoStop'` → drop (UI hints,
 *       not part of conversation history sent to LLM)
 *
 * Phase 1 change (ADR-018 §2 D8): the Phase 0 `chiposLangGraphState`
 * extraction is gone — reasoner internal state lives reasoner-side in
 * FileStateStore now; IDE no longer round-trips it through the conversation.
 *
 * See PHASE-1-PROTOCOL-SPEC.md §2 and ADR-018 §2 D8/D13 for cross-refs.
 */

import { IChatModel, IChatRequestModel, IChatResponseModel } from '../../../../chat/common/model/chatModel.js';
import { ChatSessionRecord } from './conversationAssembler.js';

/**
 * Adapter that walks an `IChatModel` and produces the normalised record
 * list ConversationAssembler consumes.
 *
 * Stateless. All public methods are pure — same input always yields the
 * same output, no caching, no side effects.
 */
export class ChatModelToRecordsAdapter {

	/**
	 * Walk the model's request list and emit `ChatSessionRecord[]`.
	 *
	 * Handles tool_use/tool_result pairing across request boundaries:
	 * when request N's response contains a `toolInvocationSerialized`,
	 * the matching tool_result record is emitted from the SAME walk pass
	 * using `resultDetails` (the IDE already has the result when the
	 * model is rehydrated; we don't synthesise from `requests[N+1]`).
	 *
	 * Confirmation cards (`kind:'confirmation'`) pair across the request
	 * boundary: card lives in `requests[N].response[]`; the user's reply
	 * shows up as `requests[N+1].confirmation` (the chosen button label)
	 * + `requests[N+1].message.text`. The adapter peeks at `requests[N+1]`
	 * to extract the matching tool_result.
	 */
	fromChatModel(model: IChatModel): ChatSessionRecord[] {
		const requests = model.getRequests();
		return this._walkRequests(requests);
	}

	/**
	 * Internal: walk the request list with index awareness so confirmation
	 * cards can peek `requests[N+1].confirmation` for the user reply.
	 *
	 * Visible for tests; production callers should use `fromChatModel`.
	 */
	_walkRequests(requests: readonly IChatRequestModel[]): ChatSessionRecord[] {
		const out: ChatSessionRecord[] = [];

		for (let i = 0; i < requests.length; i++) {
			const req = requests[i];
			const nextReq: IChatRequestModel | undefined = requests[i + 1];

			// ── User text ─────────────────────────────────────────────
			// `confirmation` is the chosen button label from a prior card.
			// When set, the user's message is the confirm answer, not a
			// new prompt — it pairs with the prior response's confirmation
			// part as a tool_result (emitted by the prior iteration's
			// response walk, not here). So skip emitting a user text for
			// confirmation continuations.
			const userText = this._extractUserText(req);
			if (userText !== null && !req.confirmation) {
				out.push({ role: 'user', content: userText });
			}

			// ── Assistant response ────────────────────────────────────
			if (req.response) {
				const records = this._walkResponse(req.response, nextReq);
				out.push(...records);
			}
		}

		return out;
	}

	/**
	 * Extract the user's prompt text from a request. Returns null when
	 * the request has no displayable text (e.g. a pure-attachment turn).
	 */
	private _extractUserText(req: IChatRequestModel): string | null {
		const text = req.message?.text;
		if (typeof text !== 'string') {
			return null;
		}
		const trimmed = text.trim();
		return trimmed.length === 0 ? null : text;
	}

	/**
	 * Walk a single response and emit records. Multiple records may be
	 * emitted: a text-then-tool sequence becomes an assistant-text +
	 * assistant-tool_use + user-tool_result triple.
	 *
	 * Tool result content extraction is best-effort: the
	 * `resultDetails` field has several variants
	 * (`IToolResultInputOutputDetails`, `Array<URI|Location>`,
	 * `IToolResultOutputDetailsSerialized`). We extract a string for
	 * conversation transport via `_resultDetailsToString`.
	 */
	_walkResponse(
		response: IChatResponseModel,
		nextReq: IChatRequestModel | undefined
	): ChatSessionRecord[] {
		const out: ChatSessionRecord[] = [];
		const parts = response.entireResponse.value;

		// Accumulate consecutive text-ish parts into a single assistant
		// content record. Tool / confirmation parts flush the buffer +
		// emit their own records.
		const textBuf: string[] = [];
		const flushText = (): void => {
			if (textBuf.length === 0) {
				return;
			}
			const joined = textBuf.join('').trim();
			textBuf.length = 0;
			if (joined.length > 0) {
				out.push({ role: 'assistant', content: joined });
			}
		};

		for (const part of parts) {
			const kind = (part as { kind?: string }).kind;

			// ── tool_use / tool_result pair ──────────────────────────
			if (kind === 'toolInvocationSerialized') {
				flushText();
				const tool = part as ToolInvocationSerializedPart;
				out.push({
					role: 'assistant',
					toolUse: {
						id: tool.toolCallId,
						name: tool.toolId,
						input: extractRawInput(tool.toolSpecificData),
					},
				});
				// Tool result — only emit if complete; pending tool calls
				// don't have a result yet (this can happen if we read the
				// model mid-stream).
				if (tool.isComplete) {
					out.push({
						role: 'user',
						toolResult: {
							tool_use_id: tool.toolCallId,
							content: this._resultDetailsToString(tool.resultDetails),
							is_error: this._resultDetailsIsError(tool.resultDetails),
						},
					});
				}
				continue;
			}

			// ── confirmation card → chipos_user_confirm tool_use pair ─
			if (kind === 'confirmation') {
				flushText();
				const conf = part as ConfirmationPart;
				// Use the confirmation's data.requestId if present (chipos
				// cards stamp it); else synthesise a stable id from
				// response.id + part index for replayability.
				const data = (conf.data ?? {}) as { requestId?: string; card_type?: string };
				const id = (typeof data.requestId === 'string' && data.requestId.length > 0)
					? data.requestId
					: `confirm-${response.id}-${out.length}`;
				out.push({
					role: 'assistant',
					toolUse: {
						id,
						name: 'chipos_user_confirm',
						input: {
							card_type: data.card_type ?? 'generic',
							card_data: conf.data,
							title: conf.title,
							buttons: conf.buttons,
						},
					},
				});
				// Pair the result: next request's `confirmation` field
				// carries the chosen button label; the user's prompt text
				// (if any) was a follow-up explanation. We surface the
				// action as JSON to preserve structure.
				if (nextReq?.confirmation) {
					out.push({
						role: 'user',
						toolResult: {
							tool_use_id: id,
							content: JSON.stringify({
								action: nextReq.confirmation,
								comment: nextReq.message?.text ?? '',
							}),
							is_error: false,
						},
					});
				}
				continue;
			}

			// ── pure-text parts: accumulate ──────────────────────────
			if (kind === 'markdownContent' || kind === 'markdownVuln') {
				const md = (part as { content?: { value?: string } }).content;
				if (md && typeof md.value === 'string') {
					textBuf.push(md.value);
				}
				continue;
			}

			// ── UI-only kinds: drop ──────────────────────────────────
			if (
				kind === 'thinking' ||
				kind === 'progressMessage' ||
				kind === 'mcpServersStarting' ||
				kind === 'mcpServersStartingSerialized' ||
				kind === 'undoStop' ||
				kind === 'roundProgress'
			) {
				continue;
			}

			// ── Unknown part kinds: drop with no record (defensive) ──
			// We deliberately do NOT throw — VS Code's progress part
			// catalog grows over time; unknown new kinds shouldn't break
			// conversation reconstruction. Caller can introspect via
			// chatService logger.
		}

		// Flush any trailing text.
		flushText();

		// Phase 1 (ADR-018 §2 D8): no chiposLangGraphState attach — the
		// reasoner owns its internal state via FileStateStore. The IDE-side
		// conversation carries only user-visible messages.

		return out;
	}

	/**
	 * Reduce `resultDetails` (a heterogenous shape — array of URI/Location,
	 * an `IToolResultInputOutputDetails`, or `IToolResultOutputDetailsSerialized`)
	 * into a single string for transport in `tool_result.content`.
	 *
	 * Best-effort. When we can't extract meaningful text, returns the JSON
	 * dump so nothing is silently lost.
	 */
	private _resultDetailsToString(details: unknown): string {
		if (details === undefined || details === null) {
			return '';
		}
		if (typeof details === 'string') {
			return details;
		}
		// IToolResultInputOutputDetails has `output: string`
		const asObj = details as { output?: unknown; input?: unknown; rawOutput?: unknown };
		if (typeof asObj.output === 'string') {
			return asObj.output;
		}
		if (typeof asObj.rawOutput === 'string') {
			return asObj.rawOutput;
		}
		// Array of URIs / Locations — list them as a brief summary
		if (Array.isArray(details)) {
			const items = details.map(d => {
				if (typeof d === 'string') {
					return d;
				}
				const uriish = d as { uri?: { fsPath?: string; path?: string }; toString?: () => string };
				if (uriish.uri?.fsPath) {
					return uriish.uri.fsPath;
				}
				if (uriish.uri?.path) {
					return uriish.uri.path;
				}
				try {
					return JSON.stringify(d);
				} catch {
					return String(d);
				}
			});
			return items.join('\n');
		}
		// Last resort — JSON dump.
		try {
			return JSON.stringify(details);
		} catch {
			return String(details);
		}
	}

	/**
	 * Pull the error flag out of `resultDetails` when present. False by
	 * default — most successful tool calls don't set it.
	 */
	private _resultDetailsIsError(details: unknown): boolean {
		if (!details || typeof details !== 'object') {
			return false;
		}
		const flag = (details as { isError?: unknown }).isError;
		return flag === true;
	}
}

// ── Structural types for the parts we read ───────────────────────────────
// We avoid importing the concrete IChatToolInvocationSerialized /
// IChatConfirmation types because VS Code's chatService.ts churns those
// shapes between minors. Structural shapes pinning only the fields we
// read makes the adapter resilient to upstream field additions.

interface ToolInvocationSerializedPart {
	kind: 'toolInvocationSerialized';
	toolCallId: string;
	toolId: string;
	toolSpecificData?: unknown;
	resultDetails?: unknown;
	isComplete: boolean;
}

interface ConfirmationPart {
	kind: 'confirmation';
	title: string;
	message: unknown;
	data?: unknown;
	buttons?: string[];
}

/**
 * Extract `rawInput` from `IChatToolInputInvocationData`-shaped data, or
 * use the data dict as-is when it doesn't follow that envelope.
 *
 * VS Code's tool_specific data envelopes vary: terminal, input, file
 * edits, etc. all have different shapes. The shared `rawInput` field is
 * the one we treat as the canonical "tool args".
 */
function extractRawInput(toolSpecificData: unknown): Record<string, unknown> {
	if (!toolSpecificData || typeof toolSpecificData !== 'object') {
		return {};
	}
	const envelope = toolSpecificData as { kind?: string; rawInput?: unknown };
	if (envelope.kind === 'input' && envelope.rawInput && typeof envelope.rawInput === 'object') {
		return envelope.rawInput as Record<string, unknown>;
	}
	// For terminal / pull-request / etc envelopes, surface the whole
	// data dict — Phase 0 #8e callers will further normalise per-tool.
	return toolSpecificData as Record<string, unknown>;
}

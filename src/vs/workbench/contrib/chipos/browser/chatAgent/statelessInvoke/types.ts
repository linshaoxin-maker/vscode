/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reasoner /invoke protocol types — thin re-export of the canonical
 * `@chipos/invoke-client` wire types (M3a, 19-SURFACE-CONVERGENCE).
 *
 * The protocol shapes (mirror of
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py`, pydantic v2)
 * live in `./vendor/agent/invokeTypes.ts` — a vendored copy of
 * `packages/invoke-client/src/agent/invokeTypes.ts` — so all three surfaces
 * (CLI / extension / IDE) consume the SAME canonical contract instead of
 * hand-maintained parallel mirrors. This module stays the single import path
 * for IDE consumers (the old-path shim): it re-exports the canonical types
 * verbatim and keeps the IDE-ONLY extensions below:
 *
 *   - `ReasonerHookDefinition` — canonical + the tier-2 *function* hook carrier
 *     fields (`kind`/`module`/`export`/`timeout_ms`/`fail_closed`, FEAT-004/H-1).
 *     These are NOT invoke.py fields — the reasoner accepts them via
 *     `extra="allow"` and mirrors them back on `hook_eval` (same pattern as the
 *     CLI's domain-side hook type).
 *   - The reserved slash-command layer (`RESERVED_COMMANDS` / `RESERVED_NAMES`).
 *   - Runtime helpers: ContentBlock type guards + round_end readers.
 *   - Typed SSE payload views (`IdeToolCallData` / `HookEvalData` / …) the
 *     eventDispatcher narrows `InvokeEvent.data` into.
 *
 * Forward-compat conventions (mirroring python `extra="allow"`) are unchanged:
 * unknown fields may appear from newer reasoners and MUST be tolerated; route
 * events on the stable `family` band, never on the open `type`.
 */

import type { ContentBlock, ImageBlock, InvokeEvent, ReasonerHookDefinition as CanonicalReasonerHookDefinition, RoundEndData, TextBlock, ToolResultBlock, ToolUseBlock } from './vendor/agent/invokeTypes.js';

// =============================================================================
// Canonical wire types (single source: packages/invoke-client)
// =============================================================================

export type {
	// Content blocks + messages (Anthropic Messages API 对齐)
	TextBlock,
	ToolUseBlock,
	ToolResultBlock,
	ImageBlock,
	ContentBlock,
	Message,
	// Request-side extension types (FEAT-003/004/005 + marketplace v5)
	SkillSource,
	PromptSource,
	PromptResourceKind,
	ReasonerHookPoint,
	ReasonerHookAction,
	HookEvalDecision,
	SelectedAgent,
	SkillHeader,
	PromptResourceAttachment,
	// Invoke request + capability declaration (/invoke v1.1 S1)
	InvokeRequest,
	InvokeRequestInput,
	RenderCapability,
	ClientCapabilities,
	// Server-derived resolved context (R1 — inbound/read-only mirrors)
	Identity,
	AllowedTools,
	ResolvedInvokeContext,
	// SSE event stream
	TokenUsage,
	EventFamily,
	InvokeEventType,
	InvokeEvent,
	RenderEnvelope,
	ArtifactRef,
	FinalResult,
	RoundEndData,
	// Endpoints: cancel / tools / reverse channel / resume / compact / hooks
	CancelRequest,
	ToolDefinition,
	RegisterToolsRequest,
	RegisterToolsResponse,
	ToolResultRequest,
	ConfirmResponseRequest,
	ResumeRequest,
	InFlightTrace,
	TurnStateResponse,
	CompactRequest,
	CompactResponse,
	HookResultRequest,
} from './vendor/agent/invokeTypes.js';

// =============================================================================
// IDE extension — ReasonerHookDefinition with the function-hook carrier
// =============================================================================

/**
 * A user/workspace/plugin-configured reasoner hook (FEAT-004) — the canonical
 * wire shape plus the IDE's tier-2 *function* (executable) hook fields
 * (FEAT-004 / H-1). Optional + additive: declarative hooks omit them and
 * behave exactly as before. When `kind === 'function'` the reasoner bridges to
 * the IDE reverse channel (`hook_eval` → POST /hook_result), and the IDE loads
 * `module`/`export` to run the plugin hook. The extra fields ride the wire via
 * the reasoner's `extra="allow"` (they are NOT canonical invoke.py fields).
 */
export interface ReasonerHookDefinition extends CanonicalReasonerHookDefinition {
	/** `'function'` marks an executable hook the IDE must run; absent ⇒ declarative. */
	kind?: 'function';
	/** Module path the IDE loads to run the hook (function hooks only). */
	module?: string;
	/** Named export within `module` to invoke (function hooks only). */
	export?: string;
	/** Per-eval timeout in ms; reasoner clamps + falls closed on overrun. */
	timeout_ms?: number;
	/** On eval failure/timeout: deny (true, default) vs proceed (false). */
	fail_closed?: boolean;
}

// =============================================================================
// IDE-only — reserved built-in slash commands (not part of the wire contract)
// =============================================================================

/**
 * How a reserved built-in slash command executes. Mirrors
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py` ReservedCommandRouting.
 * `local` = client-side only; `endpoint` = a dedicated non-/invoke endpoint;
 * `invoke` = a normal model turn (reserved, unused in Beta-1).
 */
export type ReservedCommandRouting = 'local' | 'endpoint' | 'invoke';

/**
 * Declaration of one reserved built-in slash command. Mirrors
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py` ReservedCommandSpec /
 * RESERVED_COMMANDS. Field names + defaults must align literally with python.
 * Pure data — the IDE implements the handler; the same table is the contract the
 * vscode-extension and the (future) CLI follow. See
 * `docs/plan/surface-unification/RESERVED-COMMANDS-LAYER-DESIGN-2026-06-16.md`.
 */
export interface ReservedCommandSpec {
	/** Canonical command name (typed as `/<name>`), no leading slash. */
	readonly name: string;
	/** Where the command executes. */
	readonly routing: ReservedCommandRouting;
	/** Whether inline args after `/<name>` are meaningful. */
	readonly takesArgs: boolean;
	/** Whether it may run while the previous turn still streams. */
	readonly availableInFlight: boolean;
	/** Alternative names that resolve to this same command. */
	readonly aliases: readonly string[];
}

/**
 * Single source of truth (mirror of python `RESERVED_COMMANDS`). `/clear` is the
 * surface's native new-chat; `/compact` summarises older turns and the surface
 * persists a compaction checkpoint. Adding one = edit here + the python table +
 * a handler.
 */
export const RESERVED_COMMANDS: readonly ReservedCommandSpec[] = [
	// aliases empty on purpose — see the python RESERVED_COMMANDS comment: /new and
	// /reset are only reserved once a surface resolves them (the IDE framework
	// registers only `clear`), else we'd suppress a user's own new.md/reset.md.
	{ name: 'clear', routing: 'local', takesArgs: false, availableInFlight: false, aliases: [] },
	{ name: 'compact', routing: 'endpoint', takesArgs: false, availableInFlight: false, aliases: [] },
];

/**
 * Names + aliases of every reserved command. The IDE completion uses this to
 * suppress a user/plugin command that collides with a reserved name (the
 * framework's slash-command service already enforces reserved-wins at execution).
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(
	RESERVED_COMMANDS.flatMap(c => [c.name, ...c.aliases]));

// =============================================================================
// Type guards — discriminated-union narrowing for ContentBlock
// =============================================================================

/** Narrow `ContentBlock` → `TextBlock`. */
export function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text';
}

/** Narrow `ContentBlock` → `ToolUseBlock`. */
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
	return b.type === 'tool_use';
}

/** Narrow `ContentBlock` → `ToolResultBlock`. */
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
	return b.type === 'tool_result';
}

/** Narrow `ContentBlock` → `ImageBlock`. */
export function isImageBlock(b: ContentBlock): b is ImageBlock {
	return b.type === 'image';
}

// =============================================================================
// round_end event helpers (most-used event shape)
// =============================================================================

/** Predicate: is this event a `round_end` terminator? */
export function isRoundEndEvent(e: InvokeEvent): boolean {
	return e.type === 'round_end';
}

/** Read `reason` off a `round_end` event; returns undefined for other event types. */
export function roundEndReason(e: InvokeEvent): string | undefined {
	if (e.type !== 'round_end') {
		return undefined;
	}
	// Cast through `unknown` because `Record<string, unknown>` and `RoundEndData`
	// don't structurally overlap in tsgo's view. The reasoner contract guarantees
	// `reason` is present on every `round_end` payload (PHASE-1-PROTOCOL-SPEC §2.3).
	const data = e.data as unknown as RoundEndData;
	return data.reason;
}

// =============================================================================
// Typed payload views for reverse-channel / control SSE events (IDE-side)
// =============================================================================

/**
 * Payload of `ide_tool_call` SSE event (reverse channel — IDE-side tool exec).
 *
 * IDE handler: execute the tool by `tool_name`, then POST result to
 * `/api/v1/tool_result/{trace_id}/{call_id}` (call_id from this payload).
 */
export interface IdeToolCallData {
	call_id: string;
	tool_name: string;
	args: Record<string, unknown>;
	timeout_ms?: number;
}

/**
 * Payload of `hook_eval` SSE event (reverse channel — function-hook evaluation,
 * FEAT-004 / H-1). The reasoner asks the IDE to RUN a plugin-contributed
 * executable hook at lifecycle `point` and blocks awaiting the decision.
 *
 * IDE handler: load `module` / invoke `export`, run the hook against
 * `args` (+ `tool_name` / `call_id` context), then POST the decision to
 * `/api/v1/hook_result/{trace_id}/{eval_id}` (eval_id from this payload).
 * Mirrors `reverse_channel.call_hook_eval`'s emitted `data` dict.
 */
export interface HookEvalData {
	eval_id: string;
	point: string;
	tool_name?: string | null;
	call_id?: string | null;
	args: Record<string, unknown>;
	plugin_ids?: string[];
	/** Module path the IDE loads to run the hook (function hooks). */
	module?: string | null;
	/** Named export within `module` to invoke. */
	export?: string | null;
	timeout_ms?: number;
	fail_closed?: boolean;
}

/**
 * Payload of `confirm_request` SSE event (reverse channel — render a card).
 *
 * IDE handler: render ChipOSPermissionCard with this shape, capture user's
 * click, POST result to `/api/v1/confirm_response/{trace_id}/{request_id}`.
 */
export interface ConfirmRequestData {
	request_id: string;
	card_type: string;  // "agent_ask" / "generic" / etc.
	card_data: Record<string, unknown>;
	title?: string;
	buttons?: string[];
}

/**
 * Payload of `checkpoint` event — emitted by reasoner after each LLM call
 * within a turn. IDE can use this as a "safe to resume from here" watermark.
 *
 * - `iteration`: 1-indexed counter within the turn
 * - `messages_count`: total messages accumulated so far in the turn
 */
export interface CheckpointData {
	iteration: number;
	messages_count: number;
}

/**
 * Payload of `keepalive` event — every ~25s heartbeat to prevent proxy timeout.
 */
export interface KeepaliveData {
	ts: number;  // ms epoch
}

/**
 * Payload of `resumed_buffer_drained` event — handoff marker emitted by the
 * /resume endpoint after the SSE replay buffer is drained. Tells the IDE:
 * everything ≤ this seq has been replayed; from here forward you'll see live
 * emissions (F4 live-tail when the loop is still running, or D10 rehydrate
 * continuation after a reasoner restart) or the stream closes here.
 */
export interface ResumedBufferDrainedData {
	sequence_id: number;
}

/**
 * Payload of `resumed_live` event — emitted by /resume (D10, ADR-018 §2 D10 /
 * R-D) right after the drained marker when the reasoner restarted mid-turn and
 * rehydrated the agent loop from its persisted checkpoint. Distinct from
 * `resumed_buffer_drained`: this signals the loop itself resumed (no second
 * `message_start`), so the events that follow are freshly-generated
 * continuation, not buffer replay. Decorative for now — the continuation
 * `content_block_delta` / `round_end` events drive the actual rendering.
 */
export interface ResumedLiveData {
	trace_id: string;
	resumed_from_iteration: number;
}

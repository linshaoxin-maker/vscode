/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8e — pure event-dispatch state machine.
 *
 * Translate one stateless SSE `InvokeEvent` from the reasoner into a
 * `DispatchResult` describing what side-effects the caller should run on its
 * progress channel + how to update its accumulators. Kept free-function /
 * dependency-free so it's straightforward to unit-test without DI.
 *
 * The caller (`ChipOSChatAgent._invokeStateless`) owns:
 *   - text accumulation buffer (so consecutive `content_block_delta` events
 *     fold into one chat bubble),
 *   - the `final_messages` list from the terminal `round_end` event (Phase 1
 *     replaces the Phase 0 `langgraph_state_blob` — IDE appends these
 *     directly to chatSessions/*.jsonl per ADR-018 §2 D8 mixed-state),
 *   - latest token usage,
 *   - termination flag,
 *   - flushing the text buffer on `content_block_stop` / `message_stop` /
 *     `round_end` / `error`,
 *   - reverse-channel dispatch for `ide_tool_call` (POST /tool_result) and
 *     `confirm_request` (POST /confirm_response),
 *   - bookkeeping for `checkpoint` (resume watermark) / `keepalive` (idle
 *     timer reset) / `resumed_buffer_drained` (live-stream handoff marker).
 *
 * Forward-compat: unknown event types are ignored (return `{}`). New
 * reasoner-side events should be additive — clients on older protocol
 * versions silently drop them, the conversation still terminates on
 * `round_end`.
 */

import { resolveRenderEnvelope, type ResolvedRender } from './renderEnvelope.js';
import { StatelessHttpError, StatelessReplayExpiredError } from './statelessClient.js';
import type {
	CheckpointData,
	ConfirmRequestData,
	HookEvalData,
	IdeToolCallData,
	InvokeEvent,
	KeepaliveData,
	Message,
	ResumedBufferDrainedData,
	TokenUsage,
} from './types.js';
import type {
	IChatEdaCoverageReport,
	IChatEdaLintError,
	IChatEdaLintReport,
	IChatEdaNegotiationView,
	IChatEdaParallelProgress,
	IChatEdaPpaMetrics,
	IChatEdaPpaReport,
	IChatEdaProgress,
	IChatEdaSimReport,
	IChatEdaSimTestResult,
	IChatEdaSpecReview,
	IChatEdaWaveform,
	IChatRoundProgress,
} from '../../../../chat/common/chatEdaTypes.js';
import type { ITaskSummaryPayload } from '../../eventTypes.js';

/**
 * What the dispatcher's caller should do after processing one event.
 *
 * All fields are optional. Caller logic:
 *   - `appendText`: concat onto its assistant-text accumulator.
 *   - `flushText`: call its flush helper (`progress([markdown(buf)])`) and
 *     reset the buffer.
 *   - `progressMessage`: emit as `IChatProgressMessage` (e.g. tool-call
 *     pill, shimmer reconnect banner).
 *   - `thinkingText`: emit as `IChatThinkingPart` (reasoning panel).
 *   - `markdownError`: emit as `IChatMarkdownContent` then mark error
 *     in the final result (see `errorMessage`).
 *   - `usage`: stash for the final result's metadata.
 *   - `errorMessage`: when set, caller terminates with errorDetails.
 *   - `terminate`: when true, the SSE round is over; caller breaks
 *     the for-await loop after flushing.
 *
 * Phase 1 (ADR-018) additions — reverse-channel + heartbeat plumbing:
 *   - `ideToolCall`: reasoner asked IDE to execute a tool. Caller must
 *     run the tool and POST result to `/api/v1/tool_result/{trace_id}/{call_id}`.
 *   - `confirmRequest`: reasoner asked IDE to render a confirm card. Caller
 *     renders, captures user click, POSTs to
 *     `/api/v1/confirm_response/{trace_id}/{request_id}`.
 *   - `keepalive`: heartbeat — caller may reset its idle-disconnect timer.
 *   - `checkpoint`: safe-to-resume watermark — caller may stash for later
 *     `/api/v1/resume/{chat_session_id}` calls (`last_sequence_id`).
 *   - `resumedBufferDrained`: emitted by `/resume` after replay catches up;
 *     caller knows it's now on the live stream (or stream closes here).
 *   - `finalMessages`: from the terminal `round_end.data.final_messages` —
 *     caller appends these to chatSessions/*.jsonl. Replaces the Phase 0
 *     `langgraphStateBlob` field which is gone from the wire.
 */
export interface DispatchResult {
	appendText?: string;
	flushText?: boolean;
	progressMessage?: { content: string; shimmer?: boolean };
	thinkingText?: string;
	/**
	 * [ChipOS] Final assistant reply text carried by a `chat` event (deps.reply →
	 * ChatMessage{content}). The STATEFUL caller renders it ONLY if no assistant
	 * text streamed this turn (`model_output` / `content_block_delta`) — mirroring
	 * the reasoner accumulator's `_saw_streamed_text` guard
	 * (stateless_agentcore_driver.py:217) on the live render side. For the main
	 * agent the reply already streamed, so the caller drops this; for a reply path
	 * that never streams (subagent / resume / analog clarification / a
	 * non-streaming provider) this is the ONLY carrier of the reply.
	 */
	replyText?: string;
	markdownError?: string;
	usage?: TokenUsage;
	errorMessage?: string;
	terminate?: boolean;
	/**
	 * [ChipOS][F-4] Next-step suggestion(s) from `round_end.final_result.followups`
	 * (the reasoner's mandated `建议下一步: …` line). The caller stashes them on the
	 * turn result so `provideFollowups` can render native clickable reply chips.
	 */
	followups?: string[];
	/**
	 * [ChipOS] Phase 6 / Run workbench: the run-relevant slice of a terminal
	 * `round_end.final_result` (trace_id / status / verdict / artifacts / changed
	 * files / errors). Present only when the turn produced artifacts or changed
	 * files (a real EDA run, not plain chat). The caller persists it via
	 * `IRunStorageService` so it surfaces in the Runs view.
	 */
	runResult?: {
		traceId: string;
		status: string;
		verdict: string;
		artifacts: { kind: string; uri?: string; summary?: string }[];
		changedFiles: string[];
		errors: { category?: string; code?: string; message?: string }[];
	};
	/**
	 * [ChipOS] Phase 6 / Waveform viewer (slice 5 Part B): the reasoner asked the
	 * IDE to open a waveform (`.vcd`) in Vaporview and best-effort reveal `signals`
	 * (full instance paths) / mark a `cycle`. An imperative host ACTION (the
	 * `viewer_action` event, `control` family) — NOT a render card — so the
	 * dispatcher stays pure and just surfaces the descriptor; the DI-constructed
	 * caller resolves `path` against the workspace and drives
	 * `IChiposWaveformService.openWaveform`. `path` may be workspace-relative or
	 * absolute.
	 */
	viewerAction?: {
		path: string;
		signals?: string[];
		cycle?: number;
	};
	/**
	 * [ChipOS] Phase 6 / PPA workbench: a structured slice of a `ppa_report` event
	 * (stage / round / strategy + current/baseline/best metrics + improvement). The
	 * dispatcher already renders the inline card via `edaParts`; this directive lets
	 * the DI-constructed caller ALSO persist it (with the turn's trace id) into the
	 * `IPpaStorageService` so the dedicated PPA view + dashboard surface it.
	 */
	ppaReport?: {
		round?: number;
		stage: string;
		strategy?: string;
		current?: IChatEdaPpaMetrics;
		baseline?: IChatEdaPpaMetrics;
		best?: IChatEdaPpaMetrics;
		improvement?: Record<string, number>;
	};
	// Phase 1 additions (ADR-018 §2 D7 + D8 + D10 + D14):
	/** Reverse channel: IDE must execute this tool + POST result back. */
	ideToolCall?: { callId: string; toolName: string; args: Record<string, unknown>; timeoutMs?: number };
	/**
	 * Reverse channel (FEAT-004 / H-1): the reasoner asked the IDE to RUN a
	 * plugin-contributed function hook at a lifecycle `point` and is blocking on
	 * the decision. The caller loads `module` / invokes `export` against `args`
	 * (+ `toolName` / `callId` context), then POSTs the decision to
	 * `/api/v1/hook_result/{trace_id}/{evalId}`. Mirrors `ideToolCall` shape.
	 */
	hookEval?: {
		evalId: string;
		point: string;
		toolName?: string;
		callId?: string;
		args: Record<string, unknown>;
		module?: string;
		export?: string;
		pluginIds?: string[];
		timeoutMs?: number;
		failClosed?: boolean;
	};
	/** Reverse channel: IDE must render confirm card + POST user choice back. */
	confirmRequest?: { requestId: string; cardType: string; cardData: Record<string, unknown>; title?: string; buttons?: string[] };
	/** Keepalive heartbeat — reset client-side idle timer; usually no-op render. */
	keepalive?: { ts: number };
	/** Checkpoint watermark — IDE may store as "safe-to-resume seq" marker. */
	checkpoint?: { iteration: number; messagesCount: number };
	/** Resume buffer-drain done marker (from /resume endpoint stream). */
	resumedBufferDrained?: { sequenceId: number };
	/**
	 * D10 rehydrate marker: the reasoner restarted mid-turn and re-drove the
	 * agent loop from its checkpoint. The caller uses this to retire any confirm
	 * card that was live on the old reasoner — the rehydrated loop re-emits a
	 * FRESH `confirm_request` (new request_id), so the original card would
	 * otherwise linger as a dead duplicate.
	 */
	resumedLive?: boolean;
	/** When `terminate: true`, the final_messages list to append to chatSessions/*.jsonl. */
	finalMessages?: Message[];
	/**
	 * [ChipOS] A tool-call lifecycle update for collapsible tool-invocation
	 * rendering (replaces the plain "$(tools) name" progressMessage). The
	 * caller pairs start/complete by `callId`:
	 *   - `tool_call_emitted`    → { isComplete:false, toolName, input }
	 *   - `tool_result_observed` → { isComplete:true, outputPreview, isError }
	 * The reasoner ships the args (`input`) and a result preview
	 * (`content_preview`) precisely so the IDE can show what each tool did.
	 */
	toolInvocation?: {
		callId: string;
		toolName?: string;
		input?: Record<string, unknown>;
		isComplete: boolean;
		outputPreview?: string;
		isError?: boolean;
		/**
		 * Backend `error_kind` carried on a tool_result (e.g. 'hook_deny' when a
		 * reasoner hook blocked the tool before dispatch). Lets the renderer show a
		 * distinct "🛡 被 hook 拦截" badge instead of a generic red tool-error.
		 */
		errorKind?: string;
	};
	/**
	 * [ChipOS] Fusion: a sub-agent (composite role) tool-lifecycle frame. On
	 * the agent_core path the reasoner delegates to internal roles (e.g.
	 * `lint_fix_loop` → `rtl-coder`) and emits `subagent_event` frames for each
	 * of the role's own tool calls. The caller turns the FIRST frame per
	 * `taskId` into a parent subagent toolInvocation (the collapsible card
	 * header) and each `tool_start` / `tool_end` into a CHILD toolInvocation
	 * tagged with that card's id — so the activity renders inside the native
	 * `ChatSubagentContentPart` card instead of the old transient one-line
	 * progress message. There is no model `task` tool call on this path
	 * (composite roles run reasoner-side), so the caller synthesizes the parent.
	 */
	subagentEvent?: {
		/** The delegated role, e.g. "rtl-coder" — keys the card + names the agent. */
		taskId: string;
		kind: 'tool_start' | 'tool_end';
		toolName?: string;
		/** tool_start args (file_path lives here for edit tools). */
		args?: Record<string, unknown>;
		/** tool_end file path (for edit tools, when the reasoner resolved it). */
		filePath?: string;
		/** tool_start before-snapshot for edit tools (often empty on this path). */
		snapshotContent?: string;
		/** tool_end terse outcome ("✓ 通过" / "12 行" / "改 1 处") — rendered as a dim badge after the object. */
		result?: string;
	};
	/**
	 * [ChipOS] Structured agent error → rendered as an `agentError` card
	 * (category icon + error code + retry hint) instead of a plain markdown
	 * line. Carries the raw backend fields; the caller applies category
	 * presets for the final visual.
	 */
	agentError?: {
		category?: string;
		errorCode?: string;
		message: string;
		retryable?: boolean;
	};
	/**
	 * [ChipOS] Fusion: rich EDA report cards (sim test table, lint error table,
	 * coverage, PPA comparison, multi-agent negotiation, parallel-track progress,
	 * spec review). The agent_core / composite-tools path emits these as
	 * `sim_report` / `lint_report` / `coverage_report` / `ppa_report` /
	 * `negotiation_view` / `parallel_progress` / `spec_review` events; the
	 * dispatcher parses the backend payload (whose keys differ from the legacy
	 * WebSocket shape) into the native `IChatEda*` content parts. The caller emits
	 * them via its `progress(...)` channel — flush any pending assistant text
	 * FIRST (cases below set `flushText: true`) so the card lands after the prose
	 * it summarizes, not before. Mirrors the legacy `_handleAgentEvent` path so a
	 * prod (stateless) turn shows the same rich cards the WebSocket path did.
	 */
	edaParts?: IChatEdaProgress[];
	/**
	 * [ChipOS] `diff_preview` → a framework-native `textEditGroup` (side-by-side
	 * diff editor with built-in Apply/Discard buttons), NOT a fenced ```diff```
	 * markdown block. The caller resolves `filePath` against the workspace and
	 * emits a `kind: 'textEdit'` progress part per file; the chat model folds
	 * those into one `textEditGroup` rendered by `ChatTextEditContentPart`. The
	 * `edits` are whole-line replacements derived purely from the hunk headers
	 * (the `@@ -oldStart,oldLen @@` ranges) so we never have to read the file —
	 * the renderer loads the on-disk original itself and applies these edits to
	 * produce the modified side.
	 */
	diffPreview?: {
		filePath: string;
		edits: IDiffTextEdit[];
	};
	/**
	 * [ChipOS] Markdown blocks to render (each via the caller's `_markdown`
	 * helper). Used as a fallback when a `diff_preview` carries no parseable
	 * hunks (so the native diff path has nothing to render), plus the layer-3
	 * RenderEnvelope degrade note.
	 */
	markdownContents?: string[];
	/**
	 * [ChipOS] End-of-turn structured summary. Replaces the Phase-0 single-line
	 * progress downgrade: the caller renders the full `_formatTaskSummary` card
	 * (verdict badge + KV table + generated files + next steps), matching legacy.
	 * `structured_data` is already JSON-parsed (the subagent_tracker path ships it
	 * as a `structured_data_json` string; the agent_core SummaryAssembler ships a
	 * `structured_data` object).
	 */
	taskSummary?: ITaskSummaryPayload;
	/**
	 * [ChipOS] #4: round termination reason from `round_end.data.reason`. Present
	 * only when terminate: true. Values: 'end_turn' (normal) / 'max_iterations' /
	 * 'max_tokens' (resource limits) / 'cancelled' (user) / 'interrupted'
	 * (reasoner-side failure). The caller surfaces non-'end_turn' termination so a
	 * truncated turn (hit the 50-round cap) is visibly distinct from clean
	 * completion — the two render identically otherwise.
	 */
	terminationReason?: string;
}

/**
 * Render a degraded RenderEnvelope (layer 3 — unknown kind / schema too new /
 * `ui_spec`) as a markdown block. D10: the mandatory `fallback` is NEVER dropped.
 * The reasoner ships human-readable `summary` / `text` / `message` (+ optional
 * `artifact_ref`); format whatever is present into one block, flushing pending
 * assistant text first so it lands after the prose it summarizes.
 */
function renderEnvelopeFallback(resolved: ResolvedRender): DispatchResult {
	const fb = (resolved.data ?? {}) as Record<string, unknown>;
	const summary = typeof fb.summary === 'string' && fb.summary ? fb.summary
		: typeof fb.text === 'string' && fb.text ? fb.text
			: typeof fb.message === 'string' && fb.message ? fb.message : '';
	const parts: string[] = [];
	if (summary) {
		parts.push(summary);
	}
	// artifact_ref → a link when the fallback carries a resolvable path/uri.
	const ref = fb.artifact_ref;
	if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
		const r = ref as Record<string, unknown>;
		const href = typeof r.uri === 'string' ? r.uri : typeof r.path === 'string' ? r.path : '';
		if (href) {
			const label = typeof r.label === 'string' && r.label ? r.label : href;
			parts.push(`[${label}](${href})`);
		}
	}
	if (parts.length === 0) {
		// Never empty — surface the kind so a degrade is visible, not a silent drop.
		parts.push(resolved.kind ? `\`${resolved.kind}\`` : 'Result');
	}
	return { flushText: true, markdownContents: [parts.join('\n\n')] };
}

/**
 * A whole-line replacement edit, in the shape the framework's `kind: 'textEdit'`
 * progress part expects (`range` is an `IRange`, `text` is the replacement).
 * Kept structurally compatible with `editor/common/languages.ts#TextEdit` /
 * `core/range.ts#IRange` so the caller can hand it straight to the chat model
 * without a conversion step — declared locally to keep this module DI-free and
 * unit-testable.
 */
export interface IDiffTextEdit {
	range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
	text: string;
}

/**
 * Reconstruct framework `TextEdit`s from a `diff_preview` hunk list so the
 * caller can render a native side-by-side diff (with Apply/Discard) instead of a
 * fenced ```diff``` block.
 *
 * Each hunk header is `@@ -oldStart[,oldLen] +newStart[,newLen] @@`; we replace
 * the original lines `[oldStart, oldStart+oldLen)` with the hunk's resulting
 * lines (its `ctx` + `add` lines, in order — `del` lines are dropped). The
 * replacement is a *whole-line* edit: the range runs from `(oldStart, 1)` to the
 * start of the line after the block, and the text keeps a trailing newline, so
 * the framework applies it cleanly against the on-disk original it loads itself
 * (we never read the file here).
 *
 * Hunks with no parseable header, or whose lines are all context (no real
 * change), are skipped. Returns `[]` when nothing is renderable so the caller
 * can fall back to a markdown block.
 */
export function buildTextEditsFromDiffHunks(
	hunks: Array<{ header?: string; lines?: Array<{ type?: string; content?: string }> }>,
): IDiffTextEdit[] {
	const edits: IDiffTextEdit[] = [];
	for (const hunk of hunks) {
		const header = typeof hunk.header === 'string' ? hunk.header : '';
		// `@@ -oldStart,oldLen +newStart,newLen @@` — oldLen defaults to 1 when omitted.
		const match = /^@@\s*-(?<oldStart>\d+)(?:,(?<oldLen>\d+))?\s+\+\d+(?:,\d+)?\s*@@/.exec(header);
		if (!match || !match.groups) {
			continue;
		}
		const oldStart = Number(match.groups.oldStart);
		const oldLen = match.groups.oldLen !== undefined ? Number(match.groups.oldLen) : 1;
		if (!Number.isFinite(oldStart) || oldStart < 1 || !Number.isFinite(oldLen) || oldLen < 0) {
			continue;
		}
		const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
		const hasChange = lines.some(l => l.type === 'add' || l.type === 'del');
		if (!hasChange) {
			// Pure-context hunk — nothing to apply.
			continue;
		}
		// New side = ctx + add lines, in order; del lines are removed.
		const newLines = lines
			.filter(l => l.type !== 'del')
			.map(l => typeof l.content === 'string' ? l.content : '');
		// Whole-line replace of [oldStart, oldStart+oldLen): from (oldStart,1) to
		// the first column of the line just past the block. Keep a trailing \n so
		// the replaced lines remain newline-terminated.
		const text = newLines.length > 0 ? newLines.join('\n') + '\n' : '';
		edits.push({
			range: {
				startLineNumber: oldStart,
				startColumn: 1,
				endLineNumber: oldStart + oldLen,
				endColumn: 1,
			},
			text,
		});
	}
	return edits;
}

/**
 * Translate one `InvokeEvent` → `DispatchResult`. Pure function.
 *
 * S5 / F-1-ide entry: unwrap the {@link resolveRenderEnvelope RenderEnvelope} before
 * the per-type switch so the render cases (which read `event.data` directly, e.g.
 * `data.tests` for `sim_report`) see the real card payload, not the
 * `{ kind, payload, fallback }` wrapper.
 *   - layer 1 (legacy bare frame) → passes through untouched (backward-compat, D-2);
 *   - layer 2 (known kind, compatible schema) → `event.data` becomes the payload;
 *   - layer 3 (unknown kind / schema too new / `ui_spec`) → render `fallback` (D10).
 *
 * @param event raw event off the SSE stream
 * @param friendlyToolName optional tool-name humaniser (defaults to identity)
 */
export function dispatchStatelessEvent(
	event: InvokeEvent,
	friendlyToolName: (raw: string) => string = raw => raw,
): DispatchResult {
	const resolved = resolveRenderEnvelope(event.data);
	if (resolved.degraded) {
		return renderEnvelopeFallback(resolved);
	}
	// Layer 2 unwrap: `resolved.data` is the envelope payload, guaranteed an object by
	// `resolveRenderEnvelope` (the safePayload guard) — coerce to the event `data` shape.
	const unwrapped: InvokeEvent = resolved.data === event.data
		? event
		: { ...event, data: resolved.data as Record<string, unknown> };
	return dispatchUnwrappedEvent(unwrapped, friendlyToolName);
}

/**
 * EDA payload schema guard. These card payloads ship with BARE keys (no
 * RenderEnvelope on this path), so a backend key rename / schema drift makes a
 * card render SILENTLY EMPTY — and a 0-row lint/sim card reads as "passed", which
 * is worse than nothing. If the event carried a non-empty payload but NONE of the
 * keys this card knows how to render are present, return a VISIBLE degraded note
 * (+ the raw keys) instead. Returns null when fine: empty payload (legit no-op),
 * or ≥1 recognized key present.
 */
function edaSchemaGuard(kind: string, raw: Record<string, unknown>, recognizedKeys: readonly string[]): DispatchResult | null {
	const keys = Object.keys(raw);
	if (keys.length === 0 || recognizedKeys.some(k => k in raw)) {
		return null;
	}
	return {
		flushText: true,
		markdownContents: [`> ⚠️ **EDA "${kind}" 卡无法渲染** — 后端 payload 未含任何已知字段(收到: ${keys.join(', ')})。可能是 IDE↔reasoner 字段约定漂移了。`],
	};
}

/**
 * The per-`event.type` switch, operating on an already-unwrapped event (see
 * {@link dispatchStatelessEvent}). `friendlyToolName` is injected so the dispatcher
 * can render `Calling ${friendly_name}` without importing the chat agent's
 * `_friendlyToolName` map.
 */
function dispatchUnwrappedEvent(
	event: InvokeEvent,
	friendlyToolName: (raw: string) => string,
): DispatchResult {
	switch (event.type) {
		case 'message_start':
		case 'content_block_start':
			return {};

		case 'content_block_delta': {
			// Anthropic shape: { delta: { type: 'text_delta', text: '...' } }
			const data = (event.data ?? {}) as { delta?: { type?: string; text?: string } };
			if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
				return { appendText: data.delta.text };
			}
			return {};
		}

		case 'content_block_stop':
			return { flushText: true };

		case 'message_delta': {
			// PHASE-0-SPEC-AUDIT P0-3: server emits usage on message_delta.
			const data = (event.data ?? {}) as { usage?: TokenUsage };
			return data.usage ? { usage: data.usage } : {};
		}

		case 'message_stop':
			return { flushText: true };

		case 'tool_call_emitted': {
			// [ChipOS] Render as a collapsible tool invocation (was: a plain
			// "$(tools) name" progressMessage that couldn't be expanded). The
			// reasoner ships id + name + input — pass them through so the IDE
			// shows the tool name and its args.
			const data = (event.data ?? {}) as { id?: string; name?: string; input?: Record<string, unknown> };
			const name = typeof data.name === 'string' ? data.name : 'tool';
			return {
				flushText: true,
				toolInvocation: {
					callId: typeof data.id === 'string' && data.id ? data.id : name,
					toolName: name,
					input: data.input && typeof data.input === 'object' ? data.input : undefined,
					isComplete: false,
				},
			};
		}

		case 'tool_result_observed': {
			// [ChipOS] Was dropped ("not surfaced to user") even though the
			// reasoner explicitly marks this event display-purpose and ships a
			// content_preview. Pair by tool_use_id and complete the invocation
			// with the result preview so the user can see what the tool returned.
			const data = (event.data ?? {}) as { tool_use_id?: string; is_error?: boolean; content_preview?: string };
			const callId = typeof data.tool_use_id === 'string' ? data.tool_use_id : '';
			if (!callId) {
				return {};
			}
			return {
				toolInvocation: {
					callId,
					isComplete: true,
					outputPreview: typeof data.content_preview === 'string' ? data.content_preview : '',
					isError: !!data.is_error,
				},
			};
		}

		case 'tool_start': {
			// [ChipOS] Fusion: the agent_core bridge surfaces the MASTER's own tool
			// calls as `tool_start` / `tool_result` (legacy 10-event protocol), NOT
			// the `tool_call_emitted` / `tool_result_observed` pair above (those are
			// the Anthropic-passthrough names). Without these two cases the master's
			// read/edit/lint/synthesis calls rendered as nothing — only the model's
			// prose — so we map them onto the same toolInvocation directive that the
			// shared row template (verb + `object` + result) renders.
			const data = (event.data ?? {}) as { tool_id?: string; tool_name?: string; args?: Record<string, unknown> };
			const name = typeof data.tool_name === 'string' ? data.tool_name : 'tool';
			return {
				flushText: true,
				toolInvocation: {
					callId: typeof data.tool_id === 'string' && data.tool_id ? data.tool_id : name,
					toolName: name,
					input: data.args && typeof data.args === 'object' ? data.args : undefined,
					isComplete: false,
				},
			};
		}

		case 'tool_result': {
			const data = (event.data ?? {}) as { tool_id?: string; content?: string; is_error?: boolean; error_kind?: string };
			const callId = typeof data.tool_id === 'string' ? data.tool_id : '';
			if (!callId) {
				return {};
			}
			return {
				toolInvocation: {
					callId,
					isComplete: true,
					outputPreview: typeof data.content === 'string' ? data.content : '',
					isError: !!data.is_error,
					// 'hook_deny' (FEAT-004) → renderer shows a hook-block badge, not a tool error.
					errorKind: typeof data.error_kind === 'string' ? data.error_kind : undefined,
				},
			};
		}

		case 'ide_tool_call': {
			// Phase 1 reverse channel — IDE-side tool execution. Reasoner blocks
			// awaiting POST /tool_result/{trace_id}/{call_id}. flushText so any
			// pending assistant text renders before we kick off tool exec.
			const data = (event.data ?? {}) as unknown as IdeToolCallData;
			return {
				flushText: true,
				ideToolCall: {
					callId: data.call_id,
					toolName: data.tool_name,
					args: data.args,
					timeoutMs: typeof data.timeout_ms === 'number' ? data.timeout_ms : undefined,
				},
			};
		}

		case 'hook_eval': {
			// FEAT-004 / H-1 reverse channel — the reasoner asked the IDE to RUN a
			// plugin-contributed function hook at a lifecycle `point` and is blocking
			// awaiting POST /hook_result/{trace_id}/{eval_id}. Mirrors ide_tool_call:
			// flushText so any pending assistant text renders before the eval runs,
			// and surface the structured payload (module/export carrier + plugin_ids
			// + timeout/fail-closed posture) so the caller can load + invoke it.
			const data = (event.data ?? {}) as unknown as HookEvalData;
			return {
				flushText: true,
				hookEval: {
					evalId: data.eval_id,
					point: data.point,
					toolName: typeof data.tool_name === 'string' ? data.tool_name : undefined,
					callId: typeof data.call_id === 'string' ? data.call_id : undefined,
					args: data.args,
					module: typeof data.module === 'string' ? data.module : undefined,
					export: typeof data.export === 'string' ? data.export : undefined,
					pluginIds: Array.isArray(data.plugin_ids) ? data.plugin_ids : undefined,
					timeoutMs: typeof data.timeout_ms === 'number' ? data.timeout_ms : undefined,
					failClosed: typeof data.fail_closed === 'boolean' ? data.fail_closed : undefined,
				},
			};
		}

		case 'confirm_request': {
			// Phase 1 reverse channel — render ChipOSPermissionCard, capture
			// click, POST /confirm_response/{trace_id}/{request_id}.
			const data = (event.data ?? {}) as unknown as ConfirmRequestData;
			return {
				flushText: true,
				confirmRequest: {
					requestId: data.request_id,
					cardType: data.card_type,
					cardData: data.card_data,
					title: typeof data.title === 'string' ? data.title : undefined,
					buttons: Array.isArray(data.buttons) ? data.buttons : undefined,
				},
			};
		}

		case 'keepalive': {
			// Phase 1 anti-proxy-timeout heartbeat (every ~25s). Caller may
			// use it to reset its idle timer or render a subtle alive indicator.
			const data = (event.data ?? {}) as unknown as KeepaliveData;
			return { keepalive: { ts: typeof data.ts === 'number' ? data.ts : 0 } };
		}

		case 'checkpoint': {
			// Phase 1 safe-to-resume watermark. Caller stashes for a future
			// /resume call's `last_sequence_id` semantics.
			const data = (event.data ?? {}) as unknown as CheckpointData;
			return {
				checkpoint: {
					iteration: typeof data.iteration === 'number' ? data.iteration : 0,
					messagesCount: typeof data.messages_count === 'number' ? data.messages_count : 0,
				},
			};
		}

		case 'resumed_buffer_drained': {
			// Phase 1 /resume endpoint handoff marker — replay caught up,
			// from this seq forward we're on the live stream (or stream closes).
			const data = (event.data ?? {}) as unknown as ResumedBufferDrainedData;
			return {
				resumedBufferDrained: {
					sequenceId: typeof data.sequence_id === 'number' ? data.sequence_id : 0,
				},
			};
		}

		case 'resumed_live':
			// D10 (ADR-018 §2 D10 / R-D) marker: the reasoner restarted mid-turn
			// and rehydrated the agent loop from its checkpoint. The continuation
			// content_block_delta / round_end events that follow drive the actual
			// rendering — but the rehydrated loop also re-emits any pending
			// confirm_request with a FRESH request_id, so the caller must retire
			// the now-orphaned card from the dead reasoner (else two cards show
			// for one logical confirm).
			return { resumedLive: true };

		case 'thinking_delta': {
			const data = (event.data ?? {}) as { delta?: { text?: string } };
			const text = typeof data.delta?.text === 'string' ? data.delta.text : '';
			return text.length > 0 ? { thinkingText: text } : {};
		}

		case 'round_progress': {
			// [ChipOS] #1: the roundProgress content part IS registered
			// (chiposContribution registerContentPart('roundProgress')) but this
			// case used to drop the event (`return {}`), so multi-round composite
			// loops (lint_fix / ppa_optimize / sim_debug) rendered no round
			// counter — a half-wired part. Map the backend payload onto the part
			// so the agentcore path shows live "round N/M" progress.
			const data = (event.data ?? {}) as {
				current_round?: number;
				max_rounds?: number;
				phase?: string;
				status?: string;
				tool?: string;
			};
			return {
				flushText: true,
				edaParts: [{
					kind: 'roundProgress',
					current_round: typeof data.current_round === 'number' ? data.current_round : 0,
					max_rounds: typeof data.max_rounds === 'number' ? data.max_rounds : 0,
					phase: typeof data.phase === 'string' ? data.phase : undefined,
					status: (data.status === 'running' || data.status === 'done' || data.status === 'failed') ? data.status : undefined,
					tool: typeof data.tool === 'string' ? data.tool : undefined,
				} satisfies IChatRoundProgress],
			};
		}

		case 'trace_link':
			// Decorative — reserved for future UI hooks.
			return {};

		// ── [ChipOS] Fusion (Direction 2): rich agent_core events ──────────
		// The bare loop streams assistant text as `content_block_delta`; the
		// agent_core driver instead emits `model_output` (streamed deltas) +
		// the rich semantic events below. Map them onto the existing render
		// channels so the agentcore path renders without new chat-agent code.

		case 'model_output': {
			// Streamed assistant text (legacy adapter shape: { content, is_delta }).
			// Without this the agentcore path would render NO assistant text.
			const data = (event.data ?? {}) as { content?: string };
			return typeof data.content === 'string' && data.content
				? { appendText: data.content }
				: {};
		}

		case 'chat': {
			// Final assistant reply (deps.reply → ChatMessage{content}). The main
			// agent already streamed this via `model_output`, so the caller drops
			// it (sawStreamedText). But a reply path that does NOT stream
			// model_output (subagent / resume / analog clarification / a
			// non-streaming provider) carries its ONLY text here — hand it to the
			// STATEFUL caller as `replyText` and let it decide: render iff nothing
			// streamed this turn. This is the live-render mirror of the reasoner
			// accumulator's `_saw_streamed_text` guard (which already does the same
			// for persisted history at stateless_agentcore_driver.py:217), so a
			// chat-only reply is no longer invisible on screen while present in history.
			const data = (event.data ?? {}) as { content?: string };
			return typeof data.content === 'string' && data.content
				? { replyText: data.content }
				: {};
		}

		case 'status': {
			// EDA status line ("正在综合…" etc.) → a progress message.
			const data = (event.data ?? {}) as { message?: string; text?: string };
			const content = typeof data.message === 'string' ? data.message
				: typeof data.text === 'string' ? data.text : '';
			return content ? { flushText: true, progressMessage: { content } } : {};
		}

		case 'subagent_event': {
			// Sub-agent (composite role) activity → a `subagentEvent` directive
			// the caller renders as a collapsible `ChatSubagentContentPart` card
			// (parent header + nested tool rows), replacing the old transient
			// one-line progress message. The reasoner ships `task_id` (the role,
			// e.g. "rtl-coder") + `kind` ("tool_start"/"tool_end") + `tool_name`
			// (+ `args` / `file_path` / `snapshot_content`); legacy aliases
			// `subagent` / `phase` mirror task_id / kind.
			const data = (event.data ?? {}) as {
				task_id?: string; subagent?: string;
				kind?: string; phase?: string;
				tool_name?: string;
				args?: Record<string, unknown>;
				file_path?: string; snapshot_content?: string;
				result?: string;
			};
			const taskId = typeof data.task_id === 'string' && data.task_id ? data.task_id
				: typeof data.subagent === 'string' && data.subagent ? data.subagent : '';
			const kind = typeof data.kind === 'string' ? data.kind
				: typeof data.phase === 'string' ? data.phase : '';
			// Only tool-lifecycle frames drive the card; anything else (or a frame
			// with no task_id) is dropped — forward-compatible, and the bare
			// progress line it used to render is exactly what we're replacing.
			if (!taskId || (kind !== 'tool_start' && kind !== 'tool_end')) {
				return {};
			}
			return {
				subagentEvent: {
					taskId,
					kind,
					toolName: typeof data.tool_name === 'string' ? data.tool_name : undefined,
					args: data.args && typeof data.args === 'object' ? data.args as Record<string, unknown> : undefined,
					filePath: typeof data.file_path === 'string' ? data.file_path : undefined,
					snapshotContent: typeof data.snapshot_content === 'string' ? data.snapshot_content : undefined,
					result: typeof data.result === 'string' && data.result ? data.result : undefined,
				},
			};
		}

		// ── [ChipOS] Fusion: rich EDA report cards ─────────────────────────
		// The composite-tools / agent_core path emits these report events via
		// deps.emit (bridged onto the wire by SSEEmitSink). Phase 0 dropped them
		// (no case → `default: {}`), so a prod stateless turn lost every rich EDA
		// card the legacy WebSocket path rendered. Map each onto the native
		// `IChatEda*` content part. IMPORTANT: payload keys follow what the
		// BACKEND `safe_emit`s (see composite_tools/*), which differs from the
		// legacy WebSocket payload — e.g. lint errors carry `column` (not `col`),
		// negotiation arrives as per-round `perspectives` / `challenges`, coverage
		// `gaps` are plain strings. Each case flushes pending assistant text first
		// so the card lands after the prose it summarizes.

		case 'sim_report': {
			const guard = edaSchemaGuard('sim_report', (event.data ?? {}) as Record<string, unknown>, ['tests', 'summary', 'round', 'result']);
			if (guard) { return guard; }
			// sim_debug_loop emits {tests:[{name,status,message}], summary:{total,passed,failed}};
			// coverage_boost's internal simulate emits {round, result} (no tests) →
			// an empty table (parity with legacy, which normalized the same way).
			const data = (event.data ?? {}) as {
				tests?: Array<{ name?: string; status?: string; message?: string; duration_ms?: number }>;
				summary?: { total?: number; passed?: number; failed?: number; errors?: number };
			};
			const tests: IChatEdaSimTestResult[] = Array.isArray(data.tests)
				? data.tests.map(t => ({
					name: typeof t.name === 'string' ? t.name : '',
					status: (t.status === 'pass' || t.status === 'fail' || t.status === 'error' || t.status === 'skip') ? t.status : 'error',
					message: typeof t.message === 'string' ? t.message : undefined,
					duration_ms: typeof t.duration_ms === 'number' ? t.duration_ms : undefined,
				}))
				: [];
			const s = data.summary;
			const summary = (s && typeof s === 'object' && typeof s.total === 'number')
				? { total: s.total, passed: s.passed ?? 0, failed: s.failed ?? 0, errors: s.errors }
				: {
					total: tests.length,
					passed: tests.filter(t => t.status === 'pass').length,
					failed: tests.filter(t => t.status === 'fail').length,
					errors: tests.filter(t => t.status === 'error').length || undefined,
				};
			return { flushText: true, edaParts: [{ kind: 'edaSimReport', tests, summary } satisfies IChatEdaSimReport] };
		}

		case 'coverage_report': {
			const guard = edaSchemaGuard('coverage_report', (event.data ?? {}) as Record<string, unknown>, ['gaps', 'line_cov', 'branch_cov', 'toggle_cov', 'overall_cov', 'target', 'round']);
			if (guard) { return guard; }
			// coverage_boost: {line_cov?, branch_cov?, toggle_cov?, overall_cov?,
			// target?, gaps: string[], ...} (values are 0-100 percentages). The
			// text-fallback path omits line_cov/branch_cov (only overall_cov) and
			// `gaps` are formatted strings ("file:line [kind] body"), not objects.
			// P1-3: forward toggle/overall/target so the card shows the full RTL
			// coverage picture; pass line/branch only when present (the part shows
			// "N/A" for absent metrics rather than faking them from overall_cov).
			const data = (event.data ?? {}) as {
				line_cov?: number; branch_cov?: number; toggle_cov?: number;
				overall_cov?: number; target?: number; gaps?: unknown[];
			};
			const rawGaps = Array.isArray(data.gaps) ? data.gaps : [];
			const gaps = rawGaps.length
				? rawGaps.map(g => {
					if (typeof g === 'string') { return { file: '', lines: g }; }
					const o = (g ?? {}) as { file?: string; lines?: string | number; type?: string };
					return {
						file: typeof o.file === 'string' ? o.file : '',
						lines: typeof o.lines === 'string' ? o.lines : String(o.lines ?? ''),
						type: typeof o.type === 'string' ? o.type : undefined,
					};
				})
				: undefined;
			const coverage: IChatEdaCoverageReport = { kind: 'edaCoverageReport', gaps };
			if (typeof data.line_cov === 'number') { coverage.line_cov = data.line_cov; }
			if (typeof data.branch_cov === 'number') { coverage.branch_cov = data.branch_cov; }
			if (typeof data.toggle_cov === 'number') { coverage.toggle_cov = data.toggle_cov; }
			if (typeof data.overall_cov === 'number') { coverage.overall_cov = data.overall_cov; }
			if (typeof data.target === 'number') { coverage.target = data.target; }
			return { flushText: true, edaParts: [coverage] };
		}

		case 'lint_report': {
			const guard = edaSchemaGuard('lint_report', (event.data ?? {}) as Record<string, unknown>, ['errors', 'auto_fixable', 'tool', 'round']);
			if (guard) { return guard; }
			// lint_fix_loop: {round, errors:[{file,line,column,rule,message,severity}]}
			// — note `column`, not the IDE's `col`.
			const data = (event.data ?? {}) as {
				errors?: Array<{ file?: string; line?: number; col?: number; column?: number; severity?: string; message?: string; rule?: string; auto_fixable?: boolean }>;
				auto_fixable?: number; tool?: string; file?: string; file_path?: string;
			};
			const errors: IChatEdaLintError[] = Array.isArray(data.errors)
				? data.errors.map(e => ({
					file: typeof e.file === 'string' ? e.file : '',
					line: typeof e.line === 'number' ? e.line : 0,
					col: typeof e.col === 'number' ? e.col : (typeof e.column === 'number' ? e.column : undefined),
					severity: (e.severity === 'error' || e.severity === 'warning' || e.severity === 'info') ? e.severity : 'error',
					message: typeof e.message === 'string' ? e.message : '',
					rule: typeof e.rule === 'string' ? e.rule : undefined,
					auto_fixable: typeof e.auto_fixable === 'boolean' ? e.auto_fixable : undefined,
				}))
				: [];
			// Resolve the linted file so the card can offer "Open File" even when
			// lint passed (errors=[]). Prefer an explicit top-level field; fall
			// back to the first error's file.
			const lintFile = typeof data.file === 'string' && data.file
				? data.file
				: typeof data.file_path === 'string' && data.file_path
					? data.file_path
					: errors.find(e => e.file)?.file;
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaLintReport',
					errors,
					auto_fixable: typeof data.auto_fixable === 'number' ? data.auto_fixable : undefined,
					tool: typeof data.tool === 'string' ? data.tool : undefined,
					file: lintFile || undefined,
				} satisfies IChatEdaLintReport],
			};
		}

		case 'ppa_report': {
			const guard = edaSchemaGuard('ppa_report', (event.data ?? {}) as Record<string, unknown>, ['stage', 'round']);
			if (guard) { return guard; }
			// ppa_optimize_loop emits per-stage payloads that already match the
			// IDE part's fields 1:1 (stage / round / *_ppa / improvement / …).
			const data = (event.data ?? {}) as Partial<IChatEdaPpaReport> & { stage?: string };
			const stage: IChatEdaPpaReport['stage'] =
				(data.stage === 'baseline' || data.stage === 'eval_round' || data.stage === 'improved' || data.stage === 'not_improved')
					? data.stage : 'eval_round';
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaPpaReport',
					stage,
					round: data.round,
					ppa: data.ppa,
					baseline_ppa: data.baseline_ppa,
					previous_best_ppa: data.previous_best_ppa,
					current_ppa: data.current_ppa,
					best_ppa: data.best_ppa,
					improvement: data.improvement,
					strategy: data.strategy,
					sta_report: data.sta_report,
					power_report: data.power_report,
					pareto_front_size: data.pareto_front_size,
				} satisfies IChatEdaPpaReport],
				ppaReport: {
					round: data.round,
					stage,
					strategy: data.strategy,
					current: data.current_ppa ?? data.ppa,
					baseline: data.baseline_ppa,
					best: data.best_ppa,
					improvement: data.improvement,
				},
			};
		}

		case 'negotiation_view': {
			const guard = edaSchemaGuard('negotiation_view', (event.data ?? {}) as Record<string, unknown>, ['perspectives', 'challenges', 'recommendation', 'issue', 'round']);
			if (guard) { return guard; }
			// multi_agent_debate emits three distinct per-round shapes:
			//   round 1 → {perspectives:[{role,analysis,confidence}]}
			//   round 2 → {challenges:[{role,response,revised_confidence}]}
			//   synth   → {recommendation, consensus_reached}
			// plus the graph/subagent_tracker shape {issue, perspectives, recommendation}.
			// Fold perspectives + challenges into the IDE's {agent,position,reasoning}.
			const data = (event.data ?? {}) as {
				issue?: string; recommendation?: string;
				perspectives?: Array<{ role?: string; agent?: string; analysis?: string; position?: string; claim?: string; confidence?: number | string; reasoning?: string }>;
				challenges?: Array<{ role?: string; response?: string; revised_confidence?: number | string }>;
			};
			const fromPerspectives = Array.isArray(data.perspectives)
				? data.perspectives.map(p => ({
					agent: typeof p.agent === 'string' ? p.agent : (typeof p.role === 'string' ? p.role : ''),
					position: p.position ?? p.analysis ?? p.claim ?? '',
					reasoning: String(p.reasoning ?? p.confidence ?? ''),
				}))
				: [];
			const fromChallenges = Array.isArray(data.challenges)
				? data.challenges.map(c => ({
					agent: typeof c.role === 'string' ? c.role : '',
					position: typeof c.response === 'string' ? c.response : '',
					reasoning: String(c.revised_confidence ?? ''),
				}))
				: [];
			const perspectives = [...fromPerspectives, ...fromChallenges];
			const recommendation = typeof data.recommendation === 'string' ? data.recommendation : '';
			// A bare round marker with nothing to show → drop (no empty shell).
			if (!perspectives.length && !recommendation) {
				return {};
			}
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaNegotiationView',
					issue: typeof data.issue === 'string' ? data.issue : '',
					perspectives,
					recommendation,
				} satisfies IChatEdaNegotiationView],
			};
		}

		case 'parallel_progress': {
			const guard = edaSchemaGuard('parallel_progress', (event.data ?? {}) as Record<string, unknown>, ['tracks', 'phase', 'conflicts', 'round']);
			if (guard) { return guard; }
			// parallel_generate / parallel_check: {phase, tracks:[{name,status,current_step,files?}], conflicts?}.
			// Track `status` is a free-form backend string ("worktree_created",
			// "review", …); preserve it raw (cast) so the renderer can show it,
			// matching legacy's straight passthrough.
			const data = (event.data ?? {}) as {
				phase?: string;
				tracks?: Array<{ name?: string; status?: string; progress?: number; file?: string; files?: string[] }>;
				conflicts?: string[];
			};
			const tracks = (Array.isArray(data.tracks) ? data.tracks : []).map(t => ({
				name: typeof t.name === 'string' ? t.name : '',
				status: typeof t.status === 'string' ? t.status : 'running',
				progress: typeof t.progress === 'number' ? t.progress : undefined,
				file: typeof t.file === 'string' ? t.file : (Array.isArray(t.files) && t.files.length ? t.files[0] : undefined),
			})) as IChatEdaParallelProgress['tracks'];
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaParallelProgress',
					phase: typeof data.phase === 'string' ? data.phase : '',
					tracks,
					conflicts: Array.isArray(data.conflicts) ? data.conflicts : undefined,
				} satisfies IChatEdaParallelProgress],
			};
		}

		case 'spec_review': {
			const guard = edaSchemaGuard('spec_review', (event.data ?? {}) as Record<string, unknown>, ['spec_path', 'spec_name', 'summary', 'files', 'round']);
			if (guard) { return guard; }
			// subagent_tracker: {spec_path, spec_name, summary, files} — 1:1.
			const data = (event.data ?? {}) as { spec_path?: string; spec_name?: string; summary?: string; files?: string[] };
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaSpecReview',
					spec_path: typeof data.spec_path === 'string' ? data.spec_path : '',
					spec_name: typeof data.spec_name === 'string' ? data.spec_name : '',
					summary: typeof data.summary === 'string' ? data.summary : '',
					files: Array.isArray(data.files) ? data.files : undefined,
				} satisfies IChatEdaSpecReview],
			};
		}

		case 'waveform':
		case 'vcd_waveform': {
			// [ChipOS] P6 waveform card — an inline GRAPHICAL SVG rendered from the
			// reasoner's `waveform` (alias `vcd_waveform`, handled identically) event.
			// Inner payload (post-RenderEnvelope-unwrap):
			//   { kind, path, title, signals:[{name,wave,data?}], timescale?, summary? }
			// `signals` is the ONLY required consumed field; `path` is IGNORED here (that
			// is the SEPARATE `viewer_action` / open_waveform control event for the
			// external Vaporview viewer). Read defensively + fail closed — a backend
			// key rename must surface a visible degrade note, never a crash or a
			// silently-empty card.
			const guard = edaSchemaGuard('waveform', (event.data ?? {}) as Record<string, unknown>, ['signals', 'title', 'timescale', 'summary', 'path']);
			if (guard) { return guard; }
			const data = (event.data ?? {}) as {
				title?: string;
				timescale?: string;
				summary?: string;
				signals?: Array<{ name?: string; wave?: string; data?: unknown }>;
			};
			const signals = (Array.isArray(data.signals) ? data.signals : []).map(s => ({
				name: typeof s.name === 'string' ? s.name : '',
				wave: typeof s.wave === 'string' ? s.wave : '',
				data: Array.isArray(s.data) ? s.data.map(d => String(d)) : [],
			}));
			return {
				flushText: true,
				edaParts: [{
					kind: 'edaWaveform',
					title: typeof data.title === 'string' ? data.title : '',
					signals,
					timescale: typeof data.timescale === 'string' ? data.timescale : undefined,
					summary: typeof data.summary === 'string' ? data.summary : undefined,
				} satisfies IChatEdaWaveform],
			};
		}

		case 'diff_preview': {
			// {file_path, hunks:[{header, lines:[{type:'add'|'del'|'ctx', content}]}]}.
			// Render a framework-native `textEditGroup` (side-by-side diff editor with
			// built-in Apply/Discard) instead of the legacy fenced ```diff``` block.
			// The caller resolves `filePath` → a URI and emits one `kind: 'textEdit'`
			// progress part; the chat model folds it into a `textEditGroup`.
			const data = (event.data ?? {}) as { file_path?: string; hunks?: Array<{ header?: string; lines?: Array<{ type?: string; content?: string }> }> };
			const filePath = typeof data.file_path === 'string' ? data.file_path : '';
			const rawHunks = Array.isArray(data.hunks) ? data.hunks : [];
			const edits = filePath ? buildTextEditsFromDiffHunks(rawHunks) : [];
			if (edits.length > 0) {
				return { flushText: true, diffPreview: { filePath, edits } };
			}
			// Fallback: no parseable hunk ranges (e.g. header-less or pure-context
			// diff) — keep the legacy markdown block so nothing is silently dropped.
			const hunks = rawHunks.map(h => {
				const lines = (Array.isArray(h.lines) ? h.lines : []).map(l => {
					const content = typeof l.content === 'string' ? l.content : '';
					if (l.type === 'add') { return `+ ${content}`; }
					if (l.type === 'del') { return `- ${content}`; }
					return `  ${content}`;
				}).join('\n');
				return `${typeof h.header === 'string' ? h.header : ''}\n${lines}`;
			}).join('\n\n');
			return { flushText: true, markdownContents: [`**Diff: \`${filePath}\`**\n\`\`\`diff\n${hunks}\n\`\`\``] };
		}

		case 'task_summary': {
			// End-of-turn structured summary → the full `_formatTaskSummary` card
			// (verdict badge + KV table + files + next steps), NOT the Phase-0
			// single-line downgrade. The agent_core SummaryAssembler ships
			// {task_type, verdict, rendered_markdown, structured_data:{…}}; the
			// subagent_tracker path ships {task_type, structured_data_json:"…"}.
			const data = (event.data ?? {}) as {
				task_type?: string;
				structured_data?: Record<string, unknown>;
				structured_data_json?: string;
			};
			let structured: Record<string, unknown> = {};
			if (data.structured_data && typeof data.structured_data === 'object') {
				structured = data.structured_data;
			} else if (typeof data.structured_data_json === 'string' && data.structured_data_json) {
				try {
					const parsed = JSON.parse(data.structured_data_json);
					if (parsed && typeof parsed === 'object') {
						structured = parsed as Record<string, unknown>;
					}
				} catch {
					// malformed JSON — render the verdict-only card from task_type alone.
				}
			}
			const taskType = typeof data.task_type === 'string' ? data.task_type : '';
			// Nothing to render → drop (forward-compat with bare/empty summaries).
			if (!taskType && Object.keys(structured).length === 0) {
				return {};
			}
			return { flushText: true, taskSummary: { task_type: taskType, structured_data: structured } };
		}

		case 'todo': {
			// Planning state. Minimal: surface a progress line with the count;
			// the native todo widget remains driven by the write_todos toolInvocation path.
			const data = (event.data ?? {}) as { todos?: unknown[] };
			const n = Array.isArray(data.todos) ? data.todos.length : 0;
			return n > 0 ? { progressMessage: { content: `Updated todo list (${n})` } } : {};
		}

		case 'round_start':
		case 'model_turn_start':
		case 'model_turn_end':
			// Turn/round boundaries — no direct render (the deltas + summary carry
			// the visible signal); flush any buffered text at a turn boundary.
			return { flushText: true };

		case 'round_end': {
			// Phase 1 (ADR-018): `reason` literal now excludes "tool_use" and
			// adds "max_iterations" / "interrupted". `langgraph_state_blob` is
			// gone — IDE owns the conversation log via `final_messages` which
			// it appends to chatSessions/*.jsonl (D8 mixed-state).
			const data = (event.data ?? {}) as {
				reason?: string;
				final_messages?: Message[];
				final_result?: {
					followups?: unknown;
					trace_id?: string;
					status?: string;
					verdict?: string;
					artifacts?: { kind?: string; uri?: string; summary?: string }[];
					changed_files?: string[];
					errors?: { category?: string; code?: string; message?: string }[];
				};
			};
			// [ChipOS][F-4] lift the structured next-step suggestions so the caller
			// can render them as native clickable reply chips (provideFollowups).
			const rawFollowups = data.final_result?.followups;
			const followups = Array.isArray(rawFollowups)
				? rawFollowups.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
				: undefined;
			// [ChipOS] Phase 6: capture the run iff it produced artifacts or changed
			// files (a real EDA run, not plain chat). The caller persists it.
			const fr = data.final_result;
			const frArtifacts = Array.isArray(fr?.artifacts) ? fr!.artifacts : [];
			const frChanged = Array.isArray(fr?.changed_files) ? fr!.changed_files.filter((f): f is string => typeof f === 'string') : [];
			const runResult = fr && (frArtifacts.length > 0 || frChanged.length > 0)
				? {
					traceId: typeof fr.trace_id === 'string' ? fr.trace_id : '',
					status: typeof fr.status === 'string' ? fr.status : 'unknown',
					verdict: typeof fr.verdict === 'string' ? fr.verdict : '',
					artifacts: frArtifacts.map(a => ({ kind: typeof a.kind === 'string' ? a.kind : 'artifact', uri: a.uri, summary: a.summary })),
					changedFiles: frChanged,
					errors: Array.isArray(fr.errors) ? fr.errors : [],
				}
				: undefined;
			return {
				terminate: true,
				flushText: true,
				terminationReason: typeof data.reason === 'string' ? data.reason : 'end_turn',
				finalMessages: Array.isArray(data.final_messages) ? data.final_messages : undefined,
				followups: followups && followups.length > 0 ? followups : undefined,
				...(runResult ? { runResult } : {}),
			};
		}

		case 'error': {
			// [ChipOS] Emit a structured agentError so the caller can render a
			// proper error card (category icon + code + retry hint) rather than
			// a one-line markdown string.
			const data = (event.data ?? {}) as { message?: string; error_code?: string; category?: string; retryable?: boolean };
			const msg = typeof data.message === 'string'
				? data.message
				: `reasoner error (${data.error_code ?? data.category ?? 'unknown'})`;
			return {
				flushText: true,
				agentError: {
					category: typeof data.category === 'string' ? data.category : undefined,
					errorCode: typeof data.error_code === 'string' ? data.error_code : undefined,
					message: msg,
					retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
				},
				errorMessage: msg,
			};
		}

		case 'viewer_action': {
			// [ChipOS] Phase 6 slice 5 Part B: the reasoner (its `open_waveform`
			// tool) asked the IDE to open a waveform (.vcd) in Vaporview and
			// best-effort reveal signals / mark a cycle. An imperative host ACTION
			// (`control` family), not a render card — keep this pure (no service
			// import) and surface a typed descriptor; the DI-constructed caller
			// drives IChiposWaveformService.openWaveform. Keys map 1:1 to
			// IOpenWaveformOptions (`signals` / `cycle`); accept `path` (canonical)
			// or `vcd` (alias) for the file, read defensively like the EDA cases.
			const data = (event.data ?? {}) as { path?: unknown; vcd?: unknown; signals?: unknown; cycle?: unknown };
			const rawPath = typeof data.path === 'string' ? data.path : typeof data.vcd === 'string' ? data.vcd : '';
			const path = rawPath.trim();
			if (!path) {
				return {};
			}
			const signals = Array.isArray(data.signals)
				? data.signals.filter((s): s is string => typeof s === 'string' && s.length > 0)
				: undefined;
			const cycle = typeof data.cycle === 'number' && Number.isFinite(data.cycle) ? data.cycle : undefined;
			return {
				viewerAction: {
					path,
					...(signals && signals.length > 0 ? { signals } : {}),
					...(cycle !== undefined ? { cycle } : {}),
				},
			};
		}

		default:
			// Forward-compat: caller should `_logService.trace(...)` the unknown.
			return {};
	}
}

// ── SSE-failure classifier (used by _invokeStateless's catch block) ────────

/**
 * Classify what went wrong with a stateless SSE iteration so the caller can
 * decide between:
 *   - `'cancelled'`: user clicked Stop → return a cancelled result (don't
 *     re-render the error to chat).
 *   - `'replay'`: transient network drop → try `client.replay(traceId, seq)`.
 *   - `'surface-http'`: server responded non-2xx (4xx / 5xx) → render the
 *     status to user, do NOT attempt replay (re-issuing won't help).
 *   - `'surface-replay-expired'`: a previous `replay()` call returned 410 →
 *     surface "reconnect window expired" guidance.
 *   - `'surface-other'`: anything else (unknown shape) → render best-effort
 *     error message.
 *
 * Pure function — no DI, no I/O. Caller owns the actual progress + cleanup.
 *
 * @param err the thrown value from a `for await ... of client.invoke(...)` block
 * @param abortSignal the controller signal we passed into the iterator;
 *                    `aborted` distinguishes user cancel from anything else
 */
export function classifySseFailure(
	err: unknown,
	abortSignal: AbortSignal,
): 'cancelled' | 'replay' | 'surface-http' | 'surface-replay-expired' | 'surface-other' {
	if (abortSignal.aborted) {
		return 'cancelled';
	}
	if (err instanceof StatelessReplayExpiredError) {
		return 'surface-replay-expired';
	}
	if (err instanceof StatelessHttpError) {
		// 4xx and 5xx that surfaced as HttpError are not transient — re-
		// issuing the SAME bytes won't help; surface and let user decide.
		return 'surface-http';
	}
	// Anything else (TypeError from a half-closed socket, AbortError that
	// wasn't ours, generic network error) → attempt replay before giving up.
	return 'replay';
}


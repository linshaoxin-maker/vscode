/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate by re-copying the canonical source
 * canonical source: packages/invoke-client/src/agent/invokeTypes.ts
 * @chipos/invoke-client — shared reasoner /invoke wire types (M3a vendored copy; sync-vendor ide target lands after M2).
 * ──────────────────────────────────────────────────────────────────── */
/*---------------------------------------------------------------------------------------------
 *  Phase 2-A: TS mirror of the reasoner invoke protocol.
 *
 *  Source of truth: backend_v2/packages/shared/src/shared/contracts/invoke.py
 *  (NOT chipos.proto — that path is legacy task SSE). The chipos IDE keeps the
 *  same shapes in vscode/src/.../chatAgent/statelessInvoke/types.ts; this is the
 *  vscode-extension copy, trimmed to the subset Phase 2-A needs.
 *
 *  Field names match the Python wire shape exactly so request bodies serialize
 *  straight to JSON. All shapes are `extra="allow"` on the reasoner side, so
 *  unknown fields from a newer reasoner are tolerated and extra optional fields
 *  here are forward compatible.
 *--------------------------------------------------------------------------------------------*/

// ── Content blocks (Anthropic Messages API 对齐) ─────────────────────────────

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	/** toolu_xxxxxx OR chipos_confirm_xxxxxx */
	id: string;
	/** tool name OR "chipos_user_confirm" */
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string | TextBlock[];
	is_error?: boolean;
}

export interface ImageBlock {
	type: 'image';
	source: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// ── Messages ─────────────────────────────────────────────────────────────────

export interface Message {
	role: 'user' | 'assistant' | 'system';
	content: string | ContentBlock[];
	/** ChipOS extension: compact summary marker. */
	is_compact_summary?: boolean;
	/** ChipOS extension: transcript-only (not fed to the LLM). */
	is_visible_in_transcript_only?: boolean;
}

// ── Sub-role / skills / hooks / prompt-resources (request-side: FEAT-003/004/005 + marketplace v5) ──
// Shapes mirror invoke-core/bindings/*.ts (the ts-rs-generated canonical) so the
// P-rust-4 swap (canonical = generated re-export) is a drop-in. SSOT = invoke.py.

/** invoke.py SkillSource — where a skill came from. */
export type SkillSource = 'builtin' | 'user' | 'plugin' | 'workspace';
/** invoke.py PromptSource — where a hook / prompt-resource was configured. */
export type PromptSource = 'user' | 'workspace' | 'plugin';
/** invoke.py PromptResourceKind. */
export type PromptResourceKind = 'rule' | 'command';
/** invoke.py ReasonerHookPoint — the 14 dotted hook anchor points (FEAT-004). */
export type ReasonerHookPoint =
	| 'turn.before_start'
	| 'context.before_collect'
	| 'context.after_collect'
	| 'prompt.before_render'
	| 'prompt.after_render'
	| 'llm.before_call'
	| 'llm.after_response'
	| 'tool.before_dispatch'
	| 'tool.after_result'
	| 'subagent.before_invoke'
	| 'subagent.after_result'
	| 'final.before_emit'
	| 'turn.after_end'
	| 'turn.on_error';
/** invoke.py ReasonerHookAction. */
export type ReasonerHookAction = 'observe' | 'deny' | 'amend' | 'ask';
/** invoke.py HookEvalDecision — the surface's verdict POSTed back for an 'ask' hook. */
export type HookEvalDecision = 'proceed' | 'deny' | 'ask' | 'amend';

/** invoke.py SelectedAgent — FEAT-005 user @agent routing (extra=allow). */
export interface SelectedAgent {
	name: string;
	instructions: string;
	description?: string;
	/** Non-empty clamps this turn's tool catalog to this allow-list. */
	tools?: string[];
	/** 'subagent' = isolated delegation; else persona overlay (default, keeps conversation). */
	mode?: string;
	/** FEAT-005: per-agent model override (only on the mode:subagent isolated path); omit = inherit the turn's model. */
	model?: string;
}

/** invoke.py SkillHeader — skill catalog header (name+description, body lazy-loaded, FEAT-003). */
export interface SkillHeader {
	name: string;
	description: string;
	source: SkillSource;
	source_ref?: string;
}

/**
 * invoke.py PromptResourceAttachment — rule/command injected into the prompt (marketplace v5).
 * Only kind+name are required in invoke.py; description/source/reason/priority/payload all
 * carry pydantic defaults ("", "user", "", 0, {}) → optional here (M3a, same rule as
 * ReasonerHookDefinition.reason). The ts-rs binding marks them REQUIRED (serde-default
 * limitation, #6) — P-rust-4 keeps this as a hand-written facade.
 */
export interface PromptResourceAttachment {
	kind: PromptResourceKind;
	name: string;
	/** invoke.py defaults "" → optional here. */
	description?: string;
	/** invoke.py defaults "user" → optional here. */
	source?: PromptSource;
	source_ref?: string;
	/** invoke.py defaults "" → optional here. */
	reason?: string;
	/** invoke.py defaults 0 → optional here. */
	priority?: number;
	token_estimate?: number;
	/** invoke.py defaults {} → optional here. */
	payload?: Record<string, unknown>;
}

/** invoke.py ReasonerHookDefinition — user/workspace/plugin-configured reasoner hook (FEAT-004). */
export interface ReasonerHookDefinition {
	point: ReasonerHookPoint;
	action: ReasonerHookAction;
	tool_name?: string;
	/** invoke.py defaults "" → optional here (agent-facing explanation surfaced on a deny). */
	reason?: string;
	source: PromptSource;
	source_ref?: string;
}

// ── Invoke request (IDE → reasoner) ──────────────────────────────────────────

export interface InvokeRequest {
	/** Wire-protocol version. Reasoner 409s if unsupported. */
	protocol_version?: number;
	/** UUID for this turn, IDE-generated. */
	trace_id: string;
	/** Stable per-chat-thread id; multiple trace_ids share one chat_session_id. */
	chat_session_id: string;
	/** Full user-visible conversation, min 1 message. */
	messages: Message[];
	/** Optional user-level system addendum (reasoner prepends its own mode prompt). */
	system?: string | null;
	mode?: 'agent' | 'spec';
	// LLM routing config (forwarded from user settings).
	model: string;
	provider?: string;
	base_url?: string | null;
	api_key_alias?: string | null;
	/**
	 * F6: ship the actual LLM provider key in-band (mirrors the legacy stateful
	 * path) until the reasoner-side vault is wired. When both api_key and
	 * api_key_alias are present, reasoner uses api_key.
	 */
	api_key?: string | null;
	temperature?: number | null;
	max_tokens?: number | null;
	thinking?: boolean;
	/** Opaque hash from a prior RegisterToolsResponse; reasoner 412s on mismatch. */
	expected_catalog_version: string;
	/** Absolute workspace root (worker affinity uses it). */
	workspace_path: string;
	auto_approve_mode?: string;
	/**
	 * FEAT-DS-002: per-turn dynamic-skill LEARNING toggle (from the user's
	 * `chipos.dynamicSkill.enabled` setting). Overrides the reasoner's
	 * CHIPOS_DYNAMIC_SKILL_LEARN env default; omit/null => use the env default.
	 * Mirrors `shared/contracts/invoke.py` InvokeRequest.dynamic_skill_learn.
	 */
	dynamic_skill_learn?: boolean | null;
	/** Open structural editor context: current_file / selection / git_branch / open_files / ... */
	workspace_meta?: Record<string, unknown> | null;
	/**
	 * /invoke v1.1 S1: this surface's self-declared capability facts (renders
	 * registry / host_tools / confirm_ui / machine_output / ...). Additive +
	 * optional + backward compatible. Mirrors
	 * `backend_v2/packages/shared/src/shared/contracts/invoke.py` ClientCapabilities.
	 * NO identity/scopes here (R1) — those are server-derived.
	 */
	client_capabilities?: ClientCapabilities;
	/**
	 * 011a: per-turn client tool allow-list SOFT hint (narrows only — the hard,
	 * scope-clamped AllowedTools stays server-derived, R1/R5). Mirrors
	 * invoke.py InvokeRequest.allowed_tools.
	 */
	allowed_tools?: string[];
	/** FEAT-003: allow dynamic skill-SCRIPT execution this turn (invoke.py defaults False → omit = off). */
	skill_scripts_enabled?: boolean;
	/** FEAT-005: a user-chosen @agent (sub-role) to route this turn to. */
	selected_agent?: SelectedAgent;
	/**
	 * marketplace v5: in-band rule/command attachments injected as synthetic
	 * persistent instructions (invoke.py defaults []). NOTE: the ts-rs binding
	 * marks this REQUIRED (it cannot express a serde-default Vec as optional);
	 * canonical keeps it optional to match invoke.py + callers — P-rust-4 reconciles.
	 */
	prompt_resource_attachments?: PromptResourceAttachment[];
	/** FEAT-003: dynamic / attached skill headers available to the LLM this turn. */
	skills?: SkillHeader[];
	/** FEAT-004: ReasonerHookPoint registrations active for this turn. */
	hooks?: ReasonerHookDefinition[];
	user?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
}

/**
 * One event `kind` a surface can natively render + the schema version it knows
 * (/invoke v1.1 S1 / §4). Mirrors
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py` RenderCapability.
 * `kind` is an OPEN string (not an enum), so a new EDA card is a new registry
 * entry with the wire contract unchanged.
 */
export interface RenderCapability {
	/** Event kind the surface renders natively, e.g. "sim_report" | "lint_report" | future. */
	kind: string;
	/** Highest payload schema version the surface knows for this kind. Default 1. */
	max_schema_version?: number;
}

/**
 * A surface's self-declared capability facts (/invoke v1.1 S1 / §4). Mirrors
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py` ClientCapabilities.
 *
 * Purely capability facts — NO identity / scopes / user_id / workspace_id /
 * allowed_tools (R1): those are derived server-side from the JWT + session +
 * registry, never reported by the client. Per R4 the reasoner never branches
 * behaviour on `client_type` (telemetry + preset selection only).
 */
export interface ClientCapabilities {
	/** "ide" | "extension" | "cli" — telemetry + preset selection ONLY (R4). Open string. */
	client_type: string;
	/** Surface build version (telemetry). */
	client_version: string;
	/** Registry of natively renderable kinds (NOT an enum). */
	renders?: RenderCapability[];
	/** Can render a `ui_spec` kind. Contract placeholder — Beta-1 does NOT implement it (D-1). */
	supports_generative_ui?: boolean;
	/** Host operations the surface can execute, e.g. "apply_edit" / "open_diff" / "terminal" / "waveform_viewer". */
	host_tools?: string[];
	/** How confirm/permission prompts are presented: "cards" (rich) | "stdin" (CLI) | "none" (headless). */
	confirm_ui?: 'cards' | 'stdin' | 'none';
	/** Whether the surface can execute reasoner reverse-channel `ide_tool_call` events. */
	supports_reverse_channel?: boolean;
	/** Stable machine-output contract for CLI/CI: "none" | "json" | "ndjson". */
	machine_output?: 'none' | 'json' | 'ndjson';
	/** Whether the surface needs a process exit code (CLI/CI). */
	requires_exit_code?: boolean;
	/** Whether the surface can resume an in-flight turn after an SSE disconnect. */
	supports_resume?: boolean;
}

// ── Resolved invoke context (SERVER-DERIVED — /invoke v1.1 S2 / §5) ──────────
//
// ⚠️ R1 SECURITY RED LINE: these three shapes are produced SERVER-SIDE by the
// reasoner's CapabilityResolver from the JWT + session + registry. The client
// NEVER constructs, sends, or self-reports them — they are NOT fields of
// InvokeRequest. A client self-reporting `scopes` / `identity` / `allowed_tools`
// would be privilege spoofing, and the resolver explicitly IGNORES any such key
// smuggled into the request body (ClientCapabilities is extra="allow").
//
// They are mirrored here ONLY so a shared client SDK / CLI can PARSE a
// server-emitted resolved context if one is ever surfaced read-only. Treat them
// as inbound/read-only. Mirrors
// `backend_v2/packages/shared/src/shared/contracts/invoke.py`
// Identity / AllowedTools / ResolvedInvokeContext.

/** Authenticated actor for a turn — JWT/chiops derived, NEVER client-reported (R1). */
export interface Identity {
	user_id: string;
	workspace_id: string;
	/** Authorization scopes — server-derived (R1), never a client claim. */
	scopes: string[];
}

/** The scope-clamped single-catalog tool view for a turn — server-derived (R1/R5). */
export interface AllowedTools {
	/** worker-executed tools (registry × scopes). */
	worker: string[];
	/** IDE/MCP-executed tools (registry × scopes). */
	mcp: string[];
	/** Host operations the surface may be asked to perform (host_tools ∩ scope-allowed). */
	surface: string[];
}

/**
 * Server-internal resolved context (§5) — client never sees or reports this (R1).
 * `effective_capabilities` is preset ⊕ request ⊕ registry-clamped; downstream
 * reads only it (never `client_type`, R4).
 */
export interface ResolvedInvokeContext {
	identity: Identity;
	allowed_tools: AllowedTools;
	effective_capabilities: ClientCapabilities;
}

/** InvokeRequest without the catalog version — ReasonerClient fills it in. */
export type InvokeRequestInput = Omit<InvokeRequest, 'expected_catalog_version'>;

// ── Invoke response (SSE event stream, reasoner → IDE) ───────────────────────

export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/**
 * The 8 stable event families (/invoke v1.1 S5 / §8). A surface routes on the
 * stable `family` band — NEVER on the open `type` (which a newer reasoner may
 * extend). Mirrors `EVENT_FAMILIES` in
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py`.
 *
 *   stream    — Anthropic content: message_start / content_block_* / message_delta / …
 *   tool      — tool_start / tool_result / tool_call_emitted / ide_tool_call / …
 *   control   — round_start / round_progress / checkpoint / keepalive / heartbeat / …
 *   render    — ⭐ rich cards (sim / lint / ppa / diff / spec / …); `data` is a RenderEnvelope
 *   confirm   — confirm_request / confirm_auto_resolved
 *   subagent  — subagent_event
 *   custom    — ⭐ escape hatch: an event not (yet) classified; route generically
 *   terminal  — round_end (with FinalResult) / error
 */
export type EventFamily =
	| 'stream'
	| 'tool'
	| 'control'
	| 'render'
	| 'confirm'
	| 'subagent'
	| 'custom'
	| 'terminal';

/**
 * The set of SSE event `type`s the reasoner emits. Anthropic streaming events +
 * ChipOS control events + the agent_core "fusion" rich-event set (emitted only
 * when CHIPOS_STATELESS_DRIVER=agentcore). Kept here for reference; InvokeEvent
 * types `type` as a plain string for forward compatibility (a newer reasoner may
 * add events an older client doesn't know — route on `family` instead, §8).
 */
export type InvokeEventType =
	// Anthropic streaming
	| 'message_start'
	| 'content_block_start'
	| 'content_block_delta'
	| 'content_block_stop'
	| 'message_delta'
	| 'message_stop'
	// tool / control
	| 'tool_call_emitted'
	| 'tool_result_observed'
	| 'ide_tool_call'
	| 'confirm_request'
	| 'confirm_auto_resolved'
	| 'hook_eval'
	| 'thinking_delta'
	| 'round_progress'
	| 'trace_link'
	// agent_core fusion: rich semantic events
	| 'round_start'
	| 'status'
	| 'chat'
	| 'model_output'
	| 'model_turn_start'
	| 'model_turn_end'
	| 'tool_start'
	| 'tool_result'
	| 'subagent_event'
	| 'task_summary'
	| 'task_complete'
	| 'todo'
	| 'plan'
	| 'spec_review'
	| 'negotiation_view'
	| 'diff_preview'
	| 'sim_report'
	| 'coverage_report'
	| 'lint_report'
	| 'ppa_report'
	| 'parallel_progress'
	| 'loop_progress'
	| 'verification_progress'
	| 'timing_highlight'
	| 'waveform'
	| 'viewer_action'
	| 'worktree_files_applied'
	| 'pre_review_report'
	| 'review_gate'
	// stateless transport control
	| 'checkpoint'
	| 'keepalive'
	| 'heartbeat'
	| 'resumed_live'
	| 'resumed_buffer_drained'
	// termination
	| 'round_end'
	| 'error';

export interface InvokeEvent {
	/** One of InvokeEventType; OPEN string for forward-compat (§8). Route on `family`. */
	type: string;
	/**
	 * Stable routing band (/invoke v1.1 S5 / §8). The reasoner sets it (derived
	 * from `type`, "custom" when unmapped); a surface routes on THIS, not `type`.
	 * Optional here so frames from an older reasoner that omits it still parse.
	 */
	family?: EventFamily;
	/** Monotonic across an invoke; used for replay / resume. */
	sequence_id: number;
	/**
	 * Event payload — each type has its own shape (opaque dict). For
	 * `family === 'render'` the reasoner wraps `data` into a {@link RenderEnvelope}
	 * (kind/schema_version/payload/fallback) so an unknown card kind still degrades
	 * via its mandatory fallback (D10) instead of being dropped.
	 */
	data: Record<string, unknown>;
}

/**
 * The uniform shell for every `family === 'render'` card (/invoke v1.1 S5 / §8).
 * Mirrors `RenderEnvelope` in
 * `backend_v2/packages/shared/src/shared/contracts/invoke.py`. The reasoner wraps
 * each rich card in this at the SSEEmitSink boundary; a surface does the three-layer
 * degrade:
 *   - `kind` known & `schema_version` ≤ its max → render `payload` richly
 *   - `kind` unknown / schema too new            → render `fallback` (never dropped)
 *   - `kind === 'ui_spec'` (supports_generative_ui) → generic declarative render
 *     (D-1: contract placeholder — Beta-1 does NOT implement this third layer)
 */
export interface RenderEnvelope {
	/** Open card kind — "sim_report" | "lint_report" | … | future | "ui_spec". */
	kind: string;
	/** Schema version of THIS kind's `payload` (default 1). */
	schema_version: number;
	/** The rich render data (rendered when the surface knows `kind`). */
	payload: Record<string, unknown>;
	/**
	 * REQUIRED (D10) — what the surface shows when it cannot richly render the card
	 * (unknown kind / schema too new). Canonical shapes: `{ text: string }` or
	 * `{ artifact_ref: ArtifactRef }`.
	 */
	fallback: { text: string } | { artifact_ref: ArtifactRef } | Record<string, unknown>;
}

/**
 * A pointer to a turn-produced artifact (report / patch / waveform / …).
 * Mirrors `backend_v2/packages/shared/src/shared/contracts/invoke.py` ArtifactRef
 * (/invoke v1.1 S4, §7). `uri` is a reference (worker-relative / trace-store path),
 * not the bytes.
 */
export interface ArtifactRef {
	/** "report" | "patch" | "waveform" | "trace" | … (open string) */
	kind: string;
	/** worker-relative or trace-store path */
	uri: string;
	/** optional one-line human description */
	summary?: string;
}

/**
 * Structured outcome of one turn — the CLI exit-code / `--json` basis.
 * Mirrors `backend_v2/packages/shared/src/shared/contracts/invoke.py` FinalResult
 * (/invoke v1.1 S4, §7). Assembled by the reasoner at the round_end boundary and
 * carried on the terminal `round_end` frame (additive — `extra="allow"`, no
 * protocol_version break). `verdict` is produced by the agent that ENDS the turn
 * (D-4: main-agent if it finishes; the sub-agent if a sub finishes).
 */
export interface FinalResult {
	/** terminal disposition — drives the CLI exit code */
	status: 'success' | 'stopped' | 'cancelled' | 'error' | 'needs_input';
	/** one-line conclusion (D-4: from the turn-ending agent) */
	verdict?: string;
	/** workspace files the turn modified (best-effort) */
	changed_files?: string[];
	/** structured pointers to produced artifacts */
	artifacts?: ArtifactRef[];
	/** failure records — `{category, code, message}` */
	errors?: Array<Record<string, unknown>>;
	/** suggested next steps */
	followups?: string[];
	/** the invoke's trace_id (correlates with the event stream) */
	trace_id: string;
	/** cumulative token usage for the turn, if known */
	usage?: TokenUsage;
}

/** `round_end` payload (terminal). */
export interface RoundEndData {
	/** "end_turn" | "max_iterations" | "max_tokens" | "error" | "cancelled" | "interrupted" */
	reason?: string;
	/** Authoritative conversation log the IDE persists for the next turn. */
	final_messages?: Message[];
	/**
	 * Structured turn outcome (/invoke v1.1 S4, §7). Carried on the SAME terminal
	 * frame as `reason` + `final_messages`; optional so older reasoners (v1.0) that
	 * omit it don't break this client.
	 */
	final_result?: FinalResult;
}

// ── Cancellation ─────────────────────────────────────────────────────────────

export interface CancelRequest {
	trace_id: string;
	reason?: string;
}

// ── Tool catalog registration ────────────────────────────────────────────────

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	/**
	 * Routing metadata (not shown to the LLM):
	 *   worker_mcp  → reasoner dispatches via gRPC to the worker
	 *   ide_mcp     → reasoner emits ide_tool_call to the IDE
	 *   ide_builtin → same reverse-channel path as ide_mcp
	 */
	chipos_source: 'worker_mcp' | 'ide_mcp' | 'ide_builtin';
}

export interface RegisterToolsRequest {
	chat_session_id: string;
	tools: ToolDefinition[];
	ide_version?: string;
	workspace_path?: string;
}

export interface RegisterToolsResponse {
	/** sha256[:16] of the canonical tools[]; IDE sends as expected_catalog_version. */
	catalog_version: string;
	accepted_tool_count: number;
	rejected?: Array<Record<string, string>>;
}

// ── Reverse-channel callbacks ────────────────────────────────────────────────

export interface ToolResultRequest {
	/** Must match the ide_tool_call.data.call_id. */
	call_id: string;
	content: string;
	is_error?: boolean;
	output_type?: 'text' | 'image' | 'binary_ref';
	metadata?: Record<string, unknown> | null;
}

export interface ConfirmResponseRequest {
	/** Must match the confirm_request.data.request_id (usually the tool_use.id). */
	request_id: string;
	/** action_id of the button the user clicked, e.g. "approve" / "reject". */
	action: string;
	selections?: Record<string, string> | null;
	comment?: string | null;
}

// ── Resume + turn state ──────────────────────────────────────────────────────

export interface ResumeRequest {
	trace_id: string;
	last_sequence_id: number;
	disconnect_reason?: string | null;
	/** Re-supplied on resume so a rehydrated turn keeps a per-user LLM key (F6). */
	api_key?: string | null;
	api_key_alias?: string | null;
}

export interface InFlightTrace {
	trace_id: string;
	started_at: number;
	last_checkpoint_seq?: number;
	state: 'running' | 'stale';
	last_user_message_preview?: string;
}

export interface TurnStateResponse {
	chat_session_id: string;
	in_flight_traces: InFlightTrace[];
}

// ── Compact (conversation summarization endpoint, POST /api/v1/compact) ───────

/**
 * invoke.py CompactRequest — IDE→reasoner summarize old turns into a summary message
 * (one pure-LLM call). Fields with invoke.py defaults (protocol_version=1, generated
 * trace/session ids, provider="auto", max_summary_tokens=4000) are optional here so a
 * caller only supplies what it overrides.
 */
export interface CompactRequest {
	protocol_version?: number;
	trace_id?: string;
	chat_session_id?: string;
	messages: Message[];
	model: string;
	provider?: string;
	base_url?: string;
	api_key_alias?: string;
	api_key?: string;
	max_summary_tokens?: number;
	user?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/**
 * invoke.py CompactResponse — reasoner→IDE compaction result (sync JSON; IDE prepends
 * summary to recent turns). The usage stats default to 0 in invoke.py (best-effort,
 * provider may not report) — optional here so parsing an older reasoner stays safe.
 */
export interface CompactResponse {
	summary_message: Message;
	tokens_in?: number;
	tokens_out?: number;
	cost_usd?: number;
}

// ── Hook result callback (POST /api/v1/hook_result/{trace_id}/{eval_id}, H-1) ──

/** invoke.py HookResultRequest — the surface's verdict for an 'ask' reasoner hook. */
export interface HookResultRequest {
	eval_id: string;
	decision: HookEvalDecision;
	amended_args?: Record<string, unknown>;
	/** invoke.py defaults "" → optional here. */
	agent_message?: string;
	/** invoke.py defaults "" → optional here. */
	user_message?: string;
	source_ref?: string;
}

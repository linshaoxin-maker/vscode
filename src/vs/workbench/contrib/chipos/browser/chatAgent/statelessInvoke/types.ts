/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 1 — TS schema types for the reasoner-driven mixed-state architecture.
 *
 * Mirror of `backend_v2/packages/shared/src/shared/contracts/invoke.py` (pydantic v2).
 * Field names / defaults / nullability must align literally with the python side or
 * the wire contract breaks. See ADR-018 + PHASE-1-PROTOCOL-SPEC.md §2.
 *
 * Phase 1 schema changes from Phase 0 (ADR-017 → ADR-018):
 *   - InvokeRequest: dropped `tools: dict[]` and `langgraph_state_blob: string`
 *     (tools registered out-of-band via RegisterToolsRequest at IDE startup;
 *     internal LangGraph state lives reasoner-side in FileStateStore)
 *   - InvokeRequest: added `expected_catalog_version: string` (required, 412
 *     on mismatch) and `workspace_meta: dict | null` (open editor context)
 *   - New schemas: ToolDefinition, RegisterToolsRequest/Response, ToolResultRequest,
 *     ConfirmResponseRequest, ResumeRequest, InFlightTrace, TurnStateResponse
 *   - SSE event types: added `ide_tool_call`, `confirm_request`, `keepalive`,
 *     `checkpoint`, `resumed_buffer_drained`
 *
 * Design goals:
 *   - Anthropic Messages API alignment (ADR-018 §2 D13) → multi-provider trivial
 *   - IDE chatSessions/*.jsonl is the user-data truth; reasoner FileStateStore
 *     is the reasoner-internal-state truth (D8 mixed-state)
 *   - Reasoner-driven agent loop (one /invoke = one user turn, internal LLM ↔
 *     tool loop on reasoner side) per D2
 *
 * Forward-compat conventions (mirroring python `extra="allow"`):
 *   - Listed fields are the minimum subset; unknown fields may appear from future
 *     reasoner versions — downstream consumers MUST NOT exhaustively switch
 *     `Object.keys()` and MUST tolerate unknown keys silently.
 *   - `ContentBlock` is a discriminated union — narrow via `type` field.
 *   - `Message.content` accepts `string` or `ContentBlock[]` (both Anthropic shapes).
 */

// =============================================================================
// Content blocks (Anthropic Messages API 对齐)
// =============================================================================

/**
 * 纯文本 block。
 *
 * - `type`: 判别字段, 固定 "text"
 * - `text`: 文本内容
 */
export interface TextBlock {
	type: 'text';
	text: string;
}

/**
 * assistant 发起的工具调用 block。
 *
 * 覆盖两种语义（ADR-017 §11.2）:
 *   - 普通工具调用 → `id="toolu_xxxxxx"`, `name="<tool_name>"`
 *   - ChipOS 用户确认 → `id="chipos_confirm_xxxxxx"`, `name="chipos_user_confirm"`
 *
 * - `type`: 判别字段, 固定 "tool_use"
 * - `id`: 唯一调用 id, 与后续 `ToolResultBlock.tool_use_id` 配对
 * - `name`: 工具名（或 "chipos_user_confirm"）
 * - `input`: 工具入参（confirm 场景为 card_data）
 */
export interface ToolUseBlock {
	type: 'tool_use';
	/** toolu_xxxxxx OR chipos_confirm_xxxxxx */
	id: string;
	/** tool name OR "chipos_user_confirm" */
	name: string;
	/** tool args OR confirm card_data */
	input: Record<string, unknown>;
}

/**
 * 工具结果 block（包在 role="user" 的 message.content 里回给 assistant）。
 *
 * - `type`: 判别字段, 固定 "tool_result"
 * - `tool_use_id`: 配对的 `ToolUseBlock.id`
 * - `content`: 结果文本（短结果可直接 string; 长/混合结果用 `TextBlock[]`）
 * - `is_error`: 工具执行失败时置 true, LLM 看到自行决定下一步; 默认 false
 */
export interface ToolResultBlock {
	type: 'tool_result';
	/** 配对的 tool_use.id */
	tool_use_id: string;
	content: string | TextBlock[];
	/** 默认 false */
	is_error?: boolean;
}

/**
 * 图片 block (Anthropic vision API 对齐)。
 *
 * - `type`: 判别字段, 固定 "image"
 * - `source`: 图片源描述, 典型 `{type:"base64", media_type:"image/png", data:"..."}`
 */
export interface ImageBlock {
	type: 'image';
	/** {type:"base64", media_type:..., data:...} */
	source: Record<string, unknown>;
}

/**
 * Discriminated union — 按 `type` 字段 narrow 到具体 block 类型。
 *
 * 使用方法见本文件下方的 `isTextBlock` / `isToolUseBlock` / `isToolResultBlock` /
 * `isImageBlock` type guards。
 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// =============================================================================
// Messages
// =============================================================================

/**
 * 单条 conversation message — Anthropic Messages API 对齐 + ChipOS 扩展。
 *
 * - `role`: 消息角色 "user" / "assistant" / "system"
 * - `content`: 文本（string）或 block 列表（`ContentBlock[]`); 两种 shape 都接受
 * - `is_compact_summary`: ChipOS 扩展。IDE 端 compact 后插入的总结消息打这个标记,
 *   用 Anthropic API 时这个字段会被 ignore (pydantic extra="allow"), 不影响 multi-provider。
 *   默认 false
 * - `is_visible_in_transcript_only`: ChipOS 扩展（沿用 Claude Code 同名字段）。
 *   消息只在 transcript UI 显示, 不参与 LLM 推理。默认 false
 */
export interface Message {
	role: 'user' | 'assistant' | 'system';
	content: string | ContentBlock[];
	// ChipOS 扩展字段 (Anthropic 没有, 但兼容):
	/** IDE 端 compact 后插入的总结消息; 默认 false */
	is_compact_summary?: boolean;
	/** 用 Claude Code 同名字段; UI 提示; 默认 false */
	is_visible_in_transcript_only?: boolean;
}

// =============================================================================
// Invoke request (IDE → reasoner)
// =============================================================================

/**
 * LLM token usage for billing / observability.
 *
 * PHASE-0-SPEC-AUDIT P0-3 (2026-05-27): emitted as the `usage` field on
 * `message_delta` events (Anthropic API style — same field shape they use, so
 * multi-provider routing is trivial).
 *
 * All fields are cumulative-since-invoke-start (NOT delta). Counts are in
 * tokens, not bytes. Provider may not report all fields; in that case fields
 * default to 0.
 */
export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	/** Anthropic prompt-caching read */
	cache_read_input_tokens: number;
	/** Anthropic prompt-caching write */
	cache_creation_input_tokens: number;
}

/**
 * Phase 1 invoke request — IDE → reasoner (per-turn long-lived SSE).
 *
 * Per ADR-018 §2 D2: one /invoke = one user turn. Reasoner runs an internal
 * agent loop (LLM ↔ tool ↔ LLM ... → end_turn) until natural termination,
 * streaming events back via SSE. State within a turn lives in reasoner-side
 * FileStateStore; conversation messages between turns live in IDE chatSessions/*.jsonl.
 *
 * Schema-level changes from Phase 0 (ADR-017 → ADR-018):
 *   - DROPPED `tools: dict[]` — now registered out-of-band via
 *     `RegisterToolsRequest`, referenced by `expected_catalog_version`
 *   - DROPPED `langgraph_state_blob` — internal reasoner state, no longer
 *     round-trips through IDE (ADR-018 §2 D8 mixed-state)
 *   - DROPPED `langgraph_state_version` — same reason
 *   - ADDED `expected_catalog_version` — 412 retry on mismatch (D9 + R-S)
 *   - ADDED `workspace_meta` — open structural metadata for system prompt
 *
 * Field reference (matches `invoke.py::InvokeRequest`):
 *   - `trace_id`: per-turn UUID, IDE-generated
 *   - `chat_session_id`: stable per-chat-thread id; reasoner uses for sticky
 *     routing in Phase 2 and for tool catalog cache lookup
 *   - `messages`: full user-visible conversation, min 1 (P0-2)
 *   - `system`: optional user-level addendum; reasoner prepends its own
 *     mode-specific system prompt (Issue-1 in PHASE-1-DOC-AUDIT)
 *   - `mode`: Agent mode
 *   - `model/provider/base_url/api_key_alias/temperature/max_tokens/thinking`:
 *     standard LLM routing config from user settings
 *   - `expected_catalog_version`: opaque hash from prior `RegisterToolsResponse`.
 *     Reasoner returns 412 if cache mismatch.
 *   - `workspace_path`: absolute workspace root (worker affinity uses it)
 *   - `auto_approve_mode`: "standard" / "autopilot"
 *   - `workspace_meta`: free-form structural metadata for current edit context
 *     (current_file, selection, git_branch, open_files, etc.)
 *   - `user/metadata`: opaque telemetry
 *   - `protocol_version`: wire-protocol version (409 if unsupported)
 */
export interface InvokeRequest {
	// 标识
	trace_id: string;
	chat_session_id: string;
	// Conversation — min 1 (PHASE-0-SPEC-AUDIT P0-2 still applies)
	messages: Message[];
	// System prompt / mode (Phase 1: user-supplied system is OPTIONAL ADDENDUM,
	// reasoner has its own mode-specific system prompt that comes first)
	system?: string | null;
	mode?: 'agent' | 'spec';
	// LLM config
	model: string;
	provider?: string;
	base_url?: string | null;
	api_key_alias?: string | null;
	// F6 fix (PHASE-1-IMPLEMENTATION-AUDIT post-deploy): IDE may ship the
	// actual LLM provider key in-band as legacy stateful path does, until
	// reasoner-side vault is wired (ADR-018 §1.1). When both `api_key` and
	// `api_key_alias` are present, reasoner uses `api_key`.
	api_key?: string | null;
	temperature?: number | null;
	max_tokens?: number | null;
	thinking?: boolean;
	// Tool catalog reference (must register first via /tools/register)
	// 412 on mismatch → IDE re-registers and retries (ADR-018 §2 D9 / R-S).
	expected_catalog_version: string;
	// Workspace + EXECUTION binding
	workspace_path: string;
	auto_approve_mode?: string;
	// Open structural editor context for reasoner system prompt
	// Common keys (all optional): current_file, selection, git_branch, open_files
	workspace_meta?: Record<string, unknown> | null;
	// Telemetry
	user?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
	// Protocol version handshake — bump when wire format breaks
	protocol_version?: number;
}

// =============================================================================
// Invoke response (SSE event stream, reasoner → IDE)
// =============================================================================

/**
 * SSE event type literal — covers Anthropic 流式事件 + ChipOS 自定义事件。
 *
 * Anthropic 对齐:
 *   - `message_start` / `content_block_start` / `content_block_delta` /
 *     `content_block_stop` / `message_delta` / `message_stop`
 *
 * Tool / control:
 *   - `tool_call_emitted`    — display-purpose: LLM decided to call a tool (all tools)
 *   - `tool_result_observed` — display-purpose: tool result observed by reasoner
 *   - `ide_tool_call`        — Phase 1: reverse-channel call to IDE for IDE-side tool
 *                              execution. IDE responds via POST /tool_result/{trace_id}/{call_id}.
 *                              Reasoner blocks awaiting that POST.
 *   - `confirm_request`      — Phase 1: reverse-channel call for chipos_user_confirm.
 *                              IDE renders confirm card, user clicks, IDE POSTs to
 *                              /confirm_response/{trace_id}/{request_id}.
 *
 * ChipOS specific:
 *   - `thinking_delta`
 *   - `round_progress`   — {round_idx, phase, progress_pct}
 *   - `trace_link`       — {trace_id} for chat bubble pill
 *   - `keepalive`        — Phase 1: every 25s anti-proxy-timeout heartbeat {ts}
 *   - `checkpoint`       — Phase 1: agent loop iteration completed + state persisted
 *                          {iteration, messages_count} — IDE can use as resume watermark
 *   - `resumed_buffer_drained` — emitted by /resume endpoint after replay catches up
 *                                {sequence_id} — Phase 1 buffer-drain-only handoff marker
 *
 * Termination:
 *   - `round_end` — {reason: "end_turn"|"max_iterations"|"max_tokens"|"error"|"cancelled"|"interrupted",
 *                    final_messages: Message[]  — IDE appends to chatSessions/*.jsonl}
 *   - `error`     — {category, error_code, message, retryable} followed by round_end{error}
 *
 * **Phase 1 removed**: `round_end.data.reason === "tool_use"` (tool_use is a
 * mid-turn step, not a terminal state — agent loop continues internally).
 */
export type InvokeEventType =
	| 'message_start'
	| 'content_block_start'
	| 'content_block_delta'
	| 'content_block_stop'
	| 'message_delta'
	| 'message_stop'
	| 'tool_call_emitted'
	| 'tool_result_observed'
	| 'ide_tool_call'
	| 'confirm_request'
	| 'thinking_delta'
	| 'round_progress'
	| 'trace_link'
	| 'keepalive'
	| 'checkpoint'
	| 'resumed_buffer_drained'
	| 'round_end'
	| 'error';

/**
 * SSE event from reasoner during one invoke's lifecycle.
 *
 * 每个 invoke 的 HTTP response 是一个 SSE stream, 里面是若干 `InvokeEvent`。
 * `sequence_id` 跨 invoke 单调递增, 断线后用于 replay 端点续传。
 *
 * - `type`: 事件类型字面量
 * - `sequence_id`: 跨 invoke 单调; replay 用
 * - `data`: 事件 payload（每个 type 有自己的 shape, opaque dict）
 *     - 对于 `type=message_delta`: `data` 应包含 `usage: TokenUsage` (P0-3)
 *     - 对于 `type=error`: `data` 应包含 `category` / `error_code` / `message`,
 *       且 emit error 后 reasoner 必须紧跟着 emit `round_end{reason:"error"}` 再
 *       关闭 SSE (P0-4 严格顺序)
 */
export interface InvokeEvent {
	type: InvokeEventType;
	/** 跨 invoke 单调; replay 用 */
	sequence_id: number;
	data: Record<string, unknown>;
}

// =============================================================================
// Cancellation
// =============================================================================

/**
 * IDE → reasoner: 取消正在进行的 invoke。
 *
 * 对应 endpoint: `POST /api/v1/invoke/{trace_id}/cancel`
 *
 * - `trace_id`: 待取消的 invoke trace_id
 * - `reason`: 取消原因（默认 "user_cancelled", 便于 telemetry）
 */
export interface CancelRequest {
	trace_id: string;
	/** 默认 "user_cancelled" */
	reason?: string;
}

// =============================================================================
// Conversation compact (ADR-017 Q3 / PHASE-0-PROTOCOL-SPEC §6)
// =============================================================================

/**
 * IDE → reasoner: 压缩老对话生成 summary message。
 *
 * 对应 endpoint: `POST /api/v1/compact`（同步 JSON, 非 SSE）。
 *
 * 语义: IDE 端 chatSession 累计 token 超阈值后, 把"老 turns"批量送来; reasoner 调一次
 * LLM 摘要返回 `summary_message`, IDE 端把老 turns 替换为
 * `[summary_message, ...recent_turns]` 写回 jsonl。reasoner 端完全无 session state,
 * 本请求 self-contained。
 *
 * 与 `InvokeRequest` 共享公共字段 (trace_id / chat_session_id / model / provider /
 * base_url / api_key_alias / user / metadata), 但不携带 system prompt / tools /
 * workspace_path / langgraph state — compact 只是一次纯 LLM summarize 调用。
 *
 * - `trace_id`: 本 compact 调用的 UUID (与触发它的 invoke 的 trace_id 区分)
 * - `chat_session_id`: IDE 端 chatSession uuid, 关联 telemetry
 * - `messages`: 待压缩的全部 messages (IDE 决定截取哪段历史送来)。**min 1**
 *   (PHASE-0-SPEC-AUDIT P0-2)
 * - `model`: 用于摘要的 LLM 模型标识
 * - `provider`: provider 标识, 默认 "auto"
 * - `base_url`: 可选 base URL
 * - `api_key_alias`: IDE 端别名, reasoner 端从 vault 解
 * - `max_summary_tokens`: 摘要 token 上限（默认 4000）; 作为 LLM `max_tokens` 参数下发
 * - `user`: 用户/组织 telemetry, opaque dict
 * - `metadata`: IDE 端 opaque metadata
 * - `protocol_version`: mirrors `InvokeRequest.protocol_version` semantics. 默认 1
 */
export interface CompactRequest {
	// 标识
	trace_id: string;
	chat_session_id: string;
	// Conversation — min 1 (PHASE-0-SPEC-AUDIT P0-2)
	messages: Message[];
	// LLM config
	model: string;
	provider?: string;
	base_url?: string | null;
	api_key_alias?: string | null;
	// Compact-specific
	/** 摘要 token 上限; 作为 LLM max_tokens 下发; 默认 4000 */
	max_summary_tokens?: number;
	// Telemetry
	user?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
	// Protocol version handshake — bump when wire format breaks
	protocol_version?: number;
}

/**
 * reasoner → IDE: compact 调用结果 (同步 JSON, 非 SSE)。
 *
 * - `summary_message`: 摘要 message, IDE 端把它前置到 recent turns 之前。
 *   shape: `{role:"user", content:"<markdown summary>", is_compact_summary: true,
 *           is_visible_in_transcript_only: true}`
 *   role="user" 参照 Claude Code 行为 (summary 作为下一轮 user turn 头注入)
 * - `tokens_in`: 摘要调用消耗的输入 token 数 (best-effort, provider 不报则为 0)
 * - `tokens_out`: 摘要调用输出 token 数 (best-effort, provider 不报则为 0)
 * - `cost_usd`: 摘要调用估算成本 (best-effort, provider 不报则为 0.0)
 */
export interface CompactResponse {
	summary_message: Message;
	tokens_in: number;
	tokens_out: number;
	cost_usd: number;
}

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
// round_end event helper (most-used event shape)
// =============================================================================

/**
 * Typed view of `InvokeEvent.data` for `type === 'round_end'`.
 *
 * Phase 1 changes (ADR-018):
 *   - Removed `tool_use` reason (tool_use is a mid-turn step, agent loop continues)
 *   - Added `max_iterations` reason (loop hit MAX_ITERATIONS cap)
 *   - Added `interrupted` reason (reasoner-side unrecoverable failure)
 *   - Removed `langgraph_state_blob` field (state lives reasoner-side now)
 *   - Added `final_messages` field — Message[] the IDE should append to
 *     chatSessions/*.jsonl on this turn's completion
 *
 * - `reason`: spec-defined termination reason or unknown string (forward-compat)
 * - `final_messages`: assistant + tool_result messages added during this turn
 *                     (NOT including the original input messages — IDE already has those)
 */
export interface RoundEndData {
	reason: 'end_turn' | 'max_iterations' | 'max_tokens' | 'error' | 'cancelled' | 'interrupted' | string;
	final_messages?: Message[];
}

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
	// (which has a required `reason: string` field) don't structurally overlap
	// in tsgo's view. The reasoner contract guarantees `reason` is present on
	// every `round_end` payload (PHASE-1-PROTOCOL-SPEC §2.3).
	const data = e.data as unknown as RoundEndData;
	return data.reason;
}

// =============================================================================
// Phase 1 — Tool catalog registration (ADR-018 §2 D9)
// =============================================================================

/**
 * Single tool descriptor — Anthropic Messages API tool format + ChipOS routing meta.
 *
 * Mirror of python `invoke.py::ToolDefinition`. The `chipos_source` field is
 * server-internal routing metadata (NOT shown to LLM) that tells reasoner
 * where this tool's execution lives:
 *   - "worker_mcp"  → reasoner dispatches via gRPC to worker
 *   - "ide_mcp"     → reasoner emits ide_tool_call SSE event for IDE to execute
 *   - "ide_builtin" → same channel as ide_mcp (read_file / run_in_terminal / etc.)
 */
export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	chipos_source: 'worker_mcp' | 'ide_mcp' | 'ide_builtin';
}

/**
 * IDE → reasoner: long-lived tool catalog registration.
 *
 * Endpoint: `POST /api/v1/tools/register`.
 *
 * Called by IDE on startup and again whenever the live MCP server set changes
 * (user installs/removes an MCP server, or worker tools update). Replaces the
 * per-invoke `tools[]` field that Phase 0 had — InvokeRequest now references
 * the catalog by `expected_catalog_version`, reasoner returns 412 on mismatch.
 *
 * - `chat_session_id`: catalog scoped per chat session (different chats may
 *   have different MCP sets enabled)
 * - `tools`: 1..500 definitions
 */
export interface RegisterToolsRequest {
	chat_session_id: string;
	tools: ToolDefinition[];
	ide_version?: string;
	workspace_path?: string;
}

/**
 * Reasoner → IDE: catalog accepted, opaque version handle for later InvokeRequest.
 *
 * - `catalog_version`: sha256[:16] hex of canonicalised tools JSON. IDE caches
 *   and sends as `expected_catalog_version` on every subsequent invoke.
 * - `accepted_tool_count`: == tools.length on full success
 * - `rejected`: list of {name, reason} for any tool the reasoner couldn't accept
 */
export interface RegisterToolsResponse {
	catalog_version: string;
	accepted_tool_count: number;
	rejected: { name: string; reason: string }[];
}

// =============================================================================
// Phase 1 — Reverse-channel callbacks (ADR-018 §2 D7 + D14)
// =============================================================================

/**
 * IDE → reasoner: IDE finished executing an `ide_tool_call` event.
 *
 * Endpoint: `POST /api/v1/tool_result/{trace_id}/{call_id}`.
 *
 * Reasoner's agent loop awaits the corresponding `asyncio.Future`; the POST
 * resolves it and the loop continues. Default timeout on the reasoner side
 * is 300s — after that the loop synthesises an error tool_result and
 * continues (R-F in PHASE-1-DOC-AUDIT).
 *
 * - `call_id`: must match the SSE `ide_tool_call.data.call_id` (reasoner
 *   uses it to look up the pending Future)
 * - `content`: tool output (short = string; long output caller may truncate)
 * - `output_type`: "text" default; "image"/"binary_ref" reserved for future
 * - `metadata`: optional structured output (e.g. {file_modified, exit_code})
 */
export interface ToolResultRequest {
	call_id: string;
	content: string;
	is_error?: boolean;
	output_type?: 'text' | 'image' | 'binary_ref';
	metadata?: Record<string, unknown> | null;
}

/**
 * IDE → reasoner: user clicked a button on a confirm card.
 *
 * Endpoint: `POST /api/v1/confirm_response/{trace_id}/{request_id}`.
 *
 * Reasoner converts this into a `tool_result` content (JSON serialised) for
 * the `chipos_user_confirm` tool_use (ADR-018 §2 D13).
 *
 * - `request_id`: must match the SSE `confirm_request.data.request_id`
 *   (typically equal to the tool_use.id, "toolu_xxx" or "chipos_confirm_xxx")
 * - `action`: clicked button's action_id, e.g. "approve" / "reject" / "submit" / "skip"
 * - `selections`: agent_ask radio form picks (key=question_id, value=option_id)
 * - `comment`: optional extra text (e.g. user note on submit)
 */
export interface ConfirmResponseRequest {
	request_id: string;
	action: string;
	selections?: Record<string, string> | null;
	comment?: string | null;
}

// =============================================================================
// Phase 1 — Resume + turn state (ADR-018 §2 D10 + R-D)
// =============================================================================

/**
 * IDE → reasoner: SSE drop → reconnect + continue in-flight turn.
 *
 * Endpoint: `POST /api/v1/resume/{chat_session_id}`.
 *
 * Reasoner behaviour:
 *   - in-flight trace_id not found → 404 (turn done or never existed)
 *   - SSE buffer evicted (24h GC) → 410 (IDE shows "session expired")
 *   - Otherwise: SSE 200 + replays events > last_sequence_id from FileStateStore,
 *     then emits `resumed_buffer_drained` marker and closes (Phase 1 buffer-
 *     drain-only; live event handoff is integrated later in CP-2)
 *
 * - `trace_id`: which turn to resume
 * - `last_sequence_id`: client's last received seq (use -1 for "everything from start")
 * - `disconnect_reason`: optional telemetry ("network" / "ide_restart" / "user_action")
 */
export interface ResumeRequest {
	trace_id: string;
	last_sequence_id: number;
	disconnect_reason?: string;
}

/**
 * One in-flight turn's metadata, included in TurnStateResponse.
 *
 * - `state`: "running" if last activity within 5 min, "stale" otherwise
 *   (reasoner instance may have died — IDE should ask user before resuming)
 * - `last_user_message_preview`: first ~100 chars of the user prompt that
 *   started this turn (for UI "you asked: ...")
 */
export interface InFlightTrace {
	trace_id: string;
	started_at: number;
	last_checkpoint_seq?: number;
	state: 'running' | 'stale';
	last_user_message_preview?: string;
}

/**
 * Reasoner → IDE: list of in-flight turns for a chat session.
 *
 * Endpoint response: `GET /api/v1/turn_state/{chat_session_id}`.
 *
 * IDE calls this on startup to check whether to auto-resume any unfinished
 * turn (e.g. user closed IDE mid-LLM-call → reasoner finished the turn in
 * background → next IDE open should fetch the result).
 */
export interface TurnStateResponse {
	chat_session_id: string;
	in_flight_traces: InFlightTrace[];
}

// =============================================================================
// Phase 1 — Typed payload helpers for new SSE events (most-used shapes)
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
 * Payload of `resumed_buffer_drained` event — Phase 1 buffer-drain-only handoff
 * marker emitted by /resume endpoint after replay completes. Tells IDE: from
 * this seq forward, you'll either see live emissions (when live handoff is
 * wired in a future increment) or the stream closes here.
 */
export interface ResumedBufferDrainedData {
	sequence_id: number;
}

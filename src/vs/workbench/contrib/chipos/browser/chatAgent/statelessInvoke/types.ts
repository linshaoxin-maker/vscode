/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 #8a — TS schema types for C 档 stateless reasoner.
 *
 * 这是 `backend_v2/packages/shared/src/shared/contracts/invoke.py`（pydantic v2）的
 * TypeScript 等价镜像。IDE 端用本模块构造类型化 invoke / compact / cancel 请求体,
 * 解析 reasoner 回传的 SSE 事件 payload。**字段名 / 默认值 / 可空性必须与 python
 * 端逐字对齐**, 任何漂移都会立即破坏 wire 契约。
 *
 * 设计目标（与 python 端共享）:
 *   - 与 **Anthropic Messages API** 100% 对齐（ADR-017 §11.3），让 ChipOS reasoner
 *     成为 Anthropic API 的"增强代理"
 *   - IDE 端 conversation 数组结构 = Claude Code 同款, 迁移成本低
 *   - 未来接入 multi-provider (OpenAI / Claude / Zhipu / DeepSeek) trivial 适配
 *   - reasoner 服务端完全无状态: 每次 invoke 由 IDE 自带 messages + state_blob
 *
 * 关联设计文档:
 *   - ADR-016 (conversation state 决策)
 *   - ADR-017 §11.3 (Anthropic 兼容 schema 调研)
 *   - PHASE-0-PROTOCOL-SPEC.md §2 (Message schema), §12 (AUDIT P0 resolutions)
 *
 * 兼容性注意（与 pydantic 端一致）:
 *   - python 端所有类启用 `extra="allow"`; TS 这边对应的语义是 "interface 字段是最小子集,
 *     未列出的字段可能由上游 Anthropic 引入, 不要 strict-reject"。下游消费方对未知 key
 *     应保持 forward-compat (不要 `Object.keys()` 做完备性 switch)
 *   - `ContentBlock` 是 discriminated union, 按 `type` 字段 narrow
 *   - `Message.content` 接受 `string` 或 `ContentBlock[]`, 覆盖 Anthropic 两种 shape
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
 * C 档 stateless invoke request — IDE → reasoner.
 *
 * 每次完整携带: messages 数组 + LangGraph state opaque + workspace 上下文。
 * 服务端不存任何东西, 本请求 self-contained。
 *
 * Field reference (matches `invoke.py::InvokeRequest`):
 *   - `trace_id`: 本 invoke 的 UUID, IDE 生成
 *   - `chat_session_id`: IDE 端 chatSessions/*.jsonl 的 uuid; 多个 trace_id 共享同一
 *     chat_session_id
 *   - `messages`: 完整对话历史（含 tool_use / tool_result）。**IDE side must enforce
 *     at least 1 message** — server returns 400 on empty (PHASE-0-SPEC-AUDIT P0-2)
 *   - `system`: 可选系统提示
 *   - `mode`: Agent 工作模式 "agent" / "spec", 默认 "agent"
 *   - `model`: LLM 模型标识 (zhipu/glm-5.1, claude-3.5-sonnet, ...)
 *   - `provider`: provider 标识, 默认 "auto"
 *   - `base_url`: 可选 base URL
 *   - `api_key_alias`: IDE 端别名, reasoner 端从 vault 解
 *   - `temperature`: 采样温度
 *   - `max_tokens`: 输出 token 上限
 *   - `thinking`: 是否启用 thinking; 默认 false
 *   - `tools`: per-request 工具定义列表（替代 session-level 注册）; 默认 []
 *   - `workspace_path`: 工作区绝对路径（worker affinity 用）
 *   - `auto_approve_mode`: Auto-Approve 模式, 默认 "standard"
 *   - `langgraph_state_blob`: base64-encoded pydantic 序列化 state; 新 trace 首次
 *     invoke 为 null
 *   - `langgraph_state_version`: state schema 版本, 默认 1
 *   - `user`: 用户/组织 telemetry, opaque dict
 *   - `metadata`: IDE 端 opaque metadata
 *   - `protocol_version`: wire-protocol version; reasoner rejects with 409 if not
 *     in SUPPORTED_PROTOCOL_VERSIONS. Bump only when the schema breaks backwards
 *     compatibility. 默认 1
 */
export interface InvokeRequest {
	// 标识
	trace_id: string;
	chat_session_id: string;
	// Conversation — min 1 (PHASE-0-SPEC-AUDIT P0-2)
	messages: Message[];
	// System prompt / mode
	system?: string | null;
	mode?: 'agent' | 'spec';
	// LLM config
	model: string;
	provider?: string;
	base_url?: string | null;
	api_key_alias?: string | null;
	temperature?: number | null;
	max_tokens?: number | null;
	thinking?: boolean;
	// Tools — IDE 注册的 MCP tools + reasoner 内置 + worker tools
	tools?: Record<string, unknown>[];
	// Workspace + EXECUTION binding
	workspace_path: string;
	auto_approve_mode?: string;
	// State persistence (ADR-017 Q1)
	langgraph_state_blob?: string | null;
	langgraph_state_version?: number;
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
 *   - `tool_call_emitted`   — assistant decided to call a tool (also encoded in messages)
 *   - `tool_result_observed` — tool result accepted by reasoner (for worker tools)
 *
 * ChipOS specific:
 *   - `thinking_delta`
 *   - `round_progress`  — {round_idx, phase, progress_pct}
 *   - `trace_link`      — {trace_id} for IDE chat bubble pill
 *
 * Termination:
 *   - `round_end` — {reason: "end_turn"|"tool_use"|"max_tokens"|"error"|"cancelled",
 *                    langgraph_state_blob?: string  -> 给 IDE 持久化}
 *   - `error`
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
	| 'thinking_delta'
	| 'round_progress'
	| 'trace_link'
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
 * - `reason`: one of the spec-defined termination reasons, or an unknown string
 *   (forward-compat — server may add new reasons in future protocol_version)
 * - `langgraph_state_blob`: opaque base64 state to persist for the next invoke
 */
export interface RoundEndData {
	reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'cancelled' | string;
	langgraph_state_blob?: string;
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
	// every `round_end` payload (PHASE-0-PROTOCOL-SPEC §2).
	const data = e.data as unknown as RoundEndData;
	return data.reason;
}

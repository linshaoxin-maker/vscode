/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

// ── AgentEvent base ─────────────────────────────────────────────────────────

export const enum AgentEventType {
	TextDelta = 'text_delta',
	ThinkingDelta = 'thinking_delta',
	ToolCall = 'tool_call',
	ToolResult = 'tool_result',
	FileEdit = 'file_edit',
	Confirm = 'confirm',
	ConfirmRequest = 'confirm_request',
	ConfirmAutoResolved = 'confirm_auto_resolved',
	Error = 'error',
	Done = 'done',
	Status = 'status',
	TodoUpdate = 'todo',
	TaskComplete = 'task_complete',
	SkillTree = 'skill_tree',
	RoundStart = 'round_start',
	Plan = 'plan',
	DiffPreview = 'diff_preview',
	SimReport = 'sim_report',
	CoverageReport = 'coverage_report',
	LintReport = 'lint_report',
	NegotiationView = 'negotiation_view',
	ParallelProgress = 'parallel_progress',
	LoopProgress = 'loop_progress',
	SpecReview = 'spec_review',
	TaskSummary = 'task_summary',
	SubagentEvent = 'subagent_event',
	ModelTurnStart = 'model_turn_start',
	ModelTurnEnd = 'model_turn_end',
	WorktreeFilesApplied = 'worktree_files_applied',
	// FEAT-T01: Proto 对齐 — 系统事件
	Usage = 'usage',
	Heartbeat = 'heartbeat',
	// FEAT-61: Queue position update
	QueueUpdate = 'queue_update',
	// FEAT-65: Context window usage warning
	ContextWarning = 'context_warning',
	// Reasoner passthrough events
	TimingHighlight = 'timing_highlight',
	PreReviewReport = 'pre_review_report',
	// FEAT-R72: IDE 端工具调用（Reasoner → IDE 执行）
	IdeToolCall = 'ide_tool_call',
	// PPA 优化报告（时序/综合/功耗报告 + 优化前后对比）
	PpaReport = 'ppa_report',
}

export interface IAgentEventBase {
	readonly event_id: string;
	readonly event_type: AgentEventType;
	readonly sub_type?: string;
	readonly timestamp: number;
	/** Session ID for multi-session isolation (R20). Injected by SSE client. */
	readonly session_id?: string;
	/**
	 * Trace ID for cross-tier correlation (ADR-009 §4.1).
	 *
	 * Reasoner emits trace_id at the top level of every ServerEvent
	 * (stream_manager.py:build_event). The WebSocket / SSE client extracts it
	 * from the raw message and injects here so downstream consumers (chat
	 * bubble pill / replay CLI / admin UI) can correlate IDE-side rendering
	 * with reasoner master trace.jsonl + worker artifact 上传 ref.
	 *
	 * 2026-05-08: this is the chipos IDE side (vscode/ fork) of the same
	 * fix that vscode-extension/src/ws/WebSocketClient.ts:_handleMessage 早
	 * 期实现过。两端独立实现，不共享代码（unified-clients plan §二）。
	 */
	readonly trace_id?: string;
}

// ── Core payload interfaces ─────────────────────────────────────────────────

export interface ITextDeltaPayload {
	readonly content: string;
	readonly role: 'assistant' | 'thinking';
}

export interface IToolCallPayload {
	readonly tool_name: string;
	readonly arguments: Record<string, unknown>;
	readonly call_id: string;
	readonly summary?: string;
	readonly snapshot_content?: string;
}

export interface IToolResultPayload {
	readonly call_id: string;
	readonly tool_name: string;
	readonly result: unknown;
	readonly success: boolean;
	readonly summary?: string;
	readonly is_error?: boolean;
}

export interface IEditOperation {
	readonly range: { startLine: number; startCol: number; endLine: number; endCol: number };
	readonly newText: string;
}

export interface IFileEditPayload {
	readonly file_path: string;
	readonly edits: IEditOperation[];
}

export interface IConfirmPayload {
	readonly hook_id: string;
	readonly card_type: 'simple' | 'diff_preview' | 'sim_report' | 'custom';
	readonly card_data: Record<string, unknown>;
	readonly skippable: boolean;
}

export interface IErrorPayload {
	readonly error_code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly category?: string;
	readonly details?: Record<string, unknown>;
}

export interface IDonePayload {
	readonly summary: string;
	readonly metrics: Record<string, number>;
}

// ── Backend V1 protocol payloads ────────────────────────────────────────────

export type StatusLevel = 'info' | 'success' | 'warning' | 'thinking';

export interface IStatusPayload {
	readonly level: StatusLevel;
	readonly text: string;
	readonly tool_name?: string;
}

export interface ITodoItem {
	readonly task_id?: string;
	readonly task_des?: string;
	readonly task_status?: string;
	// ── 兼容后端实际格式 ──
	readonly id?: string;
	readonly content?: string;
	readonly status?: string;
}

export interface ITodoUpdatePayload {
	readonly todos: ITodoItem[];
}

export interface ITaskCompletePayload {
	readonly status: 'success' | 'cancelled' | 'error';
	readonly message?: string;
}

export interface ISkillTreePayload {
	readonly version: number;
	readonly total_skills: number;
	readonly children: unknown[];
}

export interface IConfirmRequestPayload {
	readonly request_id: string;
	readonly card_type: string;
	readonly card_data: Record<string, unknown>;
	readonly title?: string;
	readonly message?: string;
	readonly options?: Array<{ label: string; action?: string; action_id?: string }>;
	readonly is_background?: boolean;
}

/**
 * Payload for `confirm_auto_resolved` — emitted by reasoner when a
 * confirm card timed out server-side and the agent moved on with a
 * default action. Lets the IDE retire the card (issue #51 comment 2).
 */
export interface IConfirmAutoResolvedPayload {
	readonly request_id: string;
	readonly hook_id: string;
	readonly card_type: string;
	readonly action: string;
	readonly reason: string;
	readonly timeout_ms: number;
}

export interface IRoundStartPayload {
	readonly round: number;
}

export interface IPlanMilestone {
	readonly id: string;
	readonly title: string;
	readonly status: 'pending' | 'running' | 'done' | 'failed';
	readonly description?: string;
}

export interface IPlanPayload {
	readonly milestones: IPlanMilestone[];
}

export interface IDiffHunkLine {
	readonly type: 'add' | 'del' | 'ctx';
	readonly content: string;
	readonly line_no?: number;
}

export interface IDiffHunk {
	readonly header: string;
	readonly lines: IDiffHunkLine[];
}

export interface IDiffPreviewPayload {
	readonly file_path: string;
	readonly hunks: IDiffHunk[];
}

export interface ISimTestResult {
	readonly name: string;
	readonly status: 'pass' | 'fail' | 'error' | 'skip';
	readonly message?: string;
	readonly duration_ms?: number;
}

export interface ISimReportPayload {
	readonly tests: ISimTestResult[];
	readonly summary: { total: number; passed: number; failed: number; errors?: number };
}

export interface ICoverageReportPayload {
	readonly line_cov: number;
	readonly branch_cov: number;
	readonly gaps?: Array<{ file: string; lines: string; type?: string }>;
}

export interface ILintError {
	readonly file: string;
	readonly line: number;
	readonly col?: number;
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly rule?: string;
	readonly auto_fixable?: boolean;
}

export interface ILintReportPayload {
	readonly errors: ILintError[];
	readonly auto_fixable?: number;
	readonly tool?: string;
}

// PPA 优化报告
export interface IPpaMetrics {
	readonly area?: number;
	readonly delay_ns?: number;
	readonly power_w?: number;
	readonly wns?: number;
	readonly tns?: number;
}

export interface IPpaReportPayload {
	readonly stage: 'baseline' | 'eval_round' | 'improved' | 'not_improved';
	readonly round?: number;
	readonly ppa?: IPpaMetrics;
	readonly baseline_ppa?: IPpaMetrics;
	readonly previous_best_ppa?: IPpaMetrics;
	readonly current_ppa?: IPpaMetrics;
	readonly best_ppa?: IPpaMetrics;
	readonly improvement?: Record<string, number>;
	readonly strategy?: string;
	readonly sta_report?: string;
	readonly power_report?: string;
	readonly pareto_front_size?: number;
}

export interface INegotiationPerspective {
	readonly agent: string;
	readonly position: string;
	readonly reasoning: string;
}

export interface INegotiationViewPayload {
	readonly issue: string;
	readonly perspectives: INegotiationPerspective[];
	readonly recommendation: string;
}

export interface IParallelTrack {
	readonly name: string;
	readonly status: 'pending' | 'running' | 'done' | 'failed';
	readonly progress?: number;
	readonly file?: string;
}

export interface IParallelProgressPayload {
	readonly phase: string;
	readonly tracks: IParallelTrack[];
	readonly conflicts?: string[];
}

export interface ILoopProgressPayload {
	readonly tool: string;
	readonly round: number;
	readonly max_rounds: number;
	readonly phase: string;
	readonly status: string;
	readonly summary?: string;
}

export interface ISpecReviewPayload {
	readonly spec_path: string;
	readonly spec_name: string;
	readonly summary: string;
	readonly files?: string[];
}

export interface ITaskSummaryPayload {
	readonly task_type: string;
	readonly structured_data: Record<string, unknown>;
}

export interface ISubagentEventPayload {
	readonly task_id: string;
	readonly kind: 'start' | 'text' | 'tool_start' | 'tool_end' | 'status' | 'error' | 'complete';
	readonly content?: string;
	readonly tool_name?: string;
	/** Tool arguments — present on tool_start for file-writing tools */
	readonly args?: Record<string, unknown>;
	/** File path — present on tool_end for file-writing tools */
	readonly file_path?: string;
	/** File content snapshot taken BEFORE the tool writes — present on tool_start */
	readonly snapshot_content?: string;
}

export interface IWorktreeFilesAppliedPayload {
	readonly files: Array<{ path: string; action: 'added' | 'modified' | 'deleted' }>;
}

/** FEAT-R72: IDE 端工具调用 payload（Reasoner → IDE 执行） */
export interface IIdeToolCallPayload {
	readonly call_id: string;
	readonly name: string;
	readonly args_json: string;
}

// ── Concrete AgentEvent types ───────────────────────────────────────────────

export interface ITextDeltaEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TextDelta;
	readonly payload: ITextDeltaPayload;
}

export interface IToolCallEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ToolCall;
	readonly payload: IToolCallPayload;
}

export interface IToolResultEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ToolResult;
	readonly payload: IToolResultPayload;
}

export interface IFileEditEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.FileEdit;
	readonly payload: IFileEditPayload;
}

export interface IConfirmEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Confirm;
	readonly payload: IConfirmPayload;
}

export interface IErrorEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Error;
	readonly payload: IErrorPayload;
}

export interface IDoneEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Done;
	readonly payload: IDonePayload;
}

export interface IStatusEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Status;
	readonly payload: IStatusPayload;
}

export interface ITodoUpdateEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TodoUpdate;
	readonly payload: ITodoUpdatePayload;
}

export interface ITaskCompleteEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TaskComplete;
	readonly payload: ITaskCompletePayload;
}

export interface ISkillTreeEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.SkillTree;
	readonly payload: ISkillTreePayload;
}

export interface IConfirmRequestEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ConfirmRequest;
	readonly payload: IConfirmRequestPayload;
}

export interface IConfirmAutoResolvedEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ConfirmAutoResolved;
	readonly payload: IConfirmAutoResolvedPayload;
}

export interface IRoundStartEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.RoundStart;
	readonly payload: IRoundStartPayload;
}

export interface IPlanEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Plan;
	readonly payload: IPlanPayload;
}

export interface IDiffPreviewEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.DiffPreview;
	readonly payload: IDiffPreviewPayload;
}

export interface ISimReportEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.SimReport;
	readonly payload: ISimReportPayload;
}

export interface ICoverageReportEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.CoverageReport;
	readonly payload: ICoverageReportPayload;
}

export interface ILintReportEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.LintReport;
	readonly payload: ILintReportPayload;
}

export interface IPpaReportEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.PpaReport;
	readonly payload: IPpaReportPayload;
}

export interface INegotiationViewEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.NegotiationView;
	readonly payload: INegotiationViewPayload;
}

export interface IParallelProgressEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ParallelProgress;
	readonly payload: IParallelProgressPayload;
}

export interface ILoopProgressEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.LoopProgress;
	readonly payload: ILoopProgressPayload;
}

export interface ISpecReviewEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.SpecReview;
	readonly payload: ISpecReviewPayload;
}

export interface ITaskSummaryEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TaskSummary;
	readonly payload: ITaskSummaryPayload;
}

export interface ISubagentEventEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.SubagentEvent;
	readonly payload: ISubagentEventPayload;
}

export interface IModelTurnEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ModelTurnStart | AgentEventType.ModelTurnEnd;
	readonly payload: Record<string, never>;
}

export interface IWorktreeFilesAppliedEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.WorktreeFilesApplied;
	readonly payload: IWorktreeFilesAppliedPayload;
}

export interface IQueueUpdateEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.QueueUpdate;
	readonly payload: IQueueUpdatePayload;
}

export interface IContextWarningEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ContextWarning;
	readonly payload: IContextWarningPayload;
}

/** FEAT-R72 */
export interface IIdeToolCallEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.IdeToolCall;
	readonly payload: IIdeToolCallPayload;
}

export type AgentEvent =
	| ITextDeltaEvent
	| IThinkingDeltaEvent
	| IToolCallEvent
	| IToolResultEvent
	| IFileEditEvent
	| IConfirmEvent
	| IErrorEvent
	| IDoneEvent
	| IStatusEvent
	| ITodoUpdateEvent
	| ITaskCompleteEvent
	| ISkillTreeEvent
	| IConfirmRequestEvent
	| IConfirmAutoResolvedEvent
	| IRoundStartEvent
	| IPlanEvent
	| IDiffPreviewEvent
	| ISimReportEvent
	| ICoverageReportEvent
	| ILintReportEvent
	| IPpaReportEvent
	| INegotiationViewEvent
	| IParallelProgressEvent
	| ILoopProgressEvent
	| ISpecReviewEvent
	| ITaskSummaryEvent
	| ISubagentEventEvent
	| IModelTurnEvent
	| IWorktreeFilesAppliedEvent
	| IUsageEvent
	| IHeartbeatEvent
	| IQueueUpdateEvent
	| IContextWarningEvent
	| IIdeToolCallEvent;

// ── Task request payload ────────────────────────────────────────────────────

export interface ITaskRequest {
	readonly type: 'task';
	readonly session_id: string;
	readonly query: string;
	readonly context: IContextPayload;
	readonly mode: 'agent' | 'spec';
	readonly options: {
		readonly thinking: boolean;
		readonly auto_approve: boolean;
	};
}

export interface IContextPayload {
	readonly files?: IContextFile[];
	readonly workspace_path?: string;
}

export interface IContextFile {
	readonly path: string;
	readonly type: 'file' | 'folder' | 'snippet';
	readonly content?: string | null;
}

// ── Mention item ────────────────────────────────────────────────────────────

export interface IMentionItem {
	readonly path: string;
	readonly type: 'file' | 'folder' | 'snippet';
	readonly displayName: string;
	readonly content?: string;
	readonly startLine?: number;
	readonly endLine?: number;
}

// ── FEAT-61: Queue update payload ───────────────────────────────────────────

export interface IQueueUpdatePayload {
	readonly position: number;
	readonly estimated_wait_seconds?: number;
}

// ── FEAT-65: Context window warning payload ─────────────────────────────────

export interface IContextWarningPayload {
	readonly usage_percent: number;
	readonly tokens_used: number;
	readonly tokens_max: number;
	readonly suggestion?: string;
}

// ── FEAT-T01: Proto 对齐 — ThinkingDelta / Usage / Heartbeat ────────────────

export interface IThinkingDeltaPayload {
	readonly content: string;
}

export interface IThinkingDeltaEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.ThinkingDelta;
	readonly payload: IThinkingDeltaPayload;
}

export interface IUsagePayload {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly model?: string;
	readonly tokens_max?: number;
	// Accumulated session totals (for billing/analytics, not for context window display)
	readonly accumulated_prompt_tokens?: number;
	readonly accumulated_completion_tokens?: number;
	readonly accumulated_total_tokens?: number;
}

export interface IUsageEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Usage;
	readonly payload: IUsagePayload;
}

export interface IHeartbeatPayload {
	readonly timestamp_ms: number;
}

export interface IHeartbeatEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Heartbeat;
	readonly payload: IHeartbeatPayload;
}

// ── Connection state ────────────────────────────────────────────────────────

export const enum ConnectionState {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
	Reconnecting = 'reconnecting',
	Error = 'error',
}

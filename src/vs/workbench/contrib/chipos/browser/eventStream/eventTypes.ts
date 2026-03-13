/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

// ── AgentEvent base ─────────────────────────────────────────────────────────

export const enum AgentEventType {
	TextDelta = 'text_delta',
	ToolCall = 'tool_call',
	ToolResult = 'tool_result',
	FileEdit = 'file_edit',
	Confirm = 'confirm',
	Error = 'error',
	Done = 'done',
	Status = 'status',
	TodoUpdate = 'todo_update',
	TaskComplete = 'task_complete',
	SkillTree = 'skill_tree',
}

export interface IAgentEventBase {
	readonly event_id: string;
	readonly event_type: AgentEventType;
	readonly sub_type?: string;
	readonly timestamp: number;
}

// ── Payload interfaces ──────────────────────────────────────────────────────

export interface ITextDeltaPayload {
	readonly content: string;
	readonly role: 'assistant' | 'thinking';
}

export interface IToolCallPayload {
	readonly tool_name: string;
	readonly arguments: Record<string, unknown>;
	readonly call_id: string;
}

export interface IToolResultPayload {
	readonly call_id: string;
	readonly tool_name: string;
	readonly result: unknown;
	readonly success: boolean;
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
}

export interface IDonePayload {
	readonly summary: string;
	readonly metrics: Record<string, number>;
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

// ── Backend protocol event types (V1 → AgentEvent adapter) ─────────────────

export type StatusLevel = 'info' | 'success' | 'warning' | 'thinking';

export interface IStatusPayload {
	readonly level: StatusLevel;
	readonly text: string;
	readonly tool_name?: string;
}

export interface IStatusEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.Status;
	readonly payload: IStatusPayload;
}

export interface ITodoItem {
	readonly task_id: string;
	readonly task_des: string;
	readonly task_status: string;
}

export interface ITodoUpdatePayload {
	readonly todos: ITodoItem[];
}

export interface ITodoUpdateEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TodoUpdate;
	readonly payload: ITodoUpdatePayload;
}

export interface ITaskCompletePayload {
	readonly status: 'success' | 'cancelled' | 'error';
	readonly message?: string;
}

export interface ITaskCompleteEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.TaskComplete;
	readonly payload: ITaskCompletePayload;
}

export interface ISkillTreePayload {
	readonly version: number;
	readonly total_skills: number;
	readonly children: unknown[];
}

export interface ISkillTreeEvent extends IAgentEventBase {
	readonly event_type: AgentEventType.SkillTree;
	readonly payload: ISkillTreePayload;
}

export type AgentEvent =
	| ITextDeltaEvent
	| IToolCallEvent
	| IToolResultEvent
	| IFileEditEvent
	| IConfirmEvent
	| IErrorEvent
	| IDoneEvent
	| IStatusEvent
	| ITodoUpdateEvent
	| ITaskCompleteEvent
	| ISkillTreeEvent;

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

// ── Connection state ────────────────────────────────────────────────────────

export const enum ConnectionState {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
	Reconnecting = 'reconnecting',
	Error = 'error',
}

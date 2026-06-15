/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceCancellation, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { MarkdownString, type IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { stripIcons } from '../../../../../base/common/iconLabels.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService, ITerminalChatService } from '../../../terminal/browser/terminal.js';
import { ITerminalSandboxService } from '../../../terminalContrib/chatAgentTools/common/terminalSandboxService.js';
import { IMcpService } from '../../../mcp/common/mcpTypes.js';
import {
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentHistoryEntry,
} from '../../../../contrib/chat/common/participants/chatAgents.js';
import { URI, type UriComponents } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import {
	IChatProgress,
	IChatFollowup,
	IChatMarkdownContent,
	IChatConfirmation,
	IChatCommandButton,
	IChatProgressMessage,
	IChatThinkingPart,
	IChatExternalToolInvocationUpdate,
	IChatToolInputInvocationData,
	IChatSubagentToolInvocationData,
	IChatTerminalToolInvocationData,
	IChatAgentError,
	IChatChiposTodoCard,
} from '../../../../contrib/chat/common/chatService/chatService.js';
import type { IToolResultInputOutputDetails } from '../../../../contrib/chat/common/tools/languageModelToolsService.js';
import { IChatTodoListService, type IChatTodo } from '../../../../contrib/chat/common/tools/chatTodoListService.js';
import { IChatEditingService, type IChatEditingSession } from '../../../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import type { IChatResponseModel, IChatModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { ChatModelToRecordsAdapter } from './statelessInvoke/chatModelAdapter.js';
import { ConversationAssembler, ConversationAssemblyError } from './statelessInvoke/conversationAssembler.js';
import { ConversationCompactor } from './statelessInvoke/conversationCompactor.js';
import {
	StatelessClient,
	StatelessHttpError,
	StatelessResumeNotFoundError,
} from './statelessInvoke/statelessClient.js';
import type {
	InFlightTrace,
	InvokeRequest,
	Message,
	PromptResourceAttachment,
	ToolDefinition,
	TokenUsage,
	TurnStateResponse,
} from './statelessInvoke/types.js';
import { collectPromptResources } from '../resources/promptResourceAttachmentCollector.js';
import { isExtensionSystemEnabled } from '../../common/extensionsBeta.js';
import { IChiposPromptInputsService } from './chiposPromptInputsService.js';
import { filterHooksForInvoke, redactSensitive } from './hookSecurity.js';
import { IChiposHookLogService } from './chiposHookLogService.js';
import { substituteCommandArgs } from '../resources/commandSubstitution.js';
import { ChiposRulesService } from '../resources/chiposRulesService.js';
import { ChiposCommandsService } from '../resources/chiposCommandsService.js';
import { ChiposSkillsService } from '../resources/chiposSkillsService.js';
import { ChiposAgentsService } from '../resources/chiposAgentsService.js';
import { ChiposPluginsService } from '../resources/chiposPluginsService.js';
import { ChiposPluginHookHost } from './chiposPluginHookHost.js';
import { IChiposPluginHookService } from '../../common/chiposPluginHookService.js';
import { buildIdeMcpTools, shapeMcpToolResult, IdeMcpToolInfo } from './ideToolCatalog.js';
import { ChiposHooksService } from '../resources/chiposHooksService.js';
import { classifySseFailure, dispatchStatelessEvent, type DispatchResult } from './statelessInvoke/eventDispatcher.js';
import { computeSubagentFinalizeUpdates, computeSubagentToolUpdates, createSubagentCardState, type ISubagentCardState } from './statelessInvoke/subagentCard.js';
import { buildToolRowLabel, summarizeToolOutput, withResultBadge } from './statelessInvoke/toolRowFormat.js';
import { StatelessObservability } from './statelessInvoke/statelessObservability.js';
import { isStatelessTurnResumable } from './statelessInvoke/statelessResumability.js';
import { ChipOSEditorEffects } from './editorEffects.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { resolveReasoningUrl } from '../../common/chiposEndpoints.js';
import { IChipOSWorkerPermissionService, IWorkerPermissionAsk } from '../permission/workerPermissionService.js';
import { IChipOSConfirmRetireService, type ChipOSConfirmRetireReason } from './chiposConfirmRetireService.js';
import { ChatPermissionLevel, isAutoApproveLevel } from '../../../chat/common/constants.js';
import {
	type IConfirmRequestPayload,
	type ITaskSummaryPayload,
	type IMentionItem,
} from '../eventStream/eventTypes.js';

interface IChatSessionRuntime {
	backendSessionId?: string;
	toolStartTimes: Map<string, number>;
	toolFileArgs: Map<string, string>;
	subagentTimers: Map<string, number>;
	subagentParentMap: Map<string, string>;
	lastSubagentToolCallId?: string;
	externalEditOps: Map<string, number>;
	pendingStartEdits: Map<string, Promise<void>>;
	/** Aborted when the session is disposed, so pending invoke/continuation can reject. */
	disposeController: AbortController;
	/** Maps tool call key → terminal session/command IDs for ChatTerminalToolProgressPart rendering */
	terminalSessionMap: Map<string, { sessionId: string; commandId: string }>;
	/** Caches tool call key → command line string for ToolResult to reuse in terminal snapshot */
	terminalCommandLines: Map<string, string>;
	/** Stores terminal artifacts (theme, URI) captured after _runInTerminal completes, for ToolResult handler */
	terminalArtifacts: Map<string, { theme?: { background?: string; foreground?: string }; commandUri?: UriComponents }>;
	/**
	 * UX polish — every-event runtime state for chat progress hygiene.
	 *
	 * `inInitPhase`: true between user message submit and the first real
	 *   content event (TextDelta / ThinkingDelta / ToolCall). While true,
	 *   incoming Status events are *swallowed* and only a single
	 *   "Connecting…" spinner stays visible. Once any real content arrives
	 *   we flip this to false and Status events pass through normally.
	 *
	 * `lastStatusText`: cache of the previous Status text so we can drop
	 *   immediate duplicates ("Step model_run" arriving twice in a row,
	 *   etc.) — they were rendering as two adjacent identical lines.
	 */
	inInitPhase: boolean;
	lastStatusText?: string;
	/**
	 * UX polish — track which file refs have already been emitted in the
	 * current invoke. Without this, an agent that writes the same file
	 * three times (e.g. write_file → edit_file → str_replace on rtl/x.v)
	 * produces three identical "modified" rows in the chat references
	 * area. We dedupe on the resolved absolute path string. Cleared on
	 * each invoke alongside the other transient maps.
	 */
	emittedFileRefs: Set<string>;
	/**
	 * Working-set fallback: the spec/subagent flow doesn't surface
	 * `WorktreeFilesApplied` to the IDE, so files that get written via
	 * subagent tool calls never make it into chatEditingSession's entries
	 * observable — leaving the chat input's working-set widget empty even
	 * after the agent wrote files to disk. We work around that by running
	 * a workspace-root file watcher during each invoke, collecting URIs
	 * that change between user-input start and TaskComplete, and feeding
	 * them through `_startExternalEdit + _stopExternalEdit` at task end.
	 *
	 * `workspaceWatcher` — disposable for the recursive watcher (created
	 *   on first invoke per session, disposed on _disposeRuntime).
	 * `watchedFileChanges` — URIs reported by the watcher during the
	 *   current invoke; flushed at TaskComplete; dedup'd against
	 *   `externalEditOps` so files already tracked by direct ToolCall don't
	 *   double-register.
	 */
	workspaceWatcher?: IDisposable;
	watchedFileChanges: Set<string>;
	/**
	 * Worker permission ASK channel (WORKER-PERMISSION-ASK-TRANSPORT):
	 * - `activeProgress`: when invoke() is mid-flight, points at the same
	 *   progress callback so worker SSE asks can be surfaced as confirmations
	 *   asynchronously.
	 * - `pendingWorkerAsks`: asks received between invokes are queued and
	 *   flushed on the next invoke entry.
	 * - `permissionSub`: SSE EventSource subscription, owned by the runtime
	 *   so dispose() closes it.
	 */
	activeProgress?: (parts: IChatProgress[]) => void;
	/** Bound to invoke()'s `finish()` so worker-permission asks can finalize
	 * the current invoke immediately on card emission — without this, VS Code
	 * chat keeps the invoke "in flight" and the confirmation Submit button is
	 * disabled until the invoke ends naturally (which can be 30-60s while
	 * reasoner waits for tool result). */
	activeFinish?: (result: IChatAgentResult, thinkingTitle?: string) => void;
	pendingWorkerAsks: Map<string, IWorkerPermissionAsk>;
	permissionSub?: IDisposable;
	/** v2 (PERMISSION-APPROVAL-UX-V2 §1): IDE chat permission level for the
	 * **current** invoke. When AutoApprove or Autopilot, worker permission
	 * ASKs are silently auto-allowed instead of rendered as a card. Updated
	 * at every invoke() entry from `request.modeInfo?.permissionLevel`. */
	permissionLevel?: ChatPermissionLevel;
	/** InlineChat v2 — tracks whether the current invoke emitted any FileEdit
	 * (i.e. the response was edit-style). If false at completion AND the
	 * request came from EditorInline location, we treat the response as
	 * chat-style and surface it (the inline overlay's "Done, 0 changes"
	 * collapse otherwise drops it into the void). Reset at every invoke entry. */
	emittedTextEdit?: boolean;
	/** InlineChat v2 (F) — count of distinct files edited in this invoke +
	 * the *first* edited file's basename. Used when the invoke comes from
	 * EditorInline to fire a "Applied N edits to file — ⌘⇧Y to accept" toast
	 * so users see an obvious next-action affordance after AI edits land.
	 * Reset alongside emittedTextEdit. */
	editedFiles?: Set<string>;
	firstEditedFileLabel?: string;
	/** InlineChat v2 — accumulates TextDelta chunks during an EditorInline
	 * invoke so the final inline-overlay progress message can show a short
	 * answer preview. Cleared at every invoke entry. */
	inlineAccumulator?: string;
}

/**
 * IChatAgentImplementation that bridges the native VSCode Chat UI
 * to the ChipOS backend via SSE (Server-Sent Events).
 *
 * Maps all backend events to native IChatProgress types:
 *   - model_output → markdownContent / thinking
 *   - tool_start/result → progressMessage with tool trace
 *   - confirm_request → confirmation (native buttons)
 *   - sim_report/coverage/lint → markdownContent (rich formatted)
 *   - task_complete → resolves the invoke Promise
 */


export function _buildTracePillMarkdown(traceId: string): MarkdownString {
	const safeTitle = traceId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const encodedArg = encodeURIComponent(JSON.stringify(traceId));
	// 2026-05-16 — visual round 5: round 4 (icon-only `[$(link-external)]`)
	// silently rendered NOTHING in the chat bubble — the markdown link
	// renderer does NOT substitute `$(name)` codicons that sit INSIDE
	// the link text position of `[text](url)`. The link disappeared.
	//
	// Round 5 strategy: keep "trace" as the link text (we know that
	// renders, per round 3 dogfood), but **wrap it in italics + lead
	// with em-dash + put the codicon OUTSIDE the link** where icon
	// substitution works. Net visual:
	//
	//     — $(link-external) *trace*
	//
	// italic trace word reads as metadata not content; em-dash
	// demotes it to footnote prominence; codicon decorates without
	// overwhelming.
	return new MarkdownString(
		`\n\n— $(link-external) *[trace](command:chipos.trace.copyId?${encodedArg} "Trace ID: ${safeTitle} — click to copy")*`,
		{ supportThemeIcons: true, isTrusted: true },
	);
}

export class ChipOSChatAgent extends Disposable implements IChatAgentImplementation {

	private readonly _sessionRuntimes = new ResourceMap<IChatSessionRuntime>();
	/** PHASE-1-CUTOVER §5: client-observable stateless ramp counters (DI). */
	private readonly _statelessObs!: StatelessObservability;
	/** FEAT-006c: per-turn extension-usage accumulator — auto-context @ collect,
	 * attachments/hooks @ assemble, cache @ round-end; emitted once at terminate. */
	private _pendingExtTelemetry: { autoContext: { content?: string }[]; attachments: { content?: string }[]; hooks: { status?: string }[] } | undefined;
	private _editorEffects: ChipOSEditorEffects | undefined;
	/** Counter for generating unique external edit operation IDs */
	private _externalEditOpCounter = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatTodoListService private readonly _todoListService: IChatTodoListService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustService: IWorkspaceTrustManagementService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IChatService private readonly _chatService: IChatService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalChatService private readonly _terminalChatService: ITerminalChatService,
		@ITerminalSandboxService private readonly _terminalSandboxService: ITerminalSandboxService,
		@IMcpService private readonly _mcpService: IMcpService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IProductService private readonly _productService: IProductService,
		@IChipOSWorkerPermissionService private readonly _workerPermissionService: IChipOSWorkerPermissionService,
		@IChipOSConfirmRetireService private readonly _confirmRetireService: IChipOSConfirmRetireService,
		@IEditorService private readonly _editorService: IEditorService,
		@IChiposPromptInputsService private readonly _promptInputsService: IChiposPromptInputsService,
		@IChiposHookLogService private readonly _hookLogService: IChiposHookLogService,
	) {
		super();
		// T6b IDE FullTracer (ADR-009 §4.2) — buffers IDE-side trace events per
		// chat round and POSTs to reasoner /v1/trace/upload at TaskComplete.
		this._statelessObs = this._instantiationService.createInstance(StatelessObservability);
		this._register(this._chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResource) {
				this._disposeRuntime(sessionResource);
			}
		}));

		// R62: 监听 MCP 工具列表变更 → 通知 Reasoner
		this._register(autorun(reader => {
			const servers = this._mcpService.servers.read(reader);
			// 读取每个 server 的 tools 以建立依赖追踪
			for (const server of servers) {
				server.tools.read(reader);
			}
			// 当 servers 或任何 server 的 tools 变化时，重新上报
			this._onMcpToolsChanged();
		}));

		// WORKER-PERMISSION-ASK-TRANSPORT: subscribe once to worker→IDE SSE
		// asks. When a permission ASK arrives we look up the matching session
		// runtime by backendSessionId, and either fire it through the active
		// progress callback (if invoke() is mid-flight) or queue it to be
		// flushed on the next invoke. The actual subscription is per-session
		// and opened in `_setSessionBackendId` once we know the sessionId.
		this._register(this._workerPermissionService.onAsk(ask => this._onWorkerPermissionAsk(ask)));

		// PHASE-1 §2.9 (ADR-018 §2 D10 / R-D) IDE-restart auto-resume: when a chat
		// model is created — including the lazy restore of a persisted thread on
		// startup — probe the reasoner for an in-flight turn that was cut off by
		// the reload. The framework force-cancels a restored in-flight response
		// (chatModel coerces Pending→Cancelled on (de)serialize), so we cannot
		// append into the original row; instead we surface a notification whose
		// "继续" click drives a /resume into a fresh render. See
		// `_maybeProbeInFlightTurn`.
		this._register(this._chatService.onDidCreateModel(model => {
			void this._maybeProbeInFlightTurn(model).catch(err => {
				this._logService.warn('[ChipOS Stateless] in-flight turn probe failed:', String(err));
			});
		}));
		// Cover any thread already restored before this listener was wired
		// (dedup in `_maybeProbeInFlightTurn` makes the double-cover harmless).
		for (const model of this._chatService.chatModels.get()) {
			void this._maybeProbeInFlightTurn(model).catch(err => {
				this._logService.warn('[ChipOS Stateless] in-flight turn probe failed:', String(err));
			});
		}

		// 2026-05-26: carousel subscription removed (see _pendingCarousels
		// removal comment above). agent_ask now uses option-as-buttons via
		// reasoner ed5cd46b + standard sendConfirmResponse handler.

		// PERMISSION-DECOUPLE: a stateless permission card cannot resolve via the
		// chat re-entry (sendRequest) path while its originating invoke() is
		// still in-flight — the chat session is busy, so the click's sendRequest
		// is rejected and the parked confirm Promise never resolves (verified:
		// renderer.log shows no "confirm response" on click; only the 600s
		// timeout POSTs). So the card resolves DIRECTLY through this command,
		// which fulfils the parked Promise in-process; _handleStatelessConfirm-
		// Request then POSTs /confirm_response (the proven timeout path).
		this._register(CommandsRegistry.registerCommand(
			'_chipos.resolveStatelessConfirm',
			(_accessor, requestId: string, action: string, selections?: Record<string, string>, comment?: string) =>
				this._resolveStatelessConfirm(requestId, action, selections, comment),
		));

		// ADR-018 resume-from-break: the error card's PRIMARY "继续 (从中断处)" button
		// fires this with the failed turn's resume context. We CONTINUE the turn from
		// its last checkpoint (POST /resume) instead of re-running the whole prompt.
		// Mirrors the IDE-restart notification path: a fresh chat row is the only
		// render target available (see `_resumeStatelessTurn` section header), so we
		// route through sendRequest rather than calling `_resumeStatelessTurn` directly.
		this._register(CommandsRegistry.registerCommand(
			'_chipos.resumeStatelessTurn',
			(_accessor, ctx: { chatSessionId: string; traceId: string; lastSequenceId: number }) =>
				this._resumeStatelessTurnFromCard(ctx),
		));

		// [ChipOS][F-4 redesign] Inline next-step card: each chip is a non-blocking
		// IChatCommandButton whose click fires this command to send the (full) step
		// text as a fresh user turn — the in-conversation replacement for the native
		// followups that float above the input box.
		this._register(CommandsRegistry.registerCommand(
			'chipos.chat.sendFollowup',
			(_accessor, sessionResource: UriComponents | URI, text: string) =>
				this._sendFollowupTurn(URI.revive(sessionResource), text),
		));
	}

	/**
	 * Resolve a parked stateless confirm Promise (see
	 * `_handleStatelessConfirmRequest`). Called by the `_chipos.resolveStateless-
	 * Confirm` command when the user clicks a permission-card button, bypassing
	 * the chat re-entry path that deadlocks while the originating turn is
	 * in-flight. Returns true if a pending confirm matched.
	 */
	private _resolveStatelessConfirm(requestId: string, action: string, selections?: Record<string, string>, comment?: string): boolean {
		const pending = this._pendingStatelessConfirms.get(requestId);
		if (!pending) {
			this._logService.warn('[ChipOS Stateless] resolve: no pending confirm for request_id=%s', requestId);
			return false;
		}
		this._logService.info(
			'[ChipOS Stateless] confirm resolved via card click: trace=%s request_id=%s action=%s comment=%s',
			pending.traceId, requestId, action, comment ? '<note>' : '<none>',
		);
		// P1-4: forward the user's free-form note — `_handleStatelessConfirmRequest`
		// already POSTs `result.comment` to /confirm_response, so threading it here
		// is the only missing link.
		pending.resolve({ action, selections, comment });
		this._pendingStatelessConfirms.delete(requestId);
		return true;
	}

	/**
	 * ADR-018 resume-from-break — handler for the error card's "继续 (从中断处)"
	 * button. The card carries only {chatSessionId, traceId, lastSequenceId}; we
	 * reverse-map chat_session_id → sessionResource (the click has no session
	 * context of its own) and drive a fresh chat row via `_sendStatelessResume-
	 * Request`. The continuation streams into the new row from `lastSequenceId`,
	 * preserving the prior (failed) row's already-rendered output.
	 */
	private async _resumeStatelessTurnFromCard(ctx: { chatSessionId: string; traceId: string; lastSequenceId: number }): Promise<boolean> {
		if (!ctx?.chatSessionId || !ctx.traceId) {
			this._logService.warn('[ChipOS Stateless] resume-from-card: missing context %s', JSON.stringify(ctx));
			return false;
		}
		let sessionResource: URI | undefined;
		for (const [resource, csId] of this._statelessChatSessionIds) {
			if (csId === ctx.chatSessionId) {
				sessionResource = resource;
				break;
			}
		}
		if (!sessionResource) {
			// Session disposed, or history restored after an IDE restart before any
			// invoke re-seeded the id map — there is no live render target. Returning
			// false lets the error card fall back to resend instead of dead-ending.
			this._logService.warn('[ChipOS Stateless] resume-from-card: no live session for cs=%s — caller should resend', ctx.chatSessionId);
			return false;
		}
		this._logService.info('[ChipOS Stateless] resume-from-card: trace=%s cs=%s from seq=%d', ctx.traceId, ctx.chatSessionId, ctx.lastSequenceId);
		return this._sendStatelessResumeRequest(sessionResource, ctx);
	}

	/**
	 * Issue the synthetic sendRequest that re-enters invoke() carrying a resume
	 * marker, so invoke() routes to `_resumeStatelessTurn` (which needs invoke()'s
	 * render target — see its section header). Shared by the IDE-restart
	 * notification ("继续生成") and the error-card "继续 (从中断处)" button.
	 */
	private async _sendStatelessResumeRequest(sessionResource: URI, ctx: { traceId: string; chatSessionId: string; lastSequenceId: number }): Promise<boolean> {
		const label = localize('chipos.stateless.resume.continueLabel', "继续生成");
		const resumeData = {
			__chiposStatelessResumeTraceId: ctx.traceId,
			__chiposStatelessResumeCsId: ctx.chatSessionId,
			__chiposStatelessResumeLastSeq: ctx.lastSequenceId,
		};
		try {
			const result = await this._chatService.sendRequest(sessionResource, label, {
				// Route to ChipOS without injecting an "@" mention; mark it as a
				// confirmation reply so the conversation assembler skips this
				// synthetic prompt on future invokes (chatModelAdapter §101).
				agentIdSilent: 'chipos.chat',
				confirmation: label,
				acceptedConfirmationData: [resumeData],
			});
			if (result.kind !== 'sent') {
				// The chat session is busy (another turn is in flight) — sendRequest
				// is rejected. Report so the caller can fall back to resend.
				this._logService.warn('[ChipOS Stateless] resume sendRequest not sent: %s', JSON.stringify(result));
				return false;
			}
			return true;
		} catch (err) {
			this._logService.error('[ChipOS Stateless] resume sendRequest failed:', String(err));
			return false;
		}
	}

	/**
	 * [ChipOS][F-4 redesign] Send a clicked next-step chip as a fresh user turn.
	 * Routed to ChipOS without an "@" mention (like a typed message). Fired by the
	 * inline `chipos.chat.sendFollowup` command button (see `_buildFollowupsCard`).
	 */
	private async _sendFollowupTurn(sessionResource: URI, text: string): Promise<void> {
		const step = typeof text === 'string' ? text.trim() : '';
		if (!step) {
			return;
		}
		try {
			const result = await this._chatService.sendRequest(sessionResource, step, {
				agentIdSilent: 'chipos.chat',
			});
			if (result.kind !== 'sent') {
				this._logService.warn('[ChipOS][followup] sendRequest not sent: %s', JSON.stringify(result));
			}
		} catch (err) {
			this._logService.error('[ChipOS][followup] sendRequest failed:', String(err));
		}
	}

	/**
	 * Build the structured error card for a terminal stateless-invoke failure
	 * (GAP-1: replaces plain-markdown surfacing so a button always appears).
	 * `retryable` is always true → the card shows at least a Retry (resend)
	 * button; when `resumable`, `resumeContext` upgrades the primary action to
	 * continue-from-break (POST /resume), preserving already-rendered output.
	 */
	private _statelessFailureCard(args: {
		errorCode: string;
		message: string;
		resumable: boolean;
		chatSessionId: string;
		traceId: string;
		lastSequenceId: number;
	}): IChatAgentError {
		return {
			kind: 'agentError',
			error_code: args.errorCode,
			message: args.message,
			retryable: true,
			suggestion: args.resumable
				? localize('chipos.stateless.fail.continueHint', "可从中断处继续，已生成的内容会保留。")
				: localize('chipos.stateless.fail.resendHint', "请重新发送上一条消息。"),
			resumeContext: args.resumable
				? { chatSessionId: args.chatSessionId, traceId: args.traceId, lastSequenceId: args.lastSequenceId }
				: undefined,
		} satisfies IChatAgentError;
	}

	// ── R62: MCP 工具变更通知 ──────────────────────────────────────────────


	private _onMcpToolsChanged(): void {
		// R-C (PHASE-1-IMPLEMENTATION-AUDIT §13.3): invalidate the Phase 1
		// catalog fingerprint cache so the NEXT _ensureToolsRegistered call
		// re-computes the tool list and re-POSTs /tools/register. Without
		// this the optimisation cache would short-circuit even after the
		// user installed a new MCP server, and the LLM wouldn't see the
		// new tools until the IDE restarted.
		// Done synchronously (not behind the 1s debounce) so a chat fired
		// immediately after an MCP install never sees a stale fingerprint.
		this._statelessCatalogFingerprints.clear();
		this._statelessCatalogVersions.clear();
	}



	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		// Phase 1 reverse-channel confirm-click detector: when a user clicks a
		// confirm card emitted by an in-flight stateless turn, the framework
		// re-invokes invoke() with `acceptedConfirmationData` carrying our
		// `__chiposStatelessConfirmTraceId` marker. Route the click to the
		// parked Promise (in `_pendingStatelessConfirms`) WITHOUT starting a
		// new turn — the original invoke's SSE iteration is still draining
		// events on the original trace, and will surface the LLM's continued
		// reasoning naturally. This runs regardless of the feature flag (a
		// stale Phase 1 confirm card from a session where the flag was on
		// should still resolve cleanly even after the user toggles it off).
		const accepted = request.acceptedConfirmationData?.[0] as
			{ __chiposStatelessConfirmRequestId?: string; __chiposStatelessConfirmTraceId?: string;
			  options?: Array<{ label: string; action_id: string }>; selections?: Record<string, string> }
			| undefined;
		const rejected = request.rejectedConfirmationData?.[0] as
			{ __chiposStatelessConfirmRequestId?: string; __chiposStatelessConfirmTraceId?: string;
			  options?: Array<{ label: string; action_id: string }> }
			| undefined;
		const statelessConfirmData = accepted?.__chiposStatelessConfirmRequestId
			? accepted
			: rejected?.__chiposStatelessConfirmRequestId
				? rejected
				: undefined;
		if (statelessConfirmData) {
			const requestId = statelessConfirmData.__chiposStatelessConfirmRequestId!;
			const pending = this._pendingStatelessConfirms.get(requestId);
			if (pending) {
				// Derive action from clicked button label vs options.
				let action = accepted ? 'approve' : 'reject';
				const opts = statelessConfirmData.options;
				if (opts && opts.length > 0) {
					const msgLabel = request.message.split(':')[0]?.trim();
					const matched = opts.find(o => o.label === msgLabel);
					if (matched) {
						action = matched.action_id;
					}
				}
				this._logService.info(
					'[ChipOS Stateless] confirm response: trace=%s request_id=%s action=%s',
					pending.traceId, requestId, action,
				);
				pending.resolve({
					action,
					selections: (statelessConfirmData as { selections?: Record<string, string> }).selections,
					comment: undefined,
				});
				this._pendingStatelessConfirms.delete(requestId);
				// Return an empty result; the original invoke is still in
				// flight + will deliver the final assistant message via its
				// own progress callback.
				return {};
			}
			// No matching pending Promise — stale click (e.g. user clicked
			// after timeout fired auto-skip). Log + fall through to legacy
			// behaviour so the framework gets a clean result rather than
			// hanging.
			this._logService.warn(
				'[ChipOS Stateless] stale confirm click (no pending Promise): request_id=%s',
				requestId,
			);
			return { errorDetails: { message: 'confirm card already responded' } };
		}

		// PHASE-1 §2.9 IDE-restart resume: the startup notification's "继续" click
		// re-enters here via sendRequest carrying our resume marker (mirrors the
		// confirm-card round-trip above). Route to the resume path so we CONTINUE
		// the in-flight turn (/resume) instead of starting a fresh /invoke.
		const resumeMarker = request.acceptedConfirmationData?.[0] as
			{ __chiposStatelessResumeTraceId?: string; __chiposStatelessResumeCsId?: string; __chiposStatelessResumeLastSeq?: number }
			| undefined;
		if (resumeMarker?.__chiposStatelessResumeTraceId && resumeMarker.__chiposStatelessResumeCsId) {
			return this._resumeStatelessTurn(request, progress, token, {
				traceId: resumeMarker.__chiposStatelessResumeTraceId,
				chatSessionId: resumeMarker.__chiposStatelessResumeCsId,
				lastSequenceId: typeof resumeMarker.__chiposStatelessResumeLastSeq === 'number' ? resumeMarker.__chiposStatelessResumeLastSeq : -1,
			});
		}

		return this._invokeStateless(request, progress, _history, token);
	}

	/**
	 * [ChipOS][F-4] Surface the turn's next-step suggestion(s) as native clickable
	 * reply chips below the response. The reasoner emits them on
	 * `round_end.final_result.followups` (the mandated `建议下一步: …` line);
	 * `_invokeStateless` stashes them on the result metadata. One click re-sends the
	 * step as the next turn (native `IChatFollowup` behaviour) — no typing needed.
	 */
	async provideFollowups(_request: IChatAgentRequest, _result: IChatAgentResult, _history: IChatAgentHistoryEntry[], _token: CancellationToken): Promise<IChatFollowup[]> {
		// [ChipOS][F-4 redesign] Next-step suggestions now render as an INLINE
		// command-button card under the reply (see `_buildFollowupsCard`), NOT as
		// native chips floating above the input box. Returning none disables the
		// float so the inline card is the single surface.
		return [];
	}

	// ── FEAT-24: Extract #file/#selection references into IMentionItem[] ──

	private _extractMentions(request: IChatAgentRequest): IMentionItem[] {
		const entries = request.variables?.variables;
		if (!entries || entries.length === 0) {
			return [];
		}

		const mentions: IMentionItem[] = [];
		for (const entry of entries) {
			if (entry.kind === 'file' || entry.kind === 'directory') {
				const uri = entry.value instanceof URI ? entry.value :
					(typeof entry.value === 'object' && entry.value !== null && 'scheme' in entry.value)
						? URI.revive(entry.value as unknown as URI)
						: undefined;
				if (uri) {
					mentions.push({
						path: uri.fsPath,
						type: entry.kind === 'directory' ? 'folder' : 'file',
						displayName: entry.name,
					});
				}
			} else if (entry.kind === 'implicit') {
				const uri = entry.value instanceof URI ? entry.value :
					(typeof entry.value === 'object' && entry.value !== null && 'scheme' in entry.value)
						? URI.revive(entry.value as unknown as URI)
						: undefined;
				if (uri) {
					mentions.push({
						path: uri.fsPath,
						type: 'file',
						displayName: entry.name,
						content: entry.modelDescription,
					});
				}
			} else if (typeof entry.value === 'string' && entry.value.length > 0) {
				mentions.push({
					path: entry.name,
					type: 'snippet',
					displayName: entry.name,
					content: entry.value,
				});
			}
		}

		if (mentions.length > 0) {
			this._logService.info('[ChipOS Agent] Extracted mentions:', mentions.map(m => `${m.type}:${m.path}`).join(', '));
		}
		return mentions;
	}







	/**
	 * Stateless confirm `card_type`s that have a dedicated rich body `case` in
	 * `_renderConfirmMessage` (the labels in the switch below). Only these opt
	 * into rich rendering in the stateless confirm path
	 * (`_handleStatelessConfirmRequest`): the renderer's `default` branch
	 * JSON-dumps `card_data`, which would regress generic stateless cards
	 * (`chipos_user_confirm` / ad-hoc labels) whose body is plain `message`.
	 */
	private static readonly _RICH_STATELESS_CARD_TYPES = new Set<string>([
		'spec_confirm', 'arch_confirm', 'hook_confirm', 'file_edit', 'agent_ask',
		'VERIFICATION_GROUP_REVIEW', 'VERIFICATION_HUMAN_CHECK',
		'sim_report', 'lint_report', 'coverage_report',
		// P1-5: parallel-generate worktree review — render per-track rich diff
		// instead of the default JSON dump / bare title.
		'worktree_apply',
	]);

	// ── FEAT-29: Render rich confirm message based on card_type ──
	//
	// 2026-05-26: dropped `private` → `static` so unit tests in
	// test/browser/ can call it without instantiating the full
	// ChipOSChatAgent (which needs IChatService / IConfigurationService /
	// a dozen DI deps). The function is pure (no `this.*` references),
	// so the static switch is a no-op for runtime behavior.
	//
	// Header chip de-duplication invariants enforced inside (verified by
	// tests/browser/confirmMessageDedup.test.ts):
	//   - file_edit: body skips `**File:** ${file_path}` line (header chip
	//     already shows file_path via _cardSpecifier)
	//   - VERIFICATION_HUMAN_CHECK: body skips `**Stage:** ${stage}` line
	//     (header chip already shows stage)
	static _renderConfirmMessage(p: IConfirmRequestPayload): string {
		const data = p.card_data;
		switch (p.card_type) {
			case 'spec_confirm': {
				const specText = data?.spec_result ?? data?.analysis ?? data?.result;
				if (typeof specText === 'string' && specText.length > 0) {
					return specText;
				}
				if (p.message) { return p.message; }
				if (data?.summary) { return String(data.summary); }
				return 'Spec analysis complete. Review and approve to continue.';
			}

			case 'arch_confirm': {
				const archText = data?.arch_result ?? data?.analysis ?? data?.result;
				if (typeof archText === 'string' && archText.length > 0) {
					return archText;
				}
				if (p.message) { return p.message; }
				if (data?.summary) { return String(data.summary); }
				return 'Architecture analysis complete. Review and approve to continue.';
			}

			case 'hook_confirm': {
				const sections: string[] = [];
				if (data.hook_name) { sections.push(`**Hook:** \`${data.hook_name}\``); }
				if (data.description) { sections.push(`${data.description}`); }
				if (data.impact) { sections.push(`**Impact:** ${data.impact}`); }
				if (data.command) { sections.push(`**Command:** \`${data.command}\``); }
				return sections.length > 0 ? sections.join('\n\n') : JSON.stringify(data, null, 2).slice(0, 500);
			}

			case 'file_edit': {
				// 2026-05-26: don't repeat file_path in the body — the header
				// chip already shows it (via _cardSpecifier picking
				// `file_path`). Body shows the description + diff only.
				const sections: string[] = [];
				if (data.description) { sections.push(`${data.description}`); }
				if (data.diff && typeof data.diff === 'string') {
					const diffPreview = (data.diff as string).slice(0, 300);
					sections.push(`\`\`\`diff\n${diffPreview}\n\`\`\``);
				}
				return sections.length > 0 ? sections.join('\n\n') : JSON.stringify(data, null, 2).slice(0, 500);
			}

			case 'agent_ask': {
				// 2026-05-26: previously only read data.context, silently dropping
				// data.questions[] which reasoner agent_core.analyze_requirement_
				// completeness sends as a list of {question_id, prompt, options}
				// items (e.g. AXI data width, FIFO depth, protocol scope). Users
				// saw only the bare "在开始之前，我需要确认几个设计参数:" label
				// with no idea what was actually being asked. Now render the
				// questions as a numbered list with their options as bullets so
				// the user can see the inquiry surface even when they only have
				// "确认 / 跳过" coarse-grained buttons.
				const context = (data.context as string) ?? '';
				const questions = Array.isArray((data as { questions?: unknown }).questions)
					? (data as { questions: Array<{ prompt?: string; options?: Array<{ label?: string; action_id?: string }> }> }).questions
					: undefined;

				if (!questions || questions.length === 0) {
					return context || 'Please select an option.';
				}

				const lines: string[] = [];
				if (context) {
					lines.push(context);
					lines.push('');
				}
				questions.forEach((q, idx) => {
					const prompt = (q.prompt ?? '').trim() || `问题 ${idx + 1}`;
					lines.push(`${idx + 1}. **${prompt}**`);
					if (Array.isArray(q.options) && q.options.length > 0) {
						for (const opt of q.options) {
							const label = (opt.label ?? opt.action_id ?? '').trim();
							if (label) {
								lines.push(`   - ${label}`);
							}
						}
					}
					lines.push('');
				});
				return lines.join('\n').trimEnd();
			}

			// FEAT-X.1.3 — verification_pipeline group review (H14/H15/H16/H17).
			// `card_data` = { stage_group: "A"|"B"|"C"|"D", state_summary: {...} }.
			// stage_group → human-readable group name (matches the V-prefix
			// labels from verification_pipeline.py: A=Spec, B=Coverage Model,
			// C=Sim Validation, D=Coverage Boost & Summary).
			case 'VERIFICATION_GROUP_REVIEW': {
				const sections: string[] = [];
				const groupNames: Record<string, string> = {
					A: 'Spec Analysis (V1–V3.5)',
					B: 'Coverage Model (V3–V4.5)',
					C: 'Sim Validation (V5a–V6.5)',
					D: 'Coverage Boost & Summary (V7–V8)',
				};
				const stageGroup = data['stage_group'] as string | undefined;
				if (stageGroup) {
					sections.push(`**Stage Group:** ${groupNames[stageGroup] ?? stageGroup}`);
				}
				const summary = data['state_summary'];
				if (summary && typeof summary === 'object') {
					try {
						sections.push('```json\n' + JSON.stringify(summary, null, 2).slice(0, 800) + '\n```');
					} catch {
						sections.push(String(summary).slice(0, 500));
					}
				} else if (typeof summary === 'string' && summary.length > 0) {
					sections.push(summary.slice(0, 800));
				}
				if (p.message) { sections.push(p.message); }
				return sections.length > 0 ? sections.join('\n\n') : 'Review the stage group results and approve or revise.';
			}

			// FEAT-X.1.3 — verification_pipeline per-stage human check.
			// `card_data` = { stage: <name>, results: [<CheckResult>, ...] }.
			// Renders a compact one-row-per-checker summary so reviewers can
			// see at a glance which checker(s) escalated to human.
			case 'VERIFICATION_HUMAN_CHECK': {
				// 2026-05-26: don't repeat the stage name in the body — the
				// header chip already shows it (via _cardSpecifier picking
				// `stage`). Body just lists the checker results.
				const sections: string[] = [];
				const results = Array.isArray(data['results']) ? data['results'] as Array<Record<string, unknown>> : [];
				if (results.length > 0) {
					sections.push('', '| Checker | Status | Message |', '|---|---|---|');
					for (const r of results.slice(0, 20)) {
						const name = String(r['name'] ?? r['checker'] ?? '—');
						const status = String(r['status'] ?? r['outcome'] ?? '—');
						const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⚠';
						const msg = String(r['message'] ?? r['detail'] ?? '').slice(0, 120).replace(/\|/g, '\\|').replace(/\n/g, ' ');
						sections.push(`| ${name} | ${icon} ${status} | ${msg} |`);
					}
					if (results.length > 20) {
						sections.push('', `_(${results.length - 20} more checker(s) elided)_`);
					}
				}
				if (p.message) { sections.push(p.message); }
				return sections.length > 0 ? sections.join('\n') : 'A checker has requested human review.';
			}

			// ── ChipOS UI polish: render EDA report payloads as markdown tables ──
			// Schemas come from eventStream/eventTypes.ts (ISimReportPayload / ILintReportPayload /
			// ICoverageReportPayload). Each block is defensive about missing fields so a slightly
			// off payload still degrades gracefully to the default JSON pretty-print below.
			case 'sim_report': {
				const tests = Array.isArray(data?.tests) ? data.tests as Array<{ name?: string; status?: string; message?: string; duration_ms?: number }> : [];
				const summary = data?.summary as { total?: number; passed?: number; failed?: number; errors?: number } | undefined;
				const lines: string[] = [];
				if (summary) {
					const failedSeg = summary.failed ? `, ${summary.failed} failed` : '';
					const errorSeg = summary.errors ? `, ${summary.errors} errors` : '';
					lines.push(`**Summary:** ${summary.passed ?? 0} / ${summary.total ?? tests.length} passed${failedSeg}${errorSeg}`);
				}
				if (tests.length > 0) {
					lines.push('', '| Test | Status | Duration |', '|---|---|---|');
					for (const t of tests.slice(0, 50)) {
						const icon = t.status === 'pass' ? '✓' : t.status === 'fail' ? '✗' : '⚠';
						const dur = typeof t.duration_ms === 'number' ? `${t.duration_ms}ms` : '-';
						lines.push(`| ${t.name ?? '-'} | ${icon} ${t.status ?? '-'} | ${dur} |`);
					}
					if (tests.length > 50) {
						lines.push(`| _… ${tests.length - 50} more …_ | | |`);
					}
				}
				return lines.length > 0 ? lines.join('\n') : (p.message ?? 'Simulation complete.');
			}

			case 'lint_report': {
				const errors = Array.isArray(data?.errors) ? data.errors as Array<{ file?: string; line?: number; col?: number; severity?: string; message?: string; rule?: string }> : [];
				const tool = data?.tool ? String(data.tool) : 'lint';
				const autoFixable = data?.auto_fixable;
				const lines: string[] = [];
				const fixableSeg = typeof autoFixable === 'number' ? ` ｜ **Auto-fixable:** ${autoFixable}` : '';
				lines.push(`**Tool:** ${tool} ｜ **Errors:** ${errors.length}${fixableSeg}`);
				if (errors.length > 0) {
					lines.push('', '| File | Line | Severity | Message |', '|---|---|---|---|');
					for (const e of errors.slice(0, 30)) {
						const msg = (e.message ?? '').replace(/\|/g, '\\|').slice(0, 120);
						lines.push(`| \`${e.file ?? '-'}\` | ${e.line ?? '-'} | ${e.severity ?? '-'} | ${msg} |`);
					}
					if (errors.length > 30) {
						lines.push(`| _… ${errors.length - 30} more …_ | | | |`);
					}
				}
				return lines.join('\n');
			}

			case 'coverage_report': {
				const lineCov = typeof data?.line_cov === 'number' ? data.line_cov : undefined;
				const branchCov = typeof data?.branch_cov === 'number' ? data.branch_cov : undefined;
				const gaps = Array.isArray(data?.gaps) ? data.gaps as Array<{ file?: string; lines?: string; type?: string }> : [];
				const lines: string[] = [];
				if (typeof lineCov === 'number') { lines.push(`**Line Coverage:** ${(lineCov * 100).toFixed(1)}%`); }
				if (typeof branchCov === 'number') { lines.push(`**Branch Coverage:** ${(branchCov * 100).toFixed(1)}%`); }
				if (gaps.length > 0) {
					lines.push('', '**Uncovered:**', '', '| File | Lines | Type |', '|---|---|---|');
					for (const g of gaps.slice(0, 30)) {
						lines.push(`| \`${g.file ?? '-'}\` | ${g.lines ?? '-'} | ${g.type ?? '-'} |`);
					}
				}
				return lines.length > 0 ? lines.join('\n') : (p.message ?? 'Coverage report.');
			}

			// P1-5 (IDE-MIGRATION-GAPS §1.5) — parallel-generate worktree review.
			// card_data (parallel_generate.py:332) = { module_name, tracks: [{ name,
			// branch, files:[{path,action,additions,deletions}], diff_text, additions,
			// deletions, error }] }. Render each track with its branch, ± stats,
			// changed-file list and a colored unified diff so the reviewer can judge
			// what to apply — instead of the default JSON dump (the card carries no
			// `message`, so without this it showed only a bare title + buttons).
			// (`<details>` collapse isn't available — the chat markdown sanitizer
			// strips raw HTML — but the preview slot is height-capped + scrollable.)
			case 'worktree_apply': {
				const tracks = Array.isArray(data?.tracks) ? data.tracks as Array<Record<string, unknown>> : [];
				const sections: string[] = [];
				const moduleName = typeof data?.module_name === 'string' ? data.module_name : undefined;
				if (moduleName) { sections.push(`**Module:** \`${moduleName}\``); }
				if (tracks.length === 0) {
					return sections.length > 0 ? sections.join('\n\n') : (p.message ?? 'Review the parallel results and choose what to apply.');
				}
				for (const t of tracks) {
					const name = typeof t.name === 'string' && t.name ? t.name : 'Track';
					const branch = typeof t.branch === 'string' ? t.branch : '';
					const add = typeof t.additions === 'number' ? t.additions : 0;
					const del = typeof t.deletions === 'number' ? t.deletions : 0;
					const error = typeof t.error === 'string' ? t.error : '';
					const branchSeg = branch ? ` · \`${branch}\`` : '';
					const statSeg = error ? ' · ✗ failed' : ` · +${add} / -${del}`;
					sections.push(`#### ${name}${branchSeg}${statSeg}`);
					if (error) {
						sections.push(`> ⚠ ${error.replace(/\n/g, ' ').slice(0, 300)}`);
						continue;
					}
					const files = Array.isArray(t.files) ? t.files as Array<Record<string, unknown>> : [];
					if (files.length > 0) {
						const fileLines = files.slice(0, 20).map(f => {
							const path = typeof f.path === 'string' ? f.path : '';
							const actionRaw = typeof f.action === 'string' ? f.action : '';
							const actionIcon = actionRaw === 'A' ? '＋' : actionRaw === 'D' ? '－' : '∼';
							const fa = typeof f.additions === 'number' ? f.additions : undefined;
							const fd = typeof f.deletions === 'number' ? f.deletions : undefined;
							const perFile = (fa !== undefined || fd !== undefined) ? ` (+${fa ?? 0} / -${fd ?? 0})` : '';
							return `- ${actionIcon} \`${path}\`${perFile}`;
						});
						sections.push(fileLines.join('\n'));
						if (files.length > 20) { sections.push(`_… ${files.length - 20} more file(s) …_`); }
					}
					const diffText = typeof t.diff_text === 'string' ? t.diff_text : '';
					if (diffText.trim().length > 0) {
						const clipped = diffText.length > 4000 ? diffText.slice(0, 4000) + '\n... [truncated]' : diffText;
						sections.push('```diff\n' + clipped + '\n```');
					}
				}
				return sections.join('\n\n');
			}

			default:
				return JSON.stringify(data, null, 2).slice(0, 500);
		}
	}

	// ── FEAT-26: Friendly tool name mapping (used by IChatExternalToolInvocationUpdate) ──

	private static readonly _toolNameMap: Record<string, string> = {
		run_simulation: '执行仿真',
		run_sim: '执行仿真',
		run_lint: '代码检查',
		read_file: '读取文件',
		read_skill_body: '加载技能',
		read_rule_body: '加载规则',
		write_file: '写入文件',
		edit_file: '编辑文件',
		file_edit: '编辑文件',
		list_directory: '列出目录',
		list_dir: '列出目录',
		ls: '列出目录',
		search_files: '搜索文件',
		glob: '搜索文件',
		grep_search: '文本搜索',
		semantic_search: '语义搜索',
		run_command: '执行命令',
		shell_command: '执行命令',
		create_file: '创建文件',
		delete_file: '删除文件',
		get_coverage: '检查覆盖率',
		check_coverage: '检查覆盖率',
		apply_diff: '应用差异',
		str_replace: '替换文本',
		generate_rtl: '生成 RTL',
		generate_testbench: '生成测试平台',
		analyze_waveform: '分析波形',
		cdc_check: 'CDC 检查',
		read_lints: '读取诊断',
		ask_user: '询问用户',
		task: '子代理执行',
		transfer_to_agent: '代理切换',
		write_todos: '更新计划',
		web_search: '网络搜索',
		web_fetch: '网页获取',
		code_execution: '代码执行',
		// EDA worker tools + common aliases the master calls directly — without
		// these the row falls back to title-cased English ("Grep" / "Verilog Lint").
		grep: '文本搜索',
		verilog_lint: '代码检查',
		lint: '代码检查',
		verilog_syntax_check: '语法检查',
		check_syntax: '语法检查',
		verilog_simulate: '运行仿真',
		verilog_format: '格式化',
		format: '格式化',
		yosys_synthesis: '逻辑综合',
		yosys_qor: 'QoR 分析',
		rtl_ppa_scan: 'PPA 扫描',
		power_analysis: '功耗分析',
		equiv_check: '等价性检查',
		formal_equiv_check: '形式等价检查',
		fpga_synthesize: 'FPGA 综合',
		vcd_info: '波形信息',
		vcd_signals: '波形信号',
		vcd_waveform: '波形分析',
		execute: '执行命令',
		execute_command: '执行命令',
		run_in_terminal: '执行命令',
		get_terminal_output: '读取终端输出',
		query_verification_guide: '查阅验证指南',
		calculate: '计算',
	};

	private _friendlyToolName(toolName: string): string {
		return ChipOSChatAgent._toolNameMap[toolName] || toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	/**
	 * Format rawInput for tool call display.
	 * For tools like 'task' (subagent), convert JSON to readable text.
	 * For others, pass through as-is.
	 */
	private static readonly _fileWriteTools = new Set([
		'write_file', 'create_file', 'edit_file', 'str_replace', 'apply_diff',
	]);

	private static _isFileWriteTool(toolName: string): boolean {
		return ChipOSChatAgent._fileWriteTools.has(toolName);
	}

	private static readonly _shellTools = new Set([
		'run_in_terminal', 'execute_command', 'execute',
	]);

	private static _isShellTool(toolName: string): boolean {
		return ChipOSChatAgent._shellTools.has(toolName);
	}

	/**
	 * Best-effort extraction of the shell command from a tool's parsed args.
	 * The master's `execute` uses `command`; other shells use `cmd` /
	 * `command_line` / `commandLine` / `script`. Returns '' when none is present.
	 */
	private static _extractShellCommand(args: Record<string, unknown> | undefined): string {
		if (!args) { return ''; }
		const raw = args.command ?? args.cmd ?? args.command_line ?? args.commandLine ?? args.script;
		return typeof raw === 'string' ? raw : '';
	}

	/**
	 * P2-1: resolve a tool's file argument to an ABSOLUTE workspace path so the
	 * tool-row's object chip can be a clickable `vscode.open` link. Mirrors the
	 * path keys `_formatToolArgs` recognises (path / file_path / rtl_path) plus
	 * the common file/file_name aliases. Returns undefined when there's no path
	 * arg or no workspace to resolve a relative one against.
	 */
	private _resolveToolFileLink(input: Record<string, unknown> | undefined): string | undefined {
		if (!input) { return undefined; }
		const raw = input.path ?? input.file_path ?? input.rtl_path ?? input.file ?? input.file_name;
		if (typeof raw !== 'string' || !raw) { return undefined; }
		if (raw.startsWith('/')) { return raw; }
		const root = this._getWorkspaceRoot();
		return root ? `${root.replace(/\/+$/, '')}/${raw}` : undefined;
	}

	/**
	 * Get the current editing session for a chat session resource.
	 */
	private _getEditingSession(sessionResource: URI): IChatEditingSession | undefined {
		return this._chatEditingService.getEditingSession(sessionResource);
	}

	/**
	 * Get the last response model for a chat session (the one currently being streamed).
	 */
	private _getResponseModel(sessionResource: URI): IChatResponseModel | undefined {
		const chatModel = this._chatService.getSession(sessionResource);
		if (!chatModel) { return undefined; }
		const lastRequest = chatModel.getRequests().at(-1);
		return lastRequest?.response ?? undefined;
	}




	/**
	 * Start tracking an external edit operation for a file-writing tool.
	 * Calls editingSession.startExternalEdits to snapshot the file before the backend writes it.
	 * Stores the promise so _stopExternalEdit can await it before calling stop.
	 */
	private _startExternalEdit(
		toolCallId: string,
		fileUri: URI,
		sessionResource: URI,
		requestId: string,
		runtime: IChatSessionRuntime,
		snapshotContent?: string,
	): void {
		// Filter out files in hidden directories (e.g. .chipos/, .git/, .vscode/)
		// Only check the path relative to workspace root, not the full absolute path
		const workspaceRoot = this._getWorkspaceRoot();
		const relativePath = workspaceRoot && fileUri.path.startsWith(workspaceRoot)
			? fileUri.path.slice(workspaceRoot.length + 1)
			: fileUri.path;
		const pathSegments = relativePath.split('/');
		if (pathSegments.some(seg => seg.startsWith('.') && seg.length > 1)) {
			this._logService.info(`[ChipOS Agent] _startExternalEdit SKIPPED (hidden dir): ${fileUri.path}, relativePath=${relativePath}`);
			return;
		}
		this._logService.info(`[ChipOS Agent] _startExternalEdit ENTER: toolCallId=${toolCallId}, fileUri=${fileUri.path}, hasSnapshotContent=${snapshotContent !== undefined}, snapshotLen=${snapshotContent?.length ?? 0}`);
		const editingSession = this._getEditingSession(sessionResource);
		const responseModel = this._getResponseModel(sessionResource);
		if (!editingSession || !responseModel) {
			this._logService.warn('[ChipOS Agent] Cannot start external edit: no editing session or response model');
			return;
		}
		const opId = ++this._externalEditOpCounter;
		runtime.externalEditOps.set(toolCallId, opId);

		// Build beforeSnapshots map if we have snapshot content from the backend
		let beforeSnapshots: ResourceMap<string> | undefined;
		if (snapshotContent !== undefined) {
			beforeSnapshots = new ResourceMap<string>();
			beforeSnapshots.set(fileUri, snapshotContent);
		}

		this._logService.info(`[ChipOS Agent] _startExternalEdit: calling editingSession.startExternalEdits opId=${opId}, file=${fileUri.path}, hasBeforeSnapshots=${!!beforeSnapshots}`);
		const startPromise = editingSession.startExternalEdits(responseModel, opId, [fileUri], requestId, beforeSnapshots).then(() => {
			this._logService.info(`[ChipOS Agent] startExternalEdits RESOLVED opId=${opId} for ${fileUri.path}`);
		}).catch(err => {
			this._logService.error(`[ChipOS Agent] startExternalEdits REJECTED for ${fileUri.path}`, err);
			runtime.externalEditOps.delete(toolCallId);
		});
		runtime.pendingStartEdits.set(toolCallId, startPromise);
	}

	/**
	 * Stop tracking an external edit operation. Awaits the pending startExternalEdits
	 * promise first, then calls editingSession.stopExternalEdits to compute the diff.
	 * Returns IChatProgress[] that should be pushed to the framework.
	 */
	private async _stopExternalEdit(
		toolCallId: string,
		sessionResource: URI,
		runtime: IChatSessionRuntime,
	): Promise<IChatProgress[]> {
		this._logService.info(`[ChipOS Agent] _stopExternalEdit ENTER: toolCallId=${toolCallId}`);
		// CRITICAL: wait for startExternalEdits to finish before calling stop
		const pending = runtime.pendingStartEdits.get(toolCallId);
		this._logService.info(`[ChipOS Agent] _stopExternalEdit: hasPending=${!!pending}, externalEditOps keys=[${[...runtime.externalEditOps.keys()].join(',')}], pendingStartEdits keys=[${[...runtime.pendingStartEdits.keys()].join(',')}]`);
		if (pending) {
			this._logService.info(`[ChipOS Agent] _stopExternalEdit: awaiting pending startExternalEdits for ${toolCallId}...`);
			await pending;
			this._logService.info(`[ChipOS Agent] _stopExternalEdit: pending startExternalEdits resolved for ${toolCallId}`);
			runtime.pendingStartEdits.delete(toolCallId);
		}

		const opId = runtime.externalEditOps.get(toolCallId);
		this._logService.info(`[ChipOS Agent] _stopExternalEdit: opId=${opId} for toolCallId=${toolCallId}`);
		if (opId === undefined) {
			this._logService.warn(`[ChipOS Agent] _stopExternalEdit: no opId found, returning empty. toolCallId=${toolCallId}`);
			return [];
		}
		runtime.externalEditOps.delete(toolCallId);

		const editingSession = this._getEditingSession(sessionResource);
		const responseModel = this._getResponseModel(sessionResource);
		this._logService.info(`[ChipOS Agent] _stopExternalEdit: hasEditingSession=${!!editingSession}, hasResponseModel=${!!responseModel}`);
		if (!editingSession || !responseModel) {
			this._logService.warn('[ChipOS Agent] Cannot stop external edit: no editing session or response model');
			return [];
		}
		try {
			this._logService.info(`[ChipOS Agent] _stopExternalEdit: calling editingSession.stopExternalEdits opId=${opId}...`);
			const result = await editingSession.stopExternalEdits(responseModel, opId);
			this._logService.info(`[ChipOS Agent] _stopExternalEdit: stopExternalEdits RESOLVED opId=${opId}, result.length=${result.length}`);
			for (const item of result) {
				this._logService.info(`[ChipOS Agent] _stopExternalEdit: progress item kind=${item.kind}`);
			}
			return result;
		} catch (err) {
			this._logService.error(`[ChipOS Agent] _stopExternalEdit: stopExternalEdits REJECTED opId=${opId}`, err);
			return [];
		}
	}

	/**
	 * [ChipOS] Fusion: render one stateless `subagent_event` frame into the
	 * native collapsible `ChatSubagentContentPart` card. The pure
	 * `computeSubagentToolUpdates` (see `subagentCard.ts`) owns the bookkeeping
	 * — parent-synthesized-once, FIFO child pairing — and returns the
	 * toolInvocation parts to emit; this method does the I/O: emit progress and,
	 * for file-write child tools, drive the editing session so the file diff
	 * renders inside the card (mirroring the agentic `SubagentEvent` handler).
	 */
	/**
	 * [ChipOS] Fusion (#6): render a single stateless tool_call / tool_result
	 * as a chat tool row (write_todos widget / sub-agent card / terminal card /
	 * generic row with clickable file link). Shared by the live invoke() loop
	 * AND the /resume loop so a turn resumed after an IDE restart renders tool
	 * activity identically (previously the resume path silently dropped it).
	 * Returns the normalized todo list when this was a write_todos start so the
	 * caller can graduate it into a permanent inline card at turn end.
	 */
	private _renderStatelessToolInvocation(
		ti: NonNullable<DispatchResult['toolInvocation']>,
		progress: (parts: IChatProgress[]) => void,
		request: IChatAgentRequest,
		toolInputs: Map<string, { toolName: string; rawInput: string; label?: IMarkdownString }>,
	): IChatTodo[] | undefined {
		if (!ti.isComplete) {
			// tool_call_emitted → start a collapsible invocation showing args.
			const toolName = ti.toolName ?? 'tool';
			const rawInput = ti.input ? JSON.stringify(ti.input, null, 2) : '';
			toolInputs.set(ti.callId, { toolName, rawInput });
			const friendly = this._friendlyToolName(toolName);

			if (toolName === 'write_todos') {
				// [ChipOS] Phase 1: drive the native sticky todo widget (above
				// the input) instead of a generic "更新计划" tool row, and
				// remember the list so the finish block can graduate it into a
				// permanent inline card when the turn ends.
				const todos = ChipOSChatAgent._normalizeTodos(ti.input?.todos);
				this._todoListService.setTodos(request.sessionResource, todos);
				return todos;
			} else if (toolName === 'task' || toolName === 'run_subagent' || toolName === 'transfer_to_agent') {
				// [ChipOS] Render subagent invocations as a collapsible card
				// (description + agent type) rather than a raw JSON tool row.
				// Internal steps aren't on the stateless wire, so the card
				// shows description on start and the result on completion.
				const args = (ti.input ?? {}) as Record<string, unknown>;
				const desc = typeof args.description === 'string' ? args.description
					: typeof args.prompt === 'string' ? args.prompt : '';
				const shortDesc = desc.split('\n')[0].slice(0, 60);
				const agentType = (typeof args.subagent_type === 'string' ? args.subagent_type
					: typeof args.agent_type === 'string' ? args.agent_type : '') || 'sub-agent';
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: false,
					invocationMessage: friendly,
					toolSpecificData: {
						kind: 'subagent',
						description: shortDesc,
						agentName: agentType,
						prompt: typeof args.prompt === 'string' ? args.prompt.slice(0, 500) : shortDesc,
					} satisfies IChatSubagentToolInvocationData,
				} satisfies IChatExternalToolInvocationUpdate]);
			} else if (ChipOSChatAgent._isShellTool(toolName)) {
				// [ChipOS] P0-4: stateless shell tools render as a terminal-style card
				// (syntax-highlighted command + exit-code decoration + collapsible output),
				// mirroring the agentic path's terminal block, instead of a bare "执行命令"
				// row. The command already ran on the worker, so this is DISPLAY-only: no
				// live terminal session is created; the done side fills terminalCommandOutput
				// + terminalCommandState.exitCode, and the renderer auto-collapses on exit 0
				// / auto-expands on failure.
				const shellArgs = (ti.input ?? {}) as Record<string, unknown>;
				const cmdLine = ChipOSChatAgent._extractShellCommand(shellArgs);
				const cwdPath = (typeof shellArgs.cwd === 'string' ? shellArgs.cwd : '') || this._getWorkspaceRoot() || '';
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: false,
					invocationMessage: friendly,
					toolSpecificData: {
						kind: 'terminal',
						commandLine: { original: cmdLine },
						cwd: cwdPath ? URI.file(cwdPath) : undefined,
						language: 'shellscript',
						isBackground: false,
					} satisfies IChatTerminalToolInvocationData,
				} satisfies IChatExternalToolInvocationUpdate]);
			} else if (toolName === 'read_skill_body' || toolName === 'read_rule_body') {
				// [ChipOS] Skill/rule lazy-load → a distinct "using" card (📘 技能 · <name>)
				// instead of a generic tool row: surface WHICH capability the agent reached
				// for, not the raw body. The completion row is suppressed (below).
				const skillArgs = (ti.input ?? {}) as Record<string, unknown>;
				const sName = String(skillArgs.skill_id ?? skillArgs.name ?? skillArgs.id ?? skillArgs.skill ?? skillArgs.rule_id ?? '').trim();
				const isRule = toolName === 'read_rule_body';
				const skillLabel = sName
					? (isRule
						? localize('chipos.render.usingRule', '📖 **规则** · `{0}`', sName)
						: localize('chipos.render.usingSkill', '📘 **技能** · `{0}`', sName))
					: (isRule
						? localize('chipos.render.usingRuleBare', '📖 **规则**')
						: localize('chipos.render.usingSkillBare', '📘 **技能**'));
				progress([this._markdown(skillLabel)]);
			} else {
				const argDetail = ChipOSChatAgent._formatToolArgs(ti.input);
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: false,
					invocationMessage: buildToolRowLabel(friendly, argDetail, this._resolveToolFileLink(ti.input)),
					toolSpecificData: { kind: 'input', rawInput } satisfies IChatToolInputInvocationData,
				} satisfies IChatExternalToolInvocationUpdate]);
			}
		} else {
			// tool_result_observed → complete the invocation with the
			// output preview so the user can see what the tool returned.
			const cached = toolInputs.get(ti.callId);
			toolInputs.delete(ti.callId);
			const toolName = cached?.toolName ?? 'tool';
			const friendly = this._friendlyToolName(toolName);
			const output = ti.outputPreview ?? '';

			// [ChipOS] FEAT-004: a tool blocked by a reasoner hook (deny) arrives with
			// error_kind 'hook_deny'. Render a distinct "🛡 被 hook 拦截" row + its reason
			// instead of the generic red tool-error (which reads as "the tool broke"), so
			// the user sees a POLICY block. Handled before the per-tool-type branches so
			// every blocked tool (shell / generic) renders uniformly.
			if (ti.errorKind === 'hook_deny') {
				const reason = output.replace(/^Tool\s+'[^']*'\s+was blocked by a reasoner hook:\s*/i, '').trim();
				const shortReason = reason.length > 100 ? `${reason.slice(0, 100)}…` : reason;
				const blockLabel: IMarkdownString = {
					value: shortReason
						? localize('chipos.render.hookDeny', '🛡 **被 hook 拦截** · `{0}` — {1}', friendly, shortReason)
						: localize('chipos.render.hookDenyBare', '🛡 **被 hook 拦截** · `{0}`', friendly),
					supportThemeIcons: false,
				};
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: true,
					pastTenseMessage: blockLabel,
					// The start side set `toolSpecificData` (e.g. a terminal card for shell
					// tools); the framework REPLACES (not merges) it on update, so we MUST
					// re-supply a card here or the row renders empty (the bug that hid the
					// whole deny row). Show the blocked input as a neutral input card.
					toolSpecificData: { kind: 'input', rawInput: cached?.rawInput ?? '' } satisfies IChatToolInputInvocationData,
					resultDetails: {
						input: cached?.rawInput ?? '',
						output: [{ type: 'embed' as const, value: output, isText: true, mimeType: 'text/plain' }],
						isError: true,
					} satisfies IToolResultInputOutputDetails,
				} satisfies IChatExternalToolInvocationUpdate]);
				return undefined;
			}

			if (toolName === 'task' || toolName === 'run_subagent' || toolName === 'transfer_to_agent') {
				// Re-send the subagent card with its result. We must
				// re-supply description/agentName: the model layer REPLACES
				// (not merges) toolSpecificData on update.
				let description = '';
				let agentName = 'sub-agent';
				let prompt = '';
				try {
					const args = cached?.rawInput ? JSON.parse(cached.rawInput) as Record<string, unknown> : {};
					const desc = typeof args.description === 'string' ? args.description
						: typeof args.prompt === 'string' ? args.prompt : '';
					description = desc.split('\n')[0].slice(0, 60);
					agentName = (typeof args.subagent_type === 'string' ? args.subagent_type
						: typeof args.agent_type === 'string' ? args.agent_type : '') || 'sub-agent';
					prompt = typeof args.prompt === 'string' ? args.prompt.slice(0, 500) : description;
				} catch (err) {
					// best-effort — fall back to a bare card
					this._logService.trace('[ChipOS Stateless] subagent result parse failed:', String(err));
				}
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: true,
					pastTenseMessage: friendly,
					errorMessage: ti.isError ? output : undefined,
					toolSpecificData: {
						kind: 'subagent',
						description,
						agentName,
						prompt,
						result: output,
					} satisfies IChatSubagentToolInvocationData,
				} satisfies IChatExternalToolInvocationUpdate]);
			} else if (ChipOSChatAgent._isShellTool(toolName)) {
				// [ChipOS] P0-4: complete the terminal card with the worker's captured
				// output + exit code. `execute`/`execute_command` return JSON
				// ({exit_code, stdout, stderr}); fall back to the raw preview + isError.
				let cachedCmd = '';
				try { cachedCmd = ChipOSChatAgent._extractShellCommand(cached?.rawInput ? JSON.parse(cached.rawInput) as Record<string, unknown> : undefined); } catch { /* best-effort */ }
				let outputText = output;
				let exitCode: number | undefined;
				try {
					const parsed = JSON.parse(output) as { exit_code?: number; returncode?: number; stdout?: string; stderr?: string };
					const combined = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n');
					if (combined) { outputText = combined; }
					exitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code
						: typeof parsed.returncode === 'number' ? parsed.returncode : undefined;
				} catch { /* not JSON — use the raw preview */ }
				if (cachedCmd) { outputText = `$ ${cachedCmd}\n${outputText}`; }
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: true,
					pastTenseMessage: friendly,
					errorMessage: ti.isError ? output : undefined,
					toolSpecificData: {
						kind: 'terminal',
						commandLine: { original: cachedCmd },
						language: 'shellscript',
						terminalCommandOutput: {
							text: outputText,
							truncated: outputText.length > 10_000,
							lineCount: outputText.split('\n').length,
						},
						terminalCommandState: {
							exitCode: exitCode ?? (ti.isError ? 1 : 0),
						},
					} satisfies IChatTerminalToolInvocationData,
				} satisfies IChatExternalToolInvocationUpdate]);
			} else if (toolName !== 'write_todos' && toolName !== 'read_skill_body' && toolName !== 'read_rule_body') {
				// write_todos has no completion row — the sticky widget
				// already reflects the latest list from the call side.
				// Rebuild the "verb `object`" label from the cached input and append a
				// result badge (· ✓ 通过 / · 改 1 处) — same row template as the sub-agent card.
				let doneArg = '';
				let doneInput: Record<string, unknown> | undefined;
				try { doneInput = cached?.rawInput ? JSON.parse(cached.rawInput) as Record<string, unknown> : undefined; doneArg = ChipOSChatAgent._formatToolArgs(doneInput); } catch { /* best-effort */ }
				const doneLabel = withResultBadge(buildToolRowLabel(friendly, doneArg, this._resolveToolFileLink(doneInput)), summarizeToolOutput(toolName, output, !!ti.isError));
				progress([{
					kind: 'externalToolInvocationUpdate',
					toolCallId: ti.callId,
					toolName,
					isComplete: true,
					pastTenseMessage: doneLabel,
					errorMessage: ti.isError ? output : undefined,
					resultDetails: {
						input: cached?.rawInput ?? '',
						output: [{ type: 'embed' as const, value: output, isText: true, mimeType: 'text/plain' }],
						isError: !!ti.isError,
					} satisfies IToolResultInputOutputDetails,
				} satisfies IChatExternalToolInvocationUpdate]);
			}
		}
		return undefined;
	}

	/**
	 * [ChipOS] Render a structured agent-error card (category presets matching
	 * the legacy WebSocket Error handler). Shared by invoke() and /resume.
	 */
	/**
	 * [ChipOS] Phase 2: graduate the live sticky todo list into a permanent,
	 * read-only card in the chat history, then clear the sticky widget so the
	 * next turn starts clean. Mirrors the legacy WebSocket path's TaskComplete
	 * snapshot. Shared by the invoke() finish block AND the /resume finalization
	 * so a write_todos turn resumed after an IDE restart also graduates + clears
	 * (otherwise the sticky widget lingers until the next live write_todos turn).
	 * No-op when the turn produced no todos.
	 */
	private _graduateStatelessTodos(
		latestTodos: IChatTodo[],
		progress: (parts: IChatProgress[]) => void,
		request: IChatAgentRequest,
	): void {
		if (latestTodos.length > 0) {
			progress([{
				kind: 'chiposTodoCard',
				todos: latestTodos.map(t => ({ title: t.title, status: t.status })),
			} satisfies IChatChiposTodoCard]);
			this._todoListService.setTodos(request.sessionResource, []);
		}
	}

	private _renderStatelessAgentError(
		ae: NonNullable<DispatchResult['agentError']>,
		progress: (parts: IChatProgress[]) => void,
	): void {
		// [ChipOS] Render a structured error card (matches the old
		// WebSocket-path Error handler's category presets for a
		// consistent look across both paths).
		const cat = (ae.category ?? 'INTERNAL').toUpperCase();
		this._statelessObs.turnError(cat, ae.errorCode);  // §5.1 client mirror

		const presets: Record<string, { icon: string; label: string; suggestion: string }> = {
			AUTH: { icon: '🔐', label: '认证失败', suggestion: '请重新登录后再试。' },
			SESSION: { icon: '⏱️', label: '会话已结束', suggestion: '请刷新页面或开启新对话。' },
			WORKER: { icon: '🔌', label: 'Worker 连接异常', suggestion: '正在尝试恢复，可稍后重试。' },
			TOOL: { icon: '🛠️', label: '工具执行失败', suggestion: '可重新发送以重试，或换一种描述。' },
			PROTO: { icon: '⚠️', label: '请求参数错误', suggestion: '可重新发送让模型修正。' },
			INTERNAL: { icon: '❌', label: '内部错误', suggestion: '请稍后重试，问题持续可联系支持。' },
		};
		const preset = presets[cat] ?? presets.INTERNAL;
		progress([{
			kind: 'agentError',
			error_code: ae.errorCode ?? 'AGENT_ERROR',
			message: `${preset.icon} **${preset.label}**：${ae.message}`,
			retryable: ae.retryable ?? (cat === 'WORKER' || cat === 'TOOL' || cat === 'PROTO'),
			suggestion: preset.suggestion,
		} satisfies IChatAgentError]);
	}

	/**
	 * [ChipOS] Fusion: render the rich EDA report directives a dispatched
	 * event produced (sim/lint/coverage/PPA/negotiation/parallel/spec cards,
	 * diff-preview markdown, and the end-of-turn task-summary card). Shared by
	 * the live `_invokeStateless` loop and the `_resumeStateless` loop so both
	 * surface the same cards the legacy WebSocket path did — the Phase-0
	 * dispatcher dropped all of these (`default: {}`).
	 */
	private _renderStatelessEdaParts(
		handled: DispatchResult,
		progress: (parts: IChatProgress[]) => void,
	): void {
		if (handled.edaParts && handled.edaParts.length > 0) {
			progress(handled.edaParts);
		}
		if (handled.markdownContents) {
			for (const md of handled.markdownContents) {
				progress([this._markdown(md)]);
			}
		}
		if (handled.taskSummary) {
			progress([this._progress('$(output) Task Summary')]);
			progress([this._markdown(ChipOSChatAgent._formatTaskSummary(handled.taskSummary))]);
		}
	}

	private _renderStatelessSubagentEvent(
		evt: NonNullable<DispatchResult['subagentEvent']>,
		progress: (parts: IChatProgress[]) => void,
		request: IChatAgentRequest,
		state: ISubagentCardState,
	): void {
		const result = computeSubagentToolUpdates(
			evt, state,
			raw => this._friendlyToolName(raw),
			args => ChipOSChatAgent._formatToolArgs(args),
			toolName => ChipOSChatAgent._isFileWriteTool(toolName),
			args => this._resolveToolFileLink(args), // P2-1: clickable file chips inside the card too
		);
		if (result.updates.length > 0) {
			progress(result.updates);
		}

		// File-write tool_start → start an external edit (snapshot_content is the
		// before-image when present) so the card shows the file diff.
		if (result.startEdit) {
			const { childKey, filePath, snapshotContent } = result.startEdit;
			const runtime = this._getOrCreateRuntime(request.sessionResource);
			// Dedup: skip if this file already has a pending external edit.
			const alreadyTracked = [...runtime.toolFileArgs.entries()].some(
				([k, v]) => v === filePath && runtime.externalEditOps.has(k),
			);
			if (!alreadyTracked) {
				const workspaceRoot = this._getWorkspaceRoot();
				const fileUri = filePath.startsWith('/')
					? URI.file(filePath)
					: workspaceRoot
						? URI.joinPath(URI.file(workspaceRoot), filePath)
						: URI.file(filePath);
				runtime.toolFileArgs.set(childKey, filePath);
				this._startExternalEdit(childKey, fileUri, request.sessionResource, request.requestId, runtime, snapshotContent);
			}
		}

		// tool_end → stop the external edit (if one was started) and emit its diff.
		if (result.stopEditChildKey) {
			const childKey = result.stopEditChildKey;
			const runtime = this._sessionRuntimes.get(request.sessionResource);
			if (runtime && runtime.externalEditOps.has(childKey)) {
				void this._stopExternalEdit(childKey, request.sessionResource, runtime).then(editProgress => {
					if (editProgress.length > 0) {
						progress(editProgress);
					}
				}).catch(err => {
					this._logService.error('[ChipOS Stateless] subagent stopExternalEdit failed:', String(err));
				});
				runtime.toolFileArgs.delete(childKey);
			}
		}
	}

	/**
	 * [ChipOS] Fusion: close any sub-agent cards still open at turn end. The
	 * stateless path has no `complete` frame (the agentic `SubagentEvent` path
	 * does), so when the round ends we flip each synthesized parent card — and
	 * any dangling child whose `tool_end` never arrived — to complete, so no
	 * card is left spinning. The renderer additionally collapses active cards
	 * when the response element completes; this settles the underlying model
	 * state. See `computeSubagentFinalizeUpdates`.
	 */
	private _finalizeStatelessSubagents(
		progress: (parts: IChatProgress[]) => void,
		state: ISubagentCardState,
	): void {
		const updates = computeSubagentFinalizeUpdates(state, raw => this._friendlyToolName(raw));
		if (updates.length > 0) {
			progress(updates);
		}
	}


	private static _truncStr(s: string, max: number): string {
		return s.length > max ? s.slice(0, max) + '...' : s;
	}

	/**
	 * [ChipOS] Normalize a backend `write_todos` / `TodoUpdate` todos array into
	 * the native `IChatTodo[]` shape. The backend ships several serializations
	 * (snake_case, kebab-case, TitleCase) across both `{task_des, task_status}`
	 * and `{content, status}` field pairs — fold them all here. Shared by the
	 * stateless write_todos handler and the legacy WebSocket TodoUpdate handler.
	 */
	private static _normalizeTodos(raw: unknown): IChatTodo[] {
		if (!Array.isArray(raw)) {
			return [];
		}
		const statusMap: Record<string, IChatTodo['status']> = {
			'done': 'completed',
			'completed': 'completed',
			'finished': 'completed',
			'in_progress': 'in-progress',
			'in-progress': 'in-progress',
			'inprogress': 'in-progress',
			'running': 'in-progress',
			'active': 'in-progress',
			'pending': 'not-started',
			'todo': 'not-started',
			'not_started': 'not-started',
			'not-started': 'not-started',
			'cancelled': 'not-started',
			'canceled': 'not-started',
			'failed': 'not-started',
			'error': 'not-started',
		};
		return raw.map((t, idx) => {
			const item = (t ?? {}) as { task_status?: string; status?: string; task_des?: string; content?: string };
			const rawKey = (item.task_status || item.status || 'pending').toLowerCase();
			// Fall back through empty strings as well as null/undefined — task_des
			// and content were both observed to arrive as "" (an empty step);
			// without the chained || we'd render blank rows.
			const title = (item.task_des || item.content || `Todo ${idx + 1}`).trim() || `Todo ${idx + 1}`;
			return { id: idx, title, status: statusMap[rawKey] ?? 'not-started' };
		});
	}

	private static _formatToolArgs(args: Record<string, unknown> | undefined): string {
		if (!args) { return ''; }
		const parts: string[] = [];
		const str = (v: unknown) => typeof v === 'string' ? v : '';
		if (args.path) { parts.push(ChipOSChatAgent._truncStr(str(args.path), 60)); }
		else if (args.file_path) { parts.push(ChipOSChatAgent._truncStr(str(args.file_path), 60)); }
		else if (args.rtl_path) { parts.push(ChipOSChatAgent._truncStr(str(args.rtl_path), 60)); }
		if (args.command) { parts.push('`' + ChipOSChatAgent._truncStr(str(args.command), 40) + '`'); }
		if (args.pattern) { parts.push('/' + ChipOSChatAgent._truncStr(str(args.pattern), 30) + '/'); }
		if (args.query) { parts.push('"' + ChipOSChatAgent._truncStr(str(args.query), 40) + '"'); }
		if (args.subagent_type || args.agent_name) {
			const agent = str(args.subagent_type || args.agent_name).replace(/-agent$/, '').replace(/_agent$/, '');
			parts.push(agent);
		}
		if (args.description && parts.length === 0) { parts.push(ChipOSChatAgent._truncStr(str(args.description), 40)); }
		if (parts.length === 0) {
			const keys = Object.keys(args);
			if (keys.length > 0) {
				const v = args[keys[0]];
				if (typeof v === 'string') { parts.push(ChipOSChatAgent._truncStr(v, 40)); }
			}
		}
		return parts.join(' · ');
	}


	/**
	 * Format a TaskSummary payload as a readable Markdown card
	 * instead of dumping raw JSON.
	 */
	private static _formatTaskSummary(p: ITaskSummaryPayload): string {
		const d = p.structured_data ?? {};
		const lines: string[] = [];

		const verdict = (d.verdict_badge as string) ?? '';
		const title = (d.task_description as string) ?? p.task_type ?? 'Task';
		lines.push(`### ${verdict} ${title}\n`);

		const kv: [string, string][] = [];
		// 2026-05-19 dogfood: some structured_data values are pre-formatted
		// multi-line markdown tables (e.g. test_case_rows, remaining_errors
		// _table) that the backend SummaryAssembler joined with \n. Embedding
		// them into a single | label | value | cell shreds the outer table
		// layout (pipes inside the value collide with the column separator,
		// newlines split the row). Render those as their own sub-table after
		// the kv summary instead.
		const skip = new Set(['verdict_badge', 'task_description', 'next_steps', 'generated_files_list']);
		const tableHeaderByKey: Record<string, string> = {
			test_case_rows: '| Case | Status | Details |\n|---|---|---|',
			remaining_errors_table: '| Location | Severity | Message |\n|---|---|---|',
			fixes_applied_list: '',
			debug_fixes_list: '',
		};
		const inlineTables: [string, string, string][] = []; // [label, header, body]
		for (const [k, v] of Object.entries(d)) {
			if (skip.has(k) || v === undefined || v === null || v === '' || v === '无') { continue; }
			if (typeof v === 'object') { continue; }
			const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			const sval = String(v);
			if (k in tableHeaderByKey && (sval.includes('\n') || sval.startsWith('|'))) {
				inlineTables.push([label, tableHeaderByKey[k], sval]);
				continue;
			}
			// Anything else that still contains a pipe or newline would also
			// break the kv table — collapse to a single line and escape pipes.
			if (sval.includes('\n') || sval.includes('|')) {
				kv.push([label, sval.replace(/\|/g, '\\|').replace(/\n+/g, ' · ')]);
				continue;
			}
			kv.push([label, sval]);
		}

		if (kv.length) {
			lines.push('| 项目 | 值 |');
			lines.push('|---|---|');
			for (const [label, val] of kv) {
				lines.push(`| ${label} | ${val} |`);
			}
			lines.push('');
		}

		for (const [label, header, body] of inlineTables) {
			lines.push(`**${label}**`);
			if (header) {
				lines.push(header);
			}
			lines.push(body);
			lines.push('');
		}

		const filesList = d.generated_files_list as string[] | undefined;
		if (filesList && Array.isArray(filesList) && filesList.length && filesList[0] !== '无') {
			lines.push('**Generated Files:**');
			for (const f of filesList) { lines.push(`- \`${f}\``); }
			lines.push('');
		}

		const next = d.next_steps as string | undefined;
		if (next && next !== '无') {
			lines.push(`> $(lightbulb) **Next:** ${next}`);
		}

		return lines.join('\n');
	}

	// ── Helper factories ────────────────────────────────────────────────────

	private _getWorkspaceRoot(): string | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	/**
	 * [ChipOS][F-4 redesign] Build the inline "下一步" card: a non-blocking button
	 * group rendered in the conversation flow under the reply (NOT the native float
	 * above the input). First step = primary button, the rest = secondary. The
	 * button LABEL is clipped for tidiness; the click still sends the FULL action
	 * text (see the `chipos.chat.sendFollowup` command).
	 */
	private _buildFollowupsCard(sessionResource: URI, followups: readonly string[]): IChatCommandButton | undefined {
		const items = followups.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 4);
		if (items.length === 0) {
			return undefined;
		}
		const toCommand = (raw: string) => {
			const action = ChipOSChatAgent._followupAction(raw);
			return {
				id: 'chipos.chat.sendFollowup',
				title: ChipOSChatAgent._followupChipLabel(action),
				tooltip: action,
				arguments: [sessionResource, action],
			};
		};
		const [first, ...rest] = items;
		return {
			kind: 'command',
			command: toCommand(first),
			additionalCommands: rest.map(toCommand),
		};
	}

	/** Drop a trailing meta-question the model sometimes appends ("…。需要我继续吗?"). */
	private static _followupAction(raw: string): string {
		const s = raw.trim();
		const dot = s.indexOf('。');
		const action = dot > 0 ? s.slice(0, dot).trim() : s;
		return action.length > 0 ? action : s;
	}

	/** Clip the chip LABEL for tidiness; the full action still sends on click. */
	private static _followupChipLabel(action: string): string {
		const MAX = 22;
		return action.length > MAX ? action.slice(0, MAX - 1) + '…' : action;
	}

	private _markdown(content: string): IChatMarkdownContent {
		return { kind: 'markdownContent', content: new MarkdownString(content, { supportThemeIcons: true }) };
	}

	private _progress(content: string, shimmer?: boolean): IChatProgressMessage {
		// Strip codicon prefixes like "$(loading~spin)" from the message: the chat
		// panel uses chatContentMarkdownRenderer which parses them as icons (works
		// fine, but redundant since the chat row already shows its own spinner),
		// while the inline-chat overlay renders progress via renderAsPlaintext
		// (inlineChatOverlayWidget.ts §504) — which leaves "$(...)" as LITERAL TEXT.
		// Stripping at the source keeps both render paths clean.
		return { kind: 'progressMessage', content: new MarkdownString(stripIcons(content), { supportThemeIcons: true }), shimmer };
	}






	/**
	 * Build llm_config from user Settings for sendTask().
	 * Maps chipos.provider/apiKey/apiBaseUrl/model → backend LLMConfig fields.
	 */
	private _buildLlmConfig(): { provider: string; api_key: string; base_url: string; model: string } {
		const provider = this._configurationService.getValue<string>('chipos.provider') ?? '';
		const apiKey = this._configurationService.getValue<string>('chipos.apiKey') ?? '';
		const baseUrl = this._configurationService.getValue<string>('chipos.apiBaseUrl') ?? '';
		const model = this._configurationService.getValue<string>('chipos.model') ?? '';
		return { provider, api_key: apiKey, base_url: baseUrl, model };
	}


	// ── FEAT-R72: IDE 端工具执行 ────────────────────────────────────────────

	/**
	 * IDE 端工具输出缓存（terminal_id → output）
	 * 用于 get_terminal_output 工具读取之前 run_in_terminal 的输出
	 */
	private readonly _terminalOutputCache = new Map<string, { output: string; exitCode?: number }>();


	// 2026-05-26: tried IChatQuestionCarousel for agent_ask form rendering
	// but VSCode framework hardcodes carousel to render in input-bar area
	// (chatListRenderer.ts:2280-2294), not inline in the chat conversation
	// flow. Reverted to IChatConfirmation + reasoner-side options-as-buttons
	// (commit ed5cd46b on backend_v2) so the card renders inline where the
	// user expects, using the existing ChipOSPermissionCardContentPart
	// renderer.

	/**
	 * run_in_terminal inline-approval bridge.
	 *
	 * Replaces the old `IDialogService.confirm()` modal: the run_in_terminal
	 * IDE tool handler emits an `IChatConfirmation` instead of blocking on a
	 * native dialog, then awaits this Deferred while the chat finishes the
	 * current invoke. When the user clicks Run / Reject in the inline card,
	 * the next `invoke()` (with `acceptedConfirmationData` /
	 * `rejectedConfirmationData`) routes here via the
	 * `__chiposTerminalConfirmId` marker on the confirmation data — resolves
	 * the Deferred with `true` / `false` so `_executeIdeToolCall` (which is
	 * fire-and-forget at line 2090) can continue execution and send the
	 * `IdeToolResult` whenever it's ready.
	 *
	 * Key invariants:
	 *   - keyed by call_id (the LLM's tool_call.id), which is unique per
	 *     pending tool invocation;
	 *   - cleaned up either at resolution time OR if `_executeIdeToolCall`
	 *     exits early (timeout / runtime dispose) so the map doesn't leak.
	 */
	private readonly _pendingTerminalApprovals = new Map<string, DeferredPromise<boolean>>();


	/**
	 * Pure tool dispatch helper — shared by legacy `_executeIdeToolCall`
	 * (Phase 0 stateful path) and Phase 1 stateless `_handleStatelessIdeToolCall`
	 * (reverse channel). Routes by tool name:
	 *   - run_in_terminal     → approval gate + `_runInTerminal`
	 *   - get_terminal_output → `_getTerminalOutput`
	 *   - else                → MCP via `_tryCallMcpTool` (R56), or "unknown tool"
	 *
	 * Returns `{content, isError}` for the caller to ship back via the
	 * transport it owns (sendIdeToolResult on streamClient for legacy,
	 * POST /tool_result on StatelessClient for Phase 1). Never throws —
	 * exceptions are caught and surfaced as `isError: true` content so the
	 * agent loop on the server side can decide what to do next.
	 *
	 * `terminalApprovalOverride`: when defined, short-circuits the
	 * `run_in_terminal` approval gate with a decision the caller already made
	 * (true = approved, false = rejected) instead of running the legacy
	 * `_awaitTerminalApproval` here. The stateless path resolves approval up
	 * front via the inline confirm-card mechanism (`_awaitStatelessTerminal-
	 * Approval`) because its round-scoped `runtime.activeProgress` is never set,
	 * so it hands the verdict in through this param. Legacy callers omit it and
	 * keep the in-dispatch `_awaitTerminalApproval` behaviour.
	 */
	private async _dispatchIdeTool(
		name: string,
		args: Record<string, unknown>,
		runtime: IChatSessionRuntime,
		callId: string,
		terminalApprovalOverride?: boolean,
	): Promise<{ content: string; isError: boolean }> {
		if (runtime.disposeController.signal.aborted) {
			return {
				content: `IDE tool '${name}' skipped (session disposed)`,
				isError: true,
			};
		}
		let content: string;
		let isError = false;

		try {
			switch (name) {
				case 'run_in_terminal': {
					const termKey = callId || name;
					let termSession = runtime.terminalSessionMap.get(termKey);

					// T-09: IdeToolCall call_id (LLM's tool_call.id) differs from
					// ToolCall key (ExecutionHandler's run_id). Fall back to
					// command matching, then single-entry heuristic.
					if (!termSession) {
						const cmdFromArgs = typeof args.command === 'string' ? args.command : '';
						if (cmdFromArgs) {
							for (const [k, cmd] of runtime.terminalCommandLines) {
								if (cmd === cmdFromArgs && runtime.terminalSessionMap.has(k)) {
									termSession = runtime.terminalSessionMap.get(k);
									this._logService.info('[ChipOS Agent] IdeToolCall T-09 fallback (cmd match): %s → %s', termKey, k);
									break;
								}
							}
						}
					}
					if (!termSession && runtime.terminalSessionMap.size === 1) {
						const entry = runtime.terminalSessionMap.entries().next();
						if (!entry.done) {
							termSession = entry.value[1];
							this._logService.info('[ChipOS Agent] IdeToolCall T-09 fallback (single entry): %s → %s', termKey, entry.value[0]);
						}
					}

					// Approval gate: inline IChatConfirmation — see legacy comment.
					const approveMode = this._configurationService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
					const cmd = typeof args.command === 'string' ? args.command : '';
					this._logService.info('[ChipOS Agent] run_in_terminal approval: mode=%s, cmd=%s, override=%s', approveMode, cmd, String(terminalApprovalOverride));
					if (approveMode !== 'full_auto') {
						// Stateless path pre-resolves approval via the inline confirm
						// card and passes the verdict in; legacy path awaits its own
						// round-scoped inline card / modal here.
						const confirmed = terminalApprovalOverride !== undefined
							? terminalApprovalOverride
							: await this._awaitTerminalApproval(callId, cmd, runtime);
						if (!confirmed) {
							content = 'User rejected the terminal command.';
							isError = true;
							break;
						}
					}

					content = await this._runInTerminal(args as { command: string; explanation?: string; isBackground?: boolean }, termSession?.sessionId, termSession?.commandId, termKey, runtime);
					break;
				}
				case 'get_terminal_output': {
					content = this._getTerminalOutput(args as { terminal_id: string });
					break;
				}
				case 'read_skill_body': {
					// FEAT-003 (ADR-004): lazy-load a skill body on the model's request.
					const skillId = typeof args.skill_id === 'string' ? args.skill_id : '';
					const res = await this._instantiationService.createInstance(ChiposSkillsService).readBody(skillId);
					content = res.content;
					isError = res.isError;
					break;
				}
				case 'read_rule_body': {
					// FEAT-001b/c: lazy-load an agent rule's body on the model's request
					// (rule-side mirror of read_skill_body — agent rules ship header-only).
					const ruleId = typeof args.rule_id === 'string' ? args.rule_id : '';
					const res = await this._instantiationService.createInstance(ChiposRulesService).readBody(ruleId);
					content = res.content;
					isError = res.isError;
					break;
				}
				default: {
					// R56: route to MCP service if no IDE-builtin handler matched.
					const mcpResult = await this._tryCallMcpTool(name, args);
					if (mcpResult !== null) {
						content = mcpResult.content;
						isError = mcpResult.isError;
					} else {
						content = `Unknown IDE tool: ${name}`;
						isError = true;
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			content = `IDE tool '${name}' failed: ${msg}`;
			isError = true;
		}

		return { content, isError };
	}

	/**
	 * Inline approval helper for `run_in_terminal`. Emits an
	 * `IChatConfirmation` carrying the **chipos terminal-confirm card
	 * data shape** (see `chipOSPermissionCard.ts:IChipOSTerminalConfirmCardData`)
	 * so the chat list dispatches to `ChipOSPermissionCardContentPart`
	 * instead of the framework's stock confirmation widget. Same visual
	 * vocabulary as the MCP worker permission ask — header + clickable
	 * "path" (here: the command) + 2 horizontal buttons (Run / Reject).
	 *
	 * Click handling: the card uses chipos's standard
	 * `acceptedConfirmationData` path — every button click sends the
	 * card data back via `sendRequest`, the `invoke()` dispatcher picks
	 * the `__chiposTerminalConfirmId` branch, looks up the matching
	 * `options[].action_id` (`run` or `reject`) via the message label,
	 * and resolves the Deferred. `_executeIdeToolCall` then continues
	 * with command exec or rejection content.
	 *
	 * Why this design (vs the modal `IDialogService.confirm` it replaces):
	 *   - Visual continuity: the modal didn't share any styling with the
	 *     other chipos confirm cards (MCP permission, hook confirm).
	 *     Routing through `ChipOSPermissionCardContentPart` puts
	 *     terminal approval in the SAME custom card vocabulary, with
	 *     tool icon + color bar + horizontal button row.
	 *   - `_executeIdeToolCall` is called fire-and-forget (line 2091) —
	 *     it can await indefinitely without blocking the event loop, so
	 *     the "wait for click in a future invoke" pattern works without
	 *     state machine surgery on the rest of the dispatcher.
	 *
	 * If `activeProgress` / `activeFinish` are unset (runtime not in an
	 * invoke right now — shouldn't happen during tool execution but
	 * defend anyway), fall back to auto-reject so the tool call doesn't
	 * hang.
	 */
	private _awaitTerminalApproval(call_id: string, cmd: string, runtime: IChatSessionRuntime): Promise<boolean> {
		// The approval card may already have been pre-emitted at `IdeToolCall`
		// dispatch time, while the round was still active — see
		// `_maybePreEmitTerminalApprovalCard`. If so, just await that Deferred:
		// the inline card is already on screen; don't re-emit or fall back.
		const existing = this._pendingTerminalApprovals.get(call_id);
		if (existing) {
			return existing.p;
		}

		// In-round path: a round is active, so host the inline confirmation card
		// on it (emit card + finish the round). This is the common case when the
		// approval await happens to still run inside the originating round.
		const progress = runtime.activeProgress;
		const finish = runtime.activeFinish;
		if (progress && finish) {
			return this._emitTerminalApprovalCard(call_id, cmd, runtime, progress, finish);
		}

		// No active round AND no pre-emitted card. In the stateless/fusion path
		// the IDE tool call is dispatched via the reverse channel after the round
		// has finished. Auto-rejecting here lied to the user ("User rejected the
		// terminal command") even after they approved. Fall back to a modal
		// confirm, which does not depend on round-scoped progress and resolves
		// the moment the user answers.
		this._logService.info('[ChipOS Agent] terminal approval: no active round and no pre-emitted card — using modal confirm fallback');
		return this._dialogService.confirm({
			type: 'warning',
			message: localize('chipos.terminal.approval.title', 'ChipOS wants to run a terminal command'),
			detail: cmd || '(empty command)',
			primaryButton: localize('chipos.terminal.approval.run', 'Run'),
			cancelButton: localize('chipos.terminal.approval.reject', 'Reject'),
		}).then(res => res.confirmed);
	}


	/**
	 * Register the approval Deferred + emit the inline confirmation card via the
	 * supplied progress/finish (the active round's). Shared by the in-round await
	 * path and the dispatch-time pre-emit. Mirrors the worker-ask card pattern:
	 * emit the card, then finish the round so the framework re-enables input for
	 * the click → new invoke → Deferred resolution.
	 */
	private _emitTerminalApprovalCard(
		call_id: string,
		cmd: string,
		runtime: IChatSessionRuntime,
		progress: (parts: IChatProgress[]) => void,
		finish: (result: IChatAgentResult, thinkingTitle?: string) => void,
	): Promise<boolean> {
		const deferred = new DeferredPromise<boolean>();
		this._pendingTerminalApprovals.set(call_id, deferred);
		progress([this._buildTerminalConfirmation(call_id, cmd, runtime)]);
		// Finish the in-flight round so the framework opens the input for the
		// next request (button click → new invoke with the accepted/rejected
		// data). Mirrors the ConfirmRequest / worker-ask handlers.
		finish({}, localize('chipos.terminal.approval.awaiting', 'Awaiting terminal approval'));
		return deferred.p;
	}

	/**
	 * Build the `IChatConfirmation` carrying the chipos terminal-confirm card
	 * data shape so the chat list dispatches to `ChipOSPermissionCardContentPart`
	 * (same visual vocabulary as the worker permission ask) rather than the
	 * framework's stock confirmation widget.
	 *
	 * `statelessTraceId`: when set, also stamp the stateless-confirm markers
	 * (`__chiposStatelessConfirmTraceId` / `__chiposStatelessConfirmRequestId`)
	 * so the card's click resolves IN-PROCESS via the `_chipos.resolveStateless-
	 * Confirm` command (see `ChipOSPermissionCardContentPart.sendAction`) instead
	 * of `sendRequest`. The stateless path needs this: while its originating turn
	 * is in flight the chat session is busy, so the sendRequest re-entry route the
	 * legacy `__chiposTerminalConfirmId` click takes is rejected.
	 */
	private _buildTerminalConfirmation(call_id: string, cmd: string, runtime?: IChatSessionRuntime, statelessTraceId?: string): IChatConfirmation {
		const title = localize('chipos.terminal.approval.title', 'ChipOS wants to run a terminal command');
		const runLabel = localize('chipos.terminal.approval.run', 'Run');
		const rejectLabel = localize('chipos.terminal.approval.reject', 'Reject');
		// Plain string message (screen-reader + collapsed-card preview). The
		// card's main visual is built by `ChipOSPermissionCardContentPart` from
		// the data fields below, not from this message body.
		const message = `${cmd || '(empty command)'}`;
		return {
			kind: 'confirmation',
			title,
			message,
			data: {
				__chiposTerminalConfirmId: call_id,
				// Stateless path: route the click through the in-process command
				// resolver (the in-flight turn blocks the sendRequest re-entry).
				...(statelessTraceId ? {
					__chiposStatelessConfirmTraceId: statelessTraceId,
					__chiposStatelessConfirmRequestId: call_id,
				} : {}),
				tool: 'Bash',
				specifier: cmd || '(empty command)',
				sessionId: runtime?.backendSessionId ?? statelessTraceId ?? '',
				requestId: call_id,
				options: [
					{ label: runLabel, action_id: 'run' },
					{ label: rejectLabel, action_id: 'reject' },
				],
			},
			buttons: [runLabel, rejectLabel],
		};
	}

	/**
	 * FEAT-R72: 在 IDE 终端中执行 shell 命令。
	 * 使用 VS Code ITerminalService 创建终端实例，通过 runCommand/sendText 执行命令，
	 * 通过 onData 收集输出。支持前台（等待完成）和后台（立即返回）两种模式。
	 */
	private async _runInTerminal(
		args: { command: string; explanation?: string; isBackground?: boolean },
		terminalToolSessionId?: string,
		terminalCommandId?: string,
		toolCallKey?: string,
		runtime?: IChatSessionRuntime,
	): Promise<string> {
		const { command, explanation, isBackground } = args;
		const cwd = this._getWorkspaceRoot() ?? '';

		this._logService.info(
			'[ChipOS Agent] run_in_terminal: cmd=%s, cwd=%s, bg=%s, explanation=%s',
			command, cwd, isBackground, explanation,
		);

		// sandbox-runtime: wrap command if sandbox is enabled
		let effectiveCommand = command;
		try {
			if (await this._terminalSandboxService.isEnabled()) {
				effectiveCommand = this._terminalSandboxService.wrapCommand(command);
				this._logService.info('[ChipOS Agent] sandbox-runtime enabled, command wrapped');
			}
		} catch (e: any) {
			this._logService.warn('[ChipOS Agent] sandbox-runtime check failed, running without sandbox: %s', e?.message);
		}

		const terminalId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		let terminal: import('../../../terminal/browser/terminal.js').ITerminalInstance;
		try {
			terminal = await this._terminalService.createTerminal({
				config: {
					name: `ChipOS: ${command.slice(0, 30)}`,
					cwd: cwd || undefined,
					isFeatureTerminal: true,
				},
			});
		} catch (e: any) {
			this._logService.error('[ChipOS Agent] Failed to create terminal: %s', e?.message);
			return `Failed to create terminal: ${e?.message ?? 'unknown error'}`;
		}

		// Register with ITerminalChatService so ChatTerminalToolProgressPart can find & mirror it
		if (terminalToolSessionId) {
			this._terminalChatService.registerTerminalInstanceWithToolSession(terminalToolSessionId, terminal);
			this._logService.info('[ChipOS Agent] Registered terminal for tool session: %s', terminalToolSessionId);
		}

		// Helper: capture terminal artifacts (theme, URI) for ToolResult handler
		const captureArtifacts = () => {
			if (!toolCallKey || !runtime) {
				return;
			}
			const artifacts: { theme?: { background?: string; foreground?: string }; commandUri?: UriComponents } = {};
			try {
				const xterm = terminal.xterm;
				if (xterm) {
					const xtermTheme = xterm.getXtermTheme();
					artifacts.theme = { background: xtermTheme.background, foreground: xtermTheme.foreground };
				}
			} catch { /* theme capture is best-effort */ }
			try {
				if (terminalCommandId) {
					const params = new URLSearchParams(terminal.resource.query);
					params.set('command', terminalCommandId);
					artifacts.commandUri = terminal.resource.with({ query: params.toString() });
				}
			} catch { /* URI construction is best-effort */ }
			runtime.terminalArtifacts.set(toolCallKey, artifacts);
		};

		// Helper: execute command via runCommand (enables CommandDetection ID linkage) with sendText fallback
		const executeCommand = async (cmd: string): Promise<void> => {
			if (terminalCommandId && typeof terminal.runCommand === 'function') {
				await terminal.runCommand(cmd, true, terminalCommandId);
			} else {
				await terminal.sendText(cmd, true);
			}
		};

		let output = '';
		const dataListener = terminal.onData((data: string) => {
			const clean = data
				.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (title, hyperlinks)
				.replace(/\x1bP[^\x1b]*\x1b\\/g, '')                  // DCS
				.replace(/\x1b\[[0-9;:?=]*[a-zA-Z~@`]/g, '')              // CSI (SGR, cursor, erase, etc.)
				.replace(/\x1b[()][0-9A-B]/g, '')                      // charset switching
				.replace(/\x1b[=>NOcn78]/g, '')                        // misc ESC sequences
				.replace(/[\x00-\x08\x0e-\x1f]/g, '')                 // control chars (keep \t \n)
				.replace(/\r/g, '');
			output += clean;
			if (output.length > 50_000) {
				output = output.slice(-40_000);
			}
		});

		// 后台任务：发送命令后立即返回
		if (isBackground) {
			this._terminalOutputCache.set(terminalId, { output: '(running...)', exitCode: undefined });
			await executeCommand(effectiveCommand);

			// 后台监听：命令完成后更新缓存
			const bgTimeout = setTimeout(() => {
				dataListener.dispose();
				captureArtifacts();
				this._terminalOutputCache.set(terminalId, {
					output: this._cleanTerminalOutput(output, command, effectiveCommand) || '(no output captured)',
					exitCode: undefined,
				});
			}, 120_000);

			// 尝试监听命令完成
			const capabilities = terminal.capabilities;
			const cmdDetection = capabilities?.get?.(2 /* TerminalCapability.CommandDetection */);
			if (cmdDetection) {
				const finishListener = (cmdDetection as any).onCommandFinished?.((e: any) => {
					clearTimeout(bgTimeout);
					dataListener.dispose();
					finishListener?.dispose();
					captureArtifacts();
					this._terminalOutputCache.set(terminalId, {
						output: this._cleanTerminalOutput(output, command, effectiveCommand) || '(no output captured)',
						exitCode: e?.exitCode,
					});
				});
			}

			return `Background task started. Terminal ID: ${terminalId}`;
		}

		// 前台任务：等待命令完成
		return new Promise<string>((resolve) => {
			const timeout = setTimeout(() => {
				dataListener.dispose();
				captureArtifacts();
				this._terminalOutputCache.set(terminalId, { output: `Command timed out after 120s\n${output}`, exitCode: -1 });
				resolve(`Command timed out after 120s\n${output}`);
			}, 120_000);

			// 监听命令完成
			const capabilities = terminal.capabilities;
			const cmdDetection = capabilities?.get?.(2 /* TerminalCapability.CommandDetection */);

			if (cmdDetection) {
				const finishListener = (cmdDetection as any).onCommandFinished?.((e: any) => {
					clearTimeout(timeout);
					dataListener.dispose();
					finishListener?.dispose();
					captureArtifacts();
					const exitCode = e?.exitCode ?? 0;
					const result = this._cleanTerminalOutput(output, command, effectiveCommand) || '(no output)';
					this._terminalOutputCache.set(terminalId, { output: result, exitCode });

					// 限制缓存大小
					if (this._terminalOutputCache.size > 50) {
						const oldest = this._terminalOutputCache.keys().next().value;
						if (oldest) { this._terminalOutputCache.delete(oldest); }
					}
					resolve(result);
				});
			}

			// 发送命令执行
			executeCommand(effectiveCommand).then(() => {
				// 如果没有 commandDetection，用简单的延时等待
				if (!cmdDetection) {
					setTimeout(() => {
						clearTimeout(timeout);
						dataListener.dispose();
						captureArtifacts();
						const result = this._cleanTerminalOutput(output, command, effectiveCommand) || '(no output captured - command detection unavailable)';
						this._terminalOutputCache.set(terminalId, { output: result, exitCode: undefined });
						resolve(result);
					}, 3000);
				}
			});
		});
	}

	/**
	 * FEAT-R75: 获取之前终端执行的输出。
	 */
	private _getTerminalOutput(args: { terminal_id: string }): string {
		const cached = this._terminalOutputCache.get(args.terminal_id);
		if (!cached) {
			return `Terminal '${args.terminal_id}' not found or expired`;
		}
		return cached.output;
	}

	// ── R56: MCP 工具调用路由 ──────────────────────────────────────────────

	/**
	 * 尝试通过 Cursor 原生 IMcpService 调用 MCP 工具。
	 * 返回 null 表示该工具不是 MCP 工具。
	 */
	private async _tryCallMcpTool(name: string, args: Record<string, any>): Promise<{ content: string; isError: boolean } | null> {
		try {
			const servers = this._mcpService.servers.get();
			for (const server of servers) {
				const tools = server.tools.get();
				if (!tools) { continue; }
				const tool = tools.find(t => t.definition.name === name);
				if (tool) {
					this._logService.info('[ChipOS Agent] MCP tool found: %s on server %s', name, server.definition.id);
					return shapeMcpToolResult(await tool.call(args));
				}
			}
			return null;
		} catch (err: any) {
			this._logService.warn('[ChipOS Agent] MCP tool call failed: %s — %s', name, err.message);
			return { content: `MCP tool '${name}' failed: ${err.message}`, isError: true };
		}
	}

	// ── R55: MCP 工具定义上报 Reasoner ────────────────────────────────────


	private _cleanTerminalOutput(raw: string, command: string, effectiveCommand?: string): string {
		const lines = raw.split('\n');
		const cleaned: string[] = [];
		const cmdTrimmed = command.trim();
		const effectiveCmdTrimmed = effectiveCommand?.trim();
		const promptPatterns = [
			/^(\([\w.-]+\)\s*)?[\w.-]+@[\w.-]+[:#~\/$%>]\s*/,  // user@host:~$
			/^[\w.-]+[#$%>]\s*/,                                 // simple: root#, user$
			/^PS [A-Z]:\\[^>]*>\s*/,                             // PowerShell
			/^\s*\$\s*$/,                                         // bare $
			/^\s*[#%>]\s*$/,                                      // bare # % >
		];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) { continue; }
			// 跳过原始命令回显
			if (trimmed === cmdTrimmed || trimmed.endsWith(cmdTrimmed)) { continue; }
			// 跳过 sandbox 包装后的命令回显
			if (effectiveCmdTrimmed && (trimmed === effectiveCmdTrimmed || trimmed.endsWith(effectiveCmdTrimmed))) { continue; }
			let isPromptOnly = false;
			for (const pat of promptPatterns) {
				if (pat.test(trimmed) && trimmed.replace(pat, '').trim() === '') {
					isPromptOnly = true;
					break;
				}
			}
			if (isPromptOnly) { continue; }
			let cleanLine = trimmed;
			for (const pat of promptPatterns) {
				cleanLine = cleanLine.replace(pat, '');
			}
			cleaned.push(cleanLine || trimmed);
		}
		return cleaned.join('\n').trim() || '(no output)';
	}


	// ── Context collector ───────────────────────────────────────────────────


	// ── InlineDiff / SkillTree public surface ───────────────────────────────
	// Note: acceptAllDiffs/rejectAllDiffs are now handled by the framework's
	// IChatEditingService via the native Accept/Reject UI in the chat widget.

	acceptAllDiffs(): void {
		this._logService.info('[ChipOS Agent] acceptAllDiffs: now handled by framework IChatEditingService');
	}

	rejectAllDiffs(): void {
		this._logService.info('[ChipOS Agent] rejectAllDiffs: now handled by framework IChatEditingService');
	}

	getActiveDiffFiles(): string[] {
		return [];
	}

	get skillTreeHandler() {
		return this._ensureEditorEffects().skillTreeHandler;
	}

	get editorEffects(): ChipOSEditorEffects {
		return this._ensureEditorEffects();
	}

	// ── Editor effects ──────────────────────────────────────────────────────

	private _ensureEditorEffects(): ChipOSEditorEffects {
		if (!this._editorEffects) {
			this._editorEffects = this._register(
				this._instantiationService.createInstance(ChipOSEditorEffects)
			);
		}
		return this._editorEffects;
	}

	private _getOrCreateRuntime(sessionResource: URI): IChatSessionRuntime {
		let runtime = this._sessionRuntimes.get(sessionResource);
		if (!runtime) {
			runtime = {
				toolStartTimes: new Map<string, number>(),
				toolFileArgs: new Map<string, string>(),
				subagentTimers: new Map<string, number>(),
				subagentParentMap: new Map<string, string>(),
				externalEditOps: new Map<string, number>(),
				pendingStartEdits: new Map<string, Promise<void>>(),
				disposeController: new AbortController(),
				terminalSessionMap: new Map<string, { sessionId: string; commandId: string }>(),
				terminalCommandLines: new Map<string, string>(),
				terminalArtifacts: new Map(),
				inInitPhase: true,
				emittedFileRefs: new Set<string>(),
				pendingWorkerAsks: new Map<string, IWorkerPermissionAsk>(),
				watchedFileChanges: new Set<string>(),
			};
			this._sessionRuntimes.set(sessionResource, runtime);
		}
		return runtime;
	}

	private _disposeRuntime(sessionResource: URI): void {
		const runtime = this._sessionRuntimes.get(sessionResource);
		if (!runtime) {
			return;
		}

		// Abort any pending invoke/continuation Promise
		runtime.disposeController.abort();

		const externalEditOps = new Map(runtime.externalEditOps);
		const pendingStartEdits = new Map(runtime.pendingStartEdits);
		void this._cleanupExternalEditsForSession(sessionResource, externalEditOps, pendingStartEdits);

		runtime.workspaceWatcher?.dispose();
		runtime.workspaceWatcher = undefined;
		runtime.watchedFileChanges.clear();
		runtime.lastSubagentToolCallId = undefined;
		runtime.toolStartTimes.clear();
		runtime.toolFileArgs.clear();
		runtime.subagentTimers.clear();
		runtime.subagentParentMap.clear();
		runtime.externalEditOps.clear();
		runtime.pendingStartEdits.clear();
		runtime.terminalSessionMap.clear();
		runtime.terminalCommandLines.clear();
		runtime.terminalArtifacts.clear();
		// WORKER-PERMISSION-ASK-TRANSPORT: close SSE subscription + drop any
		// queued asks; auto-deny outstanding requests since the chat thread
		// is going away.
		for (const askId of runtime.pendingWorkerAsks.keys()) {
			this._workerPermissionService.decide(askId, 'deny', 'chat session disposed').catch(() => { /* swallow */ });
		}
		runtime.pendingWorkerAsks.clear();
		runtime.permissionSub?.dispose();
		runtime.permissionSub = undefined;
		runtime.activeProgress = undefined;
		runtime.activeFinish = undefined;
		this._ensureEditorEffects().clearSessionState(sessionResource);
		this._sessionRuntimes.delete(sessionResource);
		// Phase 0 #8e: also tear down stateless-path bookkeeping. The chat
		// thread is closing so any in-flight trace should abort (the SSE
		// iterator will throw AbortError → benign cancelled-result return).
		const trace = this._statelessTraces.get(sessionResource);
		if (trace) {
			trace.abortController.abort();
			this._statelessTraces.delete(sessionResource);
			// Fire-and-forget server-side cancel; reasoner stops billing for
			// the in-flight LLM call. 404 (race) silently OK.
			void this._statelessClient?.cancel(trace.traceId, 'session_disposed').catch(() => { /* swallow */ });
		}
		this._statelessChatSessionIds.delete(sessionResource);
		// Drop the durable id + probe-dedup marker — the thread is gone (cleared),
		// so there is nothing left to resume on a future startup.
		this._removeStoredStatelessChatSessionId(sessionResource);
		this._probedStatelessSessions.delete(sessionResource.toString());
	}




	private async _cleanupExternalEditsForSession(
		sessionResource: URI,
		externalEditOps: Map<string, number>,
		pendingStartEdits: Map<string, Promise<void>>,
	): Promise<void> {
		if (!externalEditOps.size && !pendingStartEdits.size) {
			return;
		}

		for (const pending of pendingStartEdits.values()) {
			try {
				await pending;
			} catch (err) {
				this._logService.warn('[ChipOS Agent] Pending external edit start rejected during runtime dispose:', String(err));
			}
		}

		const editingSession = this._getEditingSession(sessionResource);
		const responseModel = this._getResponseModel(sessionResource);
		if (editingSession && responseModel) {
			for (const opId of externalEditOps.values()) {
				try {
					await editingSession.stopExternalEdits(responseModel, opId);
				} catch (err) {
					this._logService.warn(`[ChipOS Agent] stopExternalEdits failed during runtime dispose (opId=${opId}):`, String(err));
				}
			}
			return;
		}

		if (editingSession) {
			try {
				await editingSession.stop();
			} catch (err) {
				this._logService.warn('[ChipOS Agent] editingSession.stop() failed during runtime dispose:', String(err));
			}
		}
	}


	// ── WORKER-PERMISSION-ASK-TRANSPORT helpers ─────────────────────────────

	private _onWorkerPermissionAsk(ask: IWorkerPermissionAsk): void {
		const runtime = this._findRuntimeByBackendSessionId(ask.sessionId);
		if (!runtime) {
			this._logService.info(`[ChipOS Agent] worker ASK ${ask.askId} dropped — no runtime for session ${ask.sessionId}`);
			// Best-effort: auto-deny so the worker doesn't hang on a 5-min TTL
			// when the IDE has no UI for the asking session.
			this._workerPermissionService.decide(ask.askId, 'deny', 'no IDE runtime for session').catch(() => { /* swallow */ });
			return;
		}

		// v2 PERMISSION-APPROVAL-UX-V2 §1: when the user has selected Bypass
		// Approvals / Autopilot from the chat permission dropdown, silently
		// auto-allow ASKs instead of rendering a confirmation card. The
		// existing in-progress invoke continues uninterrupted, the user
		// never sees a card, and the file write completes within the
		// normal latency budget.
		if (runtime.permissionLevel && isAutoApproveLevel(runtime.permissionLevel)) {
			this._logService.info(`[ChipOS Agent] auto-allow ASK ${ask.askId} (permission level: ${runtime.permissionLevel})`);
			this._workerPermissionService.decide(ask.askId, 'allow', `auto: ${runtime.permissionLevel}`).catch(err => {
				this._logService.warn(`[ChipOS Agent] auto-allow decide failed for ${ask.askId}: ${err}`);
			});
			return;
		}

		const confirmation = this._buildWorkerAskConfirmation(ask);
		if (runtime.activeProgress) {
			runtime.activeProgress([confirmation]);
			// CRITICAL: end the invoke so VS Code chat's Submit button activates.
			// Without this the framework keeps the round "in flight" and the
			// confirmation row's Submit is greyed out until the round ends
			// (typically via reasoner tool-timeout 30-60s later — too late).
			// Mirrors what the reasoner-side ConfirmRequest handler does
			// (`ctx.finish({}, 'Awaiting confirmation')`).
			runtime.activeFinish?.({}, 'Awaiting worker permission');
		} else {
			// Defer until the next invoke flushes pendingWorkerAsks.
			runtime.pendingWorkerAsks.set(ask.askId, ask);
		}
	}

	private _buildWorkerAskConfirmation(ask: IWorkerPermissionAsk): IChatConfirmation {
		// Phase B (PERMISSION-APPROVAL-UX-V2 §5): data carries all Phase A
		// extras so ChipOSPermissionCardContentPart can render the full card
		// without relying on the markdown message (which was cramped into 3
		// lines by BaseChatConfirmationWidget._getPreview).  The message field
		// is kept as a short plain string for accessibility / screen-readers;
		// the custom DOM renderer ignores it.
		const title = localize('chipos.workerPermission.title', 'Worker requests permission');
		const allowOnce = localize('chipos.workerPermission.allowOnce', 'Allow once');
		const allowWorkspace = localize('chipos.workerPermission.allowWorkspace', 'Always in workspace');
		const allowAlways = localize('chipos.workerPermission.allowAlways', 'Always globally');
		const deny = localize('chipos.workerPermission.deny', 'Deny');
		return {
			kind: 'confirmation',
			title,
			message: localize(
				'chipos.workerPermission.message',
				'{0} {1}',
				ask.tool,
				ask.specifier,
			),
			data: {
				// WORKER-PERMISSION-ASK-TRANSPORT marker — triggers chipos
				// routing in chipOSChatAgent's acceptedConfirmationData handler.
				__chiposWorkerAskId: ask.askId,
				requestId: ask.askId,
				sessionId: ask.sessionId,
				// Phase A extras for ChipOSPermissionCardContentPart rendering.
				tool: ask.tool,
				specifier: ask.specifier,
				targetExists: ask.targetExists,
				targetSizeBytes: ask.targetSizeBytes,
				matchedRule: ask.matchedRule,
				matchedLayer: ask.matchedLayer,
				contentPreview: ask.contentPreview,
				options: [
					{ label: allowOnce,      action_id: 'allow_once' },
					{ label: allowWorkspace, action_id: 'allow_workspace' },
					{ label: allowAlways,    action_id: 'allow_always' },
					{ label: deny,           action_id: 'deny' },
				],
			},
			buttons: [allowOnce, allowWorkspace, allowAlways, deny],
		};
	}


	private _findRuntimeByBackendSessionId(sessionId: string): IChatSessionRuntime | undefined {
		if (!sessionId) {
			return undefined;
		}
		for (const [, runtime] of this._sessionRuntimes) {
			if (runtime.backendSessionId === sessionId) {
				return runtime;
			}
		}
		return undefined;
	}


	// ── Client lifecycle ───────────────────────────────────────────────────


	// =========================================================================
	// Phase 0 #8e — Stateless reasoner invoke path (ADR-017 C 档)
	// =========================================================================
	//
	// All state below is scoped to the stateless path: legacy invoke never reads
	// or writes these fields. Lifetimes:
	//   - `_statelessClient`: lazy + reused across invokes (host + token stable
	//     for the lifetime of the agent). Recreated only when baseUrl changes.
	//   - `_statelessChatSessionIds`: stable per-chat-thread id minted on first
	//     invoke (analogue of the legacy `backendSessionId` reuse). Reset when
	//     the chat session is disposed (`_disposeRuntime`).
	//   - `_statelessTraces`: per-session in-flight trace meta — used by #8g
	//     (cancel + replay) to know which trace_id to address.

	private _statelessClient: StatelessClient | undefined;
	private _statelessClientBaseUrl: string | undefined;
	/**
	 * FEAT-004 / H-3: lazily-spawned isolated subprocess host for executable
	 * plugin hooks. Created on first consented function-hook eval; disposed in
	 * {@link dispose}.
	 */
	private _pluginHookHost: ChiposPluginHookHost | undefined;
	/** Plugin ids the user has consented to run executable hooks for, this session (H-3). */
	private readonly _consentedHookPlugins = new Set<string>();
	private readonly _statelessChatSessionIds = new ResourceMap<string>();
	private readonly _statelessTraces = new ResourceMap<{
		traceId: string;
		lastSequenceId: number;
		abortController: AbortController;
	}>();
	private readonly _statelessAdapter = new ChatModelToRecordsAdapter();
	private readonly _statelessAssembler = new ConversationAssembler();

	// PHASE-1 §2.9 IDE-restart resume state.
	//   - `_STATELESS_CSID_STORAGE_KEY`: workspace-storage key holding a
	//     {sessionResource → chat_session_id} map so the cs_id survives restart.
	//   - `_probedStatelessSessions`: sessionResources already probed this IDE
	//     run, so we offer resume at most once per thread per launch.
	private static readonly _STATELESS_CSID_STORAGE_KEY = 'chipos.stateless.chatSessionIds';
	private readonly _probedStatelessSessions = new Set<string>();

	/**
	 * Lazy / reused StatelessClient. Recreated when the configured baseUrl
	 * changes (mode switch, user override edit). Token is read at request time
	 * via the bearer header inside the client — but the StatelessClient API
	 * takes a static token in its options, so we re-mint when the token
	 * rotates as well (cheap — instance is option bag + fetch wrapper).
	 */
	private async _ensureStatelessClient(): Promise<StatelessClient> {
		const baseUrl = resolveReasoningUrl(this._configurationService, this._productService);
		// P0.5: hand the client a per-request token PROVIDER instead of a token
		// captured once here. The client resolves it before EVERY request, so
		// `getAccessToken`'s near-expiry auto-refresh keeps long-lived turns
		// (resume / late confirm_response / tool_result that fire minutes after
		// invoke-start) from sending an expired JWT → was 401 at the ~10-min
		// mark. No more re-minting on rotation — the provider always sees fresh.
		const authTokenProvider = async (): Promise<string | undefined> => {
			try {
				return await this._tokenManager?.getAccessToken();
			} catch (err) {
				// Cloud reasoner with auth disabled is a valid dev mode — fall
				// through tokenless. A 401 would surface at request time.
				this._logService.warn('[ChipOS Stateless] getAccessToken failed (continuing tokenless):', String(err));
				return undefined;
			}
		};
		if (!this._statelessClient || this._statelessClientBaseUrl !== baseUrl) {
			this._statelessClient = new StatelessClient({ baseUrl, authTokenProvider });
			this._statelessClientBaseUrl = baseUrl;
			this._logService.info('[ChipOS Stateless] Client initialised, baseUrl=%s (per-request token)', baseUrl);
		}
		return this._statelessClient;
	}

	/**
	 * Stable per-chat-thread id. Minted on first stateless invoke, then DURABLE:
	 * persisted to workspace storage so it survives an IDE restart. Recovery on
	 * startup (the `_maybeProbeInFlightTurn` path + this lookup) is what lets
	 * GET /turn_state find a turn that was in-flight when the window reloaded —
	 * the in-memory `_statelessChatSessionIds` map is empty after restart, so
	 * without the storage fallback we would mint a *new* id and lose the link.
	 */
	private _statelessChatSessionIdFor(sessionResource: URI): string {
		let id = this._statelessChatSessionIds.get(sessionResource);
		if (!id) {
			// Recover a durable id minted in a previous IDE run (survives restart).
			id = this._readStoredStatelessChatSessionId(sessionResource);
		}
		if (!id) {
			// PROD-READINESS P0-B: use an unguessable UUID, not a
			// counter+timestamp. Combined with the reasoner-side owner check
			// (claim_or_verify_owner), this prevents another authed user from
			// enumerating / hijacking someone else's chat_session_id.
			id = `stateless_chat_${generateUuid()}`;
			this._logService.info('[ChipOS Stateless] New chat_session_id:', id);
		}
		this._statelessChatSessionIds.set(sessionResource, id);
		this._writeStoredStatelessChatSessionId(sessionResource, id);
		return id;
	}

	/**
	 * Build an `InvokeRequest` from the live `IChatModel` + user settings.
	 *
	 * Returns the request + the records the adapter produced (kept for
	 * debugging / e2e assertions) + the extracted langgraph_state_blob.
	 *
	 * Throws `ConversationAssemblyError` when the model is malformed (e.g.
	 * empty after walking) — caller surfaces as inline error.
	 */
	private _buildStatelessInvokeRequest(
		request: IChatAgentRequest,
		model: IChatModel,
		traceId: string,
		chatSessionId: string,
		expectedCatalogVersion: string,
	): { req: InvokeRequest; messages: Message[] } {
		const records = this._statelessAdapter.fromChatModel(model);
		// Defensive: model may not yet include the just-submitted user
		// request (timing-dependent on how VS Code flushes the model). If
		// the last record isn't the user's current prompt, append it so
		// the reasoner sees what the user just sent. Idempotent: when the
		// model already has it, we don't double-append.
		const lastRecord = records[records.length - 1];
		const isLastUserPrompt = lastRecord
			&& lastRecord.role === 'user'
			&& typeof lastRecord.content === 'string'
			&& lastRecord.content === request.message;
		if (!isLastUserPrompt) {
			records.push({ role: 'user', content: request.message });
		}
		const { messages } = this._statelessAssembler.assemble(records);

		const llm = this._buildLlmConfig();
		const workspace = this._getWorkspaceRoot() ?? '';
		const autoApproveMode = this._configurationService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
		const modeFromInstructions = request.modeInstructions?.name;
		const isSpecMode = modeFromInstructions === 'spec' || this._configurationService.getValue<string>('chipos.chatMode') === 'spec';
		const mode: 'agent' | 'spec' = isSpecMode ? 'spec' : 'agent';
		const thinking = this._configurationService.getValue<boolean>('chipos.showThinking') ?? false;
		// FEAT-011a: per-turn tool allow-list. chipos.tools.allowlist (default []) — when
		// non-empty, the reasoner restricts this turn's actionable tools to these names.
		const allowedTools = this._configurationService.getValue<string[]>('chipos.tools.allowlist');
		// FEAT-011c: executable skill scripts require BOTH the opt-in flag AND a trusted
		// workspace; the reasoner drops run_skill_script unless this is true.
		const skillScriptsEnabled = this._configurationService.getValue<boolean>('chipos.skills.executableScripts') === true
			&& this._workspaceTrustService.isWorkspaceTrusted();

		// Phase 1 (ADR-018 §2 D8): tools registered out-of-band via
		// /tools/register, referenced by expected_catalog_version (D9, 412 on
		// mismatch → IDE re-registers + retries). LangGraph state lives
		// reasoner-side now (FileStateStore), no longer round-trips through IDE.
		const req: InvokeRequest = {
			trace_id: traceId,
			chat_session_id: chatSessionId,
			messages,
			mode,
			model: llm.model,
			provider: llm.provider || 'auto',
			base_url: llm.base_url || null,
			api_key_alias: null,
			// F6 fix (PHASE-1-IMPLEMENTATION-AUDIT post-deploy): ship the actual
			// provider key in-band, mirroring the legacy stateful invoke path.
			// Without this every Phase 1 LLM call 401s because the reasoner
			// deploy doesn't have CHIPOS_API_KEY_<ALIAS> envs provisioned and
			// `api_key_alias=null` resolves to empty server-side. ADR-018 §1.1
			// proper vault is Phase 2 work.
			api_key: llm.api_key || null,
			thinking,
			expected_catalog_version: expectedCatalogVersion,
			workspace_path: workspace,
			auto_approve_mode: autoApproveMode,
			...(Array.isArray(allowedTools) && allowedTools.length ? { allowed_tools: allowedTools } : {}),
			skill_scripts_enabled: skillScriptsEnabled,
			metadata: {
				ide_request_id: request.requestId,
				ide_session_resource: request.sessionResource.toString(),
			},
			protocol_version: 1,
		};
		return { req, messages };
	}

	/**
	 * Phase 0 #8e — stateless invoke path entry point.
	 *
	 * Replaces the legacy `_ensureClient` + `streamClient.sendTask` flow with:
	 *   1. Walk live `IChatModel` → ChatSessionRecord[] (adapter)
	 *   2. Assemble + extract latest langgraph_state_blob (assembler)
	 *   3. shouldCompact? compact() → swap messages (compactor)  — wired but
	 *      only fires past the trigger threshold; first turn is a no-op
	 *   4. POST /api/v1/invoke + iterate SSE events → progress callbacks
	 *   5. On round_end, persist langgraph_state_blob (#8f wiring — deferred)
	 *
	 * Cancel + replay (#8g) hooks into `_statelessTraces[sessionResource]` —
	 * a future Stop button handler reads the traceId and calls
	 * `client.cancel(traceId)`. Network-interrupt replay is handled inline.
	 */
	private async _invokeStateless(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const startTime = Date.now();
		const traceId = generateUuid();
		const chatSessionId = this._statelessChatSessionIdFor(request.sessionResource);
		this._logService.info('[ChipOS Stateless] invoke start: trace=%s chat_session=%s msg_len=%d', traceId, chatSessionId, request.message.length);

		// Resolve client up front so config / token errors surface before we
		// burn cycles walking the chat model.
		let client: StatelessClient;
		try {
			client = await this._ensureStatelessClient();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error('[ChipOS Stateless] client init failed:', msg);
			progress([this._markdown(`$(error) **ChipOS:** unable to initialise stateless client — ${msg}`)]);
			return { errorDetails: { message: msg } };
		}

		// Pull the live model. Without it we have no history to assemble.
		const model = this._chatService.getSession(request.sessionResource);
		if (!model) {
			const msg = `chat session ${request.sessionResource.toString()} not found in IChatService`;
			this._logService.error('[ChipOS Stateless]', msg);
			progress([this._markdown(`$(error) **ChipOS:** ${msg}`)]);
			return { errorDetails: { message: msg } };
		}

		// Phase 1 D9: register tool catalog (idempotent, lazy per chat session)
		// + capture version to thread through invoke (412 on mismatch retry).
		// For now we send a minimal stub catalog — full MCP/worker/IDE-builtin
		// gather is a separate task. catalog_version is opaque server-hash;
		// caller doesn't introspect.
		let catalogVersion: string;
		try {
			catalogVersion = await this._ensureToolsRegistered(client, chatSessionId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn('[ChipOS Stateless] tool registration failed (continuing with empty catalog hint):', msg);
			catalogVersion = 'empty-no-register';  // 412 path will surface if reasoner cares
		}

		// Build the invoke request (adapter + assembler + settings stitching).
		let invokeReq: InvokeRequest;
		try {
			invokeReq = this._buildStatelessInvokeRequest(request, model, traceId, chatSessionId, catalogVersion).req;
		} catch (err) {
			const cause = err instanceof ConversationAssemblyError ? (err.cause ?? 'assembly_error') : 'unknown';
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error('[ChipOS Stateless] assemble failed: %s (cause=%s)', msg, cause);
			progress([this._markdown(`$(error) **ChipOS:** conversation could not be assembled — ${msg}`)]);
			return { errorDetails: { message: msg } };
		}

		// FEAT-001b: attach the user's always-apply rules (workspace .chipos/rules/)
		// so the reasoner injects them as a synthetic message at the head of the
		// conversation (ADR-002). Best-effort — a failure here must never block the
		// turn. (glob + manual rules additionally need the active editor + attach
		// UI; tracked as follow-ups.)
		// FEAT-006c: master kill-switch gates the ENTIRE extension system (rules + commands + skills + hooks + @agent). Hoisted so EVERY injection block below honours it — off = baseline, no residual injection.
		const extensionSystemEnabled = isExtensionSystemEnabled(this._configurationService.getValue('chipos.extensions.beta'));
		try {
			// FEAT-001b (AGENTS.md interop): anchor the rule scan at the directory of
			// the active editor so AGENTS.md / CLAUDE.md files along the chain up to the
			// workspace root are picked up as always-on rules. Undefined when no editor
			// is active — then only `.chipos/rules/` always-rules fire.
			const activeRuleResource = this._editorService.activeEditor?.resource;
			const ruleAnchor = activeRuleResource ? dirname(activeRuleResource) : undefined;
			const rules = await this._instantiationService.createInstance(ChiposRulesService).getRules(ruleAnchor);
			// FEAT-002a: merge rules contributed by installed agent plugins
			// (~/.chipos/plugins/<id>/rules/) — tagged source=plugin so the
			// reasoner renders a `[from plugin <id>]` provenance badge.
			const pluginRules = await this._instantiationService.createInstance(ChiposPluginsService).getPluginRules();
			const allRules = pluginRules.length ? [...rules, ...pluginRules] : rules;
			// FEAT-001c: glob rules apply when the active editor's workspace-relative
			// path matches their globs, so pass it in. Without it only `always` rules
			// fire. (`manual` rules still need an attach UI — tracked as a follow-up.)
			const activeResource = this._editorService.activeEditor?.resource;
			const workspaceRoot = this._getWorkspaceRoot();
			const activeFile = activeResource
				? (workspaceRoot && activeResource.path.startsWith(workspaceRoot)
					? activeResource.path.slice(workspaceRoot.length + 1)
					: activeResource.path)
				: undefined;
			// FEAT-001: a user can manually attach a `manual` rule by typing
			// `@<name>` in the prompt; pass those ids so the collector attaches a
			// rule whose name matches. Safe vs chipos's `@`-file context
			// (chiposAtContextCompletions): the collector only attaches ids that
			// match a known rule name, so file-derived `@basename` ids that don't
			// name a rule are simply ignored. A dedicated rule `@`-completion menu
			// is a follow-up (selector UI).
			const manualRuleIds = Array.from((request.message ?? '').matchAll(/(?:^|\s)@(?<id>[\w-]+)/g), m => m.groups!.id);
			// FEAT-009: honor the prompt-resources feature flag (off => attach nothing).
			// FEAT-006c: AND the chipos.extensions.beta master switch — off returns to
			// the baseline (no injection), with no residual state.
			const promptResourcesEnabled = this._configurationService.getValue<boolean>('chipos.promptResources.enabled') !== false;
			const collected = collectPromptResources(allRules, {
				activeFile,
				enabled: promptResourcesEnabled && extensionSystemEnabled,
				...(manualRuleIds.length ? { manualRuleIds } : {}),
			});
			if (collected.attachments.length) {
				invokeReq.prompt_resource_attachments = collected.attachments;
			}
			// FEAT-006c: stash this turn's attachments for the round-end usage telemetry.
			if (this._pendingExtTelemetry) {
				this._pendingExtTelemetry.attachments = collected.attachments.map(a => ({ content: JSON.stringify(a.payload ?? {}) }));
			}
			// FEAT-008: record this turn's collection (even when empty) so the
			// "ChipOS: Show Prompt Inputs" command can render what was attached.
			this._promptInputsService.setLast({ result: collected, activeFile });
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] prompt-resource collection failed (continuing): %s', err instanceof Error ? err.message : String(err));
		}

		// FEAT-001: a slash command (`.chipos/commands/<name>.md`) is injected on
		// demand — when the user's message opens with `/<name>` — as a `command`
		// prompt-resource attachment the reasoner renders alongside rules (ADR-002).
		// Best-effort: a failure here (or no match) must never block the turn.
		try {
			// The user can invoke a command either as a parsed slash command
			// (`request.command`, when the chat framework recognises it) or by
			// typing `/<name>` inline in the prompt (kept in `request.message`).
			// Accept both so collection is robust to how the input is parsed.
			const explicitCommand = (request as { command?: string }).command;
			const inlineMatch = /(?:^|\s)\/(?<name>[\w-]+)(?:[ \t]+(?<args>[^\n]*))?/.exec(request.message ?? '');
			const commandName = explicitCommand || inlineMatch?.groups?.name;
			if (commandName && extensionSystemEnabled) {
				const commands = await this._instantiationService.createInstance(ChiposCommandsService).getCommands();
				// FEAT-002a: also match commands contributed by installed plugins.
				const pluginCommands = await this._instantiationService.createInstance(ChiposPluginsService).getPluginCommands();
				const command = [...commands, ...pluginCommands].find(c => c.name === commandName);
				if (command) {
					// FEAT-001: substitute $ARGUMENTS / $N / $name with the user's
					// arguments (the text after `/<name>`) before send — the reasoner
					// renders payload.body verbatim, so this must happen IDE-side. For a
					// framework-parsed command the `/<name>` prefix is stripped, so the
					// whole message is the argument string.
					let rawArgs = inlineMatch?.groups?.args ?? '';
					if (!rawArgs && explicitCommand) {
						rawArgs = request.message ?? '';
					}
					const body = substituteCommandArgs(command.body, rawArgs.trim(), command.argumentNames);
					const attachment: PromptResourceAttachment = {
						kind: 'command',
						name: command.name,
						source: command.source,
						source_ref: command.sourceRef,
						reason: 'slash',
						priority: 0,
						payload: { body },
					};
					invokeReq.prompt_resource_attachments = [...(invokeReq.prompt_resource_attachments ?? []), attachment];
				} else {
					// FEAT-003/P2.7: no direct/plugin command matched — a skill may DECLARE
					// this slash command (SKILL.md `command:`). Eager-load its body + inject
					// it as the command so the model applies the skill this turn. Direct +
					// plugin commands win (checked first), so a skill can't shadow them.
					const skillsSvc = this._instantiationService.createInstance(ChiposSkillsService);
					const skill = (await skillsSvc.getSkills()).find(s => s.command === commandName);
					if (skill) {
						const bodyRes = await skillsSvc.readBody(skill.name);
						if (!bodyRes.isError && bodyRes.content) {
							let rawArgs = inlineMatch?.groups?.args ?? '';
							if (!rawArgs && explicitCommand) {
								rawArgs = request.message ?? '';
							}
							const body = substituteCommandArgs(bodyRes.content, rawArgs.trim(), undefined);
							const attachment: PromptResourceAttachment = {
								kind: 'command',
								name: commandName,
								source: skill.source === 'plugin' ? 'plugin' : 'user',
								source_ref: skill.source_ref,
								reason: 'slash',
								priority: 0,
								payload: { body },
							};
							invokeReq.prompt_resource_attachments = [...(invokeReq.prompt_resource_attachments ?? []), attachment];
						}
					}
				}
			}
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] command collection failed (continuing): %s', err instanceof Error ? err.message : String(err));
		}

			// FEAT-008: the slash-command attachment is appended AFTER the rules
			// snapshot is recorded above; fold the full per-turn set (rules + command)
			// back into the snapshot so "ChipOS: Show Prompt Inputs" reflects everything
			// actually sent, not rules only. Best-effort — never blocks the turn.
			try {
				const recorded = this._promptInputsService.getLast();
				const full = invokeReq.prompt_resource_attachments ?? [];
				if (recorded && full.length !== recorded.result.attachments.length) {
					this._promptInputsService.setLast({
						result: { attachments: full, omitted: recorded.result.omitted },
						activeFile: recorded.activeFile,
					});
				}
			} catch {
				// observability only — must never affect the turn
			}

		// FEAT-005 Stage B: route the turn to a user-defined subagent when the user
		// types `@<name>` and a matching enabled agent exists (.chipos/agents/<name>.md
		// or the user-global plane). The reasoner applies the agent instructions as a
		// persona overlay for this turn. Best-effort — never blocks the turn.
		try {
			// chipos repurposes `@` for FILE attachments (chiposAtContextCompletions
			// inserts a literal `@<basename>` into the message), so an attached file
			// whose stem equals an enabled subagent name would otherwise silently hijack
			// the whole turn into that persona. Exclude any `@<stem>` that names an
			// attached file/folder context.
			const attachedStems = new Set(
				this._extractMentions(request)
					.filter(m => m.type === 'file' || m.type === 'folder')
					.map(m => (m.path.split('/').pop() ?? '').split('.')[0].toLowerCase())
					.filter(Boolean)
			);
			const agentMatch = /(?:^|\s)@(?<agent>[\w-]+)/.exec(request.message ?? '');
			const agentName = agentMatch?.groups?.agent;
			if (agentName && !attachedStems.has(agentName.toLowerCase()) && extensionSystemEnabled) {
				const def = await this._instantiationService.createInstance(ChiposAgentsService).getAgentDefinition(agentName);
				if (def) {
					invokeReq.selected_agent = { name: def.name, instructions: def.instructions, ...(def.description ? { description: def.description } : {}), ...(def.tools && def.tools.length ? { tools: def.tools } : {}), ...(def.mode ? { mode: def.mode } : {}) };
				}
			}
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] @agent resolution failed (continuing): %s', err instanceof Error ? err.message : String(err));
		}

		// FEAT-003: attach the workspace skill catalog headers (.chipos/skills/<id>/SKILL.md)
		// so the reasoner renders a `## Available Skills` segment; the model
		// lazy-loads a body via `read_skill_body` only when it decides to use one.
		// Header-only — bodies are never shipped here. Best-effort.
		try {
			const skills = await this._instantiationService.createInstance(ChiposSkillsService).getSkills();
			// FEAT-002a: also surface skills contributed by installed plugins
			// (header only — body lazy-loads via read_skill_body, FEAT-003).
			const pluginSkills = await this._instantiationService.createInstance(ChiposPluginsService).getPluginSkills();
			const allSkills = pluginSkills.length ? [...skills, ...pluginSkills] : skills;
			if (allSkills.length && extensionSystemEnabled) {
				invokeReq.skills = allSkills;
			}
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] skill collection failed (continuing): %s', err instanceof Error ? err.message : String(err));
		}

		// FEAT-004: attach the user's configured hooks (workspace .chipos/hooks/)
		// so the reasoner registers them as per-turn dispatcher subscribers; a
		// `deny` hook at `tool.before_dispatch` blocks the matching tool.
		// Best-effort: a failure here must never block the turn.
		try {
			const hooks = await this._instantiationService.createInstance(ChiposHooksService).getHooks();
			// FEAT-002a/004: also surface hooks contributed by installed plugins
			// (plugins/<id>/hooks/*.json), tagged source=plugin.
			const pluginHooks = await this._instantiationService.createInstance(ChiposPluginsService).getPluginHooks();
			const allHooks = pluginHooks.length ? [...hooks, ...pluginHooks] : hooks;
			// FEAT-004 B6: chipos.hooks.disable is the global kill switch (attach no
			// hooks at all, declarative or executable); tier-2 function hooks
			// additionally require the chipos.hooks.executablePlugins opt-in so an
			// installed plugin's function hook stays inert until enabled. See
			// filterHooksForInvoke.
			const toAttach = filterHooksForInvoke(allHooks, {
				executablePlugins: this._configurationService.getValue<boolean>('chipos.hooks.executablePlugins') === true,
				disable: this._configurationService.getValue<boolean>('chipos.hooks.disable') === true || !extensionSystemEnabled,
			});
			if (toAttach.length) {
				invokeReq.hooks = toAttach;
			}
			// FEAT-006c: stash hook count for the round-end usage telemetry.
			if (this._pendingExtTelemetry) {
				this._pendingExtTelemetry.hooks = toAttach.map(() => ({}));
			}
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] hook collection failed (continuing): %s', err instanceof Error ? err.message : String(err));
		}

		// Optional compaction. Plan B from ADR-017 Q3: client owns the trigger;
		// when over budget we POST /api/v1/compact, swap messages, retry assemble
		// would be ideal but compact returns a single summary we just prepend.
		try {
			// Pass user's chosen model to the compactor so the summary call
			// goes through the same provider/key the rest of the conversation
			// uses; user is paying for it either way.
			const compactor = new ConversationCompactor(
				{ compact: req => client.compact(req) },
				{ summaryModel: invokeReq.model },
			);
			if (compactor.shouldCompact(invokeReq.messages)) {
				this._logService.info('[ChipOS Stateless] compact triggered (est tokens=%d)', compactor.estimateTokens(invokeReq.messages));
				progress([this._progress('$(history) Conversation too long — summarising older turns…', true)]);
				const compacted = await compactor.compact(
					invokeReq.messages,
					chatSessionId,
					generateUuid(),
				);
				invokeReq.messages = compacted;
			}
		} catch (err) {
			// Compaction is best-effort: failure means we just send the long
			// conversation as-is and let the server / model fall back to its
			// own context-window handling. Log + continue.
			this._logService.warn('[ChipOS Stateless] compaction failed (continuing uncompacted):', String(err));
		}

		// Track trace for #8g cancel + replay.
		const abortController = new AbortController();
		this._statelessTraces.set(request.sessionResource, {
			traceId,
			lastSequenceId: 0,
			abortController,
		});
		// Bridge the framework CancellationToken → AbortSignal so user clicks
		// on the Stop button drop our SSE iterator.
		const cancelListener = token.onCancellationRequested(() => {
			this._logService.info('[ChipOS Stateless] token cancellation — aborting + posting /cancel');
			abortController.abort();
			// #9: settle any confirm card still up so it doesn't linger with live
			// buttons after the turn is cancelled (swaps to a "已取消" pill; the
			// parked-confirm handler skips its POST since /cancel already fired).
			this._retireStatelessConfirmsForTrace(traceId, 'cancelled');
			// Fire-and-forget server-side cancel so the reasoner can stop the
			// in-flight LLM call + bill less. 404 (race) is silently OK.
			void client.cancel(traceId, 'user_cancelled').catch(err => {
				this._logService.warn('[ChipOS Stateless] /cancel POST failed (likely race):', String(err));
			});
		});

		// Stream + dispatch.
		let firstProgressTime: number | undefined;
		const trackFirstProgress = () => {
			if (firstProgressTime === undefined) {
				firstProgressTime = Date.now() - startTime;
			}
		};
		let assistantTextBuf = '';
		const flushAssistantText = () => {
			if (assistantTextBuf.length === 0) {
				return;
			}
			progress([this._markdown(assistantTextBuf)]);
			assistantTextBuf = '';
		};
		// [ChipOS] Live-render mirror of the reasoner accumulator's
		// `_saw_streamed_text` (stateless_agentcore_driver.py:156): did ANY
		// assistant text stream this turn (model_output / content_block_delta)?
		// Gates whether a final `chat` event's `replyText` is rendered — only a
		// reply that never streamed (subagent / resume / analog / non-streaming
		// provider) must be surfaced from `chat`; a streamed reply duplicates it.
		let sawStreamedText = false;

		let roundEndReceived = false;
		let errorResult: IChatAgentResult | undefined;
		let usage: TokenUsage | undefined;
		// [ChipOS] Pair tool_call_emitted (args) with tool_result_observed
		// (output preview) by callId for the collapsible tool card.
		const statelessToolInputs = new Map<string, { toolName: string; rawInput: string; label?: IMarkdownString }>();
		// [ChipOS] Fusion: sub-agent (composite role) delegation cards, turn-scoped.
		// The reasoner has no model `task` tool call for composite roles, so the
		// FIRST `subagent_event` frame per role synthesizes the parent card and
		// each tool_start/tool_end nests as a child. See `_renderStatelessSubagentEvent`.
		const subagentCardState = createSubagentCardState();
		// [ChipOS] Latest todo list seen from write_todos this turn. The live list
		// drives the native sticky widget above the input; the final state is
		// graduated into a permanent inline card when the turn ends (finish block).
		let latestTodos: IChatTodo[] = [];
		// Phase 1 round_end carries final_messages; we don't act on them in
		// the IDE (the framework appends our return value's messages naturally
		// via the chat model), but we keep last-seen for telemetry / future use.
		let lastFinalMessages: Message[] | undefined;
		// [ChipOS][F-4] round_end.final_result.followups → surfaced as native
		// clickable reply chips via provideFollowups (stashed on result metadata).
		let lastFollowups: string[] | undefined;
		// Phase 1 checkpoint events bump our resume watermark for the SSE
		// drop / resume flow (handled in `_statelessTraces` map below).

		const applyDispatch = (handled: DispatchResult): void => {
			if (handled.appendText) {
				assistantTextBuf += handled.appendText;
				sawStreamedText = true;
				trackFirstProgress();
			}
			if (handled.replyText && !sawStreamedText) {
				// A reply that never streamed (subagent / resume / analog / a
				// non-streaming provider): its `chat` text is the only carrier, so
				// render it. If anything streamed, replyText duplicates it → drop
				// (gated by sawStreamedText). Mirrors the reasoner accumulator's
				// `_saw_streamed_text` guard on the live render side.
				assistantTextBuf += handled.replyText;
				trackFirstProgress();
				flushAssistantText();
			}
			if (handled.flushText) {
				flushAssistantText();
			}
			if (handled.progressMessage) {
				progress([this._progress(handled.progressMessage.content, handled.progressMessage.shimmer)]);
			}
			if (handled.toolInvocation) {
				const todos = this._renderStatelessToolInvocation(handled.toolInvocation, progress, request, statelessToolInputs);
				// `undefined` = not a write_todos call (leave latestTodos as-is); an
				// array (possibly EMPTY) = a write_todos snapshot. An empty list is a
				// deliberate "clean slate" clear (legacy B-T1) — must reset latestTodos
				// so the finish block doesn't graduate a stale card. So gate on the
				// array's existence, NOT its length.
				if (todos) { latestTodos = todos; }
			}
			if (handled.subagentEvent) {
				// [ChipOS] Fusion: composite-role delegation → collapsible
				// ChatSubagentContentPart card (parent header + nested tool
				// rows), replacing the old transient one-line progress message.
				trackFirstProgress();
				this._renderStatelessSubagentEvent(handled.subagentEvent, progress, request, subagentCardState);
			}
			if (handled.edaParts || handled.markdownContents || handled.taskSummary) {
				// [ChipOS] Fusion: rich EDA report cards (sim/lint/coverage/PPA/
				// negotiation/parallel/spec) + diff-preview markdown + task-summary
				// card. Phase 0 dropped all of these (`default: {}`) so a prod
				// stateless turn showed only tool rows; restore the legacy cards.
				trackFirstProgress();
				this._renderStatelessEdaParts(handled, progress);
			}
			if (handled.thinkingText) {
				progress([{ kind: 'thinking', value: handled.thinkingText } satisfies IChatThinkingPart]);
			}
			if (handled.markdownError) {
				progress([this._markdown(handled.markdownError)]);
			}
			if (handled.agentError) {
				this._renderStatelessAgentError(handled.agentError, progress);
			}
			if (handled.usage !== undefined) {
				usage = handled.usage;
			}
			if (handled.errorMessage !== undefined) {
				errorResult = { errorDetails: { message: handled.errorMessage } };
			}
			if (handled.terminate) {
				roundEndReceived = true;
				// [ChipOS] Fusion: settle any sub-agent cards still open at round
				// end (no `complete` frame exists on this path) so none spins on.
				this._finalizeStatelessSubagents(progress, subagentCardState);
				// FEAT-006c: emit the per-turn extension-usage telemetry (content-free).
				if (this._pendingExtTelemetry) {
					this._statelessObs.extensionUsage({
						...this._pendingExtTelemetry,
						cacheCreationTokens: usage?.cache_creation_input_tokens,
						cacheReadTokens: usage?.cache_read_input_tokens,
					});
					this._pendingExtTelemetry = undefined;
				}
			}
			if (handled.finalMessages !== undefined) {
				lastFinalMessages = handled.finalMessages;
			}
			if (handled.followups !== undefined) {
				lastFollowups = handled.followups;
				// [ChipOS][F-4 redesign] Render the next-step suggestions as an
				// inline, non-blocking command-button card in the conversation flow
				// (replaces the native chips floating above the input box).
				if (lastFollowups.length > 0) {
					const followupCard = this._buildFollowupsCard(request.sessionResource, lastFollowups);
					if (followupCard) {
						progress([followupCard]);
					}
				}
			}
			// Phase 1 reverse channel: ide_tool_call → execute + POST result back.
			// Fire-and-forget on a background task so the SSE loop keeps draining
			// new events (reasoner's agent loop is awaiting our POST; if we
			// blocked the SSE consumer to await execution, a slow worker tool
			// could stall every subsequent event for the same trace).
			if (handled.ideToolCall) {
				const call = handled.ideToolCall;
				void this._handleStatelessIdeToolCall(client, traceId, request.sessionResource, call, progress, token).catch(err => {
					this._logService.error('[ChipOS Stateless] ide_tool_call handler failed:', String(err));
				});
			}
			// FEAT-004 / H-3 reverse channel: hook_eval → run the plugin function
			// hook (gated + isolated) + POST decision back. Fire-and-forget like
			// ide_tool_call so the SSE loop keeps draining while the eval runs; the
			// reasoner's agent loop is blocked awaiting our /hook_result POST.
			if (handled.hookEval) {
				const hookEval = handled.hookEval;
				void this._handleStatelessHookEval(client, traceId, request.sessionResource, hookEval, token).catch(err => {
					this._logService.error('[ChipOS Stateless] hook_eval handler failed:', String(err));
				});
			}
			// Phase 1 reverse channel: confirm_request → render card + POST user
			// response. Card rendering is synchronous; user click is what's slow,
			// handled by the existing `acceptedConfirmationData` plumbing below.
			if (handled.confirmRequest) {
				const confirm = handled.confirmRequest;
				this._statelessObs.confirmShown(confirm.cardType);  // §5.2 client mirror
				void this._handleStatelessConfirmRequest(client, traceId, confirm, progress, token).catch(err => {
					this._logService.error('[ChipOS Stateless] confirm_request handler failed:', String(err));
				});
			}
			// Checkpoint: update resume watermark so any /resume retry knows
			// where to pick up from. We use sequence_id from the event itself
			// (set by the outer for-await loop on the trace entry), so the
			// checkpoint event itself is informational here — no extra action.
			if (handled.checkpoint) {
				this._logService.trace(
					'[ChipOS Stateless] checkpoint iter=%d msgs=%d',
					handled.checkpoint.iteration, handled.checkpoint.messagesCount,
				);
			}
			// keepalive / resumedBufferDrained: log + no UI action for now.
			if (handled.keepalive) {
				this._logService.trace('[ChipOS Stateless] keepalive ts=%d', handled.keepalive.ts);
			}
			if (handled.resumedBufferDrained) {
				this._logService.info(
					'[ChipOS Stateless] resume buffer drained at seq=%d',
					handled.resumedBufferDrained.sequenceId,
				);
			}
			// D10 rehydrate: the reasoner restarted mid-turn and re-drove the agent
			// loop. The rehydrated loop re-emits any pending confirm with a FRESH
			// request_id (a new card follows), so retire the card(s) that were live
			// on the now-dead reasoner — otherwise two cards show for one confirm.
			if (handled.resumedLive) {
				this._retireStatelessConfirmsForTrace(traceId);
			}
		};
		const friendlyToolName = (raw: string) => this._friendlyToolName(raw);

		// D9 (ADR-018 §2 D9 / R-S): one-shot 412 catalog_version_mismatch
		// retry. If the reasoner rejects /invoke with 412 (its cached
		// catalog hash differs from what we sent, e.g. another IDE window
		// re-registered or the reasoner restarted) we invalidate our
		// fingerprint cache, re-register fresh, and retry once. Second 412
		// would be a deterministic mismatch (catalog computation diverging
		// between IDE and reasoner) so we surface it like any other HTTP
		// error rather than looping.
		let attempt412Retried = false;
		retryLoop: while (true) {
			try {
				for await (const event of client.invoke(invokeReq, abortController.signal)) {
					const trace = this._statelessTraces.get(request.sessionResource);
					if (trace && event.sequence_id > trace.lastSequenceId) {
						trace.lastSequenceId = event.sequence_id;
					}
					applyDispatch(dispatchStatelessEvent(event, friendlyToolName));
				}
				break retryLoop;  // success — no retry needed
			} catch (err) {
				const verdict = classifySseFailure(err, abortController.signal);
				// D9 412 retry — check BEFORE the switch so we can `continue`.
				if (verdict === 'surface-http'
					&& (err as StatelessHttpError).status === 412
					&& !attempt412Retried) {
					attempt412Retried = true;
					this._logService.warn(
						'[ChipOS Stateless] /invoke 412 catalog_version_mismatch — '
						+ 're-registering tool catalog and retrying once'
					);
					// Clear fingerprint cache so _ensureToolsRegistered
					// actually POSTs (otherwise the R-C optimisation would
					// short-circuit with the same stale version).
					this._statelessCatalogFingerprints.delete(chatSessionId);
					this._statelessCatalogVersions.delete(chatSessionId);
					try {
						const newVersion = await this._ensureToolsRegistered(client, chatSessionId);
						invokeReq.expected_catalog_version = newVersion;
					} catch (regErr) {
						this._logService.error(
							'[ChipOS Stateless] re-register after 412 failed: %s',
							String(regErr),
						);
						progress([this._markdown(
							'$(error) **ChipOS:** tool catalog out of sync with reasoner '
							+ 'and re-register failed — please reload the window'
						)]);
						errorResult = { errorDetails: { message: 'catalog re-register failed' } };
						break retryLoop;
					}
					continue retryLoop;  // retry /invoke with new version
				}
				// Fall through to existing error-handling switch.
				switch (verdict) {
				case 'cancelled':
					this._logService.info('[ChipOS Stateless] aborted by user cancel');
					flushAssistantText();
					cancelListener.dispose();
					this._statelessTraces.delete(request.sessionResource);
					return { errorDetails: { message: localize('chipos.stateless.cancelled', 'Cancelled by user.') } };
				case 'surface-http': {
					const httpErr = err as StatelessHttpError;
					const msg = `reasoner returned HTTP ${httpErr.status}`;
					this._logService.error('[ChipOS Stateless] %s body=%s', msg, JSON.stringify(httpErr.body));
					// 401/403 mid-stream = token expired/invalid: neither resend nor
					// continue helps — route to the auth card (Log In) via an AUTH
					// error_code the renderer recognises (chatAgentErrorPart.ts).
					const isAuth = httpErr.status === 401 || httpErr.status === 403;
					progress([this._statelessFailureCard({
						errorCode: isAuth ? 'AUTH_TOKEN_EXPIRED' : `REASONER_HTTP_${httpErr.status}`,
						message: isAuth
							? localize('chipos.stateless.fail.auth', "登录状态已失效，请重新登录。")
							: localize('chipos.stateless.fail.http', "Reasoner 返回 HTTP {0}。", httpErr.status),
						resumable: !isAuth && isStatelessTurnResumable({ verdict: 'surface-http', httpStatus: httpErr.status }),
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? -1,
					})]);
					errorResult = { errorDetails: { message: msg } };
					break;
				}
				case 'surface-replay-expired':
					this._logService.warn('[ChipOS Stateless] /replay window expired — surfacing error to user');
					progress([this._statelessFailureCard({
						errorCode: 'RECONNECT_EXPIRED',
						message: localize('chipos.stateless.fail.expired', "连接已断开且重连窗口已过期。"),
						resumable: false,
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? -1,
					})]);
					errorResult = { errorDetails: { message: 'replay window expired' } };
					break;
				case 'surface-other': {
					const msg = err instanceof Error ? err.message : String(err);
					this._logService.error('[ChipOS Stateless] unexpected failure:', msg);
					progress([this._statelessFailureCard({
						errorCode: 'REASONER_ERROR',
						message: msg,
						resumable: isStatelessTurnResumable({ verdict: 'surface-other' }),
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? -1,
					})]);
					errorResult = { errorDetails: { message: msg } };
					break;
				}
				case 'replay': {
					// Phase 1 (ADR-018 §2 D10 + R-D): SSE dropped → /resume. The reasoner
					// live-tails the in-flight writer, or (after a reasoner RESTART) rehydrates
					// the agent loop from checkpoint and CONTINUES — including re-emitting a
					// pending confirm card. P2: retry /resume with backoff, because a reasoner
					// restart leaves a window where /resume gets 'Failed to fetch' until it is
					// healthy again; the old single shot gave up and lost the turn. Terminal
					// verdicts (404 turn-gone / 410 buffer-evicted / cancel) break immediately;
					// only transient network errors retry. Each attempt re-resolves the token
					// (P0.5), so an expired JWT refreshes between attempts.
					const maxResumeAttempts = 8;
					this._statelessObs.resumeTriggered('network-drop');  // §5.2 client mirror
					for (let resumeAttempt = 1; resumeAttempt <= maxResumeAttempts && !abortController.signal.aborted; resumeAttempt++) {
						const lastSeq = this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? -1;
						this._logService.warn('[ChipOS Stateless] SSE failed (%s) — /resume attempt %d/%d from seq %d', String(err), resumeAttempt, maxResumeAttempts, lastSeq);
						progress([this._progress('$(sync) Connection interrupted — reconnecting…', true)]);
						try {
							for await (const event of client.resume(chatSessionId, {
								trace_id: traceId,
								last_sequence_id: lastSeq,
								disconnect_reason: 'network',
								// P2: re-supply the LLM key (F6) so a reasoner restart can rehydrate +
								// re-drive the loop — the checkpoint does not persist the raw key, so
								// without this the re-driven LLM call 401s at the provider.
								api_key: invokeReq.api_key,
								api_key_alias: invokeReq.api_key_alias,
							}, abortController.signal)) {
								// Advance the watermark during resume too, so a retry resumes from
								// where we got to (avoids duplicate replay of already-rendered events).
								const trace = this._statelessTraces.get(request.sessionResource);
								if (trace && event.sequence_id > trace.lastSequenceId) {
									trace.lastSequenceId = event.sequence_id;
								}
								applyDispatch(dispatchStatelessEvent(event, friendlyToolName));
							}
							this._statelessObs.resumeOutcome('success', resumeAttempt);  // §5.2 client mirror
							break;  // resume stream completed cleanly
						} catch (replayErr) {
							const replayVerdict = classifySseFailure(replayErr, abortController.signal);
							if (replayVerdict === 'cancelled') {
								flushAssistantText();
								cancelListener.dispose();
								this._statelessTraces.delete(request.sessionResource);
								return { errorDetails: { message: localize('chipos.stateless.cancelled', 'Cancelled by user.') } };
							}
							if (replayErr instanceof StatelessResumeNotFoundError) {
								this._logService.warn('[ChipOS Stateless] /resume 404 — turn already completed or never existed');
								progress([this._statelessFailureCard({
									errorCode: 'TURN_FINISHED',
									message: localize('chipos.stateless.fail.finished', "上一个回答已经完成。"),
									resumable: isStatelessTurnResumable({ verdict: 'replay', resumeNotFound: true }),
									chatSessionId,
									traceId,
									lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? lastSeq,
								})]);
								errorResult = { errorDetails: { message: 'resume target not found' } };
								break;
							}
							if (replayVerdict === 'surface-replay-expired') {
								this._logService.warn('[ChipOS Stateless] /resume 410 — SSE buffer evicted');
								progress([this._statelessFailureCard({
									errorCode: 'RECONNECT_EXPIRED',
									message: localize('chipos.stateless.fail.resumeExpired', "重连窗口已过期。"),
									resumable: false,
									chatSessionId,
									traceId,
									lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? lastSeq,
								})]);
								errorResult = { errorDetails: { message: 'replay window expired' } };
								break;
							}
							// Transient (network error / reasoner still restarting) — backoff + retry.
							if (resumeAttempt < maxResumeAttempts) {
								const backoffMs = Math.min(1000 * 2 ** (resumeAttempt - 1), 8000);
								this._logService.warn('[ChipOS Stateless] /resume attempt %d transient-failed (%s) — retry in %dms', resumeAttempt, String(replayErr), backoffMs);
								await raceCancellation(timeout(backoffMs), token);
							} else {
								const msg = replayErr instanceof Error ? replayErr.message : String(replayErr);
								this._logService.error('[ChipOS Stateless] /resume gave up after %d attempts: %s', maxResumeAttempts, msg);
								this._statelessObs.resumeOutcome('gave-up', maxResumeAttempts);  // §5.2 client mirror
								progress([this._statelessFailureCard({
									errorCode: 'RECONNECT_FAILED',
									message: localize('chipos.stateless.fail.reconnect', "自动重连 {0} 次后仍失败。", maxResumeAttempts),
									resumable: isStatelessTurnResumable({ verdict: 'replay' }),
									chatSessionId,
									traceId,
									lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? lastSeq,
								})]);
								errorResult = { errorDetails: { message: msg } };
							}
						}
					}
					break;
				}
				}
				// D9: any switch branch other than the 412-retry continue above is
				// terminal — exit the retry loop.
				break retryLoop;
			}
		}
		flushAssistantText();
		// [ChipOS] Scenario-aware closure on turn end (mainly cancellation): any
		// tool call still tracked in `statelessToolInputs` never received a
		// `tool_result_observed`, i.e. it's still in-flight when the turn ends.
		// Close it with an ACCURATE result so the next turn's history is honest and
		// assemblable — "已取消" when the user stopped/superseded the turn, else
		// "未完成". We do NOT fabricate success (we can't verify server-side state).
		// Best-effort: if the response is already cancelled the progress emit can
		// throw (acceptResponseProgress on a closed response) — we swallow it, and
		// ConversationAssembler drops any still-orphaned tool_use as the backstop.
		if (statelessToolInputs.size > 0) {
			const wasCancelled = token.isCancellationRequested;
			const closeMsg = wasCancelled
				? localize('chipos.stateless.toolCancelled', "已取消（用户中断了本轮）")
				: localize('chipos.stateless.toolIncomplete', "未完成（本轮结束时该工具调用未返回结果）");
			for (const [callId, cached] of statelessToolInputs) {
				if (cached.toolName === 'write_todos') {
					continue; // no completion row — the sticky widget owns write_todos
				}
				try {
					let danglingArg = '';
					try { danglingArg = ChipOSChatAgent._formatToolArgs(cached.rawInput ? JSON.parse(cached.rawInput) as Record<string, unknown> : undefined); } catch { /* best-effort */ }
					progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId: callId,
						toolName: cached.toolName,
						isComplete: true,
						pastTenseMessage: cached.label ?? buildToolRowLabel(friendlyToolName(cached.toolName), danglingArg),
						errorMessage: closeMsg,
						resultDetails: {
							input: cached.rawInput ?? '',
							output: [{ type: 'embed' as const, value: closeMsg, isText: true, mimeType: 'text/plain' }],
							isError: true,
						} satisfies IToolResultInputOutputDetails,
					} satisfies IChatExternalToolInvocationUpdate]);
				} catch (err) {
					this._logService.trace('[ChipOS Stateless] close-on-cancel emit failed for %s (response likely closed): %s', callId, String(err));
				}
			}
			statelessToolInputs.clear();
		}
		// [ChipOS] Phase 2: graduate the live sticky todo list into a permanent
		// history card + clear the widget (shared with the /resume finalization).
		this._graduateStatelessTodos(latestTodos, progress, request);
		cancelListener.dispose();
		this._statelessTraces.delete(request.sessionResource);

		// Phase 1 (ADR-018 §2 D8): IDE no longer persists langgraph_state_blob —
		// internal reasoner state lives reasoner-side in FileStateStore. We just
		// stash usage + trace_id for IDE telemetry; the framework's chat model
		// already captures the rendered assistant text/tool_use blocks via the
		// progress callback emissions above.
		const resultMetadata: Record<string, unknown> = {
			usage: usage ?? null,
			trace_id: traceId,
			// PHASE-1 §2.9: stash the chat_session_id on the result so it round-trips
			// into chatSessions/*.jsonl (telemetry + a secondary recovery hint). The
			// authoritative cross-restart recovery is workspace storage, written at
			// id-mint time — see `_statelessChatSessionIdFor`.
			chipos_chat_session_id: chatSessionId,
			// [ChipOS][F-4] next-step suggestions → provideFollowups renders them
			// as native clickable reply chips below this response.
			chipos_followups: lastFollowups ?? [],
		};

		const totalElapsed = Date.now() - startTime;
		this._logService.info(
			'[ChipOS Stateless] invoke end: trace=%s elapsed=%dms terminate=%s final_msg_count=%d usage=%s',
			traceId, totalElapsed, roundEndReceived,
			Array.isArray(lastFinalMessages) ? lastFinalMessages.length : 0,
			JSON.stringify(usage ?? {}),
		);

		if (errorResult) {
			return {
				...errorResult,
				timings: { totalElapsed, firstProgress: firstProgressTime },
			};
		}
		// P1-2 (IDE-MIGRATION-GAPS §1.2): trailing copyable trace_id pill on the
		// completed assistant bubble — parity with the legacy WS path (TaskComplete
		// / Done sites both call `_buildTracePillMarkdown`). The prod stateless path
		// used to drop it, so a user reporting an AI4RTL issue had no in-bubble way
		// to hand ops the trace. `traceId` is IDE-generated per turn (the reasoner
		// stream is keyed by it) so it is always present here; the pill's hover shows
		// the full id and a click copies it via the existing `chipos.trace.copyId`
		// command. Emitted only on success — failures surface the trace in
		// `_statelessFailureCard`.
		progress([{ kind: 'markdownContent', content: _buildTracePillMarkdown(traceId) }]);
		return {
			metadata: resultMetadata,
			timings: { totalElapsed, firstProgress: firstProgressTime },
		};
	}

	// =========================================================================
	// PHASE-1 §2.9 (ADR-018 §2 D10 / R-D) — IDE-restart auto-resume
	// =========================================================================
	//
	// When the IDE reloads while a stateless turn is in-flight, the reasoner
	// keeps running the turn but the IDE's invoke()/progress callback is gone,
	// so the answer is silently lost. The chat framework force-cancels a
	// restored in-flight response (ChatResponseModel coerces Pending→Cancelled
	// on both serialize and deserialize), and `acceptResponseProgress` throws on
	// a completed response — so we CANNOT append into the original row. The only
	// way to render a continuation without switching ChipOS to a custom
	// session-content-provider scheme (large blast radius) is a fresh render
	// driven by a user action. We therefore: probe GET /turn_state on restore,
	// and for a `running` trace surface a notification whose "继续" click issues
	// a sendRequest carrying a resume marker → invoke() routes to
	// `_resumeStatelessTurn`, which streams POST /resume into the new row.

	/**
	 * On chat-model create/restore, recover the durable chat_session_id for this
	 * thread and probe the reasoner for an in-flight turn cut off by an IDE
	 * reload. No-op for fresh threads (no stored id) and for threads with no
	 * in-flight trace (turn already finished — GET /turn_state is authoritative).
	 */
	private async _maybeProbeInFlightTurn(model: IChatModel): Promise<void> {
		const sessionResource = model.sessionResource;
		const key = sessionResource.toString();
		// Probe each thread at most once per IDE run.
		if (this._probedStatelessSessions.has(key)) {
			return;
		}
		// A durable id exists only for a thread that invoked in a prior run; its
		// absence means there is nothing to resume.
		const chatSessionId = this._readStoredStatelessChatSessionId(sessionResource);
		if (!chatSessionId) {
			return;
		}
		this._probedStatelessSessions.add(key);
		// An active trace means an invoke is live for this session right now (not
		// a restart-recovery case) — leave it to its own resume machinery.
		if (this._statelessTraces.has(sessionResource)) {
			return;
		}
		// Re-seed the in-memory id map so a subsequent invoke/resume reuses the
		// same chat_session_id (the reasoner owner-check rejects a mismatched id).
		this._statelessChatSessionIds.set(sessionResource, chatSessionId);
		this._logService.info('[ChipOS Stateless] resume probe: restored thread %s -> cs=%s, querying turn_state', key, chatSessionId);

		let client: StatelessClient;
		try {
			client = await this._ensureStatelessClient();
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] resume probe: client init failed: %s', String(err));
			return;
		}
		// Retry getTurnState with backoff: this probe fires on session-restore,
		// which races IChipOSTokenManager.initialize() (SecretStorage read). Until
		// that completes getAccessToken() returns undefined → the request goes out
		// tokenless → 401. The per-request token provider re-resolves a fresh token
		// each attempt, so a short retry rides out the startup auth race.
		let turnState: TurnStateResponse | undefined;
		const maxProbeAttempts = 6;
		for (let attempt = 1; attempt <= maxProbeAttempts; attempt++) {
			try {
				turnState = await client.getTurnState(chatSessionId);
				break;
			} catch (err) {
				const is401 = err instanceof StatelessHttpError && err.status === 401;
				const retriable = is401 || !(err instanceof StatelessHttpError);
				if (attempt < maxProbeAttempts && retriable) {
					const backoffMs = Math.min(1000 * attempt, 4000);
					this._logService.info('[ChipOS Stateless] resume probe: getTurnState attempt %d not ready (%s) — retry in %dms', attempt, String(err), backoffMs);
					await timeout(backoffMs);
					continue;
				}
				this._logService.warn('[ChipOS Stateless] resume probe: getTurnState failed for cs=%s: %s', chatSessionId, String(err));
				return;
			}
		}
		if (!turnState || turnState.in_flight_traces.length === 0) {
			this._logService.info('[ChipOS Stateless] resume probe: turn_state empty for cs=%s — nothing to resume', chatSessionId);
			return;
		}
		// Offer to resume the most-recently-started in-flight trace.
		const trace = turnState.in_flight_traces.reduce((a, b) => (b.started_at >= a.started_at ? b : a));
		this._logService.info('[ChipOS Stateless] resume probe: in-flight trace=%s state=%s for cs=%s', trace.trace_id, trace.state, chatSessionId);
		this._offerStatelessResume(sessionResource, chatSessionId, trace);
	}

	/**
	 * Surface the restart-resume affordance. `running` → an info prompt that
	 * continues the turn on click; `stale` (§2.9: reasoner replica may have died)
	 * → a warning that asks the user before attempting resume. Both offer a
	 * cancel so the dangling server turn can be torn down.
	 */
	private _offerStatelessResume(sessionResource: URI, chatSessionId: string, trace: InFlightTrace): void {
		const preview = trace.last_user_message_preview ? `（"${trace.last_user_message_preview}"）` : '';
		const doResume = () => this._sendStatelessResumeRequest(sessionResource, {
			traceId: trace.trace_id,
			chatSessionId,
			// last_checkpoint_seq is the reasoner's "safe to resume from here"
			// watermark; -1 means "replay everything from the start of the turn".
			lastSequenceId: trace.last_checkpoint_seq ?? -1,
		});
		const doCancel = () => {
			void this._ensureStatelessClient()
				.then(c => c.cancel(trace.trace_id, 'ide_restart_discarded'))
				.catch(err => this._logService.warn('[ChipOS Stateless] resume-discard /cancel failed:', String(err)));
		};
		if (trace.state === 'running') {
			void this._notificationService.prompt(
				Severity.Info,
				localize('chipos.stateless.resume.running', "ChipOS：上一个回答因 IDE 重启被中断{0}，是否继续生成？", preview),
				[
					{ label: localize('chipos.stateless.resume.continueBtn', "继续生成"), run: doResume },
					{ label: localize('chipos.stateless.resume.cancelBtn', "取消该回合"), run: doCancel, isSecondary: true },
				],
				{ sticky: true },
			);
		} else {
			// state === 'stale' — §2.9: ask, don't auto-resume.
			void this._notificationService.prompt(
				Severity.Warning,
				localize('chipos.stateless.resume.stale', "ChipOS：上一个回答的连接已断开较久{0}，可能已无法恢复。要尝试继续吗？", preview),
				[
					{ label: localize('chipos.stateless.resume.tryBtn', "尝试继续"), run: doResume },
					{ label: localize('chipos.stateless.resume.discardBtn', "丢弃"), run: doCancel, isSecondary: true },
				],
				{ sticky: true },
			);
		}
	}

	/**
	 * Continue an in-flight turn after an IDE restart by streaming POST /resume
	 * into a FRESH chat row (the restored row is force-cancelled and cannot be
	 * appended to — see section header). Reached from invoke() when a request
	 * carries the resume marker. Mirrors the in-invoke `'replay'` resume path:
	 * per-request token (P0.5), capped-backoff retry, api_key re-supply (P2),
	 * and 404 (turn finished) / 410 (buffer evicted) handling.
	 */
	private async _resumeStatelessTurn(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		ctx: { traceId: string; chatSessionId: string; lastSequenceId: number },
	): Promise<IChatAgentResult> {
		const startTime = Date.now();
		const { traceId, chatSessionId } = ctx;
		this._logService.info('[ChipOS Stateless] resume-on-restart: trace=%s chat_session=%s from seq=%d', traceId, chatSessionId, ctx.lastSequenceId);

		let client: StatelessClient;
		try {
			client = await this._ensureStatelessClient();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			progress([this._markdown(localize('chipos.stateless.resume.clientErr', "$(error) **ChipOS:** 无法初始化以继续上一个回答 — {0}", msg))]);
			return { errorDetails: { message: msg } };
		}

		// LLM key for resume (F6/P2): a reasoner restart rehydrates from a
		// checkpoint that does NOT persist the raw key, so the re-driven LLM call
		// would 401 at the provider without it.
		const llm = this._buildLlmConfig();

		const abortController = new AbortController();
		this._statelessTraces.set(request.sessionResource, { traceId, lastSequenceId: ctx.lastSequenceId, abortController });
		const cancelListener = token.onCancellationRequested(() => {
			this._logService.info('[ChipOS Stateless] resume-on-restart: token cancel — aborting + /cancel');
			abortController.abort();
			// #9: settle any confirm card still up (see invoke() cancel listener).
			this._retireStatelessConfirmsForTrace(traceId, 'cancelled');
			void client.cancel(traceId, 'user_cancelled').catch(err => {
				this._logService.warn('[ChipOS Stateless] resume /cancel POST failed (likely race):', String(err));
			});
		});

		let assistantTextBuf = '';
		const flushAssistantText = () => {
			if (assistantTextBuf.length === 0) {
				return;
			}
			progress([this._markdown(assistantTextBuf)]);
			assistantTextBuf = '';
		};
		// [ChipOS] See the invoke() loop: gates rendering a chat-only reply on
		// resume so a non-streaming reply isn't dropped (mirrors `_saw_streamed_text`).
		let sawStreamedText = false;
		let usage: TokenUsage | undefined;
		let errorResult: IChatAgentResult | undefined;
		const friendlyToolName = (raw: string) => this._friendlyToolName(raw);
		// #6: a resumed turn re-emits the SAME rich event stream (tool_call /
		// tool_result / subagent_event / agent_error) as the live invoke() loop,
		// so resume needs the same per-turn render state to render them identically
		// (previously the resume dispatch silently dropped all tool/subagent rows).
		const resumeToolInputs = new Map<string, { toolName: string; rawInput: string; label?: IMarkdownString }>();
		const resumeSubagentCardState = createSubagentCardState();
		let resumeLatestTodos: IChatTodo[] = [];

		// Dispatch parity with the live invoke() loop: renders text/thinking AND
		// tool rows / sub-agent cards / error cards from the /resume event stream.
		const applyDispatch = (handled: DispatchResult): void => {
			if (handled.appendText) {
				assistantTextBuf += handled.appendText;
				sawStreamedText = true;
			}
			if (handled.replyText && !sawStreamedText) {
				// Resume parity: a chat-only reply (the resume dispatcher path may
				// not stream model_output) renders here; a streamed reply drops it
				// (sawStreamedText). Mirrors the accumulator's `_saw_streamed_text`.
				assistantTextBuf += handled.replyText;
				flushAssistantText();
			}
			if (handled.flushText) {
				flushAssistantText();
			}
			if (handled.progressMessage) {
				progress([this._progress(handled.progressMessage.content, handled.progressMessage.shimmer)]);
			}
			if (handled.toolInvocation) {
				// #6 parity: render tool rows on resume (terminal / sub-agent /
				// write_todos widget / generic row w/ file link). Capture the
				// write_todos snapshot so the resume finalization can graduate +
				// clear it like the live loop ('undefined' = not write_todos).
				const todos = this._renderStatelessToolInvocation(handled.toolInvocation, progress, request, resumeToolInputs);
				if (todos) { resumeLatestTodos = todos; }
			}
			if (handled.subagentEvent) {
				this._renderStatelessSubagentEvent(handled.subagentEvent, progress, request, resumeSubagentCardState);
			}
			if (handled.edaParts || handled.markdownContents || handled.taskSummary) {
				// [ChipOS] Fusion: rich EDA report cards on the resume path too
				// (parity with the live loop above).
				this._renderStatelessEdaParts(handled, progress);
			}
			if (handled.thinkingText) {
				progress([{ kind: 'thinking', value: handled.thinkingText } satisfies IChatThinkingPart]);
			}
			if (handled.markdownError) {
				progress([this._markdown(handled.markdownError)]);
			}
			if (handled.agentError) {
				this._renderStatelessAgentError(handled.agentError, progress);
			}
			if (handled.usage !== undefined) {
				usage = handled.usage;
			}
			if (handled.errorMessage !== undefined) {
				errorResult = { errorDetails: { message: handled.errorMessage } };
			}
			if (handled.terminate) {
				// settle any sub-agent cards still open when the resumed turn ends.
				this._finalizeStatelessSubagents(progress, resumeSubagentCardState);
			}
			if (handled.ideToolCall) {
				const call = handled.ideToolCall;
				void this._handleStatelessIdeToolCall(client, traceId, request.sessionResource, call, progress, token).catch(err => {
					this._logService.error('[ChipOS Stateless] resume ide_tool_call handler failed:', String(err));
				});
			}
			if (handled.hookEval) {
				const hookEval = handled.hookEval;
				void this._handleStatelessHookEval(client, traceId, request.sessionResource, hookEval, token).catch(err => {
					this._logService.error('[ChipOS Stateless] resume hook_eval handler failed:', String(err));
				});
			}
			if (handled.confirmRequest) {
				const confirm = handled.confirmRequest;
				this._statelessObs.confirmShown(confirm.cardType);  // §5.2 client mirror
				void this._handleStatelessConfirmRequest(client, traceId, confirm, progress, token).catch(err => {
					this._logService.error('[ChipOS Stateless] resume confirm_request handler failed:', String(err));
				});
			}
			if (handled.resumedBufferDrained) {
				this._logService.info('[ChipOS Stateless] resume buffer drained at seq=%d', handled.resumedBufferDrained.sequenceId);
			}
			if (handled.resumedLive) {
				// rehydrated loop re-emits pending confirms with fresh request_ids;
				// retire the cards that were live on the now-dead reasoner.
				this._retireStatelessConfirmsForTrace(traceId);
			}
		};

		// Resume with capped-exponential backoff: a reasoner restart leaves a
		// window where /resume returns "Failed to fetch" until it is healthy.
		const maxResumeAttempts = 8;
		this._statelessObs.resumeTriggered('auto-restart');  // §5.2 client mirror
		for (let attempt = 1; attempt <= maxResumeAttempts && !abortController.signal.aborted; attempt++) {
			const lastSeq = this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? ctx.lastSequenceId;
			this._logService.warn('[ChipOS Stateless] resume-on-restart attempt %d/%d from seq %d', attempt, maxResumeAttempts, lastSeq);
			try {
				for await (const event of client.resume(chatSessionId, {
					trace_id: traceId,
					last_sequence_id: lastSeq,
					disconnect_reason: 'ide_restart',
					api_key: llm.api_key || null,
					api_key_alias: null,
				}, abortController.signal)) {
					const trace = this._statelessTraces.get(request.sessionResource);
					if (trace && event.sequence_id > trace.lastSequenceId) {
						trace.lastSequenceId = event.sequence_id;
					}
					applyDispatch(dispatchStatelessEvent(event, friendlyToolName));
				}
				break;  // resume stream completed cleanly
			} catch (resumeErr) {
				const verdict = classifySseFailure(resumeErr, abortController.signal);
				if (verdict === 'cancelled') {
					flushAssistantText();
					cancelListener.dispose();
					this._statelessTraces.delete(request.sessionResource);
					return { errorDetails: { message: localize('chipos.stateless.cancelled', 'Cancelled by user.') } };
				}
				if (resumeErr instanceof StatelessResumeNotFoundError) {
					// Turn finished naturally between the restart and our probe/resume.
					this._logService.warn('[ChipOS Stateless] resume-on-restart 404 — turn already completed');
					progress([this._statelessFailureCard({
						errorCode: 'TURN_FINISHED',
						message: localize('chipos.stateless.fail.finished', "上一个回答已经完成。"),
						resumable: false,
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? ctx.lastSequenceId,
					})]);
					break;
				}
				if (verdict === 'surface-replay-expired') {
					this._logService.warn('[ChipOS Stateless] resume-on-restart 410 — buffer evicted');
					progress([this._statelessFailureCard({
						errorCode: 'RECONNECT_EXPIRED',
						message: localize('chipos.stateless.fail.resumeExpired', "重连窗口已过期。"),
						resumable: false,
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? ctx.lastSequenceId,
					})]);
					errorResult = { errorDetails: { message: 'replay window expired' } };
					break;
				}
				if (attempt < maxResumeAttempts) {
					const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
					this._logService.warn('[ChipOS Stateless] resume-on-restart attempt %d transient-failed (%s) — retry in %dms', attempt, String(resumeErr), backoffMs);
					await raceCancellation(timeout(backoffMs), token);
				} else {
					const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
					this._logService.error('[ChipOS Stateless] resume-on-restart gave up after %d attempts: %s', maxResumeAttempts, msg);
					// GAP-1 on the resume path too: keep offering continue-from-break so
					// a still-flaky link doesn't dead-end at buttonless text.
					progress([this._statelessFailureCard({
						errorCode: 'RECONNECT_FAILED',
						message: localize('chipos.stateless.fail.reconnect', "自动重连 {0} 次后仍失败。", maxResumeAttempts),
						resumable: isStatelessTurnResumable({ verdict: 'replay' }),
						chatSessionId,
						traceId,
						lastSequenceId: this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? ctx.lastSequenceId,
					})]);
					errorResult = { errorDetails: { message: msg } };
				}
			}
		}

		flushAssistantText();
		// #6/E parity: graduate + clear the sticky todo list if the resumed turn
		// drove write_todos, so the widget doesn't linger after an IDE-restart resume.
		this._graduateStatelessTodos(resumeLatestTodos, progress, request);
		cancelListener.dispose();
		this._statelessTraces.delete(request.sessionResource);

		const timings = { totalElapsed: Date.now() - startTime };
		if (errorResult) {
			return { ...errorResult, timings };
		}
		// P1-2: same trailing trace_id pill as the primary `_invokeStateless` path,
		// so an IDE-restart-resumed turn ends with the copyable trace too.
		progress([{ kind: 'markdownContent', content: _buildTracePillMarkdown(traceId) }]);
		return {
			metadata: { usage: usage ?? null, trace_id: traceId, chipos_chat_session_id: chatSessionId },
			timings,
		};
	}

	// ── Durable chat_session_id storage (survives IDE restart) ──────────────

	private _readStoredStatelessChatSessionIds(): Record<string, string> {
		const raw = this._storageService.get(ChipOSChatAgent._STATELESS_CSID_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return {};
		}
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
		} catch {
			return {};
		}
	}

	private _readStoredStatelessChatSessionId(sessionResource: URI): string | undefined {
		return this._readStoredStatelessChatSessionIds()[sessionResource.toString()];
	}

	private _writeStoredStatelessChatSessionId(sessionResource: URI, chatSessionId: string): void {
		const map = this._readStoredStatelessChatSessionIds();
		if (map[sessionResource.toString()] === chatSessionId) {
			return;
		}
		map[sessionResource.toString()] = chatSessionId;
		this._storageService.store(ChipOSChatAgent._STATELESS_CSID_STORAGE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _removeStoredStatelessChatSessionId(sessionResource: URI): void {
		const map = this._readStoredStatelessChatSessionIds();
		if (!(sessionResource.toString() in map)) {
			return;
		}
		delete map[sessionResource.toString()];
		this._storageService.store(ChipOSChatAgent._STATELESS_CSID_STORAGE_KEY, JSON.stringify(map), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	// =========================================================================
	// Phase 1 helpers: tool registration + reverse channel
	// =========================================================================

	/** Cached catalog_version per chat_session_id from the most recent register. */
	private readonly _statelessCatalogVersions = new Map<string, string>();

	/** R-C: catalog fingerprint per chat session — if the LLM-visible
	 * tool list hasn't changed, _ensureToolsRegistered short-circuits
	 * and reuses the cached catalog_version (no POST). Cleared on every
	 * MCP server / tool list change via the autorun in initialise(). */
	private readonly _statelessCatalogFingerprints = new Map<string, string>();

	/**
	 * Register the current chat session's tool catalog with reasoner (Phase 1
	 * ADR-018 §2 D9). Returns the catalog_version to thread through invoke.
	 *
	 * Gathers IDE-side tools (D12):
	 *   - IDE builtins (run_in_terminal, get_terminal_output) — same advertise
	 *     gate as legacy `_collectAndReportMcpTools` (run_in_terminal can be
	 *     disabled via `chipos.terminal.disableRunInTerminalTool`)
	 *   - User-installed MCP server tools (from VS Code IMcpService)
	 *
	 * Worker MCP tools (yosys / iverilog / openroad / ...) are NOT included
	 * here — they're advertised reasoner-side via the worker's own gRPC
	 * registration (D12 "各跑各的"). LLM sees the union of both.
	 *
	 * Idempotent — re-registers on every invoke (cheap; deterministic hash
	 * means unchanged catalog returns same version). Future optimisation
	 * (R-C): cache + only re-register on `IMcpService.onDidChangeServers`.
	 */
	private async _ensureToolsRegistered(
		client: StatelessClient,
		chatSessionId: string,
	): Promise<string> {
		const tools = this._gatherIdeToolCatalog();
		// Reasoner requires min_length=1 on register; if for some reason all
		// IDE tools are disabled (rare config) inject a noop sentinel so the
		// catalog handshake still completes — agent loop will just rely on
		// worker MCP catalog for any tool calls.
		const safeTools: ToolDefinition[] = tools.length > 0 ? tools : [{
			name: 'noop',
			description: 'No IDE-callable tools enabled in this session.',
			input_schema: { type: 'object', properties: {} },
			chipos_source: 'ide_builtin',
		}];
		// R-C optimisation (PHASE-1-IMPLEMENTATION-AUDIT §13.3): skip the
		// POST when the catalog fingerprint hasn't changed since the last
		// register for this chat session. The MCP-change watcher in
		// `initialize()` clears the fingerprint cache whenever
		// `IMcpService.servers` (or any server's tools list) changes, so
		// users installing/removing MCPs mid-session pick up immediately
		// without an IDE restart.
		const fingerprint = this._computeCatalogFingerprint(safeTools);
		const cachedFingerprint = this._statelessCatalogFingerprints.get(chatSessionId);
		const cachedVersion = this._statelessCatalogVersions.get(chatSessionId);
		if (cachedFingerprint === fingerprint && cachedVersion !== undefined) {
			return cachedVersion;
		}
		const resp = await client.registerTools({
			chat_session_id: chatSessionId,
			tools: safeTools,
			workspace_path: this._getWorkspaceRoot(),
		});
		this._statelessCatalogVersions.set(chatSessionId, resp.catalog_version);
		this._statelessCatalogFingerprints.set(chatSessionId, fingerprint);
		this._logService.info(
			'[ChipOS Stateless] tools registered: %d total (%d builtin + %d MCP), catalog_version=%s',
			safeTools.length,
			safeTools.filter(t => t.chipos_source === 'ide_builtin').length,
			safeTools.filter(t => t.chipos_source === 'ide_mcp').length,
			resp.catalog_version,
		);
		return resp.catalog_version;
	}

	/** Stable fingerprint of a tool list. Only depends on the LLM-visible
	 * shape (name + description + input_schema + chipos_source) so two
	 * lists with identical wire content produce the same hash. */
	private _computeCatalogFingerprint(tools: ToolDefinition[]): string {
		// JSON.stringify is stable enough for our use (object key order
		// is insertion order in V8; tools come from the same builder).
		// Sort by name to make the order deterministic across re-gathers.
		const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
		const canon = sorted.map(t => ({
			n: t.name,
			d: t.description,
			s: t.input_schema,
			c: t.chipos_source,
		}));
		// djb2-ish simple hash — we don't need crypto strength here, just
		// "different inputs ≠ same fingerprint" with high probability.
		const text = JSON.stringify(canon);
		let h = 5381;
		for (let i = 0; i < text.length; i++) {
			h = ((h << 5) + h + text.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(16);
	}

	/**
	 * Enumerate IDE-side tools for the Phase 1 catalog. Mirrors the legacy
	 * `_collectAndReportMcpTools` builder (run_in_terminal gate +
	 * IMcpService MCP server enumeration), but emits the Phase 1
	 * `ToolDefinition` shape (input_schema as object, chipos_source enum).
	 */
	private _gatherIdeToolCatalog(): ToolDefinition[] {
		const tools: ToolDefinition[] = [];

		// IDE builtin — run_in_terminal (advertise gate, same as legacy)
		const disableRunInTerminal = this._configurationService.getValue<boolean>('chipos.terminal.disableRunInTerminalTool');
		if (!(disableRunInTerminal === true)) {
			tools.push({
				name: 'run_in_terminal',
				description:
					"Execute a shell command in the user's IDE terminal with sandbox protection. " +
					'The command runs in a sandboxed environment that restricts file system and network access. ' +
					'Use this for: running scripts (python, node, bash), installing packages (pip, npm), ' +
					'building / testing / linting code, executing EDA tools (yosys, verilator, iverilog), ' +
					'or any other shell command the user explicitly requested. ' +
					'Returns the command stdout/stderr and a `terminal_id` that can be passed to ' +
					'`get_terminal_output` to read further output of long-running commands.',
				input_schema: {
					type: 'object',
					properties: {
						command: { type: 'string', description: 'The shell command to run.' },
						explanation: { type: 'string', description: 'Brief explanation of why this command is being run (shown to user in approval dialog).' },
						isBackground: { type: 'boolean', description: 'Whether the command should be started as a background task (default false).' },
					},
					required: ['command'],
				},
				chipos_source: 'ide_builtin',
			});
		}

		// IDE builtin — get_terminal_output
		tools.push({
			name: 'get_terminal_output',
			description:
				'Get the output from a previously started terminal. ' +
				'Use after `run_in_terminal` to check on background tasks or get additional output ' +
				'when the initial response was truncated or the task is still running.',
			input_schema: {
				type: 'object',
				properties: {
					terminal_id: { type: 'string', description: 'The terminal ID returned by run_in_terminal.' },
				},
				required: ['terminal_id'],
			},
			chipos_source: 'ide_builtin',
		});

		// IDE builtin — read_skill_body (FEAT-003 / ADR-004): the model loads a
		// skill's full instructions on demand after seeing it in the
		// `## Available Skills` catalog. Header-only catalog keeps prompts small.
		tools.push({
			name: 'read_skill_body',
			description:
				'Load the full instructions (body) of a skill listed in the "## Available Skills" ' +
				'section. Call this with the skill\'s name when you decide to use that skill, then ' +
				'follow the returned instructions (which may direct you to read further files).',
			input_schema: {
				type: 'object',
				properties: {
					skill_id: { type: 'string', description: 'The skill name/id exactly as shown in the Available Skills catalog.' },
				},
				required: ['skill_id'],
			},
			chipos_source: 'ide_builtin',
		});

		// IDE builtin — read_rule_body (FEAT-001b/c): the model loads an agent
		// rule's full body on demand after seeing its header (name + description)
		// in the attached rules. Header-only attachments keep prompts small.
		tools.push({
			name: 'read_rule_body',
			description: 'Load the full body of an agent-requested rule by its name.',
			input_schema: {
				type: 'object',
				properties: {
					rule_id: { type: 'string', description: 'The rule name/id exactly as shown in the attached agent rule header.' },
				},
				required: ['rule_id'],
			},
			chipos_source: 'ide_builtin',
		});

		// User-installed MCP servers (VS Code IMcpService). The ide_mcp tagging +
		// schema fallback lives in buildIdeMcpTools (pure, unit-tested).
		try {
			const mcpTools: IdeMcpToolInfo[] = [];
			for (const server of this._mcpService.servers.get()) {
				const serverTools = server.tools.get();
				if (!serverTools) { continue; }
				for (const tool of serverTools) {
					mcpTools.push({
						name: tool.definition.name,
						description: tool.definition.description,
						inputSchema: tool.definition.inputSchema,
					});
				}
			}
			tools.push(...buildIdeMcpTools(mcpTools));
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] failed enumerating IDE MCP servers:', String(err));
		}

		return tools;
	}

	/**
	 * Phase 1 reverse channel: reasoner asked IDE to execute an IDE-side tool.
	 * Routes through `_dispatchIdeTool` (shared with the legacy stateful
	 * path's `_executeIdeToolCall`), then POSTs result back to
	 * `/api/v1/tool_result/{trace_id}/{call_id}`.
	 *
	 * R-F mitigation: reasoner has its own 300s timeout — if we never POST,
	 * it injects a synthesised error tool_result and the agent loop continues.
	 * On IDE-side execution failure we ALWAYS POST a best-effort result (with
	 * is_error=true) so the agent loop unblocks cleanly even on local errors.
	 */
	private async _handleStatelessIdeToolCall(
		client: StatelessClient,
		traceId: string,
		sessionResource: URI,
		call: { callId: string; toolName: string; args: Record<string, unknown>; timeoutMs?: number },
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		this._logService.info(
			'[ChipOS Stateless] ide_tool_call name=%s call_id=%s',
			call.toolName, call.callId,
		);
		const runtime = this._getOrCreateRuntime(sessionResource);

		// run_in_terminal approval: in the stateless/fusion path the legacy
		// `_awaitTerminalApproval` cannot host an inline card — it keys off
		// `runtime.activeProgress` (only set on the legacy stateful invoke) and
		// the invoke()-reentry click route is dead while the turn is in flight
		// (busy chat session rejects sendRequest), so it fell back to a native
		// modal. Resolve approval up front via the SAME in-process confirm-card
		// mechanism the worker permission asks use, then hand the verdict to the
		// shared dispatcher as an override (keeps `_dispatchIdeTool` generic).
		let terminalApprovalOverride: boolean | undefined;
		if (call.toolName === 'run_in_terminal') {
			const approveMode = this._configurationService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
			if (approveMode !== 'full_auto') {
				const cmd = typeof call.args.command === 'string' ? call.args.command : '';
				const decision = await this._awaitStatelessTerminalApproval(traceId, call.callId, cmd, progress, token);
				if (decision.skipResult) {
					// Turn cancelled (Stop/dispose) or the card was superseded by a
					// reasoner-restart rehydrate: the awaited tool_result is moot
					// (old call_id gone / turn torn down). Skip the POST so we don't
					// burn the retry budget against a dead trace.
					this._logService.info('[ChipOS Stateless] run_in_terminal approval skipped result POST for call_id=%s', call.callId);
					return;
				}
				terminalApprovalOverride = decision.approved;
			}
		}

		const { content, isError } = await this._dispatchIdeTool(
			call.toolName, call.args, runtime, call.callId, terminalApprovalOverride,
		);
		try {
			await client.postToolResult(traceId, call.callId, {
				call_id: call.callId,
				content,
				is_error: isError,
			});
		} catch (err) {
			this._logService.warn(
				'[ChipOS Stateless] POST /tool_result failed for call_id=%s: %s',
				call.callId, String(err),
			);
		}
	}

	/**
	 * FEAT-004 / H-3 reverse channel: the reasoner asked the IDE to RUN a
	 * plugin-contributed executable function hook and is BLOCKING on the decision.
	 *
	 * SECURITY-CRITICAL — this is the gate that runs untrusted plugin code:
	 *   - every early exit MUST POST a decision so the reasoner's pending eval
	 *     future resolves (it has its own timeout, but we never want to rely on
	 *     it). The fail-closed default is `deny` (the reasoner sets
	 *     `fail_closed: true` for security-relevant points); a hook that opts out
	 *     (`fail_closed: false`) degrades to `proceed` instead.
	 *   - the gate order is FLAG → WORKSPACE-TRUST → per-plugin CONSENT, and ALL
	 *     of them are checked BEFORE we resolve any module path or spawn the host.
	 *   - module resolution is traversal-guarded ({@link ChiposPluginsService.resolvePluginFile})
	 *     so a `..` carrier cannot load a file outside the plugin dir.
	 *   - the host runs the export in an isolated node child (never on the
	 *     renderer thread) and is itself fail-closed on timeout / crash.
	 * An `ask` decision is bridged to a user confirm and collapsed to
	 * proceed/deny (the reasoner only understands terminal decisions here).
	 */
	private async _handleStatelessHookEval(client: StatelessClient, traceId: string, sessionResource: URI, hookEval: { evalId: string; point: string; toolName?: string; callId?: string; args: Record<string, unknown>; module?: string; export?: string; pluginIds?: string[]; timeoutMs?: number; failClosed?: boolean }, token: CancellationToken): Promise<void> {
		const failClosed = hookEval.failClosed !== false;
		const post = async (decision: string, extra?: { amended_args?: object; agent_message?: string; user_message?: string }) => {
			try { await client.postHookResult(traceId, hookEval.evalId, { eval_id: hookEval.evalId, decision, ...(extra ?? {}) }); }
			catch (err) { this._logService.warn('[ChipOS Stateless] POST /hook_result failed for eval_id=%s: %s', hookEval.evalId, String(err)); }
		};
		const denyOrProceed = failClosed ? 'deny' : 'proceed';
		// Gate 1: master flag (default off). Flag off = the user disabled executable
		// hooks, so the hook is INERT (not a deny): proceed, so a stray eval (e.g. the
		// flag was flipped off mid-turn) can never block a tool. The send-side filter
		// normally prevents function hooks from being sent at all when off.
		if (this._configurationService.getValue<boolean>('chipos.hooks.executablePlugins') !== true) { await post('proceed', { agent_message: 'executable plugin hooks are disabled' }); return; }
		// Gate 2: workspace trust.
		if (!this._workspaceTrustService.isWorkspaceTrusted()) { await post(denyOrProceed, { agent_message: 'workspace is not trusted' }); return; }
		const pluginId = hookEval.pluginIds && hookEval.pluginIds[0];
		if (!pluginId || !hookEval.module || !hookEval.export) { await post(denyOrProceed, { agent_message: 'malformed function hook' }); return; }
		// Gate 3: per-plugin one-time consent (this session).
		if (!this._consentedHookPlugins.has(pluginId)) {
			const { confirmed } = await this._dialogService.confirm({ type: 'warning', message: localize('chipos.hooks.consent', 'Allow plugin \'{0}\' to run an executable hook ({1})? It runs code on your machine in an isolated process.', pluginId, hookEval.export), primaryButton: localize('chipos.hooks.consent.allow', 'Allow for this session') });
			if (!confirmed) { await post(denyOrProceed, { agent_message: 'user declined to run the plugin hook' }); return; }
			this._consentedHookPlugins.add(pluginId);
		}
		// Resolve the plugin module (traversal-guarded).
		const plugins = this._instantiationService.createInstance(ChiposPluginsService);
		const moduleUri = await plugins.resolvePluginFile(pluginId, hookEval.module);
		if (!moduleUri) { await post(denyOrProceed, { agent_message: 'plugin hook module not found' }); return; }
		// Resolve the (desktop-only) hook runner service — the electron-browser impl
		// forwards hook evaluation to the main-process node child. Absent on web (no
		// fork there); the host then fail-closes. Resolved safely since the service
		// is registered only in the Electron entrypoint.
		if (!this._pluginHookHost) {
			let hookService: IChiposPluginHookService | undefined;
			try {
				hookService = this._instantiationService.invokeFunction(acc => acc.get(IChiposPluginHookService));
			} catch {
				// not registered (e.g. web) — host fail-closes
			}
			this._pluginHookHost = new ChiposPluginHookHost(hookService);
		}
		this._pluginHookHost.grantConsent(pluginId);
		const result = await this._pluginHookHost.evaluate({ evalId: hookEval.evalId, pluginId, modulePath: moduleUri.fsPath, exportName: hookEval.export, ctx: { point: hookEval.point, toolName: hookEval.toolName, callId: hookEval.callId, args: redactSensitive(hookEval.args), pluginId }, timeoutMs: hookEval.timeoutMs ?? 5000, failClosed });
		// FEAT-004 B6: record the executable-hook decision for the audit log viewer.
		this._hookLogService.record({ at: Date.now(), pluginId, point: hookEval.point ?? '', toolName: hookEval.toolName ?? '', decision: result.decision, reason: result.reason ?? result.agentMessage });
		// ask -> bridge to a user confirm; resolve to proceed/deny.
		if (result.decision === 'ask') {
			const { confirmed } = await this._dialogService.confirm({ type: 'warning', message: result.userMessage || localize('chipos.hooks.ask', 'A plugin hook asks to proceed with {0}. Allow?', hookEval.toolName || 'this tool') });
			await post(confirmed ? 'proceed' : 'deny', { agent_message: result.agentMessage }); return;
		}
		await post(result.decision, { amended_args: result.amendedArgs, agent_message: result.agentMessage, user_message: result.userMessage });
	}

	/**
	 * Stateless `run_in_terminal` approval. Renders the inline terminal-confirm
	 * card on the live (in-flight) `progress` and resolves it through the SAME
	 * in-process path the worker permission asks use — park a Promise in
	 * `_pendingStatelessConfirms` keyed by `callId`, stamp the card with the
	 * stateless-confirm markers so the click fires `_chipos.resolveStateless-
	 * Confirm` (which fulfils the parked Promise in-process), and await it. This
	 * replaces the legacy `_awaitTerminalApproval` + `_pendingTerminalApprovals` +
	 * invoke()-reentry route, which cannot work while the originating turn is in
	 * flight (busy chat session → sendRequest rejected → native-modal fallback).
	 *
	 * Returns `{ approved, skipResult }`. `skipResult` is true when the turn was
	 * cancelled or the card was superseded by a reasoner-restart rehydrate — in
	 * which case the caller must NOT POST a tool_result (the trace is gone). The
	 * cancel/retire path (`_retireStatelessConfirmsForTrace`) and the per-turn
	 * cancel listener both resolve the parked Promise, so no separate cleanup of
	 * `_pendingStatelessConfirms` is needed beyond the finally below.
	 */
	private async _awaitStatelessTerminalApproval(
		traceId: string,
		callId: string,
		cmd: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<{ approved: boolean; skipResult: boolean }> {
		// Park the Promise BEFORE emitting the card so an immediate click always
		// has a pending target to resolve (mirrors `_handleStatelessConfirmRequest`).
		const responsePromise = new Promise<{ action: string; selections?: Record<string, string>; comment?: string; superseded?: boolean }>((resolve, reject) => {
			this._pendingStatelessConfirms.set(callId, { resolve, reject, traceId });
		});
		this._statelessObs.confirmShown('terminal');  // §5.2 client mirror — parity w/ worker cards
		progress([this._buildTerminalConfirmation(callId, cmd, undefined, traceId)]);

		let resolved: { action: string; selections?: Record<string, string>; comment?: string; superseded?: boolean } | undefined;
		try {
			// 永等 (parity with the confirm card): no client-side timeout — the card
			// waits for the click; the only escape is turn cancellation via `token`.
			resolved = await raceCancellation(responsePromise, token);
		} catch (err) {
			this._logService.warn('[ChipOS Stateless] terminal approval wait error for call_id=%s: %s', callId, String(err));
			resolved = undefined;
		} finally {
			this._pendingStatelessConfirms.delete(callId);
		}

		if (!resolved) {
			this._logService.info('[ChipOS Stateless] terminal approval cancelled (Stop/dispose) for call_id=%s', callId);
			return { approved: false, skipResult: true };
		}
		if (resolved.superseded) {
			this._logService.info('[ChipOS Stateless] terminal approval superseded by rehydrate for call_id=%s', callId);
			return { approved: false, skipResult: true };
		}
		const approved = resolved.action === 'run';
		this._logService.info('[ChipOS Stateless] terminal approval resolved: call_id=%s action=%s approved=%s', callId, resolved.action, approved);
		return { approved, skipResult: false };
	}

	/**
	 * Phase 1 reverse channel: render confirm card + capture user click +
	 * POST to /confirm_response.
	 *
	 * Bridge between two async worlds:
	 *   - The reasoner-side agent loop awaits its `asyncio.Future`
	 *   - The IDE-side framework delivers user clicks via a SEPARATE invoke()
	 *     call (with `acceptedConfirmationData` populated)
	 *
	 * Mechanism:
	 *   1. Emit `IChatConfirmation` progress part marked with
	 *      `__chiposStatelessConfirmTraceId` + `__chiposStatelessConfirmRequestId`
	 *      so the next invoke() entry can route the click here
	 *   2. Park a Promise in `_pendingStatelessConfirms[requestId]`
	 *   3. Await Promise (with 600s timeout matching reasoner-side default)
	 *   4. When user clicks, invoke() top-level detector resolves the
	 *      Promise with `{action, selections, comment}`
	 *   5. POST /confirm_response — agent loop on reasoner unblocks
	 *
	 * Renders the radio form (with selections={}) for ANY card whose card_data
	 * carries well-formed questions[] — not just card_type === 'agent_ask' (the
	 * stateless reasoner labels confirm cards ad-hoc; see
	 * `_extractInteractiveAskQuestions`). Otherwise renders the generic confirm
	 * card. Card rendering is delegated to ChipOSPermissionCardContentPart via
	 * the `__chiposAgentAskCard` / `__chiposGenericConfirmCard` markers
	 * (same as legacy path so we get the existing UX for free).
	 */
	/**
	 * Normalize a confirm card's `card_data.questions[]` into the radio-form
	 * shape `ChipOSPermissionCardContentPart` consumes, or `undefined` when the
	 * card carries no well-formed questions (→ caller falls back to markdown).
	 *
	 * Card-type-AGNOSTIC by design: in the stateless path a confirm card is the
	 * LLM emitting a `chipos_user_confirm` tool whose `card_type` it picks ad-hoc
	 * (agent_ask | generic | …), so interactivity must key on the SHAPE of
	 * card_data, not the label. A question is well-formed iff it has a non-empty
	 * `question_id` and at least one option with a non-empty `action_id`; the
	 * validation mirrors the legacy ConfirmRequest path so the content part
	 * receives the exact `{question_id, prompt, options:[{action_id,label}]}`
	 * shape it iterates. `static` so it is unit-testable without the full DI
	 * graph (same rationale as `_renderConfirmMessage`).
	 */
	static _extractInteractiveAskQuestions(
		cardData: Record<string, unknown>,
	): Array<{ question_id: string; prompt: string; options: Array<{ action_id: string; label: string }> }> | undefined {
		const raw = Array.isArray((cardData as { questions?: unknown }).questions)
			? (cardData as { questions: Array<{ question_id?: string; prompt?: string; options?: Array<{ action_id?: string; label?: string }> }> }).questions
			: undefined;
		if (!raw) {
			return undefined;
		}
		const normalized = raw
			.filter(q => typeof q.question_id === 'string' && q.question_id.length > 0
				&& Array.isArray(q.options) && q.options.length > 0)
			.map(q => ({
				question_id: q.question_id as string,
				prompt: (q.prompt ?? '').trim() || (q.question_id as string),
				options: (q.options as Array<{ action_id?: string; label?: string }>)
					.filter(o => typeof o.action_id === 'string' && o.action_id.length > 0)
					.map(o => ({ action_id: o.action_id as string, label: (o.label ?? o.action_id as string) })),
			}))
			.filter(q => q.options.length > 0);
		return normalized.length > 0 ? normalized : undefined;
	}

	private async _handleStatelessConfirmRequest(
		client: StatelessClient,
		traceId: string,
		confirm: { requestId: string; cardType: string; cardData: Record<string, unknown>; title?: string; buttons?: string[] },
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		this._logService.info(
			'[ChipOS Stateless] confirm_request type=%s request_id=%s',
			confirm.cardType, confirm.requestId,
		);

		// Double-card guard: a reasoner rehydrate re-emits the confirm with a NEW
		// request_id. Retire ANY card previously rendered for THIS trace before
		// rendering the new one, so the user never sees two stacked permission
		// cards. The `resumed_live` retire (_retireStatelessConfirmsForTrace) only
		// covers cards still in `_pendingStatelessConfirms`; this also catches the
		// manual "继续 (从中断处)" path, where the failed turn's card already left
		// the pending map. If the prior is still pending, resolve it superseded so
		// its detached handler exits cleanly.
		let renderedForTrace = this._renderedConfirmsByTrace.get(traceId);
		if (!renderedForTrace) {
			renderedForTrace = new Set<string>();
			this._renderedConfirmsByTrace.set(traceId, renderedForTrace);
		}
		for (const priorReqId of renderedForTrace) {
			if (priorReqId === confirm.requestId) {
				continue;
			}
			// C (parallel-confirm fix): a prior confirm STILL live-pending on the
			// current stream is a legitimate PARALLEL confirm — the agent_core
			// path dispatches e.g. verilog_lint + yosys_synthesis together, so two
			// cards are open at once and EACH needs its own approval. Retiring it
			// here (the old behaviour) killed the first of two parallel cards into
			// an un-clickable "superseded" pill → the turn hung. Only retire priors
			// that are no longer pending: stale ghost cards from a dead/previous
			// turn (the rehydrate / "继续(从中断处)" path this guard was built for).
			if (this._pendingStatelessConfirms.has(priorReqId)) {
				continue;
			}
			this._confirmRetireService.retire(priorReqId);
		}
		renderedForTrace.add(confirm.requestId);

		// Build the IChatConfirmation data shape mirroring legacy ConfirmRequest
		// handler so ChipOSPermissionCardContentPart renders without changes.
		const title = confirm.title || 'Confirm requested';
		const buttons = confirm.buttons && confirm.buttons.length > 0 ? confirm.buttons : ['Approve', 'Reject'];
		const cardData = confirm.cardData;
		// Card-type-AGNOSTIC interactive-form detection (see
		// `_extractInteractiveAskQuestions`). The stateless reasoner labels a
		// `chipos_user_confirm` card's `card_type` ad-hoc (agent_ask | generic |
		// …), so keying the radio form on the exact label `agent_ask` left any
		// other label carrying the same questions[] shape degrading to markdown.
		// We detect on the SHAPE of card_data instead.
		const askQuestions = ChipOSChatAgent._extractInteractiveAskQuestions(cardData);
		const isInteractiveAsk = askQuestions !== undefined;
		// Prefer explicit {label, action_id} options from card_data (worker
		// permission_ask cards send these so a localized label like "允许一次"
		// still maps to the canonical action_id "allow_once"). Fall back to the
		// label.toLowerCase() derivation for cards that only carry button labels.
		const explicitOptions = Array.isArray((cardData as { options?: unknown }).options)
			? (cardData as { options: Array<{ label?: string; action_id?: string }> }).options
				.filter(o => o && typeof o.action_id === 'string' && o.action_id.length > 0)
				.map(o => ({ label: (o.label ?? o.action_id) as string, action_id: o.action_id as string }))
			: undefined;
		// The permission-card renderer reads `data.tool` (for the header label +
		// icon). Carry it from card_data.tool (worker permission_ask sends the
		// tool name) and fall back to the card type so the card never renders an
		// undefined tool.
		const toolName = typeof (cardData as { tool?: unknown }).tool === 'string' && (cardData as { tool: string }).tool
			? (cardData as { tool: string }).tool
			: (confirm.cardType || 'Confirm');
		// Surface the permission-card fields the renderer reads (path/preview/
		// rule/badge) from card_data so the body isn't blank. Worker
		// permission_ask cards carry payload/matched_rule/content_preview/etc.
		const cd = cardData as {
			payload?: unknown; matched_rule?: unknown; matched_layer?: unknown;
			content_preview?: unknown; target_exists?: unknown; target_size_bytes?: unknown;
		};
		const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
		const baseData: Record<string, unknown> = {
			requestId: confirm.requestId,
			card_type: confirm.cardType,
			card_data: cardData,
			tool: toolName,
			specifier: str(cd.payload) ?? '',
			matchedRule: str(cd.matched_rule),
			matchedLayer: str(cd.matched_layer),
			contentPreview: str(cd.content_preview),
			targetExists: typeof cd.target_exists === 'boolean' ? cd.target_exists : undefined,
			targetSizeBytes: typeof cd.target_size_bytes === 'number' ? cd.target_size_bytes : undefined,
			sessionId: traceId,
			// Phase 1 markers (read by invoke() top-level detector below)
			__chiposStatelessConfirmTraceId: traceId,
			__chiposStatelessConfirmRequestId: confirm.requestId,
			options: explicitOptions && explicitOptions.length > 0
				? explicitOptions
				: buttons.map(label => ({ label, action_id: label.toLowerCase() })),
		};
		// ④ Rich-card readiness: when a stateless confirm card carries a card_type
		// that has a dedicated structured renderer (spec/arch/hook/file_edit/
		// verification/sim/lint/coverage report), render its body via the SAME
		// `_renderConfirmMessage` the legacy event-stream path uses (FEAT-29), so
		// the card isn't a flat one-liner the moment the reasoner emits a structured
		// EDA card. Allowlisted on purpose: that renderer's `default` branch
		// JSON-dumps card_data, which would regress generic stateless confirm cards
		// (chipos_user_confirm / ad-hoc labels) whose body lives only in `message`.
		// Skipped for the interactive radio form (questions render in the form).
		const baseMessage = typeof (cardData as { message?: unknown }).message === 'string'
			? (cardData as { message: string }).message
			: title;
		const isRichCard = !isInteractiveAsk && ChipOSChatAgent._RICH_STATELESS_CARD_TYPES.has(confirm.cardType);
		const message = isRichCard
			? ChipOSChatAgent._renderConfirmMessage({
				request_id: confirm.requestId,
				card_type: confirm.cardType,
				card_data: cardData,
				title: confirm.title,
				message: baseMessage,
			})
			: baseMessage;

		const data: Record<string, unknown> = isInteractiveAsk
			? {
				...baseData,
				__chiposAgentAskCard: true,
				questions: askQuestions,
				selections: {} as Record<string, string>,
			}
			: {
				...baseData,
				__chiposGenericConfirmCard: true,
				// permission_ask renders via structured fields (header/path/meta/
				// contentPreview); every OTHER generic stateless confirm card
				// (chipos_user_confirm, spec/arch/code/...) has its content in
				// `message` (rich-rendered above when the card_type has a dedicated
				// renderer), so it must opt into markdown rendering or the card body
				// shows up blank.
				renderMessageAsMarkdown: confirm.cardType !== 'permission_ask',
			};

		// Park a Promise — resolved by the next invoke() with this requestId.
		const responsePromise = new Promise<{ action: string; selections?: Record<string, string>; comment?: string; superseded?: boolean }>((resolve, reject) => {
			this._pendingStatelessConfirms.set(confirm.requestId, { resolve, reject, traceId });
		});

		// Emit the inline confirmation card.
		const confirmation: IChatConfirmation = {
			kind: 'confirmation',
			title,
			message: new MarkdownString(message, { supportThemeIcons: true, isTrusted: true }),
			data,
			buttons,
		};
		progress([confirmation]);

		// 永等 (P0-2): NO client-side timeout — a permission card waits for the
		// user's click and never auto-denies on a timer. The only escape is turn
		// cancellation (user Stop / session dispose → `token` fires); we then
		// POST action=skip so the reasoner side doesn't leak an in-flight turn.
		let result: { action: string; selections?: Record<string, string>; comment?: string; superseded?: boolean };
		try {
			const resolved = await raceCancellation(responsePromise, token);
			if (resolved) {
				result = resolved;
			} else {
				this._logService.info(
					'[ChipOS Stateless] confirm_request cancelled (Stop/dispose) request_id=%s — sending action=skip',
					confirm.requestId,
				);
				result = { action: 'skip', comment: 'cancelled before user responded' };
			}
		} catch (err) {
			result = { action: 'skip', comment: `confirm wait error: ${String(err)}` };
		} finally {
			this._pendingStatelessConfirms.delete(confirm.requestId);
		}

		// D10 rehydrate: this confirm was superseded by a reasoner-restart that
		// re-emitted the confirm with a fresh request_id. The OLD request_id no
		// longer exists on the restarted reasoner, so a POST would 404 and burn
		// the whole retry budget for nothing — skip it. The user responds on the
		// new card; this stale one has already swapped to a "superseded" pill.
		if (result.superseded) {
			this._logService.info(
				'[ChipOS Stateless] confirm request_id=%s superseded by rehydrate — skipping POST (old reasoner gone)',
				confirm.requestId,
			);
			return;
		}

		// P1: the user's confirm decision is precious — a single POST that fails
		// during a transient blip (network drop the moment they click, or a
		// just-rotated token) must NOT be silently dropped (the card has already
		// swapped to "responded", so there's no second click to recover). Retry
		// with capped exponential backoff; each attempt re-resolves the token
		// (P0.5), so a refresh between attempts lands cleanly. Bail on cancel.
		const maxAttempts = 6;
		let posted = false;
		for (let attempt = 1; attempt <= maxAttempts && !token.isCancellationRequested; attempt++) {
			try {
				await client.postConfirmResponse(traceId, confirm.requestId, {
					request_id: confirm.requestId,
					action: result.action,
					selections: result.selections ?? null,
					comment: result.comment ?? null,
				});
				posted = true;
				break;
			} catch (err) {
				this._logService.warn(
					'[ChipOS Stateless] POST /confirm_response attempt %d/%d failed for request_id=%s: %s',
					attempt, maxAttempts, confirm.requestId, String(err),
				);
				if (attempt < maxAttempts) {
					// 1s, 2s, 4s, 8s, 8s — ~23s total, enough to ride out a brief
					// outage / token refresh without hanging the turn forever.
					const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
					await raceCancellation(timeout(backoffMs), token);
				}
			}
		}
		if (!posted) {
			this._logService.error(
				'[ChipOS Stateless] POST /confirm_response gave up after %d attempts for request_id=%s — user decision lost',
				maxAttempts, confirm.requestId,
			);
		}
	}

	/**
	 * request_ids that have rendered a confirm card, per trace — kept INDEPENDENT
	 * of the `_pendingStatelessConfirms` promise lifecycle (which is deleted on
	 * resolve / skip / turn-end). On a reasoner rehydrate the turn re-emits a
	 * confirm with a NEW request_id; the OLD card may already be out of
	 * `_pendingStatelessConfirms` (e.g. the failed turn's card after the manual
	 * "继续 (从中断处)" resume), so the `resumed_live` retire (which iterates
	 * pending) can't find it. We use this to retire ANY prior card rendered for
	 * the same trace when a new one renders — covering both the in-invoke
	 * auto-resume AND the manual continue path. Cleared on dispose.
	 */
	private readonly _renderedConfirmsByTrace = new Map<string, Set<string>>();

	/**
	 * Phase 1: pending confirm-card Promises waiting for the next invoke() call
	 * to deliver the user's click. Keyed by request_id (the `chipos_user_confirm`
	 * tool_use id from the LLM). Resolved by the invoke() entry's stateless-
	 * confirm detector branch; rejected on session disposal.
	 */
	private readonly _pendingStatelessConfirms = new Map<string, {
		resolve: (r: { action: string; selections?: Record<string, string>; comment?: string; superseded?: boolean }) => void;
		reject: (err: Error) => void;
		traceId: string;
	}>();

	/**
	 * D10 rehydrate (ADR-018 §2 D10 / R-D): the reasoner restarted mid-turn and
	 * re-drove the agent loop, which re-emits any pending confirm with a FRESH
	 * request_id. Retire every confirm still parked for this trace so we don't
	 * leave a dead duplicate card alongside the new one:
	 *   1. fire the retire channel → the OLD card swaps to a "superseded" pill
	 *      (clicks become no-ops via `isUsed`)
	 *   2. resolve its parked Promise with `superseded:true` → the original
	 *      `_handleStatelessConfirmRequest` unblocks and skips its POST (the old
	 *      request_id is gone on the restarted reasoner)
	 */
	private _retireStatelessConfirmsForTrace(traceId: string, reason: ChipOSConfirmRetireReason = 'superseded'): void {
		for (const [requestId, pending] of [...this._pendingStatelessConfirms]) {
			if (pending.traceId !== traceId) {
				continue;
			}
			this._logService.info(
				'[ChipOS Stateless] retiring confirm request_id=%s (trace=%s reason=%s)',
				requestId, traceId, reason,
			);
			this._confirmRetireService.retire(requestId, reason);
			// Resolving with superseded:true makes the parked-confirm handler SKIP
			// its POST. On cancel the SSE is being torn down + /cancel already POSTed,
			// so skipping the per-card POST is also correct (#9).
			const comment = reason === 'cancelled'
				? 'turn cancelled by user'
				: 'superseded by reasoner-restart rehydrate';
			pending.resolve({ action: 'skip', comment, superseded: true });
			this._pendingStatelessConfirms.delete(requestId);
		}
	}

	// =========================================================================
	// End Phase 0 #8e / #8f
	// =========================================================================

	override dispose(): void {
		// R62: 清理 debounce timer
		for (const [sessionResource] of this._sessionRuntimes) {
			this._disposeRuntime(sessionResource);
		}
		this._renderedConfirmsByTrace.clear();
		// FEAT-004 / H-3: kill the executable-hook subprocess host (if it was ever
		// spawned) so a forked plugin-hook child cannot outlive the agent.
		this._pluginHookHost?.dispose();
		super.dispose();
	}
}

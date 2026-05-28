/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { stripIcons } from '../../../../../base/common/iconLabels.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
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
import { Range } from '../../../../../editor/common/core/range.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import {
	IChatProgress,
	IChatMarkdownContent,
	IChatConfirmation,
	IChatProgressMessage,
	IChatThinkingPart,
	IChatWarningMessage,
	IChatEdaSimReport,
	IChatEdaCoverageReport,
	IChatEdaLintReport,
	IChatEdaPpaReport,
	IChatEdaParallelProgress,
	IChatEdaNegotiationView,
	IChatEdaSpecReview,
	IChatContentReference,
	ChatResponseReferencePartStatusKind,
	IChatExternalToolInvocationUpdate,
	IChatToolInputInvocationData,
	IChatSubagentToolInvocationData,
	IChatTerminalToolInvocationData,
	IChatTextEdit,
	IChatRoundProgress,
	IChatAgentError,
} from '../../../../contrib/chat/common/chatService/chatService.js';
import type { IToolResultInputOutputDetails } from '../../../../contrib/chat/common/tools/languageModelToolsService.js';
import { IChatTodoListService, type IChatTodo } from '../../../../contrib/chat/common/tools/chatTodoListService.js';
import { IChatEditingService, type IChatEditingSession } from '../../../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../../../contrib/chat/common/chatService/chatService.js';
import { IChatWidgetService } from '../../../../contrib/chat/browser/chat.js';
import { ConnectionBannerHandler } from './connectionBannerHandler.js';
import type { IChatResponseModel, IChatModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { SseEventStreamClient } from '../eventStream/grpcSseEventStreamClient.js';
import { ChatModelToRecordsAdapter } from './statelessInvoke/chatModelAdapter.js';
import { ConversationAssembler, ConversationAssemblyError } from './statelessInvoke/conversationAssembler.js';
import { ConversationCompactor } from './statelessInvoke/conversationCompactor.js';
import {
	StatelessClient,
	StatelessHttpError,
	StatelessResumeNotFoundError,
} from './statelessInvoke/statelessClient.js';
import type {
	InvokeRequest,
	Message,
	ToolDefinition,
	TokenUsage,
} from './statelessInvoke/types.js';
import { classifySseFailure, dispatchStatelessEvent, type DispatchResult } from './statelessInvoke/eventDispatcher.js';
import type { IEventStreamClient } from '../eventStream/eventStreamClient.js';
import { FullTracer } from '../eventStream/fullTracer.js';
import { ContextCollector } from '../autoContext/contextCollector.js';
import { ChipOSEditorEffects } from './editorEffects.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { resolveReasoningUrl } from '../../common/chiposEndpoints.js';
import { IChipOSWorkerPermissionService, IWorkerPermissionAsk } from '../permission/workerPermissionService.js';
import { ChatAgentLocation, ChatPermissionLevel, isAutoApproveLevel } from '../../../chat/common/constants.js';
import {
	AgentEventType,
	ConnectionState,
	type AgentEvent,
	type ITextDeltaPayload,
	type IThinkingDeltaPayload,
	type IToolCallPayload,
	type IToolResultPayload,
	type IConfirmRequestPayload,
	type IConfirmAutoResolvedPayload,
	type IStatusPayload,
	type ITodoUpdatePayload,
	type ITaskCompletePayload,
	type IRoundStartPayload,
	type IPlanPayload,
	type IDiffPreviewPayload,
	type ISimReportPayload,
	type ICoverageReportPayload,
	type ILintReportPayload,
	type IPpaReportPayload,
	type INegotiationViewPayload,
	type IParallelProgressPayload,
	type ILoopProgressPayload,
	type ISpecReviewPayload,
	type ITaskSummaryPayload,
	type ISubagentEventPayload,
	type IWorktreeFilesAppliedPayload,
	type IFileEditPayload,
	type IQueueUpdatePayload,
	type IContextWarningPayload,
	type IUsagePayload,
	type IMentionItem,
	type IIdeToolCallPayload,
} from '../eventStream/eventTypes.js';

interface IChatSessionRuntime {
	streamClient?: IEventStreamClient;
	clientListeners: DisposableStore;  // listeners tied to the current streamClient lifetime
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

/**
 * Build the dim "trace" pill rendered at the end of every chat round.
 *
 * Output: `[trace](command:chipos.trace.copyId?<encoded-id> "Click to copy: <safe-id>")`
 * with `isTrusted: true` so the command URI is invoked when clicked.
 * The chat markdown sanitizer strips raw `<span style/title>` (see Layer-4
 * note in commit `16e901fd0d4`), so we use a real markdown link instead —
 * `chatContentMarkdownRenderer.ts:114-117` reads the link's `title=` and
 * hands it to IHoverService, giving us the same hover affordance.
 *
 * Exported (module-level) for unit testing — the two render sites in
 * `ChipOSChatAgent` (TaskComplete + Done) both call this so the
 * tooltip / command URI formulation stays in one place.
 *
 * Defensive escapes — trace_id is server-generated and constrained to
 * alphanumeric + dash in practice (`reasoning-<hex>-<random>`), but if a
 * future reasoner emits quotes or backslashes the markdown title
 * `"Click to copy: ${tid}"` would parse incorrectly (or worse, leak the
 * end of the link syntax). Escape `\` and `"` in the title text. The
 * command argument goes through `encodeURIComponent(JSON.stringify(...))`
 * separately so it's safe regardless.
 */
/**
 * FEAT-X.1.2 — render a frozen-in-time snapshot of the todo list when a
 * task finishes (matches vscode-extension a65e1d2a behavior, ported to
 * chipos-ide). We use GFM task list syntax (`- [x]` / `- [ ]`) so the
 * native chat markdown renderer gives us proper checkboxes without
 * needing a dedicated ChatContentPart subclass.
 *
 *   ✗ Run stopped — 2/5 todos done            (cancelled / error)
 *   — 7/10 todos done at end of run            (partial completion)
 *
 *   - [x] Generate testbench scaffold
 *   - [x] Wire reset signal
 *   - [-] Validate counter increment        ← in-progress marker
 *   - [ ] Connect override path
 *   - [ ] Compile + simulate
 *
 * Caller (TaskComplete handler) decides when to emit — typically only
 * when wasCancelled OR completed < todos.length. We accept any todos
 * defensively (status defaults to "not-started").
 */
function _buildTodoSnapshotMarkdown(todos: ReadonlyArray<IChatTodo>, wasCancelled: boolean, completed: number): MarkdownString {
	const total = todos.length;
	const header = wasCancelled
		? `\n\n✗ **Run stopped** — ${completed}/${total} todos done`
		: `\n\n— **${completed}/${total}** todos done at end of run`;
	const lines = todos.map(t => {
		// IChatTodo.status is 'not-started' | 'in-progress' | 'completed'
		// GFM task lists only have [ ] / [x]; use [-] for in-progress as
		// a visual middle-state (renders as a dash inside the box on
		// the markdown renderers that handle it, plain "[-]" otherwise).
		const box = t.status === 'completed' ? '[x]' : t.status === 'in-progress' ? '[-]' : '[ ]';
		// Escape pipes + leading dashes that could confuse the markdown parser.
		const title = String(t.title ?? '').replace(/\n/g, ' ').slice(0, 200);
		return `- ${box} ${title}`;
	});
	return new MarkdownString(`${header}\n\n${lines.join('\n')}\n`, { supportThemeIcons: false, isTrusted: false });
}

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
	private readonly _connectionBanners = new ResourceMap<ConnectionBannerHandler>();
	/** T6b IDE FullTracer — created in constructor (DI), buffers per chat round. */
	private readonly _fullTracer!: FullTracer;
	private _editorEffects: ChipOSEditorEffects | undefined;
	private _contextCollector: ContextCollector | undefined;
	private _sessionCounter = 0;
	/** Counter for generating unique subagent tool call keys (avoids collision when same tool is called multiple times) */
	private _subagentToolCounter = 0;
	/** Counter for generating unique external edit operation IDs */
	private _externalEditOpCounter = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatTodoListService private readonly _todoListService: IChatTodoListService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IChatService private readonly _chatService: IChatService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalChatService private readonly _terminalChatService: ITerminalChatService,
		@ITerminalSandboxService private readonly _terminalSandboxService: ITerminalSandboxService,
		@IMcpService private readonly _mcpService: IMcpService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IProductService private readonly _productService: IProductService,
		@IChipOSWorkerPermissionService private readonly _workerPermissionService: IChipOSWorkerPermissionService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		// T6b IDE FullTracer (ADR-009 §4.2) — buffers IDE-side trace events per
		// chat round and POSTs to reasoner /v1/trace/upload at TaskComplete.
		this._fullTracer = this._register(this._instantiationService.createInstance(FullTracer));
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

		// 2026-05-26: carousel subscription removed (see _pendingCarousels
		// removal comment above). agent_ask now uses option-as-buttons via
		// reasoner ed5cd46b + standard sendConfirmResponse handler.
	}

	// ── R62: MCP 工具变更通知 ──────────────────────────────────────────────

	private _mcpToolsReportDebounce: ReturnType<typeof setTimeout> | undefined;

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

		// 防抖 1s — 避免启动时大量 server 连接导致频繁上报
		if (this._mcpToolsReportDebounce) {
			clearTimeout(this._mcpToolsReportDebounce);
		}
		this._mcpToolsReportDebounce = setTimeout(() => {
			this._mcpToolsReportDebounce = undefined;
			// Notify ALL active sessions so every Reasoner sees the updated tool list
			const activeSessions = this._findAllActiveSessions();
			for (const s of activeSessions) {
				this._collectAndReportMcpTools(s.streamClient, s.sessionId);
			}
		}, 1000);
	}

	/**
	 * Clear any user-level overrides for the internal backend endpoints so the
	 * chat agent falls back to the deployment default (product.json) on the
	 * next connection attempt.
	 *
	 * Called from the "Reset Connection" inline action when a stale URL/port
	 * has been left behind in user settings (e.g. a previous chipos-remote-ssh
	 * forwarded port that has since been released, or a manual debug value the
	 * user typed once and forgot about). The whole point is that users should
	 * never have to reason about these keys — this helper is the no-questions
	 * "make it work like a fresh install" escape hatch.
	 */
	private async _resetBackendOverrides(): Promise<void> {
		// Every chipos.backend.* key the IDE has ever shipped. Even though the
		// schema for most of these has been removed, older user settings.json
		// files may still carry stale values written by earlier builds — we
		// must clear all of them or the override silently keeps poisoning the
		// connection. Order doesn't matter; updateValue(undefined, USER) is
		// idempotent for keys with no userValue.
		const keys = [
			'chipos.backend.mode',
			'chipos.backend.developerMode',
			'chipos.backend.reasoningUrl',
			'chipos.backend.workerHttpUrl',
			'chipos.backend.httpPort',
			'chipos.backend.grpcPort',
			'chipos.backend.workerHttpPort',
			'chipos.backend.grpcAddress',
			'chipos.backend.token',
			'chipos.backend.tlsEnabled',
		];
		const cleared: string[] = [];
		for (const key of keys) {
			try {
				const inspect = this._configurationService.inspect<unknown>(key);
				if (inspect.userValue !== undefined) {
					await this._configurationService.updateValue(key, undefined, ConfigurationTarget.USER);
					cleared.push(key);
				}
			} catch (err) {
				this._logService.warn('[ChipOS Agent] Failed to clear user override for', key, err);
			}
		}
		this._logService.info('[ChipOS Agent] Reset backend overrides; cleared keys:', cleared);

		// Tell the user something actually happened. resolveReasoningUrl reads
		// settings each call, so the very next chat message will pick up the
		// deployment default — no reload required.
		void this._notificationService.info(
			cleared.length > 0
				? localize(
					'chipos.backend.resetConnection.done',
					'ChipOS: connection reset. Send a message to retry.',
				)
				: localize(
					'chipos.backend.resetConnection.noop',
					'ChipOS: no manual overrides to clear.',
				),
		);
	}

	private _findAllActiveSessions(): Array<{ streamClient: IEventStreamClient; sessionId: string }> {
		const result: Array<{ streamClient: IEventStreamClient; sessionId: string }> = [];
		for (const [, runtime] of this._sessionRuntimes) {
			if (runtime.streamClient && runtime.backendSessionId) {
				result.push({ streamClient: runtime.streamClient, sessionId: runtime.backendSessionId });
			}
		}
		return result;
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		// ── Phase 0 #8e: C 档 stateless reasoner dispatch ──
		// `chipos.experiments.statelessReasoner` (off by default) flips the
		// invoke path to talk to the new `/api/v1/invoke` SSE endpoint that
		// owns no per-session state. Everything below this branch is the
		// legacy stateful path (long-lived `IEventStreamClient` + reasoner
		// stream_manager session). When the flag is on we never touch any of
		// it — the stateless path manages its own client + records + state
		// per-invoke. See ADR-017 + PHASE-0-8EFG-INTEGRATION-PLAN.md.
		const useStateless = this._configurationService.getValue<boolean>(
			'chipos.experiments.statelessReasoner',
		) ?? false;

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

		if (useStateless) {
			return this._invokeStateless(request, progress, _history, token);
		}

		// ── [ChipOS] FEAT-32 superseded by sticky streaming footer ──
		// The "Connecting to backend..." progress message used to be the
		// only feedback that the request had started. Now the sticky
		// streaming footer above the input box (`⟳ Xs`, ticking every
		// second) provides the same signal without taking space inside
		// the response card. Suppressed here to avoid duplicate UI.
		const runtime = this._getOrCreateRuntime(request.sessionResource);
		// Working-set fallback (see IChatSessionRuntime.workspaceWatcher comment):
		// ensure a workspace watcher is up for this session and reset the
		// per-invoke change-set so this invoke's TaskComplete flush only
		// covers files touched during this turn.
		this._ensureWorkspaceWatcher(runtime);
		runtime.watchedFileChanges.clear();

		// v2 PERMISSION-APPROVAL-UX-V2 §1: snapshot the IDE chat permission
		// level for this invoke. `_onWorkerPermissionAsk` consults this to
		// decide whether to render a confirmation card or silently allow.
		// Default → render; AutoApprove / Autopilot → auto-allow without UI.
		runtime.permissionLevel = request.permissionLevel;

		// WORKER-PERMISSION-ASK-TRANSPORT: tee the active progress so the
		// worker→IDE SSE channel can surface ASK confirmations asynchronously
		// while this invoke is mid-flight. Also flush any asks that arrived
		// between invokes (or before this runtime had progress).
		runtime.activeProgress = progress;
		if (runtime.pendingWorkerAsks.size) {
			const flushed: IChatProgress[] = [];
			for (const [, ask] of runtime.pendingWorkerAsks) {
				flushed.push(this._buildWorkerAskConfirmation(ask));
			}
			runtime.pendingWorkerAsks.clear();
			if (flushed.length) {
				progress(flushed);
			}
		}

		const streamClient = await this._ensureClient(request.sessionResource);
		if (!streamClient || streamClient.connectionState !== ConnectionState.Connected) {
			// B-5: classify the failure into one of a small number of buckets so the
			// hint is actionable. The same toast covers all of them; we only swap
			// the message + offered actions.
			const configured = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'auto';
			const target = resolveReasoningUrl(this._configurationService, this._productService);
			const productDefault = this._productService.chiposDefaults?.reasoningUrl ?? '';
			const userSetting = this._configurationService.getValue<string>('chipos.backend.reasoningUrl') ?? '';

			let bucket: 'unconfigured' | 'loopback-no-server' | 'cloud-unreachable' | 'manual-misconfigured';
			if (!productDefault && !userSetting && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(target)) {
				// We fell through to hardcoded localhost — neither product.json nor
				// user settings provided a URL. Almost always means a dev build
				// pointed at no deployment, or the user explicitly set
				// reasoningUrl=loopback for backend development without actually
				// running a backend on this machine.
				bucket = 'unconfigured';
			} else if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(target)) {
				bucket = 'loopback-no-server';
			} else if (configured && configured !== 'auto' && configured !== 'cloud-reasoning') {
				bucket = 'manual-misconfigured';
			} else {
				bucket = 'cloud-unreachable';
			}

			// User-facing hints. We deliberately do NOT mention any internal setting
			// key (chipos.backend.reasoningUrl etc.) — those are implementation
			// details users should never have to learn. Each bucket maps to a
			// concrete operational suggestion + actionable buttons below.
			const hasUserOverride = !!userSetting;
			let hint: string;
			switch (bucket) {
				case 'unconfigured':
					hint = `ChipOS isn't connected to a backend yet. ` +
						`This usually means you're running a development build that hasn't been linked to a deployment. ` +
						`Use a release build, or contact your ChipOS admin for the connection details.`;
					break;
				case 'loopback-no-server':
					hint = hasUserOverride
						? `ChipOS is configured to use a local backend, but nothing is responding on this machine. ` +
						  `If you set this manually, click **Reset Connection** below to fall back to the deployment default.`
						: `ChipOS expected a local backend on this machine but none is running. ` +
						  `Start the local backend, or switch to a release build that connects to a managed deployment.`;
					break;
				case 'cloud-unreachable':
					hint = `ChipOS can't reach its backend right now. ` +
						`Check your network — chat traffic goes over the public internet, not through any SSH tunnel. ` +
						`On a corporate network, ensure outbound HTTPS to the ChipOS service is allowed.`;
					break;
				case 'manual-misconfigured':
					hint = `ChipOS can't reach the backend you've configured (mode: ${configured}). ` +
						`Click **Reset Connection** below to clear the manual override and use the deployment default.`;
					break;
			}
			progress([this._markdown(`$(error) **ChipOS:** ${hint}`)]);

			// Also surface a notification with actionable buttons — chat error is
			// inline-only and easy to miss when the user is mid-typing.
			//
			// Action set depends on bucket: when the user has an override that
			// shadows the deployment default, offer a one-click reset. We never
			// link directly to "Open Settings" for these keys — they are
			// internal/advanced and surfacing them in this flow trains users to
			// think backend URLs are something they should be tweaking.
			const actions: { label: string; run: () => void }[] = [];
			if (hasUserOverride) {
				actions.push({
					label: localize('chipos.backend.resetConnection', 'Reset Connection'),
					run: () => { void this._resetBackendOverrides(); },
				});
			}
			actions.push({
				label: localize('chipos.backend.viewLogs', 'View Logs'),
				run: () => {
					void this._instantiationService.invokeFunction(accessor =>
						accessor.get(ICommandService).executeCommand('workbench.action.output.toggleOutput')
					);
				},
			});
			void this._notificationService.prompt(
				Severity.Warning,
				localize('chipos.backend.cannotReach', "ChipOS: can't reach the backend right now."),
				actions,
				// Sticky for unconfigured/manual-misconfigured because the user needs
				// to take an action before retrying. Other buckets auto-dismiss so we
				// don't pile up duplicate toasts on transient network glitches.
				{ sticky: bucket === 'unconfigured' || bucket === 'manual-misconfigured' },
			);

			// WORKER-PERMISSION-ASK-TRANSPORT: invoke is bailing out before any
			// finish() runs, so clear the activeProgress slot we set at the top
			// of the method so a later worker ASK doesn't fire into this stale
			// progress callback.
			if (runtime.activeProgress === progress) {
				runtime.activeProgress = undefined;
			}
			runtime.activeFinish = undefined;
			return { errorDetails: { message: 'Backend not connected' } };
		}

		// ── Inline terminal approval: resolve the run_in_terminal Deferred,
		//    then keep listening on the stream so the tool result lands in
		//    the chat UI. The marker `__chiposTerminalConfirmId` is stamped
		//    on the confirmation `data` in `_awaitTerminalApproval`; once we
		//    see it on accepted/rejected data here, we route to the local
		//    Deferred instead of forwarding the action to the reasoner. ──
		type TerminalConfirmData = {
			__chiposTerminalConfirmId: string;
			options?: ReadonlyArray<{ label: string; action_id: string }>;
		};
		const isTerminalConfirmData = (d: unknown): d is TerminalConfirmData =>
			!!d && typeof d === 'object' && typeof (d as TerminalConfirmData).__chiposTerminalConfirmId === 'string';
		const terminalAccepted = request.acceptedConfirmationData?.find(isTerminalConfirmData);
		const terminalRejected = request.rejectedConfirmationData?.find(isTerminalConfirmData);
		const terminalData = terminalAccepted ?? terminalRejected;
		if (terminalData) {
			const id = terminalData.__chiposTerminalConfirmId;
			// Determine which button was clicked by matching the request
			// message prefix (`${label}: ${title}`) against options. This
			// is the same convention the worker permission card uses
			// (chipOSPermissionCard sends `prompt = label + ": " + title`).
			// `acceptedConfirmationData` carries the click regardless of
			// which button — only `action_id` tells us run vs reject.
			let approved = !!terminalAccepted;
			if (terminalData.options?.length) {
				const msgLabel = request.message.split(':')[0]?.trim();
				const matched = terminalData.options.find(o => o.label === msgLabel);
				if (matched) {
					approved = matched.action_id === 'run';
				}
			}
			const deferred = this._pendingTerminalApprovals.get(id);
			this._pendingTerminalApprovals.delete(id);
			if (deferred) {
				this._logService.info('[ChipOS Agent] terminal approval resolved: call_id=%s, approved=%s', id, approved);
				deferred.complete(approved);
			} else {
				this._logService.warn('[ChipOS Agent] terminal approval click but no pending Deferred: call_id=%s', id);
			}
			// [ChipOS] Allowed/Rejected progress emit removed — the in-card
			// pill (chipos-used-pill ✓ Run / ✗ Reject, swapped on click)
			// already surfaces the user's choice. A second progress message
			// in the chat row is duplicate UI.
			// Keep listening on the existing stream so the IdeToolResult sent
			// by the (still-running, fire-and-forget) _executeIdeToolCall —
			// and the reasoner events that follow — land in this invoke's
			// chat output.
			return this._listenForContinuation(streamClient, progress, token, request);
		}

		// ── FEAT-23: Route confirmation responses instead of starting a new task ──
		if (request.acceptedConfirmationData?.length) {
			const data = request.acceptedConfirmationData[0] as { requestId: string; sessionId?: string; options?: Array<{ label: string; action?: string; action_id?: string }> };
			let action = 'approve';
			if (data.options?.length) {
				const msgLabel = request.message.split(':')[0]?.trim();
				const matched = data.options.find(o => o.label === msgLabel);
				if (matched) {
					action = matched.action ?? matched.action_id ?? 'approve';
				} else {
					action = data.options[0]?.action ?? data.options[0]?.action_id ?? 'approve';
				}
			}
			// WORKER-PERMISSION-ASK-TRANSPORT: when the confirmation originated
			// from the worker (carries `__chiposWorkerAskId`), route the
			// decision back to the worker's local HTTP endpoint instead of the
			// reasoner stream.
			//
			// v2 (PERMISSION-APPROVAL-UX-V2 §3.3): 4-button card maps action
			// IDs to (decision, scope) tuples for the worker decide POST:
			//   allow_once       → allow, scope=once         (no rule written)
			//   allow_workspace  → allow, scope=workspace    (written to .chipos/permissions.local.json)
			//   allow_always     → allow, scope=user         (written to ~/.chipos/permissions.json)
			//   deny             → deny  (scope ignored)
			if (this._isWorkerAskConfirmationData(data)) {
				const { decision, scope } = this._mapWorkerActionToDecision(action);
				this._logService.info('[ChipOS Agent] Worker confirm response (accepted):', data.__chiposWorkerAskId, decision, scope);
				// Race-fix: enter listener-registration FIRST, then POST /decide
				// inside postRegisterAction. The reasoner SSE burst kicked off
				// by the worker proceeding now lands on a live listener instead
				// of dropping into a fire-and-forget Emitter (which used to
				// surface 90 s later as CONTINUATION_IDLE_TIMEOUT).
				return this._listenForContinuation(streamClient, progress, token, request, async () => {
					try {
						await this._workerPermissionService.decide(data.__chiposWorkerAskId, decision, undefined, scope);
						let progressMsg: string;
						if (decision === 'deny') {
							progressMsg = '$(circle-slash) Permission denied';
						} else if (scope === 'workspace') {
							progressMsg = '$(check) Allowed + remembered in workspace';
						} else if (scope === 'user') {
							progressMsg = '$(check) Allowed + remembered globally';
						} else {
							progressMsg = '$(check) Permission granted';
						}
						progress([this._progress(progressMsg)]);
					} catch (err) {
						this._logService.warn('[ChipOS Agent] worker decide failed:', String(err));
						// Surface the failure so the user knows the click didn't
						// land — otherwise the LLM ends up reporting a permission
						// failure with no UI explanation.
						progress([this._progress(`$(error) Permission delivery failed: ${err instanceof Error ? err.message : String(err)}`)]);
					}
				});
			}
			// Use the sessionId stored in the confirmation data, NOT a new one
			const confirmSessionId = data.sessionId ?? runtime.backendSessionId;
			// P0-60 (2026-05-26): agent_ask radio-form cards carry user's
			// per-question picks on `data.selections` (mutated in place by
			// the radio change handlers, see chipOSPermissionCard.ts:
			// _renderAgentAskForm). On Submit, JSON-encode them into the
			// `comment` field so reasoner agent_core.py (commit 96135978)
			// can parse them into augmented_prompt. On Skip (action != submit
			// → typically "skip"), drop the partial selections and send the
			// action alone — reasoner treats that as "user declined to refine".
			let confirmComment: string | undefined;
			const agentAskMarker = (data as { __chiposAgentAskCard?: boolean }).__chiposAgentAskCard === true;
			if (agentAskMarker) {
				const selections = (data as { selections?: Record<string, string> }).selections ?? {};
				const isSubmitAction = action === 'submit' || action === 'approve' || action === 'confirm';
				if (isSubmitAction && Object.keys(selections).length > 0) {
					try {
						confirmComment = JSON.stringify(selections);
					} catch (err) {
						this._logService.warn('[ChipOS Agent] agent_ask: failed to JSON.stringify selections:', String(err));
					}
				}
			}
			this._logService.info('[ChipOS Agent] Confirm response (accepted):', data.requestId, action, 'session:', confirmSessionId, 'comment:', confirmComment ?? '<none>');
			streamClient.sendConfirmResponse(data.requestId, action, confirmComment, confirmSessionId);
			progress([this._progress('$(check) Confirmed')]);
			return this._listenForContinuation(streamClient, progress, token, request);
		}

		if (request.rejectedConfirmationData?.length) {
			const data = request.rejectedConfirmationData[0] as { requestId: string; sessionId?: string; options?: Array<{ label: string; action?: string; action_id?: string }> };
			const confirmSessionId = data.sessionId ?? runtime.backendSessionId;

			// When multi-option confirmations exist, the user may have selected a non-primary
			// option which VSCode routes as "reject". Try to match the user's message to an option.
			let action = 'reject';
			if (data.options?.length) {
				const msgLabel = request.message.split(':')[0]?.trim();
				const matched = data.options.find(o => o.label === msgLabel);
				if (matched) {
					action = matched.action ?? matched.action_id ?? 'reject';
					this._logService.info('[ChipOS Agent] Confirm response (multi-option selected):', data.requestId, action, 'session:', confirmSessionId);
				} else {
					this._logService.info('[ChipOS Agent] Confirm response (rejected):', data.requestId, 'session:', confirmSessionId);
				}
			} else {
				this._logService.info('[ChipOS Agent] Confirm response (rejected):', data.requestId, 'session:', confirmSessionId);
			}

			// Worker-direct fast path on reject.
			//
			// v2 (PERMISSION-APPROVAL-UX-V2 §3.3) caveat: VS Code routes the
			// non-primary buttons of a multi-option confirmation through the
			// REJECTED data slot — so "Always in workspace" / "Always globally"
			// land here even though they're allow choices. We re-use the same
			// action_id → (decision, scope) mapping as the accepted branch
			// instead of hard-coding deny, otherwise users who click
			// "Always in workspace" would silently get denied + persisted
			// nothing (E2E bug observed 2026-05-12).
			if (this._isWorkerAskConfirmationData(data)) {
				const { decision, scope } = this._mapWorkerActionToDecision(action);
				this._logService.info(
					'[ChipOS Agent] Worker confirm response (resolved via reject path):',
					data.__chiposWorkerAskId, action, '→', decision, scope,
				);
				// Race-fix: same listener-first ordering as the accepted-data path.
				return this._listenForContinuation(streamClient, progress, token, request, async () => {
					try {
						await this._workerPermissionService.decide(data.__chiposWorkerAskId, decision, undefined, scope);
						let progressMsg: string;
						if (decision === 'deny') {
							progressMsg = '$(circle-slash) Permission denied';
						} else if (scope === 'workspace') {
							progressMsg = '$(check) Allowed + remembered in workspace';
						} else if (scope === 'user') {
							progressMsg = '$(check) Allowed + remembered globally';
						} else {
							progressMsg = '$(check) Permission granted';
						}
						progress([this._progress(progressMsg)]);
					} catch (err) {
						this._logService.warn('[ChipOS Agent] worker decide failed:', String(err));
						progress([this._progress(`$(error) Permission delivery failed: ${err instanceof Error ? err.message : String(err)}`)]);
					}
				});
			}

			streamClient.sendConfirmResponse(data.requestId, action, undefined, confirmSessionId);
			if (action === 'reject') {
				progress([this._progress('$(circle-slash) Rejected')]);
			} else {
				progress([this._progress(`$(check) Selected: ${action}`)]);
			}
			return this._listenForContinuation(streamClient, progress, token, request);
		}

		// ── Block free-form text while a previous ConfirmRequest is still pending ──
		// User typed into the input WITHOUT clicking the decision card buttons
		// (Approve/Reject/A/B/Skip/Submit). Without this guard the message
		// would be sent as a new task → backend 409 SESSION_ALREADY_RUNNING
		// with a TASK_SUBMIT_FAILED card cluttering the chat. Surface a clear
		// inline error instead, telling the user to either resolve the card
		// or cancel the current request.
		const pendingConfirmation = this._findPendingConfirmation(request.sessionResource);
		if (pendingConfirmation) {
			progress([this._progress('$(warning) 上方有未处理的决策卡片。请点击其中一个按钮（Approve / Reject 等），或先 Stop 当前任务再发送新消息。')]);
			runtime.activeProgress = undefined;
			runtime.activeFinish = undefined;
			return {
				errorDetails: {
					message: localize(
						'chipos.confirmPendingBlock',
						'A decision card is awaiting your input above. Click one of its buttons before sending another message.'
					),
				},
			};
		}

		// ── Memory fix (2026-05-09, restored 2026-05-14) ─────────────────────
		// Reuse existing backendSessionId across turns of the same chat thread.
		// Reasoner's Memory is keyed on session_id; minting a fresh id on every
		// `invoke()` made the agent appear stateless ("无法访问上一轮的对话历史").
		//
		// History note: between 2026-05-13 and 2026-05-14 we ran a "mint fresh
		// id every prompt" workaround because the reasoner's stream_manager
		// permanently closed after every TaskComplete, deadlocking the next
		// round on the same session id. That was fixed by reasoning commit
		// a89a802d (StreamManager.reopen() + AgentSession._start_run_task
		// invocation) and deployed to 121.89.82.122 on 2026-05-14, so reuse
		// is safe again and Memory carries across turns as originally intended.
		// First turn: no backendSessionId set yet → generate one and stash it.
		// Subsequent turns: runtime.backendSessionId already populated by the
		// initial invoke / by `_setSessionBackendId` → reuse it verbatim.
		// _disposeRuntime clears it when the chat thread is closed, so a new
		// thread still gets a fresh id.
		let sessionId = runtime.backendSessionId;
		if (!sessionId) {
			sessionId = `native_chat_${++this._sessionCounter}_${Date.now()}`;
			this._setSessionBackendId(request.sessionResource, sessionId);
			this._logService.info('[ChipOS Agent] New backend session:', sessionId);
		} else {
			this._logService.info('[ChipOS Agent] Reusing backend session:', sessionId);
		}
		const userMessage = request.message;
		const startTime = Date.now();
		const effects = this._ensureEditorEffects();
		effects.setActiveSession(request.sessionResource);
		const modeFromInstructions = request.modeInstructions?.name;
		const isSpecMode = modeFromInstructions === 'spec' || this._configurationService.getValue<string>('chipos.chatMode') === 'spec';
		const mode: 'agent' | 'spec' = isSpecMode ? 'spec' : 'agent';
		const thinking = this._configurationService.getValue<boolean>('chipos.showThinking') ?? false;
		const autoApproveMode = this._configurationService.getValue<string>('chipos.autoApproveMode') ?? 'standard';

		// ── FEAT-24: Convert request.variables to IMentionItem[] for backend ──
		let mentions = this._extractMentions(request);

		// ── FEAT-25: Auto context collection ──
		const autoContextEnabled = this._configurationService.getValue<boolean>('chipos.autoContext') ?? true;
		if (autoContextEnabled) {
			try {
				const collector = this._ensureContextCollector();
				const budget = this._configurationService.getValue<number>('chipos.autoContextTokenBudget') ?? 8000;
				const result = await collector.collect(mentions, budget);
				const autoMentions: IMentionItem[] = result.items
					.filter(item => !item.metadata?.mention)
					.map(item => ({
						path: (item.metadata?.path as string) || `auto:${item.source}`,
						type: 'snippet' as const,
						displayName: `[auto:${item.source}]`,
						content: item.content,
					}));
				mentions = [...mentions, ...autoMentions];
				this._logService.info('[ChipOS Agent] Auto context:', autoMentions.length, 'items,', result.totalTokens, 'tokens');
			} catch (err) {
				this._logService.warn('[ChipOS Agent] Auto context failed, continuing without:', String(err));
			}
		}

		this._logService.info('[ChipOS Agent] invoke:', userMessage.slice(0, 100), 'mode:', mode, 'mentions:', mentions.length);

		runtime.toolStartTimes.clear();
		runtime.toolFileArgs.clear();
		runtime.subagentTimers.clear();
		runtime.subagentParentMap.clear();
		runtime.lastSubagentToolCallId = undefined;
		runtime.externalEditOps.clear();
		runtime.pendingStartEdits.clear();
		runtime.terminalSessionMap.clear();
		// Each new invoke starts a fresh init phase: Status events between
		// here and the first real content are folded; dedupe cache cleared.
		runtime.inInitPhase = true;
		runtime.lastStatusText = undefined;
		runtime.emittedFileRefs?.clear();
		runtime.terminalCommandLines.clear();
		runtime.terminalArtifacts.clear();
		// InlineChat v2: reset per-invoke tracking.
		runtime.emittedTextEdit = false;
		runtime.inlineAccumulator = '';
		runtime.editedFiles = new Set<string>();
		runtime.firstEditedFileLabel = undefined;

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;
			let firstProgressTime: number | undefined;
			let stepCount = 0; // Track steps for thinking title

			const trackFirstProgress = () => {
				if (firstProgressTime === undefined) {
					firstProgressTime = Date.now() - startTime;
				}
			};

			const finish = (result: IChatAgentResult, thinkingTitle?: string) => {
				if (!resolved) {
					// Working-set fallback: also flush at invoke finish, not just
					// task_complete. In the spec / subagent flow the backend
					// closes the SSE stream without sending an explicit
					// task_complete event, so the task_complete-only flush would
					// miss every file written through that path. Hooking finish
					// catches the SSE-close + cancellation + error paths too.
					this._flushWatchedFileChanges(request.sessionResource, request.requestId, runtime, progress)
						.catch(err => this._logService.warn('[ChipOS Agent] flushWatchedFileChanges@finish failed', err));

					// Fix P2 (2026-05-20): FullTracer.flush was only wired to the
					// task_complete branch above, despite the comment promising
					// "flush at finish". Result: any round that ends via
					// SSE-close / cancellation / error (no task_complete event)
					// left N events buffered, and the next round's begin() would
					// drop them ("[FullTracer] new round trace_id X while Y still
					// active — dropping 35 buffered events" pattern observed
					// every round during today's verification). Calling flush()
					// here releases the buffer + resets _activeTraceId so the next
					// begin() starts clean. Fire-and-forget, no-op when buffer
					// is empty.
					this._fullTracer.flush().catch(err => {
						this._logService.warn('[ChipOS Agent] FullTracer.flush@invoke-finish failed:', err);
					});
					// InlineChat v2: if this invoke came from Cmd+I (EditorInline)
					// and produced NO file edits but DID produce some answer text,
					// surface the answer as a notification toast. The inline
					// overlay's "Done, 0 changes" status collapses immediately
					// after invoke resolves, and the chat-panel session is a
					// different sessionResource than the inline session — so
					// neither surface naturally shows the answer. A notification
					// is the simplest path that doesn't require routing the same
					// prompt through a second LLM call.
					if (
						request.location === ChatAgentLocation.EditorInline &&
						!runtime.emittedTextEdit &&
						runtime.inlineAccumulator?.trim()
					) {
						const answer = stripIcons(runtime.inlineAccumulator.trim());
						const truncated = answer.length > 600 ? answer.slice(0, 600).trimEnd() + '…' : answer;
						this._notificationService.notify({
							severity: Severity.Info,
							message: `ChipOS: ${truncated}`,
							source: 'ChipOS Inline Chat',
						});
					}
					// InlineChat F: when the response WAS edit-style, the file
					// just silently mutated under the user's cursor. Without a
					// visible Accept/Reject affordance users miss that edits
					// applied ("where is the output?" complaint). Surface a
					// toast naming the file + chipos keybindings.
					if (
						request.location === ChatAgentLocation.EditorInline &&
						runtime.emittedTextEdit &&
						runtime.editedFiles && runtime.editedFiles.size > 0
					) {
						const fileCount = runtime.editedFiles.size;
						const label = runtime.firstEditedFileLabel ?? 'file';
						const filePart = fileCount === 1
							? `\`${label}\``
							: `${fileCount} files (starting with \`${label}\`)`;
						// Reference framework chatEditing keybindings: ⌘⇧Y
						// (Keep) and ⌘⇧N (Undo) per chatEditingEditorActions
						// §195-200. Toast surfaces both as clickable primary
						// actions so users don't need to remember either combo.
						const commandService = this._commandService;
						this._notificationService.notify({
							severity: Severity.Info,
							message: `ChipOS: Applied AI edits to ${filePart} — review & keep or undo below`,
							source: 'ChipOS Inline Chat',
							actions: {
								primary: [
									{
										id: 'chipos.inlineChat.keepEdits',
										label: 'Keep (⌘⇧Y)',
										tooltip: 'Keep all chat edits in this file',
										class: undefined,
										enabled: true,
										run: () => commandService.executeCommand('chatEditor.action.accept'),
									},
									{
										id: 'chipos.inlineChat.undoEdits',
										label: 'Undo (⌘⇧N)',
										tooltip: 'Undo all chat edits in this file',
										class: undefined,
										enabled: true,
										run: () => commandService.executeCommand('chatEditor.action.reject'),
									},
								],
							},
						});
					}
					// Set a meaningful thinking title so the framework doesn't fallback to "Finished with N steps"
					if (thinkingTitle || stepCount > 0) {
						const title = thinkingTitle ?? `Completed ${stepCount} step${stepCount === 1 ? '' : 's'}`;
						progress([{ kind: 'thinking', value: '', generatedTitle: title } satisfies IChatThinkingPart]);
					}
					resolved = true;
					listener.dispose();
					result = {
						...result,
						timings: {
							totalElapsed: Date.now() - startTime,
							firstProgress: firstProgressTime,
						},
					};
					// WORKER-PERMISSION-ASK-TRANSPORT: invoke is done — clear the
					// activeProgress + activeFinish slots so the next worker
					// ASK queues into pendingWorkerAsks instead of pushing into
					// this resolved progress callback.
					if (runtime.activeProgress === progress) {
						runtime.activeProgress = undefined;
					}
					if (runtime.activeFinish === finish) {
						runtime.activeFinish = undefined;
					}
					resolve(result);
				}
			};
			// Bind finish to runtime so _onWorkerPermissionAsk can call it.
			runtime.activeFinish = finish;

			const listener = streamClient.onDidReceiveEvent((event: AgentEvent) => {
				if (resolved) {
					return;
				}
				if (event.session_id && event.session_id !== sessionId) {
					this._logService.trace('[ChipOS Agent] Ignoring event for different session', event.session_id, 'expected', sessionId, 'type', event.event_type);
					return;
				}

				try {
					effects.handleEvent(request.sessionResource, event);
				} catch (e) {
					this._logService.warn('[ChipOS Agent] Editor effect error:', String(e));
				}

				try {
					this._handleAgentEvent(event, {
						runtime,
						progress,
						finish,
						request,
						streamClient,
						sessionId,
						trackFirstProgress,
						onToolStep: () => { stepCount++; },
					});
				} catch (eventErr) {
					this._logService.error('[ChipOS Agent] Event handler error for', event.event_type, eventErr);
				}

				// Mirror the SESSION_LOST_RECOVERABLE handling from
				// `_listenForContinuation`: the reasoner forgot us, the SSE
				// client just emitted the error event, no more events will
				// ever arrive. Without this finish(), the listener stays
				// alive forever (invoke() has no idle watchdog like
				// continuation does) and the chat spinner reads as still
				// "connecting" indefinitely.
				if (event.event_type === AgentEventType.Error) {
					const payload = event.payload as { code?: string; error_code?: string } | undefined;
					const code = payload?.code ?? payload?.error_code;
					if (code === 'SESSION_LOST_RECOVERABLE') {
						this._logService.info('[ChipOS Agent] SESSION_LOST_RECOVERABLE — finishing invoke immediately');
						finish({ errorDetails: { message: 'Session lost (reasoner restart) — start a new chat' } });
					}
				}
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested');
				streamClient.sendStop(sessionId);
				finish({});
			});

			// A6: precise diagnostic when required LLM settings are unset, so users
			// don't get an opaque 401/404 from a half-configured fresh install.
			const missingLlm = this._getMissingLlmFields();
			if (missingLlm.length > 0) {
				const msg = `ChipOS LLM 配置未填写：${missingLlm.join(', ')}。请打开 Settings → ChipOS 填写后重试。`;
				this._logService.warn('[ChipOS Agent] sendTask blocked — missing LLM fields: %s', missingLlm.join(','));
				progress([this._progress(`$(warning) ${msg}`, false)]);
				finish({}, 'LLM settings missing');
				return;
			}

			streamClient.sendTask(
				sessionId,
				userMessage,
				mentions,
				mode as 'agent' | 'spec',
				{
					thinking,
					autoApproveMode,
					workspacePath: this._getWorkspaceRoot(),
					llmConfig: this._buildLlmConfig(),
				},
			);

			// R55: 上报 IDE 侧 MCP 工具定义给 Reasoner
			this._collectAndReportMcpTools(streamClient, sessionId);

			// [ChipOS] "Waiting for backend response..." suppressed — the sticky
			// streaming footer above the input (`⟳ Xs`, ticking) provides the same
			// signal without taking space inside the response card.
		});
	}

	// ── Shared event handler: eliminates invoke/continuation duplication ──

	private _handleAgentEvent(
		event: AgentEvent,
		ctx: {
			runtime: IChatSessionRuntime;
			progress: (parts: IChatProgress[]) => void;
			finish: (result: IChatAgentResult, thinkingTitle?: string) => void;
			request: IChatAgentRequest | undefined;
			streamClient: IEventStreamClient;
			sessionId: string;
			trackFirstProgress?: () => void;
			onToolStep?: () => void;
		},
	): void {
		switch (event.event_type) {
			// ── Streaming text ──
			case AgentEventType.TextDelta: {
				const p = event.payload as ITextDeltaPayload;
				ctx.trackFirstProgress?.();
				ctx.runtime.inInitPhase = false;
				// T6b: best-effort begin() in case server skipped RoundStart
				// or it arrived ordered AFTER first TextDelta. begin() is
				// idempotent within a trace_id (no double-buffer).
				if (event.trace_id && this._fullTracer.activeTraceId !== event.trace_id) {
					this._fullTracer.begin(event.trace_id);
				}
				this._fullTracer.record('chat_text_delta', { role: p.role, content_len: p.content.length });
				if (p.role === 'thinking') {
					ctx.progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
				} else {
					ctx.progress([this._markdown(p.content)]);
					// InlineChat v2: accumulate assistant text so finish() can
					// surface a preview in the inline-chat overlay when the
					// response is chat-style (no FileEdit emitted).
					if (ctx.request?.location === ChatAgentLocation.EditorInline) {
						ctx.runtime.inlineAccumulator = (ctx.runtime.inlineAccumulator ?? '') + p.content;
					}
				}
				break;
			}

			case AgentEventType.ThinkingDelta: {
				const p = event.payload as IThinkingDeltaPayload;
				ctx.trackFirstProgress?.();
				ctx.runtime.inInitPhase = false;
				ctx.progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
				break;
			}

			// ── Tool lifecycle via IChatExternalToolInvocationUpdate ──
			case AgentEventType.ToolCall: {
				const p = event.payload as IToolCallPayload;
				const key = p.call_id || p.tool_name;
				ctx.onToolStep?.();
				ctx.runtime.inInitPhase = false;
				ctx.runtime.toolStartTimes.set(key, Date.now());
				// Save file_path from arguments for later reference emission
				const args = p.arguments as Record<string, unknown> | undefined;
				if (args) {
					const fp = (args.file_path ?? args.path ?? args.file ?? args.file_name) as string | undefined;
					if (fp) { ctx.runtime.toolFileArgs.set(key, fp); }
				}
				const friendly = this._friendlyToolName(p.tool_name);
				const argDetail = ChipOSChatAgent._formatToolArgs(p.arguments);
				const invocationMsg = argDetail ? `${friendly} ${argDetail}` : friendly;

				// Subagent tools get special rendering — Cursor-style collapsible card
				const isSubagent = p.tool_name === 'task' || p.tool_name === 'run_subagent' || p.tool_name === 'transfer_to_agent';
				if (isSubagent && args) {
					ctx.runtime.lastSubagentToolCallId = key;
					const desc = (args.description ?? args.prompt ?? '') as string;
					// Extract first line or first 60 chars as short description for card title
					const shortDesc = desc.split('\n')[0].slice(0, 60);
					const agentType = (args.subagent_type ?? args.agent_type ?? '') as string;
					const toolUpdate: IChatExternalToolInvocationUpdate = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: key,
						toolName: p.tool_name,
						isComplete: false,
						invocationMessage: invocationMsg,
						toolSpecificData: {
							kind: 'subagent',
							description: shortDesc,
							agentName: agentType || 'sub-agent',
							prompt: typeof args.prompt === 'string' ? args.prompt.slice(0, 500) : desc.slice(0, 500),
						} satisfies IChatSubagentToolInvocationData,
					};
					ctx.progress([toolUpdate]);
				} else if (ChipOSChatAgent._isShellTool(p.tool_name)) {
					// Shell execution tools → terminal-style inline block
					const cmdLine = typeof args?.command === 'string' ? args.command as string : '';
					const cmdArgs = (args ?? {}) as { cwd?: string; isBackground?: boolean };
					this._logService.info('[ChipOS Agent] ToolCall shell: tool=%s, key=%s, cmdLine=%s', p.tool_name, key, cmdLine || '(empty)');
					ctx.runtime.terminalCommandLines.set(key, cmdLine);
					const cwdPath = (cmdArgs.cwd as string) || this._getWorkspaceRoot() || '';
					const cwdUri = cwdPath ? URI.file(cwdPath) : undefined;

					if (p.tool_name === 'run_in_terminal') {
						const termSessionId = `chipos_${key}`;
						const termCommandId = `chipos_cmd_${key}`;
						ctx.runtime.terminalSessionMap.set(key, { sessionId: termSessionId, commandId: termCommandId });
						const toolUpdate: IChatExternalToolInvocationUpdate = {
							kind: 'externalToolInvocationUpdate',
							toolCallId: key,
							toolName: p.tool_name,
							isComplete: false,
							invocationMessage: invocationMsg,
							toolSpecificData: {
								kind: 'terminal',
								terminalToolSessionId: termSessionId,
								terminalCommandId: termCommandId,
								commandLine: { original: cmdLine },
								cwd: cwdUri,
								language: 'shellscript',
								isBackground: cmdArgs.isBackground ?? false,
							} satisfies IChatTerminalToolInvocationData,
						};
						ctx.progress([toolUpdate]);
					} else {
						const toolUpdate: IChatExternalToolInvocationUpdate = {
							kind: 'externalToolInvocationUpdate',
							toolCallId: key,
							toolName: p.tool_name,
							isComplete: false,
							invocationMessage: invocationMsg,
							toolSpecificData: {
								kind: 'terminal',
								commandLine: { original: cmdLine },
								cwd: cwdUri,
								language: 'shellscript',
								isBackground: false,
							} satisfies IChatTerminalToolInvocationData,
						};
						ctx.progress([toolUpdate]);
					}
				} else {
					// Regular tools — show input data
					const rawInput = ChipOSChatAgent._formatRawInput(p.tool_name, p.arguments);
					const toolUpdate: IChatExternalToolInvocationUpdate = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: key,
						toolName: p.tool_name,
						isComplete: false,
						invocationMessage: invocationMsg,
						toolSpecificData: {
							kind: 'input',
							rawInput,
						} satisfies IChatToolInputInvocationData,
					};
					ctx.progress([toolUpdate]);
				}

				// For file-writing tools, start external edit tracking
				// so the editing session can snapshot the file before backend writes.
				if (args && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
					const filePath = (args.file_path ?? args.path ?? args.file ?? args.file_name) as string | undefined;
					if (filePath) {
						const workspaceRoot = this._getWorkspaceRoot();
						const fileUri = filePath.startsWith('/')
							? URI.file(filePath)
							: workspaceRoot
								? URI.joinPath(URI.file(workspaceRoot), filePath)
								: URI.file(filePath);
						ctx.runtime.toolFileArgs.set(key, filePath);
						// Start external edit — snapshot file before backend writes
						this._startExternalEdit(key, fileUri, ctx.request!.sessionResource, ctx.request!.requestId, ctx.runtime, p.snapshot_content);
					}
				}
				break;
			}

		case AgentEventType.ToolResult: {
				const p = event.payload as IToolResultPayload;
				const key = p.call_id || p.tool_name;
				const friendly = this._friendlyToolName(p.tool_name);
				const startTs = ctx.runtime.toolStartTimes.get(key);
				const elapsed = startTs ? `${((Date.now() - startTs) / 1000).toFixed(1)}s` : '';
				ctx.runtime.toolStartTimes.delete(key);
				const timeSuffix = elapsed ? ` (${elapsed})` : '';
				const pastMsg = p.summary
					? `${p.summary}${timeSuffix}`
					: `${friendly}${timeSuffix}`;

				let toolComplete: IChatExternalToolInvocationUpdate;

			if (ChipOSChatAgent._isShellTool(p.tool_name) && typeof p.result === 'string') {
					const cachedCmd = ctx.runtime.terminalCommandLines.get(key) ?? '';
					ctx.runtime.terminalCommandLines.delete(key);
					this._logService.info('[ChipOS Agent] ToolResult shell: tool=%s, key=%s, cachedCmd=%s', p.tool_name, key, cachedCmd || '(empty)');
					const termSession = ctx.runtime.terminalSessionMap.get(key);
					ctx.runtime.terminalSessionMap.delete(key);
					const termArtifacts = ctx.runtime.terminalArtifacts.get(key);
					ctx.runtime.terminalArtifacts.delete(key);

					let outputText = p.result;
					let exitCode: number | undefined;

					if (p.tool_name === 'execute_command' || p.tool_name === 'execute') {
						try {
							const parsed = JSON.parse(p.result) as { exit_code?: number; stdout?: string; stderr?: string };
							outputText = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n') || '(no output)';
							exitCode = parsed.exit_code;
						} catch { /* not JSON — use raw result */ }
					}

					// Prepend command line to output for visibility
					if (cachedCmd) {
						outputText = `$ ${cachedCmd}\n${outputText}`;
					}

					toolComplete = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: key,
						toolName: p.tool_name,
						isComplete: true,
						pastTenseMessage: pastMsg,
						errorMessage: !p.success ? p.result : undefined,
						toolSpecificData: {
							kind: 'terminal',
							commandLine: { original: cachedCmd },
							language: 'shellscript',
							...(termSession ? {
								terminalToolSessionId: termSession.sessionId,
								terminalCommandId: termSession.commandId,
							} : {}),
							terminalCommandOutput: {
								text: outputText,
								truncated: outputText.length > 10_000,
								lineCount: outputText.split('\n').length,
							},
							terminalCommandState: {
								exitCode: exitCode ?? (p.success ? 0 : 1),
								duration: startTs ? Date.now() - startTs : undefined,
							},
							...(termArtifacts?.theme ? { terminalTheme: termArtifacts.theme } : {}),
							...(termArtifacts?.commandUri ? { terminalCommandUri: termArtifacts.commandUri } : {}),
						} satisfies IChatTerminalToolInvocationData,
					};
				} else {
					toolComplete = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: key,
						toolName: p.tool_name,
						isComplete: true,
						pastTenseMessage: pastMsg,
						errorMessage: !p.success && typeof p.result === 'string' ? p.result : undefined,
						resultDetails: typeof p.result === 'string' ? {
							input: p.tool_name,
							output: [{ type: 'embed' as const, value: p.result, isText: true, mimeType: 'text/plain' }],
							isError: !p.success,
						} satisfies IToolResultInputOutputDetails : undefined,
					};
				}
				ctx.progress([toolComplete]);

				// ── Stop external edit tracking and emit file reference ──
				if (ctx.runtime.externalEditOps.has(key)) {
					// External edit was started for this tool — stop it to compute diff
					this._stopExternalEdit(key, ctx.request!.sessionResource, ctx.runtime).then(editProgress => {
						if (editProgress.length > 0) {
							ctx.progress(editProgress);
						}
					}).catch(err => {
						// B-F6: previously this only logged and gave up. If the
						// editing-session machinery throws, the file *was* still
						// modified on disk — but the chat references area would
						// silently miss it. Emit a fallback file reference so the
						// user at least sees the modified file.
						this._logService.warn('[ChipOS Agent] ToolResult: stopExternalEdit failed for', key, err);
						const fallbackPath = ctx.runtime.toolFileArgs.get(key);
						if (fallbackPath) {
							const ref = this._buildFileRef(fallbackPath, p.tool_name, ctx.runtime);
							if (ref) { ctx.progress([ref]); }
						}
					});
					ctx.runtime.toolFileArgs.delete(key);
				} else if (p.success) {
					// Fallback for tools not tracked via external edits
					let filePath = ctx.runtime.toolFileArgs.get(key);
					ctx.runtime.toolFileArgs.delete(key);
					// Only attempt JSON.parse for tools that semantically return a
					// file reference. write_todos / todo-tracking tools return a
					// human-readable string ("Updated to …") on purpose — parsing
					// them as JSON spams warnings every plan-tick (5+ per session
					// observed on a single user-prompt smoke test). Allowlist the
					// file-producing tools so the fallback file-ref logic still
					// runs where it actually helps.
					if (!filePath && typeof p.result === 'string' && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
						try {
							const resultObj = JSON.parse(p.result);
							filePath = resultObj.path ?? resultObj.file_path ?? resultObj.file_name;
						} catch (parseErr) {
							// B-F5: the prior `catch {}` silenced parse errors and
							// made it impossible to debug "why is the modified
							// file missing?". Log so we can at least see what shape
							// the result took.
							this._logService.warn('[ChipOS Agent] ToolResult: result not JSON for', p.tool_name, '-', String(parseErr).slice(0, 120));
						}
					}
					if (filePath) {
						const ref = this._buildFileRef(filePath, p.tool_name, ctx.runtime);
						if (ref) { ctx.progress([ref]); }
					}
				}
				break;
			}

			// ── Status / Progress ──
			case AgentEventType.Status: {
				const p = event.payload as IStatusPayload;
				const text = p.text?.trim();
				if (!text) {
					break;
				}
				// A1: drop protocol-debug strings that leak internals to the user.
				// Patterns: "(mode=local)", "(proxy_remote=True)", trailing
				// "key=value" args. These come from backend log-style f-strings
				// not meant for end users.
				if (ChipOSChatAgent._isProtocolDebugStatus(text)) {
					break;
				}
				// A2: while initializing (between user-submit and first real
				// content), swallow all status text. The init banner spinner
				// already says "Connecting…"; we don't want a wall of progress
				// lines piling up before the response starts.
				if (ctx.runtime.inInitPhase) {
					break;
				}
				// A4: drop immediate duplicate of the previous status text.
				if (ctx.runtime.lastStatusText === text) {
					break;
				}
				ctx.runtime.lastStatusText = text;
				const shimmer = p.level === 'thinking' || p.tool_name !== undefined;
				ctx.progress([this._progress(text, shimmer)]);
				break;
			}

			// ── Round start ──
			case AgentEventType.RoundStart: {
				const p = event.payload as IRoundStartPayload;
				// T6b: kick off IDE-side trace buffering for this round so
				// downstream events (chat bubbles / tool calls / errors)
				// land in the per-trace_id batch we POST at TaskComplete.
				if (event.trace_id) {
					this._fullTracer.begin(event.trace_id);
					this._fullTracer.record('round_start_seen', { round: p.round });
				}
				// A1: backend sometimes uses round labels like "model_run" instead
				// of a numeric index — those leak protocol naming to users.
				// Numeric rounds we still surface (Step 1, Step 2, …); string
				// labels are dropped and the shimmer in the input bar carries
				// the "still working" signal instead.
				const roundIsNumeric = typeof p.round === 'number' || /^\d+$/.test(String(p.round));
				if (!roundIsNumeric) {
					break;
				}
				ctx.progress([this._progress(`Step ${p.round}`, true)]);
				break;
			}

			// ── FEAT-29: Rich confirm cards based on card_type ──
			case AgentEventType.ConfirmRequest: {
				const p = event.payload as IConfirmRequestPayload;
				const title = ChipOSChatAgent._confirmTitle(p.card_type, p.card_data, p.title);

				// P0-60 (2026-05-26): for agent_ask we keep the IChatConfirmation
				// path (so the card renders INLINE in the chat conversation flow
				// via ChipOSPermissionCardContentPart, NOT in the input-bar area
				// where IChatQuestionCarousel hardcodes itself). The custom radio
				// form is rendered by ChipOSPermissionCardContentPart's agent_ask
				// branch (see chipOSPermissionCard.ts), which builds radio inputs
				// from data.questions[] and stashes user selections on the mutable
				// data.__chiposAgentAskAnswers field. When the user clicks 提交,
				// the accepted-confirmation handler (L714 area) reads this field
				// and sends JSON-encoded answers as the comment field.
				const richMessage = ChipOSChatAgent._renderConfirmMessage(p);
				// Extract buttons from p.options or card_data.options
				const cardOpts = Array.isArray(p.card_data?.options) ? (p.card_data.options as Array<{ label?: string; action_id?: string }>) : undefined;
				const rawButtons = p.options?.map(o => o.label).filter((l): l is string => !!l)
					?? cardOpts?.map(o => o.label ?? o.action_id ?? 'Option').filter(Boolean) as string[] | undefined
					?? ['Approve', 'Reject'];
				const buttons = rawButtons.length > 0 ? rawButtons : ['Approve', 'Reject'];
				const options = p.options ?? cardOpts;

				// Card data shape per card_type. ALL confirmation cards route
				// through `ChipOSPermissionCardContentPart` now — uniform
				// visual vocabulary with the worker permission ask and the
				// terminal-command approval:
				//   - `hook_confirm` → plain-text preview (description /
				//     impact / command from card_data)
				//   - `agent_ask` (with `questions[]`) → inline radio FORM
				//     (one radio group per question, single Submit button).
				//     The card mutates `data.selections` in place via the
				//     radio change handlers (see chipOSPermissionCard.ts:
				//     _renderAgentAskForm). When the user clicks "提交",
				//     the accepted-confirmation branch (this method's L660
				//     area) reads back `data.selections` and JSON-encodes
				//     it into the `comment` field of sendConfirmResponse.
				//     Reasoner agent_core.py (commit 96135978) already
				//     parses comment-as-JSON into augmented_prompt.
				//   - everything else (spec/arch/code/file_edit/
				//     verification etc.) → opts into markdown rendering of
				//     the rich `confirmation.message` via the
				//     `renderMessageAsMarkdown: true` flag (the chipos card
				//     uses IMarkdownRendererService for that branch).
				const baseData = { requestId: p.request_id, sessionId: ctx.sessionId, options };
				const askQuestionsRaw = (p.card_data && Array.isArray((p.card_data as { questions?: unknown }).questions))
					? ((p.card_data as { questions: Array<{ question_id?: string; prompt?: string; options?: Array<{ action_id?: string; label?: string }> }> }).questions)
					: undefined;
				// Only fire the interactive-radio form path if every question
				// carries at least one option AND a question_id we can key on.
				// Mal-shaped questions (no options / no id) fall back to the
				// generic markdown render so the user still sees them as text.
				const askQuestions = askQuestionsRaw?.filter(q =>
					typeof q.question_id === 'string'
					&& q.question_id.length > 0
					&& Array.isArray(q.options)
					&& q.options.length > 0
				).map(q => ({
					question_id: q.question_id as string,
					prompt: (q.prompt ?? '').trim() || (q.question_id as string),
					options: (q.options as Array<{ action_id?: string; label?: string }>)
						.filter(o => typeof o.action_id === 'string' && o.action_id.length > 0)
						.map(o => ({ action_id: o.action_id as string, label: (o.label ?? o.action_id as string) })),
				})).filter(q => q.options.length > 0);

				const isInteractiveAgentAsk = p.card_type === 'agent_ask' && !!askQuestions && askQuestions.length > 0;

				let data: Record<string, unknown>;
				if (p.card_type === 'hook_confirm') {
					data = {
						...baseData,
						__chiposHookConfirmCard: true,
						tool: 'Bash',
						specifier: ChipOSChatAgent._hookSpecifier(p.card_data, title),
						contentPreview: ChipOSChatAgent._hookContentPreview(p.card_data),
					};
				} else if (isInteractiveAgentAsk) {
					data = {
						...baseData,
						__chiposAgentAskCard: true,
						tool: ChipOSChatAgent._cardTypeToTool(p.card_type),
						specifier: ChipOSChatAgent._cardSpecifier(p.card_type, p.card_data, title),
						questions: askQuestions,
						// Mutable record — radio change handlers in the card
						// renderer write { question_id: action_id } here.
						selections: {} as Record<string, string>,
						context: typeof (p.card_data as { context?: unknown })?.context === 'string'
							? (p.card_data as { context: string }).context
							: undefined,
					};
				} else {
					data = {
						...baseData,
						__chiposGenericConfirmCard: true,
						tool: ChipOSChatAgent._cardTypeToTool(p.card_type),
						specifier: ChipOSChatAgent._cardSpecifier(p.card_type, p.card_data, title),
						renderMessageAsMarkdown: true,
					};
				}

				const confirmation: IChatConfirmation = {
					kind: 'confirmation',
					title,
					message: new MarkdownString(richMessage, { supportThemeIcons: true, isTrusted: true }),
					data,
					buttons,
				};
				// A1 (issue #51 comment 2): remember the live confirmation so a
				// later confirm_auto_resolved can withdraw the buttons. IChat-
				// Confirmation has no native dismiss API, so we mutate `isUsed`
				// on the same object — the renderer reads it at hit-test time
				// (chatConfirmationContentPart.ts §96).
				this._pendingConfirmations.set(p.request_id, confirmation);
				ctx.progress([confirmation]);
				// Finish the current request so the framework can accept
				// the next invoke() when the user clicks a confirmation button.
				ctx.finish({}, 'Awaiting confirmation');
				break;
			}

			case AgentEventType.ConfirmAutoResolved: {
				const p = event.payload as IConfirmAutoResolvedPayload;
				const stored = this._pendingConfirmations.get(p.request_id);
				if (stored) {
					// Mark the original card as "used" so its buttons stop
					// looking actionable. The framework hides them on the next
					// re-render — see chatConfirmationContentPart §96.
					stored.isUsed = true;
					this._pendingConfirmations.delete(p.request_id);
				}
				const timeoutSec = Math.round((p.timeout_ms || 0) / 1000);
				const hint = timeoutSec > 0
					? `已自动确认（${p.reason}，${timeoutSec}s 超时 → action=${p.action}）`
					: `已自动确认（${p.reason} → action=${p.action}）`;
				ctx.progress([this._progress(`$(check) ${hint}`)]);
				this._logService.info(
					'[ChipOS Agent] confirm_auto_resolved: request_id=%s, action=%s, reason=%s',
					p.request_id, p.action, p.reason,
				);
				break;
			}

			// ── Error → IChatAgentError content part ──
			// X-1: backend now classifies exceptions into ErrorCategory
			// (AUTH/SESSION/WORKER/TOOL/PROTO/INTERNAL). Render category-aware
			// UI: icon + label + actionable suggestion + retry hint, instead of
			// the generic "执行过程中发生异常" red box.
			case AgentEventType.Error: {
				const p = event.payload as { message: string; error_code?: string; retryable?: boolean; suggestion?: string; category?: string; details?: Record<string, unknown> };
				ctx.trackFirstProgress?.();
				const cat = (p.category ?? 'INTERNAL').toUpperCase();
				// Per-category visual prefix + default suggestion (used if backend
				// didn't supply one). Suggestion is appended to message so it
				// renders inline under the error.
				const categoryPresets: Record<string, { icon: string; label: string; suggestion: string }> = {
					AUTH: { icon: '🔐', label: '认证失败', suggestion: '请重新登录后再试。' },
					SESSION: { icon: '⏱️', label: '会话已结束', suggestion: '请刷新页面或开启新对话。' },
					WORKER: { icon: '🔌', label: 'Worker 连接异常', suggestion: '正在尝试恢复，可稍后重试。' },
					TOOL: { icon: '🛠️', label: '工具执行失败', suggestion: '可重新发送以重试，或换一种描述。' },
					PROTO: { icon: '⚠️', label: '请求参数错误', suggestion: '已记录详情，可重新发送让模型修正。' },
					INTERNAL: { icon: '❌', label: '内部错误', suggestion: '请稍后重试，问题持续可联系支持。' },
				};
				const preset = categoryPresets[cat] ?? categoryPresets.INTERNAL;
				const suggestion = p.suggestion?.trim() || preset.suggestion;
				// Format: [icon label] message — suggestion
				const errorMsg = `${preset.icon} **${preset.label}**：${p.message}\n\n💡 ${suggestion}`;

				// details: show validation errors / tool name etc inline (collapsed-ish)
				let detailsLine = '';
				if (p.details && Object.keys(p.details).length > 0) {
					try {
						const ve = (p.details as { validation_errors?: Array<{ loc: unknown[]; msg: string; type: string }> }).validation_errors;
						if (Array.isArray(ve) && ve.length > 0) {
							detailsLine = '\n\n参数错误详情：\n' + ve.map(e => `• \`${e.loc.join('.')}\`: ${e.msg}`).join('\n');
						} else {
							const exType = (p.details as { exception_type?: string }).exception_type;
							if (exType) {
								detailsLine = `\n\n（异常类型：\`${exType}\`）`;
							}
						}
					} catch { /* ignore */ }
				}

				ctx.progress([{
					kind: 'agentError',
					error_code: p.error_code ?? 'AGENT_ERROR',
					message: errorMsg + detailsLine,
					retryable: p.retryable ?? (cat === 'WORKER' || cat === 'TOOL' || cat === 'PROTO'),
					suggestion: suggestion,
				} satisfies IChatAgentError]);
				ctx.finish({ errorDetails: { message: `[${cat}] ${p.message}` } });
				break;
			}

			// ── Todo update → native ChatTodoListService ──
			case AgentEventType.TodoUpdate: {
				const p = event.payload as ITodoUpdatePayload;
				if (!ctx.request) {
					break;
				}
				// B-T6: a todo widget showing up is real progress signal — let it
				// out of the init-phase suppression bucket.
				ctx.runtime.inInitPhase = false;

				const sessionRes = ctx.request.sessionResource;
				// B-T4 — backend has at least three serializations in flight
				// (snake_case from the legacy adapter, kebab-case from the new
				// adapter, and TitleCase from one model variant). Lowercase
				// before lookup so all of {Done, IN_PROGRESS, Pending, ...}
				// resolve correctly.
				// B-T5 — IChatTodo.status is a 3-value union ('not-started' |
				// 'in-progress' | 'completed'). cancelled/failed/error degrade
				// to 'not-started' (closest existing semantic) but we log so
				// the loss-of-information is debuggable.
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
				const nativeTodos: IChatTodo[] = p.todos.map((t, idx) => {
					const rawKey = (t.task_status || t.status || 'pending').toLowerCase();
					const status = statusMap[rawKey];
					if (!status) {
						this._logService.warn('[ChipOS Agent] TodoUpdate: unknown status', rawKey, '→ not-started fallback');
					}
					// B-T3 — fall back through empty strings as well as null/undef.
					// task_des and content were both observed to arrive as ""
					// (the model produced an empty step); without || we'd render
					// blank rows.
					const title = (t.task_des || t.content || `Todo ${idx + 1}`).trim() || `Todo ${idx + 1}`;
					return {
						id: idx,
						title,
						status: status ?? 'not-started',
					};
				});
				// B-T1 — call setTodos even with an empty array. Backend signals
				// "all done, clean slate" by emitting `todos: []`; the prior
				// `length > 0` gate left stale rows hanging in the UI forever.
				this._todoListService.setTodos(sessionRes, nativeTodos);
				break;
			}

			// ── Plan (FEAT-35: normalize backend 'active' → 'running') ──
			case AgentEventType.Plan: {
				const p = event.payload as IPlanPayload;
				ctx.trackFirstProgress?.();
				const lines = (p.milestones || []).map(m => {
					const status = (m.status as string) === 'active' ? 'running' : m.status;
					const icon = status === 'done' ? '- [x]' :
						status === 'running' ? '- [ ] *(running)*' :
							status === 'failed' ? '- [ ] *(failed)*' : '- [ ]';
					return `${icon} ${m.title}`;
				});
				ctx.progress([this._markdown(`### Plan\n${lines.join('\n')}`)]);
				break;
			}

			// ── Diff preview ──
			case AgentEventType.DiffPreview: {
				const p = event.payload as IDiffPreviewPayload;
				ctx.trackFirstProgress?.();
				const hunks = (p.hunks || []).map(h => {
					const lines = h.lines.map(l => {
						if (l.type === 'add') { return `+ ${l.content}`; }
						if (l.type === 'del') { return `- ${l.content}`; }
						return `  ${l.content}`;
					}).join('\n');
					return `${h.header}\n${lines}`;
				}).join('\n\n');
				ctx.progress([this._markdown(`**Diff: \`${p.file_path}\`**\n\`\`\`diff\n${hunks}\n\`\`\``)]);
				break;
			}

			// ── Simulation report → EDA content part (FEAT-35: adapt string summary) ──
			case AgentEventType.SimReport: {
				const p = event.payload as ISimReportPayload;
				ctx.trackFirstProgress?.();
				const summary = ChipOSChatAgent._normalizeSimSummary(p.summary, p.tests);
				ctx.progress([{
					kind: 'edaSimReport',
					tests: p.tests ?? [],
					summary,
				} satisfies IChatEdaSimReport]);
				break;
			}

			// ── Coverage report → EDA content part ──
			case AgentEventType.CoverageReport: {
				const p = event.payload as ICoverageReportPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([{
					kind: 'edaCoverageReport',
					line_cov: p.line_cov,
					branch_cov: p.branch_cov,
					gaps: p.gaps,
				} satisfies IChatEdaCoverageReport]);
				break;
			}

			// ── Lint report → EDA content part ──
			case AgentEventType.LintReport: {
				const p = event.payload as ILintReportPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([{
					kind: 'edaLintReport',
					errors: p.errors ?? [],
					auto_fixable: p.auto_fixable,
					tool: p.tool,
				} satisfies IChatEdaLintReport]);
				break;
			}

			// ── PPA report → EDA content part ──
			case AgentEventType.PpaReport: {
				const p = event.payload as IPpaReportPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([{
					kind: 'edaPpaReport',
					stage: p.stage,
					round: p.round,
					ppa: p.ppa,
					baseline_ppa: p.baseline_ppa,
					previous_best_ppa: p.previous_best_ppa,
					current_ppa: p.current_ppa,
					best_ppa: p.best_ppa,
					improvement: p.improvement,
					strategy: p.strategy,
					sta_report: p.sta_report,
					power_report: p.power_report,
					pareto_front_size: p.pareto_front_size,
				} satisfies IChatEdaPpaReport]);
				break;
			}

			// ── Negotiation view → EDA content part (FEAT-35: map role/claim/confidence → agent/position/reasoning) ──
			case AgentEventType.NegotiationView: {
				const p = event.payload as INegotiationViewPayload;
				ctx.trackFirstProgress?.();
				const rawPerspectives = (p.perspectives ?? []) as unknown as Array<Record<string, string>>;
				const perspectives = rawPerspectives.map(raw => ({
					agent: raw.agent ?? raw.role ?? '',
					position: raw.position ?? raw.claim ?? '',
					reasoning: raw.reasoning ?? raw.confidence ?? '',
				}));
				ctx.progress([{
					kind: 'edaNegotiationView',
					issue: p.issue,
					perspectives,
					recommendation: p.recommendation,
				} satisfies IChatEdaNegotiationView]);
				break;
			}

			// ── Parallel progress → EDA content part ──
			case AgentEventType.ParallelProgress: {
				const p = event.payload as IParallelProgressPayload;
				ctx.progress([{
					kind: 'edaParallelProgress',
					phase: p.phase,
					tracks: p.tracks ?? [],
					conflicts: p.conflicts,
				} satisfies IChatEdaParallelProgress]);
				break;
			}

			// ── FEAT-62: Loop progress → IChatRoundProgress content part ──
			case AgentEventType.LoopProgress: {
				const p = event.payload as ILoopProgressPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([{
					kind: 'roundProgress',
					current_round: p.round,
					max_rounds: p.max_rounds,
					phase: p.phase,
					status: p.status as IChatRoundProgress['status'],
					tool: p.tool,
				} satisfies IChatRoundProgress]);
				break;
			}

			// ── Spec review → EDA content part ──
			case AgentEventType.SpecReview: {
				const p = event.payload as ISpecReviewPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([{
					kind: 'edaSpecReview',
					spec_path: p.spec_path,
					spec_name: p.spec_name,
					summary: p.summary,
					files: p.files,
				} satisfies IChatEdaSpecReview]);
				break;
			}

			// ── Task summary → formatted card ──
			case AgentEventType.TaskSummary: {
				const p = event.payload as ITaskSummaryPayload;
				ctx.trackFirstProgress?.();
				ctx.progress([this._progress('$(output) Task Summary')]);
				ctx.progress([this._markdown(ChipOSChatAgent._formatTaskSummary(p))]);
				break;
			}

			// ── FEAT-33: Subagent event — structured rendering ──
			case AgentEventType.SubagentEvent: {
				const p = event.payload as ISubagentEventPayload;
				if (!ctx.runtime.subagentTimers.has(p.task_id)) {
					ctx.runtime.subagentTimers.set(p.task_id, Date.now());
					// Link task_id to the most recent subagent ToolCall
					if (ctx.runtime.lastSubagentToolCallId) {
						ctx.runtime.subagentParentMap.set(p.task_id, ctx.runtime.lastSubagentToolCallId);
					}
				}
				const parentId = ctx.runtime.subagentParentMap.get(p.task_id) ?? p.task_id;
				if (p.kind === 'text' && p.content) {
					// Route text as a virtual tool inside the subagent card
					const textKey = `sub_${p.task_id}_text_${this._subagentToolCounter++}`;
					ctx.progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId: textKey,
						toolName: 'output',
						isComplete: true,
						invocationMessage: ChipOSChatAgent._renderSubagentText(p.content),
						pastTenseMessage: ChipOSChatAgent._renderSubagentText(p.content),
						subagentInvocationId: parentId,
					} satisfies IChatExternalToolInvocationUpdate]);
				} else if (p.kind === 'tool_start' && p.tool_name) {
					const subKey = `sub_${p.task_id}_${p.tool_name}_${this._subagentToolCounter++}`;
					ctx.runtime.toolStartTimes.set(subKey, Date.now());
					// Build a friendly invocation message with args summary
					const argDetail = p.args ? ChipOSChatAgent._formatToolArgs(p.args as Record<string, unknown>) : '';
					const invMsg = argDetail ? `${p.tool_name} ${argDetail}` : p.tool_name;
					const toolUpdate: IChatExternalToolInvocationUpdate = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: subKey,
						toolName: p.tool_name,
						isComplete: false,
						invocationMessage: invMsg,
						subagentInvocationId: parentId,
					};
					ctx.progress([toolUpdate]);

					// Cache file path and start external edit for file-writing tools
					if (p.args && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
						const filePath = (p.args.file_path ?? p.args.path ?? p.args.file ?? p.args.file_name) as string | undefined;
						this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, filePath=${filePath}, hasRequest=${!!ctx.request}`);
						if (filePath && ctx.request) {
							// Dedup: skip if this file already has a pending external edit
							const alreadyTracked = [...ctx.runtime.toolFileArgs.entries()].some(
								([k, v]) => v === filePath && ctx.runtime.externalEditOps.has(k)
							);
							if (alreadyTracked) {
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: SKIPPED (already tracked) file=${filePath}, subKey=${subKey}`);
							} else {
								const workspaceRoot = this._getWorkspaceRoot();
								const fileUri = filePath.startsWith('/')
									? URI.file(filePath)
									: workspaceRoot
										? URI.joinPath(URI.file(workspaceRoot), filePath)
										: URI.file(filePath);
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: resolved fileUri=${fileUri.path}, subKey=${subKey}`);
								ctx.runtime.toolFileArgs.set(subKey, filePath);
								this._startExternalEdit(subKey, fileUri, ctx.request!.sessionResource, ctx.request!.requestId, ctx.runtime, p.snapshot_content);
							}
						}
					} else {
						this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, isFileWrite=${ChipOSChatAgent._isFileWriteTool(p.tool_name)}, hasArgs=${!!p.args}`);
					}
				} else if (p.kind === 'tool_end' && p.tool_name) {
					// Find the matching tool_start key for this tool_name (with counter suffix)
					const matchPrefix = `sub_${p.task_id}_${p.tool_name}_`;
					let subKey: string | undefined;
					for (const [k] of ctx.runtime.toolStartTimes) {
						if (k.startsWith(matchPrefix)) {
							subKey = k;
							break;
						}
					}
					this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: tool=${p.tool_name}, matchPrefix=${matchPrefix}, foundSubKey=${subKey}, file_path=${p.file_path}`);
					if (!subKey) { break; }
					const startTs = ctx.runtime.toolStartTimes.get(subKey);
					const elapsed = startTs ? ` (${((Date.now() - startTs) / 1000).toFixed(1)}s)` : '';
					ctx.runtime.toolStartTimes.delete(subKey);
					const toolComplete: IChatExternalToolInvocationUpdate = {
						kind: 'externalToolInvocationUpdate',
						toolCallId: subKey,
						toolName: p.tool_name,
						isComplete: true,
						pastTenseMessage: `${p.tool_name} done${elapsed}`,
						subagentInvocationId: parentId,
					};
					ctx.progress([toolComplete]);

					// Stop external edit — _stopExternalEdit awaits _startExternalEdit first
					const hasOp = ctx.runtime.externalEditOps.has(subKey);
					const hasPending = ctx.runtime.pendingStartEdits.has(subKey);
					this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: subKey=${subKey}, hasExternalEditOp=${hasOp}, hasPendingStart=${hasPending}, hasRequest=${!!ctx.request}`);
					if (hasOp && ctx.request) {
						this._stopExternalEdit(subKey, ctx.request!.sessionResource, ctx.runtime).then(editProgress => {
							this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit returned ${editProgress.length} progress items for ${subKey}`);
							if (editProgress.length > 0) {
								ctx.progress(editProgress);
							}
						}).catch(err => {
							this._logService.error(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit failed for ${subKey}`, err);
						});
						ctx.runtime.toolFileArgs.delete(subKey);
					}
				} else if (p.kind === 'error' && p.content) {
					// Route error inside the subagent card
					const errKey = `sub_${p.task_id}_error_${this._subagentToolCounter++}`;
					ctx.progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId: errKey,
						toolName: 'error',
						isComplete: true,
						invocationMessage: p.content,
						pastTenseMessage: p.content,
						subagentInvocationId: parentId,
					} satisfies IChatExternalToolInvocationUpdate]);
				} else if (p.kind === 'status' && p.content) {
					// Route status inside the subagent card
					const statusKey = `sub_${p.task_id}_status_${this._subagentToolCounter++}`;
					ctx.progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId: statusKey,
						toolName: 'status',
						isComplete: true,
						invocationMessage: p.content,
						pastTenseMessage: p.content,
						subagentInvocationId: parentId,
					} satisfies IChatExternalToolInvocationUpdate]);
				} else if (p.kind === 'complete') {
					const subStart = ctx.runtime.subagentTimers.get(p.task_id);
					ctx.runtime.subagentTimers.delete(p.task_id);
					// Close any dangling tool calls belonging to this subagent
					const prefix = `sub_${p.task_id}_`;
					for (const [k] of ctx.runtime.toolStartTimes) {
						if (k.startsWith(prefix)) {
							const toolName = k.slice(prefix.length).replace(/_\d+$/, '');
							ctx.progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: k,
								toolName,
								isComplete: true,
								pastTenseMessage: `${toolName} done`,
								subagentInvocationId: parentId,
							} satisfies IChatExternalToolInvocationUpdate]);
							ctx.runtime.toolStartTimes.delete(k);
						}
					}
					// Mark the parent subagent tool call as complete
					if (parentId && ctx.runtime.toolStartTimes.has(parentId)) {
						const parentStart = ctx.runtime.toolStartTimes.get(parentId);
						const elapsed = parentStart
							? ` (${((Date.now() - parentStart) / 1000).toFixed(1)}s)`
							: subStart ? ` (${((Date.now() - subStart) / 1000).toFixed(1)}s)` : '';
						ctx.runtime.toolStartTimes.delete(parentId);
						ctx.progress([{
							kind: 'externalToolInvocationUpdate',
							toolCallId: parentId,
							toolName: 'task',
							isComplete: true,
							pastTenseMessage: `Sub-agent completed${elapsed}`,
						} satisfies IChatExternalToolInvocationUpdate]);
					}
					ctx.runtime.subagentParentMap.delete(p.task_id);
				}
				break;
			}

			// ── Model turn boundaries ──
			case AgentEventType.ModelTurnStart:
			case AgentEventType.ModelTurnEnd:
				break;

			// ── FEAT-30: Worktree files applied → external edits for editing session ──
			case AgentEventType.WorktreeFilesApplied: {
				const p = event.payload as IWorktreeFilesAppliedPayload;
				if (p.files && p.files.length > 0) {
					// For files not already tracked via ToolCall external edits,
					// start+stop external edits to register them in the editing session.
					for (const f of p.files) {
						if (f.action === 'deleted') { continue; }
						const fileUri = URI.file(f.path);
						// Check if this file is already being tracked by a tool call
						const alreadyTracked = [...ctx.runtime.externalEditOps.keys()].some(k => {
							const fp = ctx.runtime.toolFileArgs.get(k);
							return fp && (fp === f.path || f.path.endsWith(fp));
						});
						if (!alreadyTracked) {
							const opId = ++this._externalEditOpCounter;
							const editingSession = this._getEditingSession(ctx.request!.sessionResource);
							const responseModel = this._getResponseModel(ctx.request!.sessionResource);
							if (editingSession && responseModel) {
								// Start and immediately stop — file is already on disk.
								// Pass `''` as the beforeSnapshot so the framework seeds
								// the entry's originalModel to empty content: the diff
								// computed for the working-set widget then shows +N -0
								// (real content count vs. empty baseline) instead of
								// +0/-0 (entry's originalModel === modifiedModel because
								// the backend already wrote the file by the time this
								// event fires). Same lossy-but-accurate defaulting as
								// `_flushWatchedFileChanges`.
								const beforeSnapshots = new ResourceMap<string>();
								beforeSnapshots.set(fileUri, '');
								editingSession.startExternalEdits(responseModel, opId, [fileUri], ctx.request!.requestId, beforeSnapshots).then(() => {
									return editingSession.stopExternalEdits(responseModel, opId);
								}).then(editProgress => {
									if (editProgress.length > 0) {
										ctx.progress(editProgress);
									}
								}).catch(err => {
									this._logService.error(`[ChipOS Agent] WorktreeFilesApplied external edit failed for ${f.path}`, err);
								});
							}
						}
					}
				}
				break;
			}

			// ── Task complete → resolve ──
			case AgentEventType.TaskComplete: {
				const p = event.payload as ITaskCompletePayload;
				// Flush working-set fallback: feed every file that changed
				// during this task into chatEditingSession so the working-set
				// widget can render them. The spec/subagent flow doesn't send
				// WorktreeFilesApplied to the IDE, so without this fallback the
				// widget stays empty even when the agent wrote files.
				if (ctx.request) {
					this._flushWatchedFileChanges(ctx.request.sessionResource, ctx.request.requestId, ctx.runtime, ctx.progress)
						.catch(err => this._logService.warn('[ChipOS Agent] flushWatchedFileChanges failed', err));

					// FEAT-X.1.2 — Todo snapshot at task completion. When the
					// run finishes (or was cancelled) with leftover todos,
					// leave a permanent read-only marker in the chat history
					// so the user can scroll back and see "this is where we
					// stopped" without the live todo widget overwriting it on
					// the next run. Skip when all todos completed normally —
					// the user just watched them tick to done, no extra card
					// needed (matches vscode-extension a65e1d2a behavior).
					try {
						const todos = this._todoListService.getTodos(ctx.request.sessionResource);
						if (todos.length > 0) {
							const completed = todos.filter(t => t.status === 'completed').length;
							const wasCancelled = p.status === 'cancelled' || p.status === 'error';
							// Only render when something's incomplete OR the run was aborted
							// — otherwise the live tick-to-done IS the user feedback.
							if (wasCancelled || completed < todos.length) {
								ctx.progress([{ kind: 'markdownContent', content: _buildTodoSnapshotMarkdown(todos, wasCancelled, completed) }]);
							}
						}
					} catch (err) {
						this._logService.warn('[ChipOS Agent] Todo snapshot render failed:', err);
					}
				}
				// T6b: record terminal status + flush IDE-side batch to reasoner
				// /v1/trace/upload. Fire-and-forget — flush failures degrade
				// observability gracefully (logged in FullTracer.flush).
				this._fullTracer.record('task_complete', { status: p.status, has_error: !!p.message });
				this._fullTracer.flush().catch(err => {
					this._logService.warn('[ChipOS Agent] FullTracer.flush failed:', err);
				});
				// 2026-05-08 reviewer Gap #1 (proper port to vscode/, replacing the
				// earlier wrong-target work in vscode-extension/): emit trace_id
				// pill at end of response so users can copy it for bug reports +
				// ops can correlate IDE-side render with reasoner master trace.jsonl.
				// The trace_id was injected by webSocketEventStreamClient._emit
				// from the top-level reasoner ServerEvent (ADR-009 §4.1).
				if (event.trace_id) {
					const tid = event.trace_id;
					// Dogfood 2026-05-15 (round 3): inline render was noisy ("有点丑"),
					// then HTML <span style/title> got stripped by the chat markdown
					// sanitizer so neither dim styling nor hover tooltip worked.
					// Switch to a markdown link with isTrusted=true → command URI:
					// link `title=` attribute survives sanitization on <a>, giving
					// us hover tooltip; clicking copies the id to clipboard via
					// the chipos.trace.copyId command (registered in
					// chiposContribution.ts).
					ctx.progress([{ kind: 'markdownContent', content: _buildTracePillMarkdown(tid) }]);
				}
				if (p.status === 'error' && p.message) {
					ctx.progress([this._warning(p.message)]);
					ctx.finish({ errorDetails: { message: p.message } });
				} else {
					ctx.finish({});
				}
				break;
			}

			// ── File edit → push IChatTextEdit to framework inline diff ──
			case AgentEventType.FileEdit: {
				const p = event.payload as IFileEditPayload;
				const workspaceRoot = this._getWorkspaceRoot();
				if (workspaceRoot && p.file_path && p.edits?.length) {
					const fileUri = URI.file(
						p.file_path.startsWith('/') ? p.file_path : `${workspaceRoot}/${p.file_path}`
					);
					const textEdits: TextEdit[] = p.edits.map(edit => ({
						range: new Range(
							edit.range.startLine,
							edit.range.startCol,
							edit.range.endLine,
							edit.range.endCol
						),
						text: edit.newText,
					}));
					ctx.progress([{
						uri: fileUri,
						edits: textEdits,
						kind: 'textEdit',
						done: true,
					} satisfies IChatTextEdit]);
					// InlineChat v2: flag this invoke as edit-style so finish()
					// skips the "surface chat-style response" path.
					ctx.runtime.emittedTextEdit = true;
					// InlineChat F: track distinct files edited so the finish()
					// toast can read "Applied N edits to <file>".
					const key = fileUri.toString();
					if (!ctx.runtime.editedFiles?.has(key)) {
						ctx.runtime.editedFiles?.add(key);
						if (!ctx.runtime.firstEditedFileLabel) {
							// Use basename for a compact label; full path is in
							// the chat panel's references section if user wants it.
							const segments = fileUri.path.split('/');
							ctx.runtime.firstEditedFileLabel = segments[segments.length - 1] || fileUri.path;
						}
					}
				}
				break;
			}

			// ── Confirm (legacy hook card) ──
			case AgentEventType.Confirm:
				break;

			// ── Skill tree (separate panel, not in chat) ──
			case AgentEventType.SkillTree:
				break;

			// ── FEAT-R72: IDE 端工具调用（Reasoner → IDE 执行）──
			case AgentEventType.IdeToolCall: {
				const p = event.payload as IIdeToolCallPayload;
				this._logService.info('[ChipOS Agent] IDE tool call: name=%s, call_id=%s', p.name, p.call_id);
				this._executeIdeToolCall(p, ctx.runtime, ctx.streamClient).catch(err => {
					this._logService.error('[ChipOS Agent] IDE tool execution failed:', err);
				});
				break;
			}

			case AgentEventType.Done:
				// Close any dangling tool calls before finishing
				for (const [k] of ctx.runtime.toolStartTimes) {
					const toolName = k.includes('_') ? k.split('_').pop()! : k;
					ctx.progress([{
						kind: 'externalToolInvocationUpdate',
						toolCallId: k,
						toolName,
						isComplete: true,
						pastTenseMessage: `${toolName} done`,
					} satisfies IChatExternalToolInvocationUpdate]);
				}
				ctx.runtime.toolStartTimes.clear();
				// Dogfood discovery 2026-05-15: chipos main-agent chats finish
				// with Done, not TaskComplete (TaskComplete is for subagents).
				//
				// Why event.trace_id is missing on Done specifically: Done is
				// emitted by stream_manager.close() which runs *after*
				// agent_core.handle_request's finally block has already called
				// reset_trace_context(). At that point self.trace_id @property
				// reads an empty contextvar, so the Done event JSON does NOT
				// carry trace_id — every earlier event in the same round does.
				//
				// Workaround: prefer event.trace_id, but fall back to FullTracer's
				// activeTraceId, which was set from the first earlier event with
				// trace_id (begin() is called the first time any event with
				// trace_id arrives — see model_output / round_start cases above).
				const _pillTid = event.trace_id ?? this._fullTracer.activeTraceId;
				if (_pillTid) {
					// Markdown link via command URI (see TaskComplete site for rationale):
					// hover shows full id, click copies to clipboard via chipos.trace.copyId.
					ctx.progress([{ kind: 'markdownContent', content: _buildTracePillMarkdown(_pillTid) }]);
				}
				ctx.finish({});
				break;

			// ── FEAT-61: Queue position update ──
			case AgentEventType.QueueUpdate: {
				const p = event.payload as IQueueUpdatePayload;
				const waitInfo = p.estimated_wait_seconds ? ` — est. ${p.estimated_wait_seconds}s` : '';
				ctx.progress([this._progress(
					`$(clock) Queue position: ${p.position}${waitInfo}`,
					true
				)]);
				break;
			}

			// ── FEAT-65: Context window usage warning ──
			case AgentEventType.ContextWarning: {
				const p = event.payload as IContextWarningPayload;
				const pct = p.usage_percent > 0 ? Math.round(p.usage_percent) : (p.tokens_max > 0 ? Math.round((p.tokens_used / p.tokens_max) * 100) : 0);
				const suggestion = p.suggestion ? ` ${p.suggestion}` : '';
				ctx.progress([this._warning(
					`$(warning) Context window ${pct}% used (${p.tokens_used}/${p.tokens_max}).${suggestion}`
				)]);
				// Also update the token usage widget with context window size
				if (ctx.request && p.tokens_max > 0) {
					const chatModel = this._chatService.getSession(ctx.request.sessionResource);
					const reqModel = chatModel?.getRequests().find(r => r.id === ctx.request!.requestId);
					if (reqModel?.response) {
						const existing = reqModel.response.usage;
						reqModel.response.setUsage({
							kind: 'usage',
							promptTokens: existing?.promptTokens ?? p.tokens_used,
							completionTokens: existing?.completionTokens ?? 0,
							contextWindow: p.tokens_max,
						});
					}
				}
				break;
			}

			case AgentEventType.Usage: {
				// Feed token usage into VS Code's chat model so ChatContextUsageWidget can display it.
				// The widget requires a non-zero `contextWindow` to show. Priority:
				//   1. Backend's `tokens_max` (preferred — reflects actual model capability)
				//   2. Value previously set by ContextWarning (>=80% threshold)
				//   3. Workspace config `chipos.contextWindow.fallback` (default 128000)
				// This guarantees the token meter shows for any model that returns usage.
				const p = event.payload as IUsagePayload;
				if (ctx.request) {
					const chatModel = this._chatService.getSession(ctx.request.sessionResource);
					const reqModel = chatModel?.getRequests().find(r => r.id === ctx.request!.requestId);
					if (reqModel?.response) {
						const existing = reqModel.response.usage;
						const fallback = this._configurationService.getValue<number>('chipos.contextWindow.fallback') || 128000;
						reqModel.response.setUsage({
							kind: 'usage',
							promptTokens: p.prompt_tokens,
							completionTokens: p.completion_tokens,
							contextWindow: p.tokens_max ?? existing?.contextWindow ?? fallback,
						});
					}
				}
				break;
			}

			default:
				this._logService.trace('[ChipOS Agent] Unhandled event:', (event as AgentEvent).event_type);
				break;
		}
	}

	// ── FEAT-23: Listen for backend events after sending confirm response ──

	/**
	 * Register the SSE event listener for the next round of backend events.
	 *
	 * Callers may pass `postRegisterAction` to perform an asynchronous side
	 * effect (e.g. POST a worker `decide`) AFTER the listener is attached.
	 * This closes the race window where the action causes the reasoner to
	 * stream events before any listener exists — a fire-and-forget Emitter
	 * drops those events, which then surfaces as `CONTINUATION_IDLE_TIMEOUT`
	 * 90 s later because no event ever reaches the watchdog reset.
	 *
	 * Ordering invariant for the worker permission path:
	 *   1. `onDidReceiveEvent` listener attached
	 *   2. idle watchdog armed
	 *   3. `postRegisterAction()` runs (POSTs /decide; worker proceeds; reasoner streams events;
	 *      events captured by step 1)
	 *   4. listener processes captured events, watchdog reset on each
	 */
	private _listenForContinuation(
		streamClient: IEventStreamClient,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		request?: IChatAgentRequest,
		postRegisterAction?: () => Promise<void>,
	): Promise<IChatAgentResult> {
		const startTime = Date.now();
		const effects = this._ensureEditorEffects();
		if (request) {
			effects.setActiveSession(request.sessionResource);
		}
		const runtime = request
			? this._getOrCreateRuntime(request.sessionResource)
			: {
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
			  } as IChatSessionRuntime;

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;
			let contStepCount = 0;
			// Idle-watchdog (HANDOFF §8 / Phase B follow-up §12 #2): in
			// multi-step Full Auto chains the IDE listener occasionally
			// stops receiving events even though the round is still
			// progressing on the reasoner side, leaving the chat spinner
			// stuck forever. Symptoms point at a hot-event drop window
			// between `await decide()` returning and the listener being
			// registered, plus SSE reconnect races. Until that root cause
			// is fully traced, guarantee the round terminates with a
			// graceful error after a long idle period so the user can
			// reopen the chat and try again rather than restart the IDE.
			//
			// Threshold tuned to be generous: a 50-line LLM completion
			// streams in ~5 s on the slowest configured backend; 90 s
			// without ANY event is well outside legitimate quiet periods
			// (heartbeat events arrive every 30 s from the SseClient idle
			// watchdog, so this watchdog effectively detects a dead SSE
			// stream that the lower layer also failed to reconnect).
			const IDLE_TIMEOUT_MS = 90_000;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const armIdleTimer = () => {
				if (idleTimer !== undefined) {
					clearTimeout(idleTimer);
				}
				idleTimer = setTimeout(() => {
					if (resolved) {
						return;
					}
					this._logService.warn(
						'[ChipOS Agent] _listenForContinuation idle for %dms — finishing with graceful error',
						IDLE_TIMEOUT_MS,
					);
					progress([{
						kind: 'agentError',
						error_code: 'CONTINUATION_IDLE_TIMEOUT',
						message: '⏱️ **会话静默超时**：未在预期时间内收到后端事件，请重新发送或刷新对话。',
						retryable: true,
						suggestion: '若经常发生，请检查与 reasoner 的网络连通或开启开发者工具查看 SSE 错误。',
					} satisfies IChatAgentError]);
					finish({ errorDetails: { message: '_listenForContinuation idle timeout' } });
				}, IDLE_TIMEOUT_MS);
			};

			const finish = (result: IChatAgentResult, thinkingTitle?: string) => {
				if (!resolved) {
					// Working-set fallback: also flush here for the
					// continuation path (confirmation responses). Same
					// rationale as invoke()'s finish — the spec/subagent flow
					// often closes SSE without explicit task_complete.
					// `request` is optional on this path (worker-permission
					// continuations can lack it); only flush when present.
					if (request) {
						this._flushWatchedFileChanges(request.sessionResource, request.requestId, runtime, progress)
							.catch(err => this._logService.warn('[ChipOS Agent] flushWatchedFileChanges@cont-finish failed', err));
					}
					// Fix P2 (2026-05-20): mirror the invoke()-side flush to release
					// the FullTracer buffer when continuation ends without a
					// task_complete event. See the same comment in invoke().
					this._fullTracer.flush().catch(err => {
						this._logService.warn('[ChipOS Agent] FullTracer.flush@cont-finish failed:', err);
					});
					if (thinkingTitle || contStepCount > 0) {
						const title = thinkingTitle ?? `Completed ${contStepCount} step${contStepCount === 1 ? '' : 's'}`;
						progress([{ kind: 'thinking', value: '', generatedTitle: title } satisfies IChatThinkingPart]);
					}
					resolved = true;
					if (idleTimer !== undefined) {
						clearTimeout(idleTimer);
						idleTimer = undefined;
					}
					listener.dispose();
					connStateListener.dispose();
					result = {
						...result,
						timings: { totalElapsed: Date.now() - startTime },
					};
					// WORKER-PERMISSION-ASK-TRANSPORT: continuation done; mirror
					// the cleanup invoke() does so a later worker ASK queues
					// rather than firing into this stale callback.
					if (runtime.activeProgress === progress) {
						runtime.activeProgress = undefined;
					}
					if (runtime.activeFinish === finish) {
						runtime.activeFinish = undefined;
					}
					resolve(result);
				}
			};
			runtime.activeFinish = finish;

			// Race-fix (2026-05-20): pause the idle watchdog while the SSE
			// stream itself is down. The 90s timer is meant to catch a
			// "backend still healthy but silent" case (e.g. hot-event drop
			// window between worker /decide and listener registration —
			// see the comment block on _listenForContinuation). It is NOT
			// meant to fire when the SSE stream is reconnecting after a
			// reasoner restart: events legitimately can't arrive in that
			// window, and tearing down the listener here makes the IDE
			// miss the worker tool result when reconnect completes —
			// reproduced 2026-05-20 by `docker restart` of the reasoner
			// mid-Verification-Upgrade. Clear the timer on any non-
			// Connected transition; re-arm on Connected.
			const connStateListener = streamClient.onDidChangeConnectionState((state: ConnectionState) => {
				if (resolved) { return; }
				if (state !== ConnectionState.Connected) {
					if (idleTimer !== undefined) {
						this._logService.info('[ChipOS Agent] SSE state=%s — clearing idle timer until reconnect', state);
						clearTimeout(idleTimer);
						idleTimer = undefined;
					}
				} else {
					this._logService.info('[ChipOS Agent] SSE state=connected — re-arming idle timer');
					armIdleTimer();
				}
			});

			const listener = streamClient.onDidReceiveEvent((event: AgentEvent) => {
				if (resolved) { return; }
				if (runtime.backendSessionId && event.session_id && event.session_id !== runtime.backendSessionId) {
					this._logService.trace('[ChipOS Agent] Ignoring continuation event for different session', event.session_id, 'expected', runtime.backendSessionId, 'type', event.event_type);
					return;
				}

				// Any event observed from the backend resets the idle
				// watchdog. Includes heartbeat / status events as well
				// as real content — a live SSE stream is enough to keep
				// the round open even if no LLM tokens are arriving.
				armIdleTimer();

				try {
					if (request) {
						effects.handleEvent(request.sessionResource, event);
					}
				} catch (e) {
					this._logService.warn('[ChipOS Agent] Editor effect error (continuation):', String(e));
				}

				try {
					this._handleAgentEvent(event, {
						runtime,
						progress,
						finish,
						request,
						streamClient,
						sessionId: runtime.backendSessionId ?? '',
					});
				} catch (eventErr) {
					this._logService.error('[ChipOS Agent] Event handler error (continuation) for', event.event_type, eventErr);
				}

				// Terminal session-lost: short-circuit the 90s idle watchdog so
				// the user doesn't see SESSION_LOST_RECOVERABLE followed (90 s
				// later) by CONTINUATION_IDLE_TIMEOUT on top of it. The
				// SSE-client's SESSION_NOT_FOUND handler already stopped its
				// reconnect loop; this finish() collapses the round on the
				// chat-agent side. The user's instruction "send another
				// message to start a fresh session" then works on the next
				// chat input.
				if (event.event_type === AgentEventType.Error) {
					const payload = event.payload as { code?: string; error_code?: string } | undefined;
					const code = payload?.code ?? payload?.error_code;
					if (code === 'SESSION_LOST_RECOVERABLE') {
						this._logService.info('[ChipOS Agent] SESSION_LOST_RECOVERABLE — finishing continuation immediately');
						finish({ errorDetails: { message: 'Session lost (reasoner restart) — start a new chat' } });
					}
				}
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested (continuation)');
				if (runtime.backendSessionId) {
					streamClient.sendStop(runtime.backendSessionId);
				}
				finish({});
			});

			// Arm the watchdog *after* the listener is installed so any
			// event we already missed during the await/POST window does
			// not count against the idle window — the timer only starts
			// counting from now.
			armIdleTimer();

			// Race-fix (2026-05-19): now that the listener is attached and
			// the watchdog armed, run any deferred decide/POST that the
			// caller wants to ride INSIDE the listener window. Previously
			// callers awaited `_workerPermissionService.decide(...)` BEFORE
			// invoking `_listenForContinuation`, and the worker → reasoner
			// → SSE event burst could fire before this listener registered
			// — those events vanished into a fire-and-forget Emitter and
			// `CONTINUATION_IDLE_TIMEOUT` surfaced 90 s later.
			if (postRegisterAction) {
				postRegisterAction().catch(err => {
					this._logService.warn(
						'[ChipOS Agent] postRegisterAction failed during continuation: %s',
						err instanceof Error ? err.message : String(err),
					);
				});
			}
		});
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

	// ── FEAT-29: Friendly titles for confirm card types ──
	/**
	 * If subagent text content looks like raw JSON, extract readable fields.
	 * Otherwise return as-is.
	 */
	private static _renderSubagentText(content: string): string {
		const trimmed = content.trim();
		if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
			return content;
		}
		try {
			const obj = JSON.parse(trimmed);
			const parts: string[] = [];
			if (obj.description) { parts.push(String(obj.description)); }
			if (obj.subagent_type) { parts.push(`Type: ${obj.subagent_type}`); }
			if (obj.prompt) {
				const prompt = String(obj.prompt);
				parts.push(prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt);
			}
			return parts.length > 0 ? parts.join('\n\n') : content;
		} catch {
			return content;
		}
	}

	/**
	 * Pick the best one-line "subject" for a `hook_confirm` card to surface
	 * as the chipos card's `specifier` (the clickable code-style slot next
	 * to the tool icon). Hook payloads carry several candidate strings; we
	 * fall through them in order of specificity: hook_name → command →
	 * description (truncated) → the card title as a last resort. The
	 * specifier is rendered as inline-code so we keep it short and stable.
	 */
	private static _hookSpecifier(cardData: Record<string, unknown> | undefined, fallbackTitle: string): string {
		const data = cardData ?? {};
		const hookName = typeof data['hook_name'] === 'string' ? data['hook_name'] as string : undefined;
		if (hookName) {
			return hookName;
		}
		const command = typeof data['command'] === 'string' ? data['command'] as string : undefined;
		if (command) {
			// Hook commands can be long shell strings — trim so the header
			// row doesn't wrap aggressively.
			return command.length > 80 ? command.slice(0, 77) + '…' : command;
		}
		const description = typeof data['description'] === 'string' ? data['description'] as string : undefined;
		if (description) {
			return description.length > 80 ? description.slice(0, 77) + '…' : description;
		}
		return fallbackTitle;
	}

	/**
	 * Render a `hook_confirm` card's secondary fields (description / impact
	 * / command) into a plain-text preview block. The chipos card uses a
	 * `<pre>` element for the preview slot — no markdown, no codicons —
	 * so we flatten the markdown markers (the same fields are already
	 * rendered as rich markdown in `confirmation.message` for accessibility,
	 * but the visual card uses this plain version).
	 */
	private static _hookContentPreview(cardData: Record<string, unknown> | undefined): string | undefined {
		const data = cardData ?? {};
		const lines: string[] = [];
		const description = typeof data['description'] === 'string' ? data['description'] as string : undefined;
		const impact = typeof data['impact'] === 'string' ? data['impact'] as string : undefined;
		const command = typeof data['command'] === 'string' ? data['command'] as string : undefined;
		if (description) {
			lines.push(description);
		}
		if (impact) {
			if (lines.length > 0) {
				lines.push('');
			}
			lines.push(`Impact: ${impact}`);
		}
		if (command) {
			if (lines.length > 0) {
				lines.push('');
			}
			lines.push(`Command: ${command}`);
		}
		return lines.length > 0 ? lines.join('\n') : undefined;
	}

	/**
	 * Map a backend `ConfirmRequest.card_type` to the chipos card's `tool`
	 * field — that drives the codicon header + left-bar tool color (see
	 * `ChipOSPermissionCardContentPart._toolCodicon` and the
	 * `.chipos-permission-card.tool-{x}` rules in chipOSPermissionCard.css).
	 *
	 * Falls back to `'Edit'` (pencil + purple bar) which is neutral enough
	 * for review-flavor cards (spec / arch / code / design / agent) — the
	 * verification-pipeline H14/H15 etc. also land here. `hook_confirm`
	 * doesn't reach this path (it has its own branch with `tool: 'Bash'`).
	 */
	private static _cardTypeToTool(cardType: string): string {
		switch (cardType) {
			case 'file_edit': return 'Edit';
			case 'agent_ask': return 'Read'; // file/document icon for decision-required
			case 'VERIFICATION_GROUP_REVIEW':
			case 'VERIFICATION_HUMAN_CHECK': return 'Edit';
			case 'spec_confirm':
			case 'arch_confirm':
			case 'design_confirm':
			case 'code_confirm':
			default: return 'Edit';
		}
	}

	/**
	 * Pick a one-line "subject" for the chipos card's `specifier` slot
	 * (the inline-code chip next to the tool icon) based on card_type.
	 * Each card_type has its own subject field in `card_data`; fall
	 * through them in order of specificity, then use the title as last
	 * resort. Truncate at 80 chars to keep the header row compact.
	 */
	private static _cardSpecifier(cardType: string, cardData: Record<string, unknown> | undefined, fallbackTitle: string): string {
		const data = cardData ?? {};
		const pick = (k: string): string | undefined => {
			const v = data[k];
			return typeof v === 'string' && v.length > 0 ? v : undefined;
		};
		// For analysis-style cards the backend ships a multi-line text
		// blob (spec_result / arch_result / context) rather than a short
		// subject — surface the first non-empty line, stripping any
		// leading markdown heading prefix, so the chip reads cleanly.
		const firstLine = (k: string): string | undefined => {
			const blob = pick(k);
			if (!blob) { return undefined; }
			const line = blob.split('\n').find(l => l.trim().length > 0)?.trim();
			return line ? line.replace(/^#+\s*/, '') : undefined;
		};
		let subject: string | undefined;
		switch (cardType) {
			// confirm_phases.py:351 ships {spec_result|arch_result: <analysis>}
			case 'spec_confirm': subject = firstLine('spec_result'); break;
			case 'arch_confirm': subject = firstLine('arch_result'); break;
			// agent_core.py:1204 + flow_tools.py:48 ship {context, options}
			case 'agent_ask': subject = firstLine('context'); break;
			// 2026-05-26 — file_edit ships {file_path, description, diff}.
			// Without this case the chip fell back to the title "File Edit"
			// which is just the card type, not the file. Showing the path
			// makes the header chip actually informative.
			case 'file_edit': subject = pick('file_path'); break;
			// verification_pipeline.py:{530,1213}
			case 'VERIFICATION_GROUP_REVIEW': subject = pick('stage_group'); break;
			case 'VERIFICATION_HUMAN_CHECK': subject = pick('stage'); break;
			// permission_middleware._build_permission_card
			case 'permission_ask': subject = pick('tool'); break;
			default:
				// sim_fail_decision / max_loops_reached / coverage_decision /
				// worktree_apply / *_escalation / etc. — most carry one of
				// these common keys; fall back to the card title otherwise.
				subject = pick('subject') ?? pick('stage') ?? pick('name');
		}
		subject = subject ?? fallbackTitle;
		return subject.length > 80 ? subject.slice(0, 77) + '…' : subject;
	}

	private static _confirmTitle(cardType: string, cardData?: Record<string, unknown>, _fallbackTitle?: string): string {
		let base: string;
		switch (cardType) {
			case 'spec_confirm': base = 'Spec Review'; break;
			case 'arch_confirm': base = 'Architecture Review'; break;
			case 'design_confirm': base = 'Design Review'; break;
			case 'code_confirm': base = 'Code Review'; break;
			case 'agent_ask': base = 'Decision Required'; break;
			// FEAT-X.1.3 — verification_pipeline (H14-H17) emit these two card types
			// from `composite_tools/verification_pipeline.py` when a stage group
			// finishes or a checker requests human review. Without explicit cases
			// the default branch would render "VERIFICATION GROUP REVIEW" /
			// "VERIFICATION HUMAN CHECK" — readable but obviously not localized.
			case 'VERIFICATION_GROUP_REVIEW': base = 'Verification Stage Review'; break;
			case 'VERIFICATION_HUMAN_CHECK': base = 'Verification Human Check'; break;
			default: base = cardType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
		}
		// Mirror vscode-extension confirmCard.js: prefix "[H14] " when the
		// backend hook supplied an id in card_data, so users can tell apart
		// e.g. H14 (Tag doc) vs H15 (Coverage framework) review cards.
		const hookId = cardData && typeof cardData['hook_id'] === 'string' ? cardData['hook_id'] as string : undefined;
		return hookId ? `[${hookId}] ${base}` : base;
	}

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
	 * Working-set fallback: ensure a recursive watcher on the workspace root
	 * is active for this chat session. The handler records every changed
	 * file URI into `runtime.watchedFileChanges` — flushed at TaskComplete
	 * by `_flushWatchedFileChanges`. No-op when no workspace folder is open
	 * (e.g. user has the IDE in empty mode).
	 */
	private _ensureWorkspaceWatcher(runtime: IChatSessionRuntime): void {
		if (runtime.workspaceWatcher) {
			return;
		}
		const workspaceRoot = this._getWorkspaceRoot();
		if (!workspaceRoot) {
			return;
		}
		const workspaceUri = URI.file(workspaceRoot);
		// Recursive + excludes for the noisy churn buckets — chipos metadata,
		// git internals, node_modules. Without excludes a single `npm install`
		// would flood watchedFileChanges with thousands of URIs.
		const watcher = this._fileService.watch(workspaceUri, {
			recursive: true,
			excludes: ['**/.git/**', '**/node_modules/**', '**/.chipos/**', '**/.vscode/**', '**/__pycache__/**'],
		});
		const onChange = this._fileService.onDidFilesChange(e => {
			// Only ADDED + UPDATED. DELETED files don't make sense to track in
			// the working set (and the framework already filters them out
			// downstream). The global event includes other watchers' changes
			// too — manual workspace-root prefix check below is the filter.
			const candidates: URI[] = [...e.rawAdded, ...e.rawUpdated];
			for (const resource of candidates) {
				if (!resource.path.startsWith(workspaceRoot)) {
					continue;
				}
				// Skip hidden segments in path (mirrors the _startExternalEdit guard).
				const rel = resource.path.slice(workspaceRoot.length + 1);
				if (rel.split('/').some((seg: string) => seg.startsWith('.') && seg.length > 1)) {
					continue;
				}
				runtime.watchedFileChanges.add(resource.toString());
			}
		});
		runtime.workspaceWatcher = {
			dispose: () => {
				try { watcher.dispose(); } catch { /* best effort */ }
				try { onChange.dispose(); } catch { /* best effort */ }
			},
		};
	}

	/**
	 * Working-set fallback: at TaskComplete, walk `runtime.watchedFileChanges`
	 * and feed any file that wasn't already tracked via a direct ToolCall
	 * (i.e. not present in `externalEditOps` keyed by file path) through
	 * `_startExternalEdit + _stopExternalEdit`. That registers the file in
	 * chatEditingSession's `_entriesObs` → the working-set widget renders it.
	 *
	 * This is the safety net for the spec/subagent flow where the reasoner
	 * doesn't send `WorktreeFilesApplied` to the IDE.
	 */
	private async _flushWatchedFileChanges(
		sessionResource: URI,
		requestId: string,
		runtime: IChatSessionRuntime,
		progress: (parts: IChatProgress[]) => void,
	): Promise<void> {
		if (runtime.watchedFileChanges.size === 0) {
			return;
		}
		const trackedFiles = new Set<string>();
		for (const fp of runtime.toolFileArgs.values()) {
			trackedFiles.add(fp);
		}
		const workspaceRoot = this._getWorkspaceRoot();
		const changes = [...runtime.watchedFileChanges];
		runtime.watchedFileChanges.clear();
		for (const uriString of changes) {
			const fileUri = URI.parse(uriString);
			const relPath = workspaceRoot && fileUri.path.startsWith(workspaceRoot)
				? fileUri.path.slice(workspaceRoot.length + 1)
				: fileUri.path;
			if ([...trackedFiles].some(tp => tp === relPath || relPath.endsWith(tp))) {
				continue;
			}
			const syntheticKey = `fswatch:${requestId}:${uriString}`;
			// Read whatever the file was at IDE startup (or empty for new
			// files) and pass it as the beforeSnapshot. Without this, the
			// framework's stopExternalEdits takes the "beforeSnapshot ===
			// undefined" path → only records FileOperationType.Create and
			// SKIPS computeEditsFromSnapshots → entry.linesAdded stays at 0
			// → working-set widget displays "+0 -0" despite the file
			// obviously containing content. Empty-string snapshot routes
			// through the regular diff path so the widget shows the right
			// numbers ("+N -0" for a new file with N lines).
			//
			// We don't have the actual prior file content for files that
			// already existed (fswatch caught a modification, not creation),
			// so '' is a lossy default — for net-new files it's accurate;
			// for modifications the +/- count will reflect the new content
			// minus the empty baseline (so +N total lines, -0). That's still
			// far better than the +0/-0 sentinel.
			const beforeSnapshot = '';
			this._startExternalEdit(syntheticKey, fileUri, sessionResource, requestId, runtime, beforeSnapshot);
			try {
				const editProgress = await this._stopExternalEdit(syntheticKey, sessionResource, runtime);
				if (editProgress.length > 0) {
					progress(editProgress);
				}
			} catch (err) {
				this._logService.warn('[ChipOS Agent] flushWatchedFileChanges: stop failed', fileUri.path, err);
			}
		}
	}

	/**
	 * Returns the previous request whose response still has an unresolved
	 * **Decision Required** confirmation card (chipos `ConfirmRequest` event
	 * with Approve/Reject/multi-option buttons), if any. Used by invoke()
	 * to short-circuit free-form input that would otherwise dispatch a new
	 * task while the backend session is still waiting on the card —
	 * yielding a 409 SESSION_ALREADY_RUNNING.
	 *
	 * Important: this looks ONLY at `kind === 'confirmation'` parts. It
	 * deliberately ignores the framework's `WaitingForPostApproval` /
	 * `WaitingForConfirmation` tool-invocation states (which back the
	 * working-set "Keep / Undo" buttons under the chat input). Those are
	 * post-edit review affordances, not gating Decision Required cards,
	 * and gating new prompts on them would block every conversation that
	 * left an unsettled edit in the working set — exactly the false
	 * positive observed on 2026-05-15.
	 *
	 * Walks from the second-most-recent request backwards because the
	 * very-last entry is typically the in-flight invoke we're inside.
	 */
	private _findPendingConfirmation(sessionResource: URI): IChatResponseModel | undefined {
		const chatModel = this._chatService.getSession(sessionResource);
		if (!chatModel) { return undefined; }
		const requests = chatModel.getRequests();
		// Last entry is the current request (just enqueued); inspect prior ones.
		for (let i = requests.length - 2; i >= 0; i--) {
			const response = requests[i]?.response;
			if (!response) { continue; }
			// Scan the response's content parts directly — we only care about
			// `confirmation` parts (chipos ConfirmRequest → IChatConfirmation).
			// `response.isPendingConfirmation` is too broad: it also flips true
			// for tool-invocation post-approval states (Keep/Undo on the
			// working-set widget), which we explicitly want to allow.
			for (const part of response.response.value) {
				if (part.kind === 'confirmation' && !part.isUsed) {
					return response;
				}
			}
		}
		return undefined;
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

	private static _formatRawInput(toolName: string, args: unknown): unknown {
		if (!args || typeof args !== 'object') { return args ?? {}; }
		const obj = args as Record<string, unknown>;

		// Subagent / task tools — show readable text instead of raw JSON
		if (toolName === 'task' || toolName === 'run_subagent' || toolName === 'transfer_to_agent') {
			const parts: string[] = [];
			if (obj.description) { parts.push(`Description: ${obj.description}`); }
			if (obj.subagent_type) { parts.push(`Type: ${obj.subagent_type}`); }
			if (obj.prompt) {
				const prompt = String(obj.prompt);
				parts.push(`Prompt:\n${prompt.length > 500 ? prompt.slice(0, 500) + '…' : prompt}`);
			}
			if (obj.model) { parts.push(`Model: ${obj.model}`); }
			return parts.length > 0 ? parts.join('\n\n') : args;
		}

		// File tools — show path prominently
		if (obj.file_path || obj.path || obj.file) {
			const fp = String(obj.file_path ?? obj.path ?? obj.file);
			if (obj.content && typeof obj.content === 'string') {
				return `File: ${fp}\n\n${obj.content}`;
			}
			return `File: ${fp}`;
		}

		return args;
	}

	private static _truncStr(s: string, max: number): string {
		return s.length > max ? s.slice(0, max) + '...' : s;
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
	 * FEAT-35: Backend may send summary as a string (e.g. "5 tests: 3 passed, 2 failed")
	 * instead of the structured object expected by IChatEdaSimReport.
	 */
	private static _normalizeSimSummary(
		raw: unknown,
		tests?: Array<{ status: string }>,
	): { total: number; passed: number; failed: number; errors?: number } {
		if (typeof raw === 'object' && raw !== null && 'total' in (raw as Record<string, unknown>)) {
			return raw as { total: number; passed: number; failed: number; errors?: number };
		}
		if (typeof raw === 'string') {
			const totalMatch = raw.match(/(\d+)\s*test/i);
			const passedMatch = raw.match(/(\d+)\s*pass/i);
			const failedMatch = raw.match(/(\d+)\s*fail/i);
			const errorMatch = raw.match(/(\d+)\s*error/i);
			return {
				total: totalMatch ? parseInt(totalMatch[1], 10) : (tests?.length ?? 0),
				passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
				failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
				errors: errorMatch ? parseInt(errorMatch[1], 10) : undefined,
			};
		}
		const t = tests ?? [];
		return {
			total: t.length,
			passed: t.filter(x => x.status === 'pass').length,
			failed: t.filter(x => x.status === 'fail').length,
			errors: t.filter(x => x.status === 'error').length || undefined,
		};
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
	 * Build the IChatContentReference for a modified/created/deleted file,
	 * if (and only if) we haven't already emitted one for that resolved
	 * absolute path in the current invoke. Returns undefined when:
	 *   - tool isn't a file-mutating one (read_file etc.)
	 *   - we've already emitted a ref for the same file (B-F1 dedupe)
	 *   - path resolution fails
	 *
	 * Also handles the path-shape footguns: collapses `/./` and double
	 * slashes (B-F2), and detects Windows-style absolute paths
	 * (`C:\foo\bar`) so they aren't mistakenly treated as relative and
	 * re-rooted under the workspace (B-F3).
	 */
	private static readonly _fileMutatingTools = new Set([
		'edit_file', 'create_file', 'apply_diff', 'write_file',
		'delete_file', 'str_replace',
	]);

	private static _isAbsolutePath(p: string): boolean {
		// POSIX: leading slash. Windows: drive letter followed by `:\` or `:/`.
		return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
	}

	private static _normalizePath(p: string): string {
		return p
			.replace(/\\/g, '/')   // Windows backslashes → forward slash so the
			//                        rest of the regex chain is uniform.
			.replace(/\/{2,}/g, '/') // collapse runs of slashes
			.replace(/\/\.\//g, '/') // collapse "/./" mid-path
			.replace(/^\.\//, '')    // strip leading "./"
			.replace(/\/\.$/, '');   // strip trailing "/."
	}

	private _buildFileRef(
		filePath: string,
		toolName: string,
		runtime: IChatSessionRuntime,
	): IChatContentReference | undefined {
		if (!ChipOSChatAgent._fileMutatingTools.has(toolName)) {
			return undefined;
		}
		const workspaceRoot = this._getWorkspaceRoot();
		const isAbs = ChipOSChatAgent._isAbsolutePath(filePath);
		const joined = isAbs ? filePath : (workspaceRoot ? `${workspaceRoot}/${filePath}` : filePath);
		const absPath = ChipOSChatAgent._normalizePath(joined);

		// B-F1: dedupe per invoke. Tracking the resolved absolute path means
		// `rtl/x.v` and `./rtl/x.v` collapse to one row even if the agent
		// alternates the spelling.
		if (runtime.emittedFileRefs.has(absPath)) {
			return undefined;
		}
		runtime.emittedFileRefs.add(absPath);

		const isDelete = toolName === 'delete_file';
		return {
			kind: 'reference',
			reference: URI.file(absPath),
			options: {
				status: {
					description: isDelete ? '$(diff-removed) deleted' : '$(diff-modified) modified',
					kind: isDelete
						? ChatResponseReferencePartStatusKind.Omitted
						: ChatResponseReferencePartStatusKind.Complete,
				},
				isDeletion: isDelete,
			},
		};
	}

	/**
	 * Heuristic: does this Status text look like backend-internal log output
	 * leaking into the chat? Common shapes seen in production:
	 *   "Session started (mode=local)"
	 *   "Agent ready (proxy_remote=True)"
	 *   "[WorkerAuth] foo=bar"
	 * These are debug f-strings from `agent_session.py` / `agent_core.py` etc.
	 * Any "(...=...)" parenthetical or a bare "key=value" trailing token is
	 * treated as protocol detail and swallowed.
	 */
	private static _isProtocolDebugStatus(text: string): boolean {
		// Parenthetical with key=value inside (matches "(mode=local)", "(proxy_remote=True)", etc.)
		if (/\([^)]*=[^)]*\)/.test(text)) {
			return true;
		}
		// Square-bracket prefix tag like "[WorkerAuth] ..." — log line shape
		if (/^\[[A-Z][A-Za-z]+\]\s/.test(text)) {
			return true;
		}
		return false;
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

	/**
	 * Return the list of required LLM settings that are still empty.
	 * Used to surface a precise diagnostic before talking to the backend,
	 * so users don't see opaque 401/404 errors when they simply haven't
	 * filled in the form.
	 */
	private _getMissingLlmFields(): string[] {
		const missing: string[] = [];
		if (!(this._configurationService.getValue<string>('chipos.apiKey') ?? '').trim()) {
			missing.push('chipos.apiKey');
		}
		if (!(this._configurationService.getValue<string>('chipos.apiBaseUrl') ?? '').trim()) {
			missing.push('chipos.apiBaseUrl');
		}
		if (!(this._configurationService.getValue<string>('chipos.model') ?? '').trim()) {
			missing.push('chipos.model');
		}
		return missing;
	}

	// ── FEAT-R72: IDE 端工具执行 ────────────────────────────────────────────

	/**
	 * IDE 端工具输出缓存（terminal_id → output）
	 * 用于 get_terminal_output 工具读取之前 run_in_terminal 的输出
	 */
	private readonly _terminalOutputCache = new Map<string, { output: string; exitCode?: number }>();

	/**
	 * A1 (issue #51 comment 2): live confirmation cards keyed by request_id.
	 * Lets `confirm_auto_resolved` flip `isUsed = true` on the original card so
	 * its buttons stop accepting clicks once the server-side timeout has
	 * already moved on with a default action.
	 */
	private readonly _pendingConfirmations = new Map<string, IChatConfirmation>();

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
	 * 处理 Reasoner 推送的 ide_tool_call 事件。
	 * 根据工具名分发到对应的执行方法，执行完毕后回传结果。
	 */
	private async _executeIdeToolCall(
		payload: IIdeToolCallPayload,
		runtime: IChatSessionRuntime,
		streamClient: IEventStreamClient,
	): Promise<void> {
		// T-08: Skip if session already disposed
		if (runtime.disposeController.signal.aborted) {
			this._logService.warn('[ChipOS Agent] IDE tool call skipped (session disposed): call_id=%s, name=%s', payload.call_id, payload.name);
			return;
		}

		const { call_id, name, args_json } = payload;
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(args_json) as Record<string, unknown>;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const sessionId = runtime.backendSessionId ?? '';
			streamClient.sendIdeToolResult(sessionId, call_id, `IDE tool '${name}' failed parsing args: ${msg}`, true);
			return;
		}

		const { content, isError } = await this._dispatchIdeTool(name, args, runtime, call_id);

		// 回传结果给 Reasoner (legacy stateful path)
		const sessionId = runtime.backendSessionId ?? '';
		this._logService.info(
			'[ChipOS Agent] IDE tool result: call_id=%s, is_error=%s, content_len=%d',
			call_id, isError, content.length,
		);
		streamClient.sendIdeToolResult(sessionId, call_id, content, isError);
	}

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
	 */
	private async _dispatchIdeTool(
		name: string,
		args: Record<string, unknown>,
		runtime: IChatSessionRuntime,
		callId: string,
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
					this._logService.info('[ChipOS Agent] run_in_terminal approval: mode=%s, cmd=%s', approveMode, cmd);
					if (approveMode !== 'full_auto') {
						const confirmed = await this._awaitTerminalApproval(callId, cmd, runtime);
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
		const progress = runtime.activeProgress;
		const finish = runtime.activeFinish;
		if (!progress || !finish) {
			this._logService.warn('[ChipOS Agent] terminal approval: no activeProgress/Finish — auto-rejecting');
			return Promise.resolve(false);
		}

		// One pending approval per call_id. The next invoke matches via
		// `__chiposTerminalConfirmId` on the accepted/rejected data.
		const existing = this._pendingTerminalApprovals.get(call_id);
		if (existing) {
			// Duplicate dispatch (shouldn't happen): re-use the existing
			// deferred so we don't lose the first awaiter.
			return existing.p;
		}
		const deferred = new DeferredPromise<boolean>();
		this._pendingTerminalApprovals.set(call_id, deferred);

		const title = localize('chipos.terminal.approval.title', 'ChipOS wants to run a terminal command');
		const runLabel = localize('chipos.terminal.approval.run', 'Run');
		const rejectLabel = localize('chipos.terminal.approval.reject', 'Reject');

		// Plain string message (visible to screen-readers + accessible
		// preview when the custom card collapses). The card's main visual
		// — header + buttons — is built by `ChipOSPermissionCardContentPart`
		// from the data fields below, not from this message body.
		const message = `${cmd || '(empty command)'}`;

		const confirmation: IChatConfirmation = {
			kind: 'confirmation',
			title,
			message,
			// IChipOSTerminalConfirmCardData shape — routes to chipos
			// permission card renderer via `isChipOSCardData` umbrella.
			data: {
				__chiposTerminalConfirmId: call_id,
				tool: 'Bash',
				specifier: cmd || '(empty command)',
				sessionId: runtime.backendSessionId ?? '',
				requestId: call_id,
				options: [
					{ label: runLabel,    action_id: 'run' },
					{ label: rejectLabel, action_id: 'reject' },
				],
			},
			buttons: [runLabel, rejectLabel],
		};

		progress([confirmation]);
		// Finish the in-flight invoke so the framework opens the input for
		// the next request (button click → new invoke with the
		// accepted/rejected data). Mirrors the existing pattern used by
		// `ConfirmRequest` handler (line 1447).
		finish({}, localize('chipos.terminal.approval.awaiting', 'Awaiting terminal approval'));

		return deferred.p;
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
					const result = await tool.call(args);
					const textParts = (result.content || [])
						.filter((c: any) => c.type === 'text')
						.map((c: any) => c.text);
					return {
						content: textParts.join('\n') || JSON.stringify(result),
						isError: !!result.isError,
					};
				}
			}
			return null;
		} catch (err: any) {
			this._logService.warn('[ChipOS Agent] MCP tool call failed: %s — %s', name, err.message);
			return { content: `MCP tool '${name}' failed: ${err.message}`, isError: true };
		}
	}

	// ── R55: MCP 工具定义上报 Reasoner ────────────────────────────────────

	/**
	 * 收集所有 MCP 工具定义，上报给 Reasoner。
	 * 在 session 开始时和 MCP 工具列表变更时调用。
	 */
	private _collectAndReportMcpTools(streamClient: IEventStreamClient, sessionId: string): void {
		try {
			const tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }> = [];

			// IDE-builtin tools that ARE LLM-callable. The other ide_tool_call
			// names (`agent_ask`, `*_confirm`, `file_edit`, `sim/lint/coverage_report`)
			// are reasoner-PUSH events and must NOT show up in the LLM tool list —
			// they're rendered as confirmation cards / report cards by the chat
			// view based on reasoner's flow, not chosen by the LLM.
			//
			// Wiring fix 2026-05-08: this builtin list was missing entirely;
			// when no user-configured MCP server existed, the function early-
			// returned without ever calling registerIdeMcpTools, so reasoner's
			// `_ide_mcp_tool_names = {}` and the LLM had no awareness of
			// terminal capabilities at all.
			// run_in_terminal advertisement gate.
			//
			// History: Bug #17 (2026-05-20 dogfood) found the chipos
			// `run_in_terminal` handler used `IDialogService.confirm()` for
			// approval — a centered, draggable, blocking modal. The previous
			// fix here was to STOP advertising the tool to the LLM (default
			// `disable = true`) so the model would prefer worker-side
			// `execute_command` / `execute` (which already used the inline
			// ChipOSPermissionCard).
			//
			// 2026-05-21: the modal is gone — the handler now emits an
			// inline `IChatConfirmation` (commit ed9e1bc420e). The flow
			// renders in the same widget family as the chipos permission
			// card + hook confirm card, so there's no longer a UX reason
			// to hide the tool. Flip the default to **enabled**; the
			// config key stays as an escape hatch (set to `true` to
			// disable if the inline approval flow misbehaves).
			const disableRunInTerminal = this._configurationService.getValue<boolean>('chipos.terminal.disableRunInTerminalTool');
			const effectiveDisable = disableRunInTerminal === undefined ? false : disableRunInTerminal;
			if (!effectiveDisable) {
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
					parameters_json_schema: JSON.stringify({
						type: 'object',
						properties: {
							command: { type: 'string', description: 'The shell command to run.' },
							explanation: { type: 'string', description: 'Brief explanation of why this command is being run (shown to user in approval dialog).' },
							isBackground: { type: 'boolean', description: 'Whether the command should be started as a background task (default false).' },
						},
						required: ['command'],
					}),
					source: 'ide-builtin',
				});
			}
			tools.push({
				name: 'get_terminal_output',
				description:
					'Get the output from a previously started terminal. ' +
					'Use after `run_in_terminal` to check on background tasks or get additional output ' +
					'when the initial response was truncated or the task is still running.',
				parameters_json_schema: JSON.stringify({
					type: 'object',
					properties: {
						terminal_id: { type: 'string', description: 'The terminal ID returned by run_in_terminal.' },
					},
					required: ['terminal_id'],
				}),
				source: 'ide-builtin',
			});

			// User-configured MCP servers (additive on top of builtins)
			const servers = this._mcpService.servers.get();
			for (const server of servers) {
				const serverTools = server.tools.get();
				if (!serverTools) { continue; }
				for (const tool of serverTools) {
					tools.push({
						name: tool.definition.name,
						description: tool.definition.description || '',
						parameters_json_schema: JSON.stringify(tool.definition.inputSchema || {}),
						source: `mcp:${server.definition.id}`,
					});
				}
			}

			// Always call register, even with just builtins. (Reasoner needs
			// the registration to populate `_ide_mcp_tool_names`; otherwise
			// LLM never sees `run_in_terminal`.)
			this._logService.info('[ChipOS Agent] Reporting %d IDE tools to Reasoner (%d builtin + %d MCP)',
				tools.length, 2, tools.length - 2);
			streamClient.registerIdeMcpTools(sessionId, tools);
		} catch (err: any) {
			this._logService.warn('[ChipOS Agent] Failed to collect MCP tools: %s', err.message);
		}
	}

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

	private _warning(content: string): IChatWarningMessage {
		return { kind: 'warning', content: new MarkdownString(content, { supportThemeIcons: true }) };
	}

	// ── Context collector ───────────────────────────────────────────────────

	private _ensureContextCollector(): ContextCollector {
		if (!this._contextCollector) {
			this._contextCollector = this._register(
				this._instantiationService.createInstance(ContextCollector)
			);
		}
		return this._contextCollector;
	}

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
				clientListeners: new DisposableStore(),
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

		runtime.streamClient?.dispose();
		runtime.clientListeners.dispose();
		runtime.workspaceWatcher?.dispose();
		runtime.workspaceWatcher = undefined;
		runtime.watchedFileChanges.clear();
		runtime.streamClient = undefined;
		runtime.backendSessionId = undefined;
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
		// Clean up any connection banner for this session
		this._hideConnectionBanner(sessionResource);
		this._connectionBanners.delete(sessionResource);
	}

	// ── Connection Banner ─────────────────────────────────────────────────────

	private _showConnectionBanner(sessionResource: URI, state: ConnectionState): void {
		// Find the chat widget for this session
		const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		const listContainer = widget?.domNode?.querySelector<HTMLElement>('.interactive-list');
		if (!listContainer) {
			// Widget not visible — fall back to notification
			if (state === ConnectionState.Error) {
				this._notificationService.warn(
					localize('chipos.agent.disconnected', 'ChipOS: Backend connection failed. Check if the Reasoner is running.')
				);
			}
			return;
		}

		let banner = this._connectionBanners.get(sessionResource);
		if (!banner) {
			banner = new ConnectionBannerHandler(this._logService);
			this._connectionBanners.set(sessionResource, banner);
		}

		banner.show(listContainer, state, () => {
			// "Reconnect Now" clicked — re-run _ensureClient
			this._ensureClient(sessionResource).catch(err => {
				this._logService.error('[ChipOS Agent] Manual reconnect failed:', String(err));
			});
		});
	}

	private _hideConnectionBanner(sessionResource: URI): void {
		const banner = this._connectionBanners.get(sessionResource);
		if (banner) {
			banner.hide();
		}
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

	private _setSessionBackendId(sessionResource: URI, backendSessionId: string | undefined): void {
		const runtime = this._getOrCreateRuntime(sessionResource);
		const previous = runtime.backendSessionId;
		runtime.backendSessionId = backendSessionId;

		// WORKER-PERMISSION-ASK-TRANSPORT: open the SSE channel as soon as we
		// know the backend session id. If the id changes for the same chat
		// thread (rare — only when a runtime is reused across sign-in events),
		// dispose the old subscription before opening a new one.
		if (previous !== backendSessionId) {
			runtime.permissionSub?.dispose();
			runtime.permissionSub = undefined;
			if (backendSessionId) {
				this._workerPermissionService.startSubscription(backendSessionId).then(sub => {
					// Only keep the new subscription if the runtime still cares
					// about it; otherwise close it immediately.
					if (this._sessionRuntimes.get(sessionResource) === runtime
						&& runtime.backendSessionId === backendSessionId) {
						runtime.permissionSub = sub;
					} else {
						sub.dispose();
					}
				}).catch(err => {
					this._logService.warn('[ChipOS Agent] WorkerPermission subscribe failed:', String(err));
				});
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

	/**
	 * Map a worker-permission card action_id to the (decision, scope) tuple
	 * expected by the worker `/decide` HTTP endpoint.
	 *
	 * v2 (PERMISSION-APPROVAL-UX-V2 §3.3): the card is rendered with four
	 * buttons — Allow once / Always in workspace / Always globally / Deny.
	 * VS Code's IChatConfirmation may route the user's pick through either
	 * `acceptedConfirmationData` or `rejectedConfirmationData` depending on
	 * which button index was clicked (only the primary button hits accepted);
	 * the worker doesn't care, so the same mapping table covers both paths.
	 *
	 * Unknown or missing action defaults to a single-call allow — matches the
	 * legacy v1 behaviour of treating an empty multi-option pick as "Allow
	 * once" rather than denying silently.
	 */
	private _mapWorkerActionToDecision(action: string): { decision: 'allow' | 'deny'; scope: 'once' | 'workspace' | 'user' } {
		switch (action) {
			case 'deny':
			case 'reject':
				return { decision: 'deny', scope: 'once' };
			case 'allow_workspace':
				return { decision: 'allow', scope: 'workspace' };
			case 'allow_always':
				return { decision: 'allow', scope: 'user' };
			case 'allow_once':
			default:
				return { decision: 'allow', scope: 'once' };
		}
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

	private _isWorkerAskConfirmationData(data: unknown): data is { __chiposWorkerAskId: string; requestId?: string; options?: unknown } {
		return !!data && typeof data === 'object' && typeof (data as { __chiposWorkerAskId?: unknown }).__chiposWorkerAskId === 'string';
	}

	// ── Client lifecycle ───────────────────────────────────────────────────

	private async _ensureClient(sessionResource: URI): Promise<IEventStreamClient | undefined> {
		const runtime = this._getOrCreateRuntime(sessionResource);
		if (runtime.streamClient && runtime.streamClient.connectionState === ConnectionState.Connected) {
			this._logService.trace('[ChipOS Agent] Reusing existing connected SSE client');
			return runtime.streamClient;
		}

		// Three-tier resolution (settings > product.json > loopback).
		// Reasoner is reached directly over the public internet (deployment
		// model A: cloud-hosted Reasoner, per-user Worker on a remote EDA
		// server). chipos-remote-ssh does NOT and SHOULD NOT route the chat
		// SSE stream through the SSH tunnel — the worker's gRPC link is the
		// only thing that needs to traverse the tunnel, and it goes
		// Worker → Reasoner directly over its own grpcAddress, not via IDE.
		const baseUrl = resolveReasoningUrl(this._configurationService, this._productService);
		const noProxy = this._configurationService.getValue<string[]>('http.noProxy') ?? [];

		this._logService.info('[ChipOS Agent] Connecting via SSE:', baseUrl, '| http.noProxy:', JSON.stringify(noProxy));

		if (runtime.streamClient && runtime.streamClient instanceof SseEventStreamClient
			&& runtime.streamClient.connectionState !== ConnectionState.Error) {
			this._logService.trace('[ChipOS Agent] Reusing existing SSE client for reconnect');
		} else {
			runtime.streamClient?.dispose();
			runtime.clientListeners.clear();  // drop listeners from previous client

			// Phase 1 Unified Auth: use TokenManager as dynamic token provider
			const tokenProvider = this._tokenManager ? {
				getAccessToken: () => this._tokenManager.getAccessToken(),
				refreshAccessToken: () => this._tokenManager.refreshAccessToken(),
			} : undefined;

			runtime.streamClient = new SseEventStreamClient({ baseUrl, tokenProvider }, this._logService);

			// Monitor connection state changes — show/hide banner in chat widget
			// Tied to clientListeners so it's cleaned up when the client is replaced or disposed
			runtime.clientListeners.add(runtime.streamClient.onDidChangeConnectionState((state) => {
				if (state === ConnectionState.Reconnecting || state === ConnectionState.Error) {
					this._showConnectionBanner(sessionResource, state);
				} else if (state === ConnectionState.Connected) {
					this._hideConnectionBanner(sessionResource);
					if (this._logService) {
						this._logService.info('[ChipOS Agent] SSE reconnected');
					}
				}
			}));
		}

		try {
			await runtime.streamClient.connect();
			this._logService.info('[ChipOS Agent] SSE connected successfully');
		} catch (err) {
			this._logService.error('[ChipOS Agent] Failed to connect SSE:', String(err));
			this._logService.error('[ChipOS Agent] Hint: If proxy issue, add server IP to Settings > http.noProxy');
			return undefined;
		}

		return runtime.streamClient;
	}

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
	private readonly _statelessChatSessionIds = new ResourceMap<string>();
	private readonly _statelessTraces = new ResourceMap<{
		traceId: string;
		lastSequenceId: number;
		abortController: AbortController;
	}>();
	private readonly _statelessAdapter = new ChatModelToRecordsAdapter();
	private readonly _statelessAssembler = new ConversationAssembler();

	/**
	 * Lazy / reused StatelessClient. Recreated when the configured baseUrl
	 * changes (mode switch, user override edit). Token is read at request time
	 * via the bearer header inside the client — but the StatelessClient API
	 * takes a static token in its options, so we re-mint when the token
	 * rotates as well (cheap — instance is option bag + fetch wrapper).
	 */
	private async _ensureStatelessClient(): Promise<StatelessClient> {
		const baseUrl = resolveReasoningUrl(this._configurationService, this._productService);
		let authToken: string | undefined;
		try {
			authToken = await this._tokenManager?.getAccessToken();
		} catch (err) {
			// Cloud reasoner with auth disabled is a valid dev mode — fall
			// through with no token. A 401 will surface at first request.
			this._logService.warn('[ChipOS Stateless] getAccessToken failed (continuing tokenless):', String(err));
		}
		if (!this._statelessClient || this._statelessClientBaseUrl !== baseUrl) {
			this._statelessClient = new StatelessClient({ baseUrl, authToken });
			this._statelessClientBaseUrl = baseUrl;
			this._logService.info('[ChipOS Stateless] Client initialised, baseUrl=%s, auth=%s', baseUrl, authToken ? 'bearer' : 'none');
		} else if (authToken) {
			// Token may have rotated — rebuild so subsequent invokes pick it up.
			this._statelessClient = new StatelessClient({ baseUrl, authToken });
		}
		return this._statelessClient;
	}

	/** Stable per-chat-thread id. Minted on first stateless invoke. */
	private _statelessChatSessionIdFor(sessionResource: URI): string {
		let id = this._statelessChatSessionIds.get(sessionResource);
		if (!id) {
			id = `stateless_chat_${++this._sessionCounter}_${Date.now()}`;
			this._statelessChatSessionIds.set(sessionResource, id);
			this._logService.info('[ChipOS Stateless] New chat_session_id:', id);
		}
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

		let roundEndReceived = false;
		let errorResult: IChatAgentResult | undefined;
		let usage: TokenUsage | undefined;
		// Phase 1 round_end carries final_messages; we don't act on them in
		// the IDE (the framework appends our return value's messages naturally
		// via the chat model), but we keep last-seen for telemetry / future use.
		let lastFinalMessages: Message[] | undefined;
		// Phase 1 checkpoint events bump our resume watermark for the SSE
		// drop / resume flow (handled in `_statelessTraces` map below).

		const applyDispatch = (handled: DispatchResult): void => {
			if (handled.appendText) {
				assistantTextBuf += handled.appendText;
				trackFirstProgress();
			}
			if (handled.flushText) {
				flushAssistantText();
			}
			if (handled.progressMessage) {
				progress([this._progress(handled.progressMessage.content, handled.progressMessage.shimmer)]);
			}
			if (handled.thinkingText) {
				progress([{ kind: 'thinking', value: handled.thinkingText } satisfies IChatThinkingPart]);
			}
			if (handled.markdownError) {
				progress([this._markdown(handled.markdownError)]);
			}
			if (handled.usage !== undefined) {
				usage = handled.usage;
			}
			if (handled.errorMessage !== undefined) {
				errorResult = { errorDetails: { message: handled.errorMessage } };
			}
			if (handled.terminate) {
				roundEndReceived = true;
			}
			if (handled.finalMessages !== undefined) {
				lastFinalMessages = handled.finalMessages;
			}
			// Phase 1 reverse channel: ide_tool_call → execute + POST result back.
			// Fire-and-forget on a background task so the SSE loop keeps draining
			// new events (reasoner's agent loop is awaiting our POST; if we
			// blocked the SSE consumer to await execution, a slow worker tool
			// could stall every subsequent event for the same trace).
			if (handled.ideToolCall) {
				const call = handled.ideToolCall;
				void this._handleStatelessIdeToolCall(client, traceId, request.sessionResource, call).catch(err => {
					this._logService.error('[ChipOS Stateless] ide_tool_call handler failed:', String(err));
				});
			}
			// Phase 1 reverse channel: confirm_request → render card + POST user
			// response. Card rendering is synchronous; user click is what's slow,
			// handled by the existing `acceptedConfirmationData` plumbing below.
			if (handled.confirmRequest) {
				const confirm = handled.confirmRequest;
				void this._handleStatelessConfirmRequest(client, traceId, confirm, progress).catch(err => {
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
					progress([this._markdown(`$(error) **ChipOS:** ${msg}`)]);
					errorResult = { errorDetails: { message: msg } };
					break;
				}
				case 'surface-replay-expired':
					this._logService.warn('[ChipOS Stateless] /replay window expired — surfacing error to user');
					progress([this._markdown('$(warning) **ChipOS:** connection lost and reconnect window expired. Please send your last message again.')]);
					errorResult = { errorDetails: { message: 'replay window expired' } };
					break;
				case 'surface-other': {
					const msg = err instanceof Error ? err.message : String(err);
					this._logService.error('[ChipOS Stateless] unexpected failure:', msg);
					progress([this._markdown(`$(error) **ChipOS:** ${msg}`)]);
					errorResult = { errorDetails: { message: msg } };
					break;
				}
				case 'replay': {
					// Phase 1 (ADR-018 §2 D10 + R-D): swap legacy replay() →
					// resume() — replays SSE buffer then closes (buffer-drain
					// model); future increment plumbs live event handoff
					// (PHASE-1-SEQUENCE-DIAGRAMS §7).
					const lastSeq = this._statelessTraces.get(request.sessionResource)?.lastSequenceId ?? -1;
					this._logService.warn('[ChipOS Stateless] SSE failed (%s) — attempting /resume from seq %d', String(err), lastSeq);
					progress([this._progress('$(sync) Connection interrupted — reconnecting…', true)]);
					try {
						for await (const event of client.resume(chatSessionId, {
							trace_id: traceId,
							last_sequence_id: lastSeq,
							disconnect_reason: 'network',
						}, abortController.signal)) {
							applyDispatch(dispatchStatelessEvent(event, friendlyToolName));
						}
					} catch (replayErr) {
						const replayVerdict = classifySseFailure(replayErr, abortController.signal);
						if (replayVerdict === 'cancelled') {
							flushAssistantText();
							cancelListener.dispose();
							this._statelessTraces.delete(request.sessionResource);
							return { errorDetails: { message: localize('chipos.stateless.cancelled', 'Cancelled by user.') } };
						}
						// Phase 1: distinct error classes for 404 vs 410 paths.
						if (replayErr instanceof StatelessResumeNotFoundError) {
							this._logService.warn('[ChipOS Stateless] /resume 404 — turn already completed or never existed');
							progress([this._markdown('$(info) **ChipOS:** the previous turn already finished. Please send your message again to start a new one.')]);
							errorResult = { errorDetails: { message: 'resume target not found' } };
						} else if (replayVerdict === 'surface-replay-expired') {
							this._logService.warn('[ChipOS Stateless] /resume 410 — SSE buffer evicted');
							progress([this._markdown('$(warning) **ChipOS:** reconnect window expired. Please send your last message again.')]);
							errorResult = { errorDetails: { message: 'replay window expired' } };
						} else {
							const msg = replayErr instanceof Error ? replayErr.message : String(replayErr);
							this._logService.error('[ChipOS Stateless] resume failed:', msg);
							progress([this._markdown(`$(error) **ChipOS:** ${msg}`)]);
							errorResult = { errorDetails: { message: msg } };
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
		return {
			metadata: resultMetadata,
			timings: { totalElapsed, firstProgress: firstProgressTime },
		};
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

		// User-installed MCP servers (VS Code IMcpService)
		try {
			const servers = this._mcpService.servers.get();
			for (const server of servers) {
				const serverTools = server.tools.get();
				if (!serverTools) { continue; }
				for (const tool of serverTools) {
					tools.push({
						name: tool.definition.name,
						description: tool.definition.description || '',
						// IMcpService delivers parsed JSON Schema dict already
						input_schema: (tool.definition.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
						chipos_source: 'ide_mcp',
					});
				}
			}
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
	): Promise<void> {
		this._logService.info(
			'[ChipOS Stateless] ide_tool_call name=%s call_id=%s',
			call.toolName, call.callId,
		);
		const runtime = this._getOrCreateRuntime(sessionResource);
		const { content, isError } = await this._dispatchIdeTool(
			call.toolName, call.args, runtime, call.callId,
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
	 * Renders agent_ask radio form (with selections={}) when card_type is
	 * 'agent_ask' + has questions; otherwise renders generic confirm card.
	 * Card rendering is delegated to ChipOSPermissionCardContentPart via
	 * the `__chiposAgentAskCard` / `__chiposGenericConfirmCard` markers
	 * (same as legacy path so we get the existing UX for free).
	 */
	private async _handleStatelessConfirmRequest(
		client: StatelessClient,
		traceId: string,
		confirm: { requestId: string; cardType: string; cardData: Record<string, unknown>; title?: string; buttons?: string[] },
		progress: (parts: IChatProgress[]) => void,
	): Promise<void> {
		this._logService.info(
			'[ChipOS Stateless] confirm_request type=%s request_id=%s',
			confirm.cardType, confirm.requestId,
		);

		// Build the IChatConfirmation data shape mirroring legacy ConfirmRequest
		// handler so ChipOSPermissionCardContentPart renders without changes.
		const title = confirm.title || 'Confirm requested';
		const buttons = confirm.buttons && confirm.buttons.length > 0 ? confirm.buttons : ['Approve', 'Reject'];
		const cardData = confirm.cardData;
		const askQuestions = Array.isArray((cardData as { questions?: unknown }).questions)
			? (cardData as { questions: unknown[] }).questions
			: undefined;
		const isInteractiveAgentAsk = confirm.cardType === 'agent_ask' && askQuestions && askQuestions.length > 0;
		const baseData: Record<string, unknown> = {
			requestId: confirm.requestId,
			card_type: confirm.cardType,
			card_data: cardData,
			// Phase 1 markers (read by invoke() top-level detector below)
			__chiposStatelessConfirmTraceId: traceId,
			__chiposStatelessConfirmRequestId: confirm.requestId,
			options: buttons.map(label => ({ label, action_id: label.toLowerCase() })),
		};
		const data: Record<string, unknown> = isInteractiveAgentAsk
			? {
				...baseData,
				__chiposAgentAskCard: true,
				questions: askQuestions,
				selections: {} as Record<string, string>,
			}
			: {
				...baseData,
				__chiposGenericConfirmCard: true,
			};

		// Park a Promise — resolved by the next invoke() with this requestId.
		const responsePromise = new Promise<{ action: string; selections?: Record<string, string>; comment?: string }>((resolve, reject) => {
			this._pendingStatelessConfirms.set(confirm.requestId, { resolve, reject, traceId });
		});

		// Emit the inline confirmation card.
		const message = typeof (cardData as { message?: unknown }).message === 'string'
			? (cardData as { message: string }).message
			: title;
		const confirmation: IChatConfirmation = {
			kind: 'confirmation',
			title,
			message: new MarkdownString(message, { supportThemeIcons: true, isTrusted: true }),
			data,
			buttons,
		};
		progress([confirmation]);

		// Await user click or timeout. 600s matches reasoner-side default
		// confirm timeout (PHASE-1-PROTOCOL-SPEC §4.1).
		const TIMEOUT_MS = 600_000;
		let result: { action: string; selections?: Record<string, string>; comment?: string };
		try {
			result = await Promise.race([
				responsePromise,
				new Promise<{ action: string; comment: string }>((_resolve, reject) =>
					setTimeout(() => reject(new Error('confirm timeout')), TIMEOUT_MS),
				),
			]) as { action: string; selections?: Record<string, string>; comment?: string };
		} catch (err) {
			this._logService.warn(
				'[ChipOS Stateless] confirm_request timeout request_id=%s — sending action=skip',
				confirm.requestId,
			);
			result = { action: 'skip', comment: `client-side timeout after ${TIMEOUT_MS}ms` };
		} finally {
			this._pendingStatelessConfirms.delete(confirm.requestId);
		}

		try {
			await client.postConfirmResponse(traceId, confirm.requestId, {
				request_id: confirm.requestId,
				action: result.action,
				selections: result.selections ?? null,
				comment: result.comment ?? null,
			});
		} catch (err) {
			this._logService.warn(
				'[ChipOS Stateless] POST /confirm_response failed for request_id=%s: %s',
				confirm.requestId, String(err),
			);
		}
	}

	/**
	 * Phase 1: pending confirm-card Promises waiting for the next invoke() call
	 * to deliver the user's click. Keyed by request_id (the `chipos_user_confirm`
	 * tool_use id from the LLM). Resolved by the invoke() entry's stateless-
	 * confirm detector branch; rejected on session disposal.
	 */
	private readonly _pendingStatelessConfirms = new Map<string, {
		resolve: (r: { action: string; selections?: Record<string, string>; comment?: string }) => void;
		reject: (err: Error) => void;
		traceId: string;
	}>();

	// =========================================================================
	// End Phase 0 #8e / #8f
	// =========================================================================

	override dispose(): void {
		// R62: 清理 debounce timer
		if (this._mcpToolsReportDebounce) {
			clearTimeout(this._mcpToolsReportDebounce);
			this._mcpToolsReportDebounce = undefined;
		}
		for (const [sessionResource] of this._sessionRuntimes) {
			this._disposeRuntime(sessionResource);
		}
		for (const [, banner] of this._connectionBanners) {
			banner.dispose();
		}
		this._connectionBanners.clear();
		super.dispose();
	}
}

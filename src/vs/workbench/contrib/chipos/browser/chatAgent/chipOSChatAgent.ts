/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
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
import type { IChatResponseModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { SseEventStreamClient } from '../eventStream/grpcSseEventStreamClient.js';
import type { IEventStreamClient } from '../eventStream/eventStreamClient.js';
import { FullTracer } from '../eventStream/fullTracer.js';
import { ContextCollector } from '../autoContext/contextCollector.js';
import { ChipOSEditorEffects } from './editorEffects.js';
import { IChipOSTokenManager } from '../auth/chiposTokenManager.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { resolveReasoningUrl } from '../../common/chiposEndpoints.js';
import {
	AgentEventType,
	ConnectionState,
	type AgentEvent,
	type ITextDeltaPayload,
	type IThinkingDeltaPayload,
	type IToolCallPayload,
	type IToolResultPayload,
	type IConfirmRequestPayload,
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
		@IDialogService private readonly _dialogService: IDialogService,
		@IChipOSTokenManager private readonly _tokenManager: IChipOSTokenManager,
		@IProductService private readonly _productService: IProductService,
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
	}

	// ── R62: MCP 工具变更通知 ──────────────────────────────────────────────

	private _mcpToolsReportDebounce: ReturnType<typeof setTimeout> | undefined;

	private _onMcpToolsChanged(): void {
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
		// ── FEAT-32: Connection status feedback ──
		progress([this._progress('$(sync~spin) Connecting to backend...', true)]);
		const runtime = this._getOrCreateRuntime(request.sessionResource);
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

			return { errorDetails: { message: 'Backend not connected' } };
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
			// Use the sessionId stored in the confirmation data, NOT a new one
			const confirmSessionId = data.sessionId ?? runtime.backendSessionId;
			this._logService.info('[ChipOS Agent] Confirm response (accepted):', data.requestId, action, 'session:', confirmSessionId);
			streamClient.sendConfirmResponse(data.requestId, action, undefined, confirmSessionId);
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

			streamClient.sendConfirmResponse(data.requestId, action, undefined, confirmSessionId);
			if (action === 'reject') {
				progress([this._progress('$(circle-slash) Rejected')]);
			} else {
				progress([this._progress(`$(check) Selected: ${action}`)]);
			}
			return this._listenForContinuation(streamClient, progress, token, request);
		}

		const sessionId = `native_chat_${++this._sessionCounter}_${Date.now()}`;
		this._setSessionBackendId(request.sessionResource, sessionId);
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
					resolve(result);
				}
			};

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
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested');
				streamClient.sendStop(sessionId);
				finish({});
			});

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

			// UX: Show "Thinking" indicator while waiting for first backend event
			progress([this._progress('$(loading~spin) Waiting for backend response...', true)]);
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
					if (!filePath && typeof p.result === 'string') {
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
				const title = ChipOSChatAgent._confirmTitle(p.card_type, p.title);
				const richMessage = this._renderConfirmMessage(p);
				// Extract buttons from p.options or card_data.options
				const cardOpts = Array.isArray(p.card_data?.options) ? (p.card_data.options as Array<{ label?: string; action_id?: string }>) : undefined;
				const rawButtons = p.options?.map(o => o.label).filter((l): l is string => !!l)
					?? cardOpts?.map(o => o.label ?? o.action_id ?? 'Option').filter(Boolean) as string[] | undefined
					?? ['Approve', 'Reject'];
				const buttons = rawButtons.length > 0 ? rawButtons : ['Approve', 'Reject'];
				const confirmation: IChatConfirmation = {
					kind: 'confirmation',
					title,
					message: new MarkdownString(richMessage, { supportThemeIcons: true, isTrusted: true }),
					data: { requestId: p.request_id, sessionId: ctx.sessionId, options: p.options ?? cardOpts },
					buttons,
				};
				ctx.progress([confirmation]);
				// Finish the current request so the framework can accept
				// the next invoke() when the user clicks a confirmation button.
				ctx.finish({}, 'Awaiting confirmation');
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
								// Start and immediately stop — file is already on disk
								editingSession.startExternalEdits(responseModel, opId, [fileUri], ctx.request!.requestId).then(() => {
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
					const last12 = tid.length > 12 ? tid.slice(-12) : tid;
					// Small dim italics so it doesn't dominate the bubble. Wraps
					// in <sub> via theme icon support in MarkdownString.
					ctx.progress([this._markdown(`\n\n*<sub>trace: \`${last12}\` (full: ${tid})</sub>*`)]);
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

	private _listenForContinuation(
		streamClient: IEventStreamClient,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		request?: IChatAgentRequest,
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
			  } as IChatSessionRuntime;

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;
			let contStepCount = 0;

			const finish = (result: IChatAgentResult, thinkingTitle?: string) => {
				if (!resolved) {
					if (thinkingTitle || contStepCount > 0) {
						const title = thinkingTitle ?? `Completed ${contStepCount} step${contStepCount === 1 ? '' : 's'}`;
						progress([{ kind: 'thinking', value: '', generatedTitle: title } satisfies IChatThinkingPart]);
					}
					resolved = true;
					listener.dispose();
					result = {
						...result,
						timings: { totalElapsed: Date.now() - startTime },
					};
					resolve(result);
				}
			};

			const listener = streamClient.onDidReceiveEvent((event: AgentEvent) => {
				if (resolved) { return; }
				if (runtime.backendSessionId && event.session_id && event.session_id !== runtime.backendSessionId) {
					this._logService.trace('[ChipOS Agent] Ignoring continuation event for different session', event.session_id, 'expected', runtime.backendSessionId, 'type', event.event_type);
					return;
				}

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
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested (continuation)');
				if (runtime.backendSessionId) {
					streamClient.sendStop(runtime.backendSessionId);
				}
				finish({});
			});
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

	private static _confirmTitle(cardType: string, _fallbackTitle?: string): string {
		switch (cardType) {
			case 'spec_confirm': return 'Spec Review';
			case 'arch_confirm': return 'Architecture Review';
			case 'design_confirm': return 'Design Review';
			case 'code_confirm': return 'Code Review';
			case 'agent_ask': return 'Decision Required';
			default: return cardType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
		}
	}

	// ── FEAT-29: Render rich confirm message based on card_type ──

	private _renderConfirmMessage(p: IConfirmRequestPayload): string {
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
				const sections: string[] = [];
				if (data.file_path) { sections.push(`**File:** \`${data.file_path}\``); }
				if (data.description) { sections.push(`${data.description}`); }
				if (data.diff && typeof data.diff === 'string') {
					const diffPreview = (data.diff as string).slice(0, 300);
					sections.push(`\`\`\`diff\n${diffPreview}\n\`\`\``);
				}
				return sections.length > 0 ? sections.join('\n\n') : JSON.stringify(data, null, 2).slice(0, 500);
			}

			case 'agent_ask': {
				const context = (data.context as string) ?? '';
				return context || 'Please select an option.';
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
		const skip = new Set(['verdict_badge', 'task_description', 'next_steps', 'generated_files_list']);
		for (const [k, v] of Object.entries(d)) {
			if (skip.has(k) || v === undefined || v === null || v === '' || v === '无') { continue; }
			if (typeof v === 'object') { continue; }
			const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			kv.push([label, String(v)]);
		}

		if (kv.length) {
			lines.push('| 项目 | 值 |');
			lines.push('|---|---|');
			for (const [label, val] of kv) {
				lines.push(`| ${label} | ${val} |`);
			}
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
		return { kind: 'progressMessage', content: new MarkdownString(content, { supportThemeIcons: true }), shimmer };
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

	// ── FEAT-R72: IDE 端工具执行 ────────────────────────────────────────────

	/**
	 * IDE 端工具输出缓存（terminal_id → output）
	 * 用于 get_terminal_output 工具读取之前 run_in_terminal 的输出
	 */
	private readonly _terminalOutputCache = new Map<string, { output: string; exitCode?: number }>();

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
		let content: string;
		let isError = false;

		try {
			const args = JSON.parse(args_json);

			switch (name) {
			case 'run_in_terminal': {
				const termKey = call_id || name;
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

				// Approval gate: require user confirmation unless full_auto mode
				const approveMode = this._configurationService.getValue<string>('chipos.autoApproveMode') ?? 'standard';
				const cmd = typeof args.command === 'string' ? args.command : '';
				this._logService.info('[ChipOS Agent] run_in_terminal approval: mode=%s, cmd=%s', approveMode, cmd);
				if (approveMode !== 'full_auto') {
					const { confirmed } = await this._dialogService.confirm({
						message: localize('chipos.terminal.approval.title', 'ChipOS wants to run a terminal command'),
						detail: cmd || '(empty command)',
						primaryButton: localize('chipos.terminal.approval.run', 'Run'),
						cancelButton: localize('chipos.terminal.approval.reject', 'Reject'),
					});
					if (!confirmed) {
						content = 'User rejected the terminal command.';
						isError = true;
						break;
					}
				}

				content = await this._runInTerminal(args, termSession?.sessionId, termSession?.commandId, termKey, runtime);
				break;
			}
				case 'get_terminal_output': {
					content = this._getTerminalOutput(args);
					break;
				}
			default: {
				// R56: 尝试路由到 MCP 工具
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
		} catch (err: any) {
			content = `IDE tool '${name}' failed: ${err.message || String(err)}`;
			isError = true;
		}

		// 回传结果给 Reasoner
		const sessionId = runtime.backendSessionId ?? '';
		this._logService.info(
			'[ChipOS Agent] IDE tool result: call_id=%s, is_error=%s, content_len=%d',
			call_id, isError, content.length,
		);
		streamClient.sendIdeToolResult(sessionId, call_id, content, isError);
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
			const servers = this._mcpService.servers.get();
			const tools: Array<{ name: string; description: string; parameters_json_schema: string; source: string }> = [];
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
			if (tools.length > 0) {
				this._logService.info('[ChipOS Agent] Reporting %d MCP tools to Reasoner', tools.length);
				streamClient.registerIdeMcpTools(sessionId, tools);
			}
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
		this._ensureEditorEffects().clearSessionState(sessionResource);
		this._sessionRuntimes.delete(sessionResource);
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
		runtime.backendSessionId = backendSessionId;
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
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
import type { IChatResponseModel } from '../../../../contrib/chat/common/model/chatModel.js';
import { SseEventStreamClient } from '../eventStream/grpcSseEventStreamClient.js';
import type { IEventStreamClient } from '../eventStream/eventStreamClient.js';
import { ContextCollector } from '../autoContext/contextCollector.js';
import { ChipOSEditorEffects } from './editorEffects.js';
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
	type IMentionItem,
	type IIdeToolCallPayload,
} from '../eventStream/eventTypes.js';

interface IChatSessionRuntime {
	streamClient?: IEventStreamClient;
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
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalChatService private readonly _terminalChatService: ITerminalChatService,
		@ITerminalSandboxService private readonly _terminalSandboxService: ITerminalSandboxService,
		@IMcpService private readonly _mcpService: IMcpService,
	) {
		super();
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
			const mode = this._configurationService.getValue<string>('chipos.backend.mode') ?? 'local';
			const reasoningUrl = this._configurationService.getValue<string>('chipos.backend.reasoningUrl');
			const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
			const target = reasoningUrl || `http://127.0.0.1:${httpPort}`;
			const hint = mode === 'local'
				? `Cannot connect to local backend at \`${target}\`. Is it running? Try \`make local\` in backend_v2/.`
				: `Cannot connect to reasoning layer at \`${target}\` (mode: ${mode}). Check \`chipos.backend.reasoningUrl\` in settings.`;
			progress([this._markdown(`$(error) **ChipOS:** ${hint}`)]);
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
				ctx.progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
				break;
			}

			// ── Tool lifecycle via IChatExternalToolInvocationUpdate ──
			case AgentEventType.ToolCall: {
				const p = event.payload as IToolCallPayload;
				const key = p.call_id || p.tool_name;
				ctx.onToolStep?.();
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
						this._logService.warn('[ChipOS Agent] ToolResult: stopExternalEdit failed for', key, err);
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
						} catch { /* not JSON, ignore */ }
					}
					if (filePath) {
						const workspaceRoot = this._getWorkspaceRoot();
						const absPath = filePath.startsWith('/') ? filePath : (workspaceRoot ? `${workspaceRoot}/${filePath}` : filePath);
						const fileTools = new Set(['edit_file', 'create_file', 'apply_diff', 'write_file', 'delete_file', 'str_replace']);
						if (fileTools.has(p.tool_name)) {
							const isDelete = p.tool_name === 'delete_file';
							const fileUri = URI.file(absPath);
							const ref: IChatContentReference = {
								kind: 'reference',
								reference: fileUri,
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
							ctx.progress([ref]);
						}
					}
				}
				break;
			}

			// ── Status / Progress ──
			case AgentEventType.Status: {
				const p = event.payload as IStatusPayload;
				if (p.text) {
					const shimmer = p.level === 'thinking' || p.tool_name !== undefined;
					ctx.progress([this._progress(p.text, shimmer)]);
				}
				break;
			}

			// ── Round start ──
			case AgentEventType.RoundStart: {
				const p = event.payload as IRoundStartPayload;
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
			case AgentEventType.Error: {
				const p = event.payload as { message: string; error_code?: string; retryable?: boolean; suggestion?: string; category?: string; details?: Record<string, unknown> };
				ctx.trackFirstProgress?.();
				const errorMsg = p.category ? `[${p.category}] ${p.message}` : p.message;
				ctx.progress([{
					kind: 'agentError',
					error_code: p.error_code ?? 'AGENT_ERROR',
					message: errorMsg,
					retryable: p.retryable ?? true,
					suggestion: p.suggestion,
				} satisfies IChatAgentError]);
				ctx.finish({ errorDetails: { message: errorMsg } });
				break;
			}

			// ── Todo update → native ChatTodoListService ──
			case AgentEventType.TodoUpdate: {
				const p = event.payload as ITodoUpdatePayload;
				if (p.todos.length > 0 && ctx.request) {
					const sessionRes = ctx.request.sessionResource;
					const statusMap: Record<string, IChatTodo['status']> = {
						done: 'completed',
						completed: 'completed',
						in_progress: 'in-progress',
						'in-progress': 'in-progress',
						pending: 'not-started',
					};
					const nativeTodos: IChatTodo[] = p.todos.map((t, idx) => {
						const key = t.task_status || t.status || 'pending';
						return {
							id: idx,
							title: t.task_des ?? t.content ?? `Todo ${idx + 1}`,
							status: statusMap[key] ?? 'not-started',
						};
					});
					this._todoListService.setTodos(sessionRes, nativeTodos);
				}
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

		const httpPort = this._configurationService.getValue<number>('chipos.backend.httpPort') ?? 8080;
		const reasoningUrl = this._configurationService.getValue<string>('chipos.backend.reasoningUrl');
		const baseUrl = reasoningUrl || `http://127.0.0.1:${httpPort}`;
		const token = this._configurationService.getValue<string>('chipos.backend.token') ?? undefined;
		const noProxy = this._configurationService.getValue<string[]>('http.noProxy') ?? [];

		this._logService.info('[ChipOS Agent] Connecting via SSE:', baseUrl, '| http.noProxy:', JSON.stringify(noProxy));

		if (runtime.streamClient && runtime.streamClient instanceof SseEventStreamClient
			&& runtime.streamClient.connectionState !== ConnectionState.Error) {
			this._logService.trace('[ChipOS Agent] Reusing existing SSE client for reconnect');
		} else {
			runtime.streamClient?.dispose();
			runtime.streamClient = new SseEventStreamClient({ baseUrl, token }, this._logService);

			// Monitor connection state changes for user-facing notifications
			runtime.streamClient.onDidChangeConnectionState((state) => {
				if (state === ConnectionState.Reconnecting) {
					this._notificationService.info(
						localize('chipos.agent.reconnecting', 'ChipOS: Connection lost, reconnecting to backend...')
					);
				} else if (state === ConnectionState.Error) {
					this._notificationService.warn(
						localize('chipos.agent.disconnected', 'ChipOS: Backend connection failed. Check if the Reasoner is running.')
					);
				} else if (state === ConnectionState.Connected) {
					// Only notify on reconnect (not initial connect)
					if (this._logService) {
						this._logService.info('[ChipOS Agent] SSE reconnected');
					}
				}
			});
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
		super.dispose();
	}
}

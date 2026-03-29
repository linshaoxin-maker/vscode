/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentHistoryEntry,
} from '../../../../contrib/chat/common/participants/chatAgents.js';
import { URI } from '../../../../../base/common/uri.js';
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
	IChatEdaParallelProgress,
	IChatEdaNegotiationView,
	IChatEdaSpecReview,
	IChatContentReference,
	ChatResponseReferencePartStatusKind,
	IChatExternalToolInvocationUpdate,
	IChatToolInputInvocationData,
	IChatSubagentToolInvocationData,
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
	) {
		super();
		this._register(this._chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResource) {
				this._disposeRuntime(sessionResource);
			}
		}));
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

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;
			let firstProgressTime: number | undefined;
			const pendingConfirmations = new Map<string, IChatConfirmation>();
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
				switch (event.event_type) {
					// ── Streaming text ──
					case AgentEventType.TextDelta: {
						const p = event.payload as ITextDeltaPayload;
						trackFirstProgress();
						if (p.role === 'thinking') {
							progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
						} else {
							progress([this._markdown(p.content)]);
						}
						break;
					}

					case AgentEventType.ThinkingDelta: {
						const p = event.payload as IThinkingDeltaPayload;
						trackFirstProgress();
						progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
						break;
					}

					// ── Tool lifecycle via IChatExternalToolInvocationUpdate ──
					case AgentEventType.ToolCall: {
						const p = event.payload as IToolCallPayload;
						const key = p.call_id || p.tool_name;
						stepCount++;
						runtime.toolStartTimes.set(key, Date.now());
						// Save file_path from arguments for later reference emission
						const args = p.arguments as Record<string, unknown> | undefined;
						if (args) {
							const fp = (args.file_path ?? args.path ?? args.file ?? args.file_name) as string | undefined;
							if (fp) { runtime.toolFileArgs.set(key, fp); }
						}
						const friendly = this._friendlyToolName(p.tool_name);
						const argDetail = ChipOSChatAgent._formatToolArgs(p.arguments);
						const invocationMsg = argDetail ? `${friendly} ${argDetail}` : friendly;

						// Subagent tools get special rendering — Cursor-style collapsible card
						const isSubagent = p.tool_name === 'task' || p.tool_name === 'run_subagent' || p.tool_name === 'transfer_to_agent';
						if (isSubagent && args) {
							runtime.lastSubagentToolCallId = key;
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
							progress([toolUpdate]);
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
							progress([toolUpdate]);
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
								runtime.toolFileArgs.set(key, filePath);
								// Start external edit — snapshot file before backend writes
								this._startExternalEdit(key, fileUri, request.sessionResource, request.requestId, runtime, p.snapshot_content);
							}
						}
						break;
					}

					case AgentEventType.ToolResult: {
						const p = event.payload as IToolResultPayload;
						const key = p.call_id || p.tool_name;
						const friendly = this._friendlyToolName(p.tool_name);
						const startTs = runtime.toolStartTimes.get(key);
						const elapsed = startTs ? `${((Date.now() - startTs) / 1000).toFixed(1)}s` : '';
						runtime.toolStartTimes.delete(key);
						const timeSuffix = elapsed ? ` (${elapsed})` : '';
						const pastMsg = p.summary
							? `${p.summary}${timeSuffix}`
							: `${friendly}${timeSuffix}`;
						const toolComplete: IChatExternalToolInvocationUpdate = {
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
						progress([toolComplete]);

						// ── Stop external edit tracking and emit file reference ──
						if (runtime.externalEditOps.has(key)) {
							// External edit was started for this tool — stop it to compute diff
							this._stopExternalEdit(key, request.sessionResource, runtime).then(editProgress => {
								if (editProgress.length > 0) {
									progress(editProgress);
								}
							}).catch(err => {
								this._logService.warn('[ChipOS Agent] ToolResult: stopExternalEdit failed for', key, err);
							});
							runtime.toolFileArgs.delete(key);
						} else if (p.success) {
							// Fallback for tools not tracked via external edits
							let filePath = runtime.toolFileArgs.get(key);
							runtime.toolFileArgs.delete(key);
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
									progress([ref]);
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
							progress([this._progress(p.text, shimmer)]);
						}
						break;
					}

					// ── Round start ──
					case AgentEventType.RoundStart: {
						const p = event.payload as IRoundStartPayload;
						progress([this._progress(`Step ${p.round}`, true)]);
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
							data: { requestId: p.request_id, sessionId, options: p.options ?? cardOpts },
							buttons,
						};
						pendingConfirmations.set(p.request_id, confirmation);
						progress([confirmation]);
						// Finish the current request so the framework can accept
						// the next invoke() when the user clicks a confirmation button.
						finish({}, 'Awaiting confirmation');
						break;
					}

					// ── Error → IChatAgentError content part ──
					case AgentEventType.Error: {
						const p = event.payload as { message: string; error_code?: string; retryable?: boolean; suggestion?: string; category?: string; details?: Record<string, unknown> };
						trackFirstProgress();
						const errorMsg = p.category ? `[${p.category}] ${p.message}` : p.message;
						progress([{
							kind: 'agentError',
							error_code: p.error_code ?? 'AGENT_ERROR',
							message: errorMsg,
							retryable: p.retryable ?? true,
							suggestion: p.suggestion,
						} satisfies IChatAgentError]);
						finish({ errorDetails: { message: errorMsg } });
						break;
					}

					// ── Todo update → native ChatTodoListService ──
					case AgentEventType.TodoUpdate: {
						const p = event.payload as ITodoUpdatePayload;
						if (p.todos.length > 0) {
							const sessionRes = request.sessionResource;
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
						trackFirstProgress();
						const lines = (p.milestones || []).map(m => {
							const status = (m.status as string) === 'active' ? 'running' : m.status;
							const icon = status === 'done' ? '- [x]' :
								status === 'running' ? '- [ ] *(running)*' :
									status === 'failed' ? '- [ ] *(failed)*' : '- [ ]';
							return `${icon} ${m.title}`;
						});
						progress([this._markdown(`### Plan\n${lines.join('\n')}`)]);
						break;
					}

					// ── Diff preview ──
					case AgentEventType.DiffPreview: {
						const p = event.payload as IDiffPreviewPayload;
						trackFirstProgress();
						const hunks = (p.hunks || []).map(h => {
							const lines = h.lines.map(l => {
								if (l.type === 'add') { return `+ ${l.content}`; }
								if (l.type === 'del') { return `- ${l.content}`; }
								return `  ${l.content}`;
							}).join('\n');
							return `${h.header}\n${lines}`;
						}).join('\n\n');
						progress([this._markdown(`**Diff: \`${p.file_path}\`**\n\`\`\`diff\n${hunks}\n\`\`\``)]);
						break;
					}

					// ── Simulation report → EDA content part (FEAT-35: adapt string summary) ──
					case AgentEventType.SimReport: {
						const p = event.payload as ISimReportPayload;
						trackFirstProgress();
						const summary = ChipOSChatAgent._normalizeSimSummary(p.summary, p.tests);
						progress([{
							kind: 'edaSimReport',
							tests: p.tests ?? [],
							summary,
						} satisfies IChatEdaSimReport]);
						break;
					}

					// ── Coverage report → EDA content part ──
					case AgentEventType.CoverageReport: {
						const p = event.payload as ICoverageReportPayload;
						trackFirstProgress();
						progress([{
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
						trackFirstProgress();
						progress([{
							kind: 'edaLintReport',
							errors: p.errors ?? [],
							auto_fixable: p.auto_fixable,
							tool: p.tool,
						} satisfies IChatEdaLintReport]);
						break;
					}

					// ── Negotiation view → EDA content part (FEAT-35: map role/claim/confidence → agent/position/reasoning) ──
					case AgentEventType.NegotiationView: {
						const p = event.payload as INegotiationViewPayload;
						trackFirstProgress();
						const rawPerspectives = (p.perspectives ?? []) as unknown as Array<Record<string, string>>;
						const perspectives = rawPerspectives.map(raw => ({
							agent: raw.agent ?? raw.role ?? '',
							position: raw.position ?? raw.claim ?? '',
							reasoning: raw.reasoning ?? raw.confidence ?? '',
						}));
						progress([{
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
						progress([{
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
						trackFirstProgress();
						progress([{
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
						trackFirstProgress();
						progress([{
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
						trackFirstProgress();
						progress([this._progress('$(output) Task Summary')]);
						progress([this._markdown(ChipOSChatAgent._formatTaskSummary(p))]);
						break;
					}

					// ── FEAT-33: Subagent event — structured rendering ──
					case AgentEventType.SubagentEvent: {
						const p = event.payload as ISubagentEventPayload;
						if (!runtime.subagentTimers.has(p.task_id)) {
							runtime.subagentTimers.set(p.task_id, Date.now());
							// Link task_id to the most recent subagent ToolCall
							if (runtime.lastSubagentToolCallId) {
								runtime.subagentParentMap.set(p.task_id, runtime.lastSubagentToolCallId);
							}
						}
						const parentId = runtime.subagentParentMap.get(p.task_id) ?? p.task_id;
						if (p.kind === 'text' && p.content) {
							// Route text as a virtual tool inside the subagent card
							const textKey = `sub_${p.task_id}_text_${this._subagentToolCounter++}`;
							progress([{
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
							runtime.toolStartTimes.set(subKey, Date.now());
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
							progress([toolUpdate]);

							// Cache file path and start external edit for file-writing tools
							if (p.args && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
								const filePath = (p.args.file_path ?? p.args.path ?? p.args.file ?? p.args.file_name) as string | undefined;
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, filePath=${filePath}, hasRequest=${!!request}`);
								if (filePath && request) {
									// Dedup: skip if this file already has a pending external edit
									const alreadyTracked = [...runtime.toolFileArgs.entries()].some(
										([k, v]) => v === filePath && runtime.externalEditOps.has(k)
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
										runtime.toolFileArgs.set(subKey, filePath);
										this._startExternalEdit(subKey, fileUri, request.sessionResource, request.requestId, runtime, p.snapshot_content);
									}
								}
							} else {
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, isFileWrite=${ChipOSChatAgent._isFileWriteTool(p.tool_name)}, hasArgs=${!!p.args}`);
							}
						} else if (p.kind === 'tool_end' && p.tool_name) {
							// Find the matching tool_start key for this tool_name (with counter suffix)
							const matchPrefix = `sub_${p.task_id}_${p.tool_name}_`;
							let subKey: string | undefined;
							for (const [k] of runtime.toolStartTimes) {
								if (k.startsWith(matchPrefix)) {
									subKey = k;
									break;
								}
							}
							this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: tool=${p.tool_name}, matchPrefix=${matchPrefix}, foundSubKey=${subKey}, file_path=${p.file_path}`);
							if (!subKey) { break; }
							const startTs = runtime.toolStartTimes.get(subKey);
							const elapsed = startTs ? ` (${((Date.now() - startTs) / 1000).toFixed(1)}s)` : '';
							runtime.toolStartTimes.delete(subKey);
							const toolComplete: IChatExternalToolInvocationUpdate = {
								kind: 'externalToolInvocationUpdate',
								toolCallId: subKey,
								toolName: p.tool_name,
								isComplete: true,
								pastTenseMessage: `${p.tool_name} done${elapsed}`,
								subagentInvocationId: parentId,
							};
							progress([toolComplete]);

							// Stop external edit — _stopExternalEdit awaits _startExternalEdit first
							const hasOp = runtime.externalEditOps.has(subKey);
							const hasPending = runtime.pendingStartEdits.has(subKey);
							this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: subKey=${subKey}, hasExternalEditOp=${hasOp}, hasPendingStart=${hasPending}, hasRequest=${!!request}`);
							if (hasOp && request) {
								this._stopExternalEdit(subKey, request.sessionResource, runtime).then(editProgress => {
									this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit returned ${editProgress.length} progress items for ${subKey}`);
									if (editProgress.length > 0) {
										progress(editProgress);
									}
								}).catch(err => {
									this._logService.error(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit failed for ${subKey}`, err);
								});
								runtime.toolFileArgs.delete(subKey);
							}
						} else if (p.kind === 'error' && p.content) {
							// Route error inside the subagent card
							const errKey = `sub_${p.task_id}_error_${this._subagentToolCounter++}`;
							progress([{
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
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: statusKey,
								toolName: 'status',
								isComplete: true,
								invocationMessage: p.content,
								pastTenseMessage: p.content,
								subagentInvocationId: parentId,
							} satisfies IChatExternalToolInvocationUpdate]);
						} else if (p.kind === 'complete') {
							const subStart = runtime.subagentTimers.get(p.task_id);
							runtime.subagentTimers.delete(p.task_id);
							// Close any dangling tool calls belonging to this subagent
							const prefix = `sub_${p.task_id}_`;
							for (const [k] of runtime.toolStartTimes) {
								if (k.startsWith(prefix)) {
									const toolName = k.slice(prefix.length).replace(/_\d+$/, '');
									progress([{
										kind: 'externalToolInvocationUpdate',
										toolCallId: k,
										toolName,
										isComplete: true,
										pastTenseMessage: `${toolName} done`,
										subagentInvocationId: parentId,
									} satisfies IChatExternalToolInvocationUpdate]);
									runtime.toolStartTimes.delete(k);
								}
							}
							// Mark the parent subagent tool call as complete
							if (parentId && runtime.toolStartTimes.has(parentId)) {
								const parentStart = runtime.toolStartTimes.get(parentId);
								const elapsed = parentStart
									? ` (${((Date.now() - parentStart) / 1000).toFixed(1)}s)`
									: subStart ? ` (${((Date.now() - subStart) / 1000).toFixed(1)}s)` : '';
								runtime.toolStartTimes.delete(parentId);
								progress([{
									kind: 'externalToolInvocationUpdate',
									toolCallId: parentId,
									toolName: 'task',
									isComplete: true,
									pastTenseMessage: `Sub-agent completed${elapsed}`,
								} satisfies IChatExternalToolInvocationUpdate]);
							}
							runtime.subagentParentMap.delete(p.task_id);
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
								const alreadyTracked = [...runtime.externalEditOps.keys()].some(k => {
									const fp = runtime.toolFileArgs.get(k);
									return fp && (fp === f.path || f.path.endsWith(fp));
								});
								if (!alreadyTracked) {
									const opId = ++this._externalEditOpCounter;
									const editingSession = this._getEditingSession(request.sessionResource);
									const responseModel = this._getResponseModel(request.sessionResource);
									if (editingSession && responseModel) {
										// Start and immediately stop — file is already on disk
										editingSession.startExternalEdits(responseModel, opId, [fileUri], request.requestId).then(() => {
											return editingSession.stopExternalEdits(responseModel, opId);
										}).then(editProgress => {
											if (editProgress.length > 0) {
												progress(editProgress);
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
							progress([this._warning(p.message)]);
							finish({ errorDetails: { message: p.message } });
						} else {
							finish({});
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
							progress([{
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

					case AgentEventType.Done:
						// Close any dangling tool calls before finishing
						for (const [k] of runtime.toolStartTimes) {
							const toolName = k.includes('_') ? k.split('_').pop()! : k;
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: k,
								toolName,
								isComplete: true,
								pastTenseMessage: `${toolName} done`,
							} satisfies IChatExternalToolInvocationUpdate]);
						}
						runtime.toolStartTimes.clear();
						finish({});
						break;

					// ── FEAT-61: Queue position update ──
					case AgentEventType.QueueUpdate: {
						const p = event.payload as IQueueUpdatePayload;
						const waitInfo = p.estimated_wait_seconds ? ` — est. ${p.estimated_wait_seconds}s` : '';
						progress([this._progress(
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
						progress([this._warning(
							`$(warning) Context window ${pct}% used (${p.tokens_used}/${p.tokens_max}).${suggestion}`
						)]);
						break;
					}

					default:
						this._logService.trace('[ChipOS Agent] Unhandled event:', (event as AgentEvent).event_type);
						break;
				}
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
				{ thinking, autoApproveMode },
			);
		});
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
				switch (event.event_type) {
					case AgentEventType.TextDelta: {
						const p = event.payload as ITextDeltaPayload;
						if (p.role === 'thinking') {
							progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
						} else {
							progress([this._markdown(p.content)]);
						}
						break;
					}
					case AgentEventType.ThinkingDelta: {
						const p = event.payload as IThinkingDeltaPayload;
						progress([{ kind: 'thinking', value: p.content } satisfies IChatThinkingPart]);
						break;
					}
					case AgentEventType.ToolCall: {
						const p = event.payload as IToolCallPayload;
						const key = p.call_id || p.tool_name;
						runtime.toolStartTimes.set(key, Date.now());
						const args = p.arguments as Record<string, unknown> | undefined;
						if (args) {
							const fp = (args.file_path ?? args.path ?? args.file ?? args.file_name) as string | undefined;
							if (fp) { runtime.toolFileArgs.set(key, fp); }
						}
						const friendly = this._friendlyToolName(p.tool_name);
						const argDetail = ChipOSChatAgent._formatToolArgs(p.arguments);
						const invocationMsg = argDetail ? `${friendly} ${argDetail}` : friendly;

						// Subagent tools get special rendering — Cursor-style collapsible card
						const isSubagent = p.tool_name === 'task' || p.tool_name === 'run_subagent' || p.tool_name === 'transfer_to_agent';
						if (isSubagent && args) {
							runtime.lastSubagentToolCallId = key;
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
							progress([toolUpdate]);
						} else {
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
							progress([toolUpdate]);
						}

						if (args && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
							const filePath = (args.file_path ?? args.path ?? args.file ?? args.file_name) as string | undefined;
							this._logService.info(`[ChipOS Agent] ToolCall: tool=${p.tool_name}, filePath=${filePath}, hasRequest=${!!request}, key=${key}`);
							if (filePath && request) {
								const workspaceRoot = this._getWorkspaceRoot();
								const fileUri = filePath.startsWith('/')
									? URI.file(filePath)
									: workspaceRoot
										? URI.joinPath(URI.file(workspaceRoot), filePath)
										: URI.file(filePath);
								runtime.toolFileArgs.set(key, filePath);
								// Start external edit — snapshot file before backend writes
								this._startExternalEdit(key, fileUri, request.sessionResource, request.requestId, runtime, p.snapshot_content);
							}
						}
						break;
					}
					case AgentEventType.ToolResult: {
						const p = event.payload as IToolResultPayload;
						const key = p.call_id || p.tool_name;
						const friendly = this._friendlyToolName(p.tool_name);
						const startTs = runtime.toolStartTimes.get(key);
						const elapsed = startTs ? `${((Date.now() - startTs) / 1000).toFixed(1)}s` : '';
						runtime.toolStartTimes.delete(key);
						const timeSuffix = elapsed ? ` (${elapsed})` : '';
						const pastMsg = p.summary
							? `${p.summary}${timeSuffix}`
							: `${friendly}${timeSuffix}`;
						const toolComplete: IChatExternalToolInvocationUpdate = {
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
						progress([toolComplete]);

						// ── Stop external edit tracking and emit file reference ──
						const hasExternalOp = runtime.externalEditOps.has(key);
						this._logService.info(`[ChipOS Agent] ToolResult: tool=${p.tool_name}, key=${key}, hasExternalOp=${hasExternalOp}, hasRequest=${!!request}, success=${p.success}`);
						if (hasExternalOp && request) {
							this._stopExternalEdit(key, request.sessionResource, runtime).then(editProgress => {
								if (editProgress.length > 0) {
									progress(editProgress);
								}
							}).catch(err => {
								this._logService.warn('[ChipOS Agent] ToolResult (cont): stopExternalEdit failed for', key, err);
							});
							runtime.toolFileArgs.delete(key);
						} else if (p.success) {
							let filePath = runtime.toolFileArgs.get(key);
							runtime.toolFileArgs.delete(key);
							if (!filePath && typeof p.result === 'string') {
								try {
									const resultObj = JSON.parse(p.result);
									filePath = resultObj.path ?? resultObj.file_path ?? resultObj.file_name;
								} catch { /* not JSON */ }
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
									progress([ref]);
								}
							}
						}
						break;
					}
					case AgentEventType.Status: {
						const p = event.payload as IStatusPayload;
						if (p.text) {
							const shimmer = p.level === 'thinking' || p.tool_name !== undefined;
							progress([this._progress(p.text, shimmer)]);
						}
						break;
					}
					case AgentEventType.RoundStart: {
						const p = event.payload as IRoundStartPayload;
						progress([this._progress(`Step ${p.round}`, true)]);
						break;
					}
					case AgentEventType.TodoUpdate: {
						const p = event.payload as ITodoUpdatePayload;
						if (p.todos.length > 0 && request) {
							const sessionRes = request.sessionResource;
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
					case AgentEventType.WorktreeFilesApplied: {
						const p = event.payload as IWorktreeFilesAppliedPayload;
						this._logService.info(`[ChipOS Agent] WorktreeFilesApplied: files=${p.files?.length ?? 0}, hasRequest=${!!request}`);
						if (p.files && p.files.length > 0 && request) {
							// For files not already tracked via ToolCall external edits,
							// start+stop external edits to register them in the editing session.
							for (const f of p.files) {
								if (f.action === 'deleted') { continue; }
								const fileUri = URI.file(f.path);
								const alreadyTracked = [...runtime.externalEditOps.keys()].some(k => {
									const fp = runtime.toolFileArgs.get(k);
									return fp && (fp === f.path || f.path.endsWith(fp));
								});
								this._logService.info(`[ChipOS Agent] WorktreeFilesApplied: file=${f.path}, action=${f.action}, alreadyTracked=${alreadyTracked}`);
								if (!alreadyTracked) {
									const opId = ++this._externalEditOpCounter;
									const editingSession = this._getEditingSession(request.sessionResource);
									const responseModel = this._getResponseModel(request.sessionResource);
									if (editingSession && responseModel) {
										editingSession.startExternalEdits(responseModel, opId, [fileUri], request.requestId).then(() => {
											return editingSession.stopExternalEdits(responseModel, opId);
										}).then(editProgress => {
											if (editProgress.length > 0) {
												progress(editProgress);
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
					case AgentEventType.SubagentEvent: {
						const p = event.payload as ISubagentEventPayload;
						if (!runtime.subagentTimers.has(p.task_id)) {
							runtime.subagentTimers.set(p.task_id, Date.now());
							if (runtime.lastSubagentToolCallId) {
								runtime.subagentParentMap.set(p.task_id, runtime.lastSubagentToolCallId);
							}
						}
						const parentId = runtime.subagentParentMap.get(p.task_id) ?? p.task_id;
						if (p.kind === 'text' && p.content) {
							// Route text as a virtual tool inside the subagent card
							const textKey = `sub_${p.task_id}_text_${this._subagentToolCounter++}`;
							progress([{
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
							runtime.toolStartTimes.set(subKey, Date.now());
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
							progress([toolUpdate]);

							// Cache file path and start external edit for file-writing tools
							if (p.args && ChipOSChatAgent._isFileWriteTool(p.tool_name)) {
								const filePath = (p.args.file_path ?? p.args.path ?? p.args.file ?? p.args.file_name) as string | undefined;
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, filePath=${filePath}, hasRequest=${!!request}`);
								if (filePath && request) {
									// Dedup: skip if this file already has a pending external edit
									const alreadyTracked = [...runtime.toolFileArgs.entries()].some(
										([k, v]) => v === filePath && runtime.externalEditOps.has(k)
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
										runtime.toolFileArgs.set(subKey, filePath);
										this._startExternalEdit(subKey, fileUri, request.sessionResource, request.requestId, runtime, p.snapshot_content);
									}
								}
							} else {
								this._logService.info(`[ChipOS Agent] SubagentEvent tool_start: tool=${p.tool_name}, isFileWrite=${ChipOSChatAgent._isFileWriteTool(p.tool_name)}, hasArgs=${!!p.args}`);
							}
						} else if (p.kind === 'tool_end' && p.tool_name) {
							// Find the matching tool_start key for this tool_name (with counter suffix)
							const matchPrefix = `sub_${p.task_id}_${p.tool_name}_`;
							let subKey: string | undefined;
							for (const [k] of runtime.toolStartTimes) {
								if (k.startsWith(matchPrefix)) {
									subKey = k;
									break;
								}
							}
							this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: tool=${p.tool_name}, matchPrefix=${matchPrefix}, foundSubKey=${subKey}, file_path=${p.file_path}`);
							if (!subKey) { break; }
							const startTs = runtime.toolStartTimes.get(subKey);
							const elapsed = startTs ? ` (${((Date.now() - startTs) / 1000).toFixed(1)}s)` : '';
							runtime.toolStartTimes.delete(subKey);
							const toolComplete: IChatExternalToolInvocationUpdate = {
								kind: 'externalToolInvocationUpdate',
								toolCallId: subKey,
								toolName: p.tool_name,
								isComplete: true,
								pastTenseMessage: `${p.tool_name} done${elapsed}`,
								subagentInvocationId: parentId,
							};
							progress([toolComplete]);

							// Stop external edit — _stopExternalEdit awaits _startExternalEdit first
							const hasOp = runtime.externalEditOps.has(subKey);
							const hasPending = runtime.pendingStartEdits.has(subKey);
							this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: subKey=${subKey}, hasExternalEditOp=${hasOp}, hasPendingStart=${hasPending}, hasRequest=${!!request}`);
							if (hasOp && request) {
								this._stopExternalEdit(subKey, request.sessionResource, runtime).then(editProgress => {
									this._logService.info(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit returned ${editProgress.length} progress items for ${subKey}`);
									if (editProgress.length > 0) {
										progress(editProgress);
									}
								}).catch(err => {
									this._logService.error(`[ChipOS Agent] SubagentEvent tool_end: stopExternalEdit failed for ${subKey}`, err);
								});
								runtime.toolFileArgs.delete(subKey);
							}
						} else if (p.kind === 'error' && p.content) {
							// Route error inside the subagent card
							const errKey = `sub_${p.task_id}_error_${this._subagentToolCounter++}`;
							progress([{
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
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: statusKey,
								toolName: 'status',
								isComplete: true,
								invocationMessage: p.content,
								pastTenseMessage: p.content,
								subagentInvocationId: parentId,
							} satisfies IChatExternalToolInvocationUpdate]);
						} else if (p.kind === 'complete') {
							const subStart = runtime.subagentTimers.get(p.task_id);
							runtime.subagentTimers.delete(p.task_id);
							const prefix = `sub_${p.task_id}_`;
							for (const [k] of runtime.toolStartTimes) {
								if (k.startsWith(prefix)) {
									const toolName = k.slice(prefix.length).replace(/_\d+$/, '');
									progress([{
										kind: 'externalToolInvocationUpdate',
										toolCallId: k,
										toolName,
										isComplete: true,
										pastTenseMessage: `${toolName} done`,
										subagentInvocationId: parentId,
									} satisfies IChatExternalToolInvocationUpdate]);
									runtime.toolStartTimes.delete(k);
								}
							}
							// Mark the parent subagent tool call as complete
							if (parentId && runtime.toolStartTimes.has(parentId)) {
								const parentStart = runtime.toolStartTimes.get(parentId);
								const elapsed = parentStart
									? ` (${((Date.now() - parentStart) / 1000).toFixed(1)}s)`
									: subStart ? ` (${((Date.now() - subStart) / 1000).toFixed(1)}s)` : '';
								runtime.toolStartTimes.delete(parentId);
								progress([{
									kind: 'externalToolInvocationUpdate',
									toolCallId: parentId,
									toolName: 'task',
									isComplete: true,
									pastTenseMessage: `Sub-agent completed${elapsed}`,
								} satisfies IChatExternalToolInvocationUpdate]);
							}
							runtime.subagentParentMap.delete(p.task_id);
						}
						break;
					}
					case AgentEventType.ConfirmRequest: {
						const p = event.payload as IConfirmRequestPayload;
						const title = ChipOSChatAgent._confirmTitle(p.card_type, p.title);
						const richMessage = this._renderConfirmMessage(p);
						const cardOpts = Array.isArray(p.card_data?.options) ? (p.card_data.options as Array<{ label?: string; action_id?: string }>) : undefined;
						const rawButtons2 = p.options?.map(o => o.label).filter((l): l is string => !!l)
							?? cardOpts?.map(o => o.label ?? o.action_id ?? 'Option').filter(Boolean) as string[] | undefined
							?? ['Approve', 'Reject'];
						const buttons2 = rawButtons2.length > 0 ? rawButtons2 : ['Approve', 'Reject'];
						const confirmation: IChatConfirmation = {
							kind: 'confirmation',
							title,
			message: new MarkdownString(richMessage, { supportThemeIcons: true, isTrusted: true }),
			data: { requestId: p.request_id, sessionId: runtime.backendSessionId, options: p.options ?? cardOpts },
			buttons: buttons2,
						};
						progress([confirmation]);
						finish({}, 'Awaiting confirmation');
						break;
					}
					case AgentEventType.Plan: {
						const p = event.payload as IPlanPayload;
						const lines = (p.milestones || []).map(m => {
							const status = (m.status as string) === 'active' ? 'running' : m.status;
							const icon = status === 'done' ? '- [x]' :
								status === 'running' ? '- [ ] *(running)*' :
									status === 'failed' ? '- [ ] *(failed)*' : '- [ ]';
							return `${icon} ${m.title}`;
						});
						progress([this._markdown(`### Plan\n${lines.join('\n')}`)]);
						break;
					}
					case AgentEventType.DiffPreview: {
						const p = event.payload as IDiffPreviewPayload;
						const hunks = (p.hunks || []).map(h => {
							const hunkLines = h.lines.map(l => {
								if (l.type === 'add') { return `+ ${l.content}`; }
								if (l.type === 'del') { return `- ${l.content}`; }
								return `  ${l.content}`;
							}).join('\n');
							return `${h.header}\n${hunkLines}`;
						}).join('\n\n');
						progress([this._markdown(`**Diff: \`${p.file_path}\`**\n\`\`\`diff\n${hunks}\n\`\`\``)]);
						break;
					}
					case AgentEventType.SimReport: {
						const p = event.payload as ISimReportPayload;
						const summary = ChipOSChatAgent._normalizeSimSummary(p.summary, p.tests);
						progress([{
							kind: 'edaSimReport',
							tests: p.tests ?? [],
							summary,
						} satisfies IChatEdaSimReport]);
						break;
					}
					case AgentEventType.CoverageReport: {
						const p = event.payload as ICoverageReportPayload;
						progress([{
							kind: 'edaCoverageReport',
							line_cov: p.line_cov,
							branch_cov: p.branch_cov,
							gaps: p.gaps,
						} satisfies IChatEdaCoverageReport]);
						break;
					}
					case AgentEventType.LintReport: {
						const p = event.payload as ILintReportPayload;
						progress([{
							kind: 'edaLintReport',
							errors: p.errors ?? [],
							auto_fixable: p.auto_fixable,
							tool: p.tool,
						} satisfies IChatEdaLintReport]);
						break;
					}
					case AgentEventType.NegotiationView: {
						const p = event.payload as INegotiationViewPayload;
						const rawPerspectives = (p.perspectives ?? []) as unknown as Array<Record<string, string>>;
						const perspectives = rawPerspectives.map(raw => ({
							agent: raw.agent ?? raw.role ?? '',
							position: raw.position ?? raw.claim ?? '',
							reasoning: raw.reasoning ?? raw.confidence ?? '',
						}));
						progress([{
							kind: 'edaNegotiationView',
							issue: p.issue,
							perspectives,
							recommendation: p.recommendation,
						} satisfies IChatEdaNegotiationView]);
						break;
					}
					case AgentEventType.ParallelProgress: {
						const p = event.payload as IParallelProgressPayload;
						progress([{
							kind: 'edaParallelProgress',
							phase: p.phase,
							tracks: p.tracks ?? [],
							conflicts: p.conflicts,
						} satisfies IChatEdaParallelProgress]);
						break;
					}
					case AgentEventType.LoopProgress: {
						const p = event.payload as ILoopProgressPayload;
						progress([{
							kind: 'roundProgress',
							current_round: p.round,
							max_rounds: p.max_rounds,
							phase: p.phase,
							status: p.status as IChatRoundProgress['status'],
							tool: p.tool,
						} satisfies IChatRoundProgress]);
						break;
					}
					case AgentEventType.SpecReview: {
						const p = event.payload as ISpecReviewPayload;
						progress([{
							kind: 'edaSpecReview',
							spec_path: p.spec_path,
							spec_name: p.spec_name,
							summary: p.summary,
							files: p.files,
						} satisfies IChatEdaSpecReview]);
						break;
					}
					case AgentEventType.TaskSummary: {
						const p = event.payload as ITaskSummaryPayload;
						progress([this._progress('$(output) Task Summary')]);
						progress([this._markdown(ChipOSChatAgent._formatTaskSummary(p))]);
						break;
					}
					case AgentEventType.Error: {
						const p = event.payload as { message: string; error_code?: string; retryable?: boolean; suggestion?: string; category?: string; details?: Record<string, unknown> };
						const errorMsg = p.category ? `[${p.category}] ${p.message}` : p.message;
						progress([{
							kind: 'agentError',
							error_code: p.error_code ?? 'AGENT_ERROR',
							message: errorMsg,
							retryable: p.retryable ?? true,
							suggestion: p.suggestion,
						} satisfies IChatAgentError]);
						finish({ errorDetails: { message: errorMsg } });
						break;
					}
					case AgentEventType.TaskComplete: {
						const p = event.payload as ITaskCompletePayload;
						if (p.status === 'error' && p.message) {
							progress([this._warning(p.message)]);
							finish({ errorDetails: { message: p.message } });
						} else {
							finish({});
						}
						break;
					}
					case AgentEventType.Done:
						for (const [k] of runtime.toolStartTimes) {
							const toolName = k.includes('_') ? k.split('_').pop()! : k;
							progress([{
								kind: 'externalToolInvocationUpdate',
								toolCallId: k,
								toolName,
								isComplete: true,
								pastTenseMessage: `${toolName} done`,
							} satisfies IChatExternalToolInvocationUpdate]);
						}
						runtime.toolStartTimes.clear();
						finish({});
						break;
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
							progress([{
								uri: fileUri,
								edits: textEdits,
								kind: 'textEdit',
								done: true,
							} satisfies IChatTextEdit]);
						}
						break;
					}
					// ── FEAT-61: Queue position update ──
					case AgentEventType.QueueUpdate: {
						const p = event.payload as IQueueUpdatePayload;
						const waitInfo = p.estimated_wait_seconds
							? ` (~${Math.ceil(p.estimated_wait_seconds)}s)`
							: '';
						progress([this._progress(`$(clock) Queue position: ${p.position}${waitInfo}`, true)]);
						break;
					}

					// ── FEAT-65: Context window warning ──
					case AgentEventType.ContextWarning: {
						const p = event.payload as IContextWarningPayload;
						const pct = p.usage_percent > 0 ? Math.round(p.usage_percent) : (p.tokens_max > 0 ? Math.round((p.tokens_used / p.tokens_max) * 100) : 0);
						const suggestion = p.suggestion ? ` ${p.suggestion}` : '';
						progress([this._warning(
							`$(warning) Context window ${pct}% used (${p.tokens_used}/${p.tokens_max}).${suggestion}`
						)]);
						break;
					}
					default:
						this._logService.trace('[ChipOS Agent] Unhandled event in continuation:', event.event_type);
						break;
				}
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
		console.log('[ConfirmMsg] card_type:', p.card_type, 'has p.message:', !!p.message, 'card_data keys:', Object.keys(p.card_data || {}));
		if (p.message) {
			console.log('[ConfirmMsg] Using p.message (first 200 chars):', p.message.slice(0, 200));
		}

		// If p.message exists but card_data also has full content, prefer the full content
		// for spec_confirm and arch_confirm so the temp file has complete details.
		const data = p.card_data;
		switch (p.card_type) {
			case 'spec_confirm': {
				const specText = data?.spec_result ?? data?.analysis ?? data?.result;
				console.log('[ConfirmMsg] spec_confirm: specText type:', typeof specText, 'length:', typeof specText === 'string' ? specText.length : 'N/A');
				if (typeof specText === 'string' && specText.length > 0) {
					return specText;
				}
				if (p.message) { return p.message; }
				if (data?.summary) { return String(data.summary); }
				return 'Spec analysis complete. Review and approve to continue.';
			}

			case 'arch_confirm': {
				const archText = data?.arch_result ?? data?.analysis ?? data?.result;
				console.log('[ConfirmMsg] arch_confirm: archText type:', typeof archText, 'length:', typeof archText === 'string' ? archText.length : 'N/A');
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
		// Filter out files in hidden directories (e.g. .cursor/, .git/, .vscode/)
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
			};
			this._sessionRuntimes.set(sessionResource, runtime);
		}
		return runtime;
	}

	private _getRuntime(sessionResource: URI): IChatSessionRuntime | undefined {
		return this._sessionRuntimes.get(sessionResource);
	}

	private _disposeRuntime(sessionResource: URI): void {
		const runtime = this._sessionRuntimes.get(sessionResource);
		if (!runtime) {
			return;
		}

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

	private _sessionBackendId(sessionResource: URI): string | undefined {
		return this._getRuntime(sessionResource)?.backendSessionId;
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
			runtime.streamClient = new SseEventStreamClient({ baseUrl, token });
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
		for (const [sessionResource] of this._sessionRuntimes) {
			this._disposeRuntime(sessionResource);
		}
		super.dispose();
	}
}

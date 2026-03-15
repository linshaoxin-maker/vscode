/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentHistoryEntry,
} from '../../../../contrib/chat/common/participants/chatAgents.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	IChatProgress,
	IChatMarkdownContent,
	IChatConfirmation,
	IChatProgressMessage,
	IChatTask,
	IChatTaskSerialized,
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
} from '../../../../contrib/chat/common/chatService/chatService.js';
import { IChatTodoListService, type IChatTodo } from '../../../../contrib/chat/common/tools/chatTodoListService.js';
import { WebSocketEventStreamClient } from '../eventStream/webSocketEventStreamClient.js';
import { ContextCollector } from '../autoContext/contextCollector.js';
import { ChipOSEditorEffects } from './editorEffects.js';
import {
	AgentEventType,
	ConnectionState,
	type AgentEvent,
	type ITextDeltaPayload,
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
	type IMentionItem,
} from '../eventStream/eventTypes.js';

/**
 * IChatAgentImplementation that bridges the native VSCode Chat UI
 * to the ChipOS backend via WebSocket.
 *
 * Maps all backend events to native IChatProgress types:
 *   - model_output → markdownContent / thinking
 *   - tool_start/result → progressMessage with tool trace
 *   - confirm_request → confirmation (native buttons)
 *   - sim_report/coverage/lint → markdownContent (rich formatted)
 *   - task_complete → resolves the invoke Promise
 */
export class ChipOSChatAgent extends Disposable implements IChatAgentImplementation {

	private _wsClient: WebSocketEventStreamClient | undefined;
	private _editorEffects: ChipOSEditorEffects | undefined;
	private _contextCollector: ContextCollector | undefined;
	private _sessionCounter = 0;
	private _lastSessionId: string | undefined;
	private readonly _toolStartTimes = new Map<string, number>();
	private readonly _subagentTimers = new Map<string, number>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatTodoListService private readonly _todoListService: IChatTodoListService,
	) {
		super();
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		// ── FEAT-32: Connection status feedback ──
		progress([this._progress('$(sync~spin) Connecting to backend...', true)]);
		const wsClient = await this._ensureClient();
		if (!wsClient || wsClient.connectionState !== ConnectionState.Connected) {
			const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');
			const hint = manualUrl
				? `Cannot connect to \`${manualUrl}\`. Is the backend running?`
				: 'Backend not connected. Set `chipos.sidecar.manualUrl` or enable `chipos.sidecar.autoStart`.';
			progress([this._markdown(`$(error) **ChipOS:** ${hint}`)]);
			return { errorDetails: { message: 'Backend not connected' } };
		}

		// ── FEAT-23: Route confirmation responses instead of starting a new task ──
		if (request.acceptedConfirmationData?.length) {
			const data = request.acceptedConfirmationData[0] as { requestId: string; options?: Array<{ label: string; action: string }> };
			const action = data.options?.[0]?.action || 'approve';
			this._logService.info('[ChipOS Agent] Confirm response (accepted):', data.requestId, action);
			wsClient.sendConfirmResponse(data.requestId, action);
			progress([this._progress('$(check) Confirmed')]);
			return this._listenForContinuation(wsClient, progress, token);
		}

		if (request.rejectedConfirmationData?.length) {
			const data = request.rejectedConfirmationData[0] as { requestId: string };
			this._logService.info('[ChipOS Agent] Confirm response (rejected):', data.requestId);
			wsClient.sendConfirmResponse(data.requestId, 'reject');
			progress([this._progress('$(circle-slash) Rejected')]);
			return {};
		}

		const sessionId = `native_chat_${++this._sessionCounter}_${Date.now()}`;
		this._lastSessionId = sessionId;
		const userMessage = request.message;
		const startTime = Date.now();
		const effects = this._ensureEditorEffects();
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

		this._toolStartTimes.clear();
		this._subagentTimers.clear();

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;
			let firstProgressTime: number | undefined;
			const pendingConfirmations = new Map<string, IChatConfirmation>();
			const pendingToolTasks = new Map<string, { task: IChatTask; deferred: DeferredPromise<string | void> }>();

			const trackFirstProgress = () => {
				if (firstProgressTime === undefined) {
					firstProgressTime = Date.now() - startTime;
				}
			};

			const finish = (result: IChatAgentResult) => {
				if (!resolved) {
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

			const listener = wsClient.onDidReceiveEvent((event: AgentEvent) => {
				if (resolved) {
					return;
				}

				try {
					effects.handleEvent(event);
				} catch (e) {
					this._logService.warn('[ChipOS Agent] Editor effect error:', String(e));
				}

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

					// ── Tool lifecycle via IChatTask (FEAT-48 enhanced) ──
					case AgentEventType.ToolCall: {
						const p = event.payload as IToolCallPayload;
						const key = p.call_id || p.tool_name;
						this._toolStartTimes.set(key, Date.now());
						const friendly = this._friendlyToolName(p.tool_name);
						const argDetail = ChipOSChatAgent._formatToolArgs(p.arguments);
						const label = argDetail
							? `$(tools~spin) **${friendly}** ${argDetail}`
							: `$(tools~spin) **${friendly}**`;
						const toolTask = this._createToolTask(label);
						pendingToolTasks.set(key, toolTask);
						progress([toolTask.task]);
						break;
					}

					case AgentEventType.ToolResult: {
						const p = event.payload as IToolResultPayload;
						const key = p.call_id || p.tool_name;
						const friendly = this._friendlyToolName(p.tool_name);
						const pending = pendingToolTasks.get(key);
						const icon = p.success ? '$(check)' : '$(error)';
						const startTs = this._toolStartTimes.get(key);
						const elapsed = startTs ? `${((Date.now() - startTs) / 1000).toFixed(1)}s` : '';
						this._toolStartTimes.delete(key);
						const timeSuffix = elapsed ? ` (${elapsed})` : '';
						const resultSummary = p.summary
							? `${icon} ${p.summary}${timeSuffix}`
							: `${icon} ${friendly}${timeSuffix}`;
						if (pending) {
							pending.deferred.complete(resultSummary);
							pendingToolTasks.delete(key);
						} else {
							progress([this._progress(resultSummary)]);
						}
						if (!p.success && typeof p.result === 'string') {
							progress([this._warning(p.result)]);
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
						const title = p.title || `Confirm: ${p.card_type}`;
						const richMessage = this._renderConfirmMessage(p);
						const buttons = p.options?.map(o => o.label) || ['Approve', 'Reject'];
						const confirmation: IChatConfirmation = {
							kind: 'confirmation',
							title,
							message: new MarkdownString(richMessage, { supportThemeIcons: true }),
							data: { requestId: p.request_id, options: p.options },
							buttons,
						};
						pendingConfirmations.set(p.request_id, confirmation);
						progress([confirmation]);
						break;
					}

					// ── Error ──
					case AgentEventType.Error: {
						const errorMsg = (event.payload as { message: string }).message;
						progress([this._warning(errorMsg)]);
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
								in_progress: 'in-progress',
								pending: 'not-started',
							};
							const nativeTodos: IChatTodo[] = p.todos.map((t, idx) => ({
								id: idx,
								title: t.task_des,
								status: statusMap[t.task_status] ?? 'not-started',
							}));
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

					// ── FEAT-33: Loop progress — enhanced indicators ──
					case AgentEventType.LoopProgress: {
						const p = event.payload as ILoopProgressPayload;
						const pct = p.max_rounds > 0 ? Math.round((p.round / p.max_rounds) * 100) : 0;
						const statusIcon = p.status === 'running' ? '$(loading~spin)' :
							p.status === 'done' ? '$(check)' :
								p.status === 'failed' ? '$(error)' : '$(circle-outline)';
						progress([this._progress(`${statusIcon} \`${p.tool}\` round ${p.round}/${p.max_rounds} (${pct}%) — ${p.phase}`, p.status === 'running')]);
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
						if (!this._subagentTimers.has(p.task_id)) {
							this._subagentTimers.set(p.task_id, Date.now());
						}
						const label = `Sub-agent \`${p.task_id.slice(0, 8)}\``;
						if (p.kind === 'text' && p.content) {
							progress([this._markdown(p.content)]);
						} else if (p.kind === 'tool_start' && p.tool_name) {
							const toolTask = this._createToolTask(`${label} $(tools) \`${p.tool_name}\``);
							pendingToolTasks.set(`sub_${p.task_id}_${p.tool_name}`, toolTask);
							progress([toolTask.task]);
						} else if (p.kind === 'tool_end' && p.tool_name) {
							const key = `sub_${p.task_id}_${p.tool_name}`;
							const pending = pendingToolTasks.get(key);
							if (pending) {
								pending.deferred.complete(`$(check) \`${p.tool_name}\` done`);
								pendingToolTasks.delete(key);
							} else {
								progress([this._progress(`${label} $(check) \`${p.tool_name}\` done`)]);
							}
						} else if (p.kind === 'error' && p.content) {
							progress([this._warning(`${label}: ${p.content}`)]);
						} else if (p.kind === 'status' && p.content) {
							progress([this._progress(`${label}: ${p.content}`, true)]);
						} else if (p.kind === 'complete') {
							const subStart = this._subagentTimers.get(p.task_id);
							const subElapsed = subStart ? ` (${((Date.now() - subStart) / 1000).toFixed(1)}s)` : '';
							this._subagentTimers.delete(p.task_id);
							progress([this._progress(`${label} $(check) completed${subElapsed}`)]);
						}
						break;
					}

					// ── Model turn boundaries ──
					case AgentEventType.ModelTurnStart:
					case AgentEventType.ModelTurnEnd:
						break;

					// ── FEAT-30: Worktree files applied → clickable references ──
					case AgentEventType.WorktreeFilesApplied: {
						const p = event.payload as IWorktreeFilesAppliedPayload;
						if (p.files && p.files.length > 0) {
							const grouped = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };
							for (const f of p.files) {
								const bucket = f.action === 'added' ? grouped.added :
									f.action === 'deleted' ? grouped.deleted : grouped.modified;
								bucket.push(f.path);
							}
							const summary: string[] = [];
							if (grouped.added.length) { summary.push(`+${grouped.added.length} added`); }
							if (grouped.modified.length) { summary.push(`~${grouped.modified.length} modified`); }
							if (grouped.deleted.length) { summary.push(`-${grouped.deleted.length} deleted`); }
							progress([this._markdown(
								`**$(file-text) Files applied** (${p.files.length}): ${summary.join(', ')}`
							)]);
							for (const f of p.files) {
								const actionIcon = f.action === 'added' ? '$(diff-added)' :
									f.action === 'deleted' ? '$(diff-removed)' : '$(diff-modified)';
								const ref: IChatContentReference = {
									kind: 'reference',
									reference: URI.file(f.path),
									options: {
										status: {
											description: `${actionIcon} ${f.action}`,
											kind: f.action === 'deleted'
												? ChatResponseReferencePartStatusKind.Omitted
												: ChatResponseReferencePartStatusKind.Complete,
										},
										isDeletion: f.action === 'deleted',
									},
								};
								progress([ref]);
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

					// ── File edit (legacy, handled by editor effects) ──
					case AgentEventType.FileEdit:
						break;

					// ── Confirm (legacy hook card) ──
					case AgentEventType.Confirm:
						break;

					// ── Skill tree (separate panel, not in chat) ──
					case AgentEventType.SkillTree:
						break;

					case AgentEventType.Done:
						finish({});
						break;
				}
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested');
				wsClient.sendStop(sessionId);
				finish({});
			});

			wsClient.sendTask(
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
		wsClient: WebSocketEventStreamClient,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const startTime = Date.now();
		const effects = this._ensureEditorEffects();

		return new Promise<IChatAgentResult>((resolve) => {
			let resolved = false;

			const finish = (result: IChatAgentResult) => {
				if (!resolved) {
					resolved = true;
					listener.dispose();
					result = {
						...result,
						timings: { totalElapsed: Date.now() - startTime },
					};
					resolve(result);
				}
			};

			const listener = wsClient.onDidReceiveEvent((event: AgentEvent) => {
				if (resolved) { return; }

				try {
					effects.handleEvent(event);
				} catch (e) {
					this._logService.warn('[ChipOS Agent] Editor effect error (continuation):', String(e));
				}

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
					case AgentEventType.ToolCall: {
						const p = event.payload as IToolCallPayload;
						const desc = p.summary || this._describeToolCall(p.tool_name, p.arguments);
						progress([this._progress(`$(tools~spin) ${desc}`, true)]);
						break;
					}
					case AgentEventType.ToolResult: {
						const p = event.payload as IToolResultPayload;
						const icon = p.success ? '$(check)' : '$(error)';
						const friendly = this._friendlyToolName(p.tool_name);
						progress([this._progress(`${icon} ${p.summary || friendly}`)]);
						break;
					}
					case AgentEventType.Status: {
						const p = event.payload as IStatusPayload;
						if (p.text) { progress([this._progress(p.text)]); }
						break;
					}
					case AgentEventType.Error: {
						const msg = (event.payload as { message: string }).message;
						progress([this._warning(msg)]);
						finish({ errorDetails: { message: msg } });
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
						finish({});
						break;
					default:
						break;
				}
			});

			token.onCancellationRequested(() => {
				this._logService.info('[ChipOS Agent] Cancellation requested (continuation)');
				if (this._lastSessionId) {
					wsClient.sendStop(this._lastSessionId);
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

	// ── FEAT-29: Render rich confirm message based on card_type ──

	private _renderConfirmMessage(p: IConfirmRequestPayload): string {
		if (p.message) {
			return p.message;
		}

		const data = p.card_data;
		switch (p.card_type) {
			case 'spec_confirm': {
				const sections: string[] = [];
				if (data.summary) { sections.push(`**Summary:** ${data.summary}`); }
				if (data.file_path) { sections.push(`**File:** \`${data.file_path}\``); }
				if (data.changes && Array.isArray(data.changes)) {
					sections.push('**Changes:**');
					for (const c of data.changes as Array<{ file?: string; description?: string }>) {
						sections.push(`- \`${c.file || 'unknown'}\` — ${c.description || ''}`);
					}
				}
				if (data.risks && Array.isArray(data.risks)) {
					sections.push('**$(warning) Risks:**');
					for (const r of data.risks as string[]) {
						sections.push(`- ${r}`);
					}
				}
				return sections.length > 0 ? sections.join('\n\n') : JSON.stringify(data, null, 2).slice(0, 500);
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

			default:
				return JSON.stringify(data, null, 2).slice(0, 500);
		}
	}

	// ── FEAT-26: Create IChatTask for native tool tracking ──

	private _createToolTask(label: string): { task: IChatTask; deferred: DeferredPromise<string | void> } {
		const deferred = new DeferredPromise<string | void>();
		const progressEmitter = new Emitter<IChatWarningMessage | IChatContentReference>();
		const progressItems: (IChatWarningMessage | IChatContentReference)[] = [];

		const task: IChatTask = {
			content: new MarkdownString(label, { supportThemeIcons: true }),
			kind: 'progressTask',
			deferred,
			progress: progressItems,
			onDidAddProgress: progressEmitter.event,
			add(item: IChatWarningMessage | IChatContentReference) {
				progressItems.push(item);
				progressEmitter.fire(item);
			},
			complete(result: string | void) {
				deferred.complete(result);
			},
			task: () => deferred.p,
			isSettled: () => deferred.isSettled,
			toJSON(): IChatTaskSerialized {
				return {
					content: task.content,
					progress: progressItems,
					kind: 'progressTaskSerialized',
				};
			},
		};

		return { task, deferred };
	}

	// ── FEAT-26: Friendly tool name mapping ─────────────────────────────────

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

	private _describeToolCall(toolName: string, args?: Record<string, unknown>): string {
		const friendly = this._friendlyToolName(toolName);
		const detail = ChipOSChatAgent._formatToolArgs(args);
		return detail ? `${friendly}: ${detail}` : friendly;
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

	acceptAllDiffs(): void {
		this._editorEffects?.inlineDiffController.acceptAllFiles();
	}

	rejectAllDiffs(): void {
		this._editorEffects?.inlineDiffController.rejectAllFiles();
	}

	getActiveDiffFiles(): string[] {
		return this._editorEffects?.inlineDiffController.getActiveDiffFiles() ?? [];
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

	// ── WebSocket lifecycle ─────────────────────────────────────────────────

	private async _ensureClient(): Promise<WebSocketEventStreamClient | undefined> {
		if (this._wsClient && this._wsClient.connectionState === ConnectionState.Connected) {
			return this._wsClient;
		}

		const manualUrl = this._configurationService.getValue<string>('chipos.sidecar.manualUrl');
		const backendUrl = this._configurationService.getValue<string>('chipos.backendUrl');
		const port = this._configurationService.getValue<number>('chipos.sidecar.port') ?? 8000;
		const url = manualUrl || backendUrl || `ws://127.0.0.1:${port}/ws/agent`;

		this._logService.info('[ChipOS Agent] Connecting to backend:', url);

		if (!this._wsClient) {
			this._wsClient = this._register(
				this._instantiationService.createInstance(WebSocketEventStreamClient, url)
			);
		} else {
			this._wsClient.setUrl(url);
		}

		try {
			await this._wsClient.connect();
		} catch (err) {
			this._logService.error('[ChipOS Agent] Failed to connect:', String(err));
			return undefined;
		}

		return this._wsClient;
	}

	override dispose(): void {
		this._toolStartTimes.clear();
		this._subagentTimers.clear();
		if (this._wsClient) {
			this._wsClient.disconnect();
		}
		super.dispose();
	}
}

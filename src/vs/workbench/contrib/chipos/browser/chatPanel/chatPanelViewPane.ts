/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ChipOS IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./chatPanel';

import { ViewPane, IViewPaneOptions } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService, RawContextKey, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IHoverService } from 'vs/platform/hover/browser/hover';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import * as dom from 'vs/base/browser/dom';
import { generateUuid } from 'vs/base/common/uuid';

import { ChatMessageRenderer, IStreamingMessageHandle } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatMessageRenderer';
import { ChatInputWidget } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatInputWidget';
import { ChatSessionManager, IChatSession, IChatMessage } from 'vs/workbench/contrib/chipos/browser/chatPanel/chatSessionManager';
import { MockEventStreamClient, IEventStreamClient } from 'vs/workbench/contrib/chipos/browser/eventStream/eventStreamClient';
import { AgentEventType, ConnectionState, type IMentionItem } from 'vs/workbench/contrib/chipos/browser/eventStream/eventTypes';

const $ = dom.$;

export const ChipOSChatIsStreaming = new RawContextKey<boolean>('chiposChatIsStreaming', false);

export class ChatPanelViewPane extends ViewPane {

	static readonly ID = 'chipos.chatView';

	private _bodyContainer!: HTMLElement;
	private _headerBar!: HTMLElement;
	private _messageArea!: HTMLElement;
	private _footerArea!: HTMLElement;

	private _renderer!: ChatMessageRenderer;
	private _inputWidget!: ChatInputWidget;
	private _sessionManager!: ChatSessionManager;
	private _eventStreamClient!: IEventStreamClient;

	private _activeHandle: IStreamingMessageHandle | undefined;
	private _streamingKey!: IContextKey<boolean>;
	private _cachedRenderers = new Map<string, HTMLElement>();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, _instantiationService, openerService, themeService, telemetryService, hoverService);

		this._streamingKey = ChipOSChatIsStreaming.bindTo(contextKeyService);

		this._sessionManager = this._register(new ChatSessionManager());
		this._eventStreamClient = this._register(this._instantiationService.createInstance(MockEventStreamClient));

		this._registerEventStreamListeners();
		this._registerSessionListeners();
		this._connectEventStream();
	}

	// ── ViewPane lifecycle ─────────────────────────────────────────────────

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._bodyContainer = container;
		container.classList.add('chipos-chat-panel');

		// Header: session tabs
		this._headerBar = $('.chipos-chat-header');
		this._renderSessionTabs();
		container.appendChild(this._headerBar);

		// Body: message list
		this._messageArea = $('.chipos-chat-body');
		this._renderer = this._register(this._instantiationService.createInstance(
			ChatMessageRenderer,
			this._messageArea,
		));
		container.appendChild(this._messageArea);

		// Footer: input area
		this._footerArea = $('.chipos-chat-footer');
		this._inputWidget = this._register(this._instantiationService.createInstance(
			ChatInputWidget,
			this._footerArea,
		));
		container.appendChild(this._footerArea);

		this._register(this._inputWidget.onDidSubmit(e => {
			this._handleSendMessage(e.text, e.mentions);
		}));

		this._register(this._inputWidget.onDidRequestStop(() => {
			this._handleStopAgent();
		}));

		this._register(this._inputWidget.onDidChangeMode(mode => {
			const session = this._sessionManager.getActiveSession();
			if (session) {
				this._sessionManager.setSessionMode(session.id, mode);
			}
		}));

		// Restore active session messages
		this._restoreActiveSession();

		// Load initial settings into input widget
		const showThinking = this.configurationService.getValue<boolean>('chipos.showThinking');
		const autoApprove = this.configurationService.getValue<string>('chipos.autoApproveMode');
		this._inputWidget.setThinkingEnabled(!!showThinking);
		this._inputWidget.setAutoApproveEnabled(autoApprove === 'full_auto');
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (!this._bodyContainer) {
			return;
		}

		const headerHeight = this._headerBar.offsetHeight;
		const footerHeight = this._footerArea.offsetHeight;
		const messageHeight = height - headerHeight - footerHeight;

		this._messageArea.style.height = `${Math.max(messageHeight, 100)}px`;
		this._renderer.layout();
		this._inputWidget.layout(width);
	}

	override focus(): void {
		super.focus();
		this._inputWidget?.focus();
	}

	// ── Message send/stop flow ─────────────────────────────────────────────

	private async _handleSendMessage(text: string, mentions?: IMentionItem[]): Promise<void> {
		const session = this._sessionManager.getActiveSession();
		if (!session) {
			return;
		}

		if (this._eventStreamClient.connectionState !== ConnectionState.Connected) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: 'ChipOS AI is not connected. Please wait for the connection to establish.',
			});
			return;
		}

		// Render user message
		this._renderer.renderUserMessage(text, mentions);

		// Add to session
		const userMsg: IChatMessage = {
			id: generateUuid(),
			role: 'user',
			content: text,
			mentions: mentions ?? [],
			timestamp: Date.now(),
			isStreaming: false,
		};
		this._sessionManager.appendMessage(session.id, userMsg);

		// Prepare assistant message
		const assistantMsg: IChatMessage = {
			id: generateUuid(),
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
		};
		this._sessionManager.appendMessage(session.id, assistantMsg);

		// Begin streaming render
		this._activeHandle = this._renderer.beginAssistantMessage();
		this._sessionManager.setSessionStatus(session.id, 'running');
		this._inputWidget.setAgentRunning(true);
		this._streamingKey.set(true);
		this._inputWidget.clear();

		// Auto-name session from first user message
		if (session.messages.length <= 2) {
			this._sessionManager.autoNameSession(session.id, text);
		}

		// Send to backend
		this._eventStreamClient.sendTask(
			session.id,
			text,
			mentions ?? [],
			session.mode,
			{
				thinking: this._inputWidget.isThinkingEnabled(),
				autoApprove: this._inputWidget.isAutoApproveEnabled(),
			},
		);
	}

	private _handleStopAgent(): void {
		const session = this._sessionManager.getActiveSession();
		if (!session) {
			return;
		}

		this._eventStreamClient.sendStop(session.id);
		this._finishCurrentStream(session.id);
	}

	// ── EventStream event handlers ─────────────────────────────────────────

	private _registerEventStreamListeners(): void {
		this._register(this._eventStreamClient.onDidReceiveEvent(event => {
			const session = this._sessionManager.getActiveSession();
			if (!session) {
				return;
			}

			switch (event.event_type) {
				case AgentEventType.TextDelta: {
					if (this._activeHandle) {
						this._renderer.appendToken(this._activeHandle, event.payload.content);
						this._sessionManager.updateLastAssistantContent(session.id, event.payload.content);
					}
					break;
				}

				case AgentEventType.ToolCall: {
					this._renderer.renderToolCall(event.payload);
					break;
				}

				case AgentEventType.ToolResult: {
					this._renderer.renderToolResult(event.payload);
					break;
				}

				case AgentEventType.Error: {
					this._renderer.renderSystemMessage(
						`Error: ${event.payload.message} (${event.payload.error_code})`,
						'error',
					);
					if (!event.payload.retryable) {
						this._finishCurrentStream(session.id);
						this._sessionManager.setSessionStatus(session.id, 'error');
					}
					break;
				}

				case AgentEventType.Done: {
					this._finishCurrentStream(session.id);
					if (event.payload.summary) {
						this._renderer.renderSystemMessage(event.payload.summary, 'info');
					}
					break;
				}

				case AgentEventType.Confirm:
				case AgentEventType.FileEdit:
					// Routed to other handlers (FEAT-06, FEAT-09) in future
					break;
			}
		}));

		this._register(this._eventStreamClient.onDidChangeConnectionState(state => {
			switch (state) {
				case ConnectionState.Connected:
					this._renderer.renderSystemMessage('Connected to ChipOS AI.', 'info');
					break;
				case ConnectionState.Disconnected:
					this._renderer.renderSystemMessage('Disconnected from ChipOS AI.', 'warning');
					break;
				case ConnectionState.Error:
					this._renderer.renderSystemMessage('Connection error.', 'error');
					break;
			}
		}));
	}

	private _finishCurrentStream(sessionId: string): void {
		if (this._activeHandle) {
			this._renderer.finishAssistantMessage(this._activeHandle);
			this._activeHandle = undefined;
		}
		this._sessionManager.finishStreaming(sessionId);
		this._sessionManager.setSessionStatus(sessionId, 'idle');
		this._inputWidget.setAgentRunning(false);
		this._streamingKey.set(false);
	}

	// ── Session tab management ─────────────────────────────────────────────

	private _registerSessionListeners(): void {
		this._register(this._sessionManager.onDidChangeActiveSession(session => {
			this._renderSessionTabs();
			this._restoreSessionMessages(session);
		}));

		this._register(this._sessionManager.onDidChangeSessionList(() => {
			this._renderSessionTabs();
		}));
	}

	private _renderSessionTabs(): void {
		if (!this._headerBar) {
			return;
		}
		dom.clearNode(this._headerBar);

		const tabContainer = $('.chipos-chat-tabs');
		const sessions = this._sessionManager.getSessions();
		const activeSession = this._sessionManager.getActiveSession();

		for (const session of sessions) {
			const tab = $('div.chipos-chat-tab');
			if (session.id === activeSession?.id) {
				tab.classList.add('chipos-chat-tab-active');
			}
			if (session.status === 'running') {
				tab.classList.add('chipos-chat-tab-running');
			}

			const title = $('span.chipos-chat-tab-title');
			title.textContent = session.title;
			tab.appendChild(title);

			const closeBtn = $('span.chipos-chat-tab-close');
			closeBtn.textContent = '×';
			this._register(dom.addDisposableListener(closeBtn, 'click', (e) => {
				e.stopPropagation();
				this._closeSessionTab(session);
			}));
			tab.appendChild(closeBtn);

			this._register(dom.addDisposableListener(tab, 'click', () => {
				this._sessionManager.switchToSession(session.id);
			}));

			this._register(dom.addDisposableListener(tab, 'dblclick', (e) => {
				e.stopPropagation();
				this._handleTabDoubleClick(session, title);
			}));

			tabContainer.appendChild(tab);
		}

		// New session button
		const addBtn = $('div.chipos-chat-tab-add');
		addBtn.textContent = '+';
		addBtn.title = 'New session';
		this._register(dom.addDisposableListener(addBtn, 'click', () => {
			this._sessionManager.createSession();
		}));
		tabContainer.appendChild(addBtn);

		this._headerBar.appendChild(tabContainer);
	}

	private async _closeSessionTab(session: IChatSession): Promise<void> {
		if (session.status === 'running') {
			const { confirmed } = await this._dialogService.confirm({
				message: `Session "${session.title}" has a running task.`,
				detail: 'Closing will stop the task and discard unsaved results. Continue?',
				primaryButton: 'Stop & Close',
			});
			if (!confirmed) {
				return;
			}
			this._eventStreamClient.sendStop(session.id);
			this._finishCurrentStream(session.id);
			this._sessionManager.forceCloseSession(session.id);
			return;
		}
		await this._sessionManager.closeSession(session.id);
	}

	private _handleTabDoubleClick(session: IChatSession, titleElement: HTMLElement): void {
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'chipos-chat-tab-rename-input';
		input.value = session.title;
		input.style.width = `${Math.max(titleElement.offsetWidth, 60)}px`;

		const originalText = titleElement.textContent;
		titleElement.textContent = '';
		titleElement.appendChild(input);
		input.focus();
		input.select();

		const commit = () => {
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== originalText) {
				this._sessionManager.renameSession(session.id, newTitle);
			}
			this._renderSessionTabs();
		};

		this._register(dom.addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._renderSessionTabs();
			}
		}));

		this._register(dom.addDisposableListener(input, 'blur', () => {
			commit();
		}));
	}

	private _restoreActiveSession(): void {
		const session = this._sessionManager.getActiveSession();
		if (session) {
			this._restoreSessionMessages(session);
		}
	}

	private _restoreSessionMessages(session: IChatSession): void {
		// Save current rendered state
		const currentActive = this._sessionManager.getActiveSession();
		if (currentActive && this._messageArea) {
			// Cache not needed for now; simply re-render from session data
		}

		this._renderer.clear();
		this._activeHandle = undefined;

		for (const msg of session.messages) {
			switch (msg.role) {
				case 'user':
					this._renderer.renderUserMessage(msg.content, msg.mentions);
					break;
				case 'assistant': {
					const handle = this._renderer.beginAssistantMessage();
					this._renderer.appendToken(handle, msg.content);
					if (!msg.isStreaming) {
						this._renderer.finishAssistantMessage(handle);
					} else {
						this._activeHandle = handle;
					}
					break;
				}
				case 'system':
					this._renderer.renderSystemMessage(msg.content, 'info');
					break;
				case 'tool':
					if (msg.toolCalls) {
						for (const tc of msg.toolCalls) {
							this._renderer.renderToolCall(tc);
						}
					}
					break;
			}
		}

		this._inputWidget.setAgentRunning(session.status === 'running');
		this._inputWidget.setMode(session.mode);
		this._streamingKey.set(session.status === 'running');
	}

	// ── EventStream connection ─────────────────────────────────────────────

	private async _connectEventStream(): Promise<void> {
		try {
			await this._eventStreamClient.connect();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._notificationService.notify({
				severity: Severity.Error,
				message: `ChipOS: Failed to connect — ${msg}`,
			});
		}
	}
}
